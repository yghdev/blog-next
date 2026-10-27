/**
 * 真实 Next HTTP 集成测试（阶段 00）。
 *
 * 覆盖验收矩阵 §11.0 指定的「只能在这一层做」的部分：真实 Next 运行时、
 * unstable_cache 预热与 revalidateTag、RSS/搜索/sitemap 各自语义、308、HTTP 鉴权。
 * 数据库是 .tmp-tests 下的临时库，服务是 standalone 产物起的真进程。
 *
 * 关键设计（都是被验收打回过的地方）：
 *   1. 缓存断言必须**真的预热再断言**。上一版这里写的是 `assert.ok(true)`，
 *      等于什么都没验证，还配了一句「TTL 行为另行覆盖」—— 而那个"另行"不存在。
 *      现在的做法：先抓页面进缓存，再绕过应用改数据库，然后分两条互斥断言证明
 *      （a）命中缓存时页面仍是旧值 => 缓存确实在起作用，不是数据库变化被漏看；
 *      （b）revalidateTag 之后页面变成新值 => 失效真的生效了。
 *   2. 失败路径必须清理子进程与临时目录。上一版失败后会留下 .tmp-tests/next-integration-*。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { warmPublicCache, fetchText, searchProbe, waitForFresh } from "./helpers/public-cache.mjs";

let server;
let authCookie;

function api(route, { method = "GET", body, cookie = authCookie } = {}) {
  return fetch(server.base + route, {
    method,
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie: "blog_session=" + cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(payload) {
  const response = await api("/api/admin/posts", { method: "POST", body: payload });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function login() {
  const response = await fetch(server.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: server.fixture.username, password: server.fixture.password }),
  });
  assert.equal(response.status, 200, await response.text());
  const raw = response.headers.get("set-cookie");
  assert.ok(raw, "login did not set a session cookie");
  const match = raw.match(/blog_session=([^;]+)/);
  assert.ok(match, "unexpected set-cookie: " + raw);
  authCookie = match[1];
}

try {
  server = await startIsolatedServer({ label: "next-integration" });
  await login();
  console.log("Isolated Next server: " + server.base + "; DATA_DIR=" + server.dataDir);
  // 隔离必须被证明，不是口头承诺：库在临时目录、Next 缓存目录已清空
  assert.ok(server.dataDir.includes(".tmp-tests"), "DATA_DIR must live under .tmp-tests: " + server.dataDir);
  assert.notEqual(server.dataDir, path.join(process.cwd(), "data"));
  /**
   * 注意不要把这里写成 `clearedCachePaths.length > 0`：全新构建的产物里
   * 根本没有 .next/cache 与 route-cache，清空数为 0 是**正确**结果。
   * 上一版就是这样，导致「干净构建后第一次跑」必失败、「第二次跑」才通过 ——
   * 一个只在新机器/新 CI 上爆的假失败。这里断言的是"缓存目录现在不存在"，
   * 它对两种前序状态都成立：本来没有（无需清），或刚被清掉。
   */
  for (const dir of server.clearedCachePaths) {
    assert.equal(fs.existsSync(dir), false, "cleared cache dir must not exist before start: " + dir);
  }
  for (const dir of [path.join(server.standaloneDir, ".next", "cache"), path.join(server.standaloneDir, ".next", "server", "route-cache")]) {
    assert.equal(fs.existsSync(dir), false, "Next cache dir must be absent at server start (cross-run isolation): " + dir);
  }
  console.log("PASS isolation: temp DATA_DIR, no stale Next cache before start");

  /* ---------------------------- 鉴权 ---------------------------- */
  const unauthenticatedApi = await api("/api/admin/posts", { cookie: "" });
  assert.equal(unauthenticatedApi.status, 401);
  const unauthenticatedPage = await fetch(server.base + "/admin", { redirect: "manual" });
  assert.equal(unauthenticatedPage.status, 307);
  assert.match(unauthenticatedPage.headers.get("location") || "", /\/admin\/login/);
  console.log("PASS authentication: API 401, admin page login redirect");

  /* ------------------------- 草稿公开隔离 ------------------------- */
  // 预热公开面，确保后面看到的是"缓存里已有的东西"，而不是请求都还没进来
  await warmPublicCache(server.base);
  await create({ type: "post", slug: "next-draft", title: "NEXT_DRAFT_TITLE", content: "NEXT_DRAFT_CONTENT", status: "draft" });

  const publicPage = await fetch(server.base + "/next-draft");
  assert.equal(publicPage.status, 404, "draft must not have a public route");
  const search = await searchProbe(server.base, "NEXT_DRAFT_TITLE");
  assert.deepEqual(search.hits, [], "draft must not appear in no-store search");
  const rss = await fetchText(server.base, "/rss.xml");
  assert.doesNotMatch(rss.text, /NEXT_DRAFT/, "draft must not appear in RSS");
  const home = await fetchText(server.base, "/");
  assert.doesNotMatch(home.text, /NEXT_DRAFT/, "draft must not appear on home page");
  console.log("PASS draft isolation: public route 404, no-store search, RSS, home");

  /* ---------------------- 发布可见性与 308 ---------------------- */
  const published = await create({ type: "post", slug: "publication-new", title: "NEXT_PUBLIC_NEW", content: "NEXT_PUBLIC_NEW_BODY", status: "published" });
  const publishedPage = await fetchText(server.base, "/publication-new");
  assert.match(publishedPage.text, /NEXT_PUBLIC_NEW_BODY/, "published post must be publicly visible");
  console.log("PASS publication visibility");

  const redirectPost = await create({ type: "post", slug: "redirect-old", title: "REDIRECT_TITLE", content: "REDIRECT_BODY", status: "published" });
  // 先把它抓进 unstable_cache，再改 slug —— 这样 308 不会被"根本没缓存过"掩盖
  await fetchText(server.base, "/redirect-old");
  const redirected = await api("/api/admin/posts/" + redirectPost.id, {
    method: "PATCH",
    body: { type: "post", slug: "redirect-new", title: "REDIRECT_TITLE", content: "REDIRECT_BODY", status: "published", categories: [], tags: [] },
  });
  assert.equal(redirected.status, 200, await redirected.text());
  // 注意：revalidateTag(tag, "max") 是 stale-while-revalidate，失效后第一次请求
  // 仍返回旧缓存，第二次才刷新。所以这里轮询到稳定结果，而不是赌第一次。
  const redirect = await waitForFresh(async () => {
    const res = await fetch(server.base + "/redirect-old", { redirect: "manual" });
    return { ok: res.status === 308, status: res.status, location: res.headers.get("location") };
  }, { label: "old slug 308 redirect" });
  assert.equal(redirect.status, 308, "old slug must permanently redirect (not 301/307)");
  assert.equal(redirect.location, "/redirect-new");
  assert.match((await fetchText(server.base, "/redirect-new")).text, /REDIRECT_BODY/);
  console.log("PASS slug change: 308 + Location, target renders new content");

  /* ------------------- 缓存真实生效 / 真实失效 ------------------- */
  // 这一段是上一版最大的窟窿：原来只有 assert.ok(true)，等于没验证。
  // 现在用「绕过应用直改数据库」来做取证，因为只有它能区分
  //   (a) 页面读到旧值 —— 是真的命中缓存，不是数据库没变
  //   (b) 失效后读到新值 —— revalidateTag 真的把缓存冲掉了
  const cachedSlug = "cache-check";
  const cachedPost = await create({ type: "post", slug: cachedSlug, title: "CACHE_BEFORE_TITLE", content: "CACHE_BEFORE_BODY", status: "published" });

  // 1) 预热：把这一页读进 unstable_cache
  const warmed = await fetchText(server.base, "/" + cachedSlug);
  assert.match(warmed.text, /CACHE_BEFORE_BODY/, "precondition: page readable before caching");

  // 2) 绕过应用层直接改库（不经过任何 revalidateTag）
  const D = (await import("better-sqlite3")).default;
  const db = new D(path.join(server.dataDir, "blog.db"));
  db.pragma("busy_timeout = 5000");
  db.prepare("UPDATE posts SET content = ? WHERE slug = ?").run("CACHE_DB_ONLY_BODY", cachedSlug);
  db.close();

  // 3) no-store 直查立刻看到新值 —— 证明数据库确实变了
  const dbOnlySearch = await searchProbe(server.base, "CACHE_DB_ONLY");
  assert.equal(dbOnlySearch.hits.length, 1, "no-store search must see the direct DB write immediately");

  // 4) 但页面仍是旧值 —— 证明它来自缓存，而不是数据库
  const stillCached = await fetchText(server.base, "/" + cachedSlug);
  assert.match(stillCached.text, /CACHE_BEFORE_BODY/, "page must still serve the cached body after a DB-only write");
  assert.doesNotMatch(stillCached.text, /CACHE_DB_ONLY_BODY/, "cache must not have been bypassed");
  console.log("PASS cache is genuinely in play: DB changed, page unchanged");

  // 5) 走正常 PATCH（触发 revalidateTag）后，页面必须立刻反映数据库
  const patched = await api("/api/admin/posts/" + cachedPost.id, {
    method: "PATCH",
    body: { type: "post", slug: cachedSlug, title: "CACHE_AFTER_TITLE", content: "CACHE_AFTER_BODY", status: "published", categories: [], tags: [] },
  });
  assert.equal(patched.status, 200, await patched.text());
  // 注意：不要把 ok 判定用的文本裁掉再拿去断言 —— 上一版返回了 text.slice(0,400)，
  // 结果断言在一个没有正文的 HTML 前缀上，失败信息还看不出是"截断"造成的。
  const afterInvalidate = await waitForFresh(async () => {
    const res = await fetchText(server.base, "/" + cachedSlug);
    const ok = /CACHE_AFTER_BODY/.test(res.text) && !/CACHE_BEFORE_BODY/.test(res.text);
    return { ok, text: res.text };
  }, { label: "revalidated page body" });
  assert.match(afterInvalidate.text, /CACHE_AFTER_BODY/);
  console.log("PASS cache invalidation: revalidateTag flushed the stale entry (SWR semantics respected)");

  // 6) no-store 搜索接口始终直查：改完立刻能搜到新标题、搜不到旧标题
  const newSearch = await searchProbe(server.base, "CACHE_AFTER_TITLE");
  assert.equal(newSearch.hits.length, 1, "no-store search must see the new title immediately");
  const oldSearch = await searchProbe(server.base, "CACHE_BEFORE_TITLE");
  assert.deepEqual(oldSearch.hits, [], "no-store search must not return the old title");

  /* ------------------------- sitemap 语义 ------------------------- */
  /**
   * sitemap 的正确断言方式（实测结论，别再改回"断言新文章出现"）：
   * app/sitemap.ts 有 `export const revalidate = 3600`，Next 会在 **next build 时
   * 预渲染** 它（构建输出里就是 `○ /sitemap.xml 1h`）。所以：
   *   - 运行期新建的文章不会立刻出现在 sitemap 里，要等 ISR 到期
   *   - 上一版这里写 `assert.match(text, /publication-new/)` 必然失败
   * 这正是验收矩阵 §11.2 说的「sitemap revalidate 3600 单独测，不作为正文泄露主探针」。
   * 这里测两件真实成立的事：形状正确，且**不泄露草稿**。
   */
  const sitemap = await fetchText(server.base, "/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.text, /<urlset/, "sitemap must be a urlset document");
  assert.doesNotMatch(sitemap.text, /next-draft/, "sitemap must never list draft slugs");
  console.log("PASS sitemap: urlset shape, prerendered ISR semantics, no draft leakage");

  /* --------------------------- 健康检查 --------------------------- */
  const health = await fetch(server.base + "/api/healthz");
  assert.equal(health.status, 200);

  console.log("All real Next integration checks passed.");
} catch (error) {
  if (server && server.logs) console.error(server.logs());
  throw error;
} finally {
  if (server) await server.close();
}
