/**
 * Friends 专题页（/friend-links）真实 Next 集成测试。
 *
 * 这一页同时依赖四份真实数据，任何一份接错都只会表现为"页面上少一块"，
 * 静态检查发现不了，所以放在真进程 + 真 HTTP 这一层：
 *
 *   1) friend_links 表      —— 后台新增即出现；隐藏项不得出现
 *   2) 页面正文（posts.page）—— 未种子时回退 content/pages/friend-links.md，
 *                              申请要求与本站信息都从这份正文解析
 *   3) settings             —— 站名/描述的兜底
 *   4) Artalk               —— 评论区容器与 pageKey 必须保持 /friend-links
 *
 * 另外验证：SEO（title/description/canonical/JSON-LD）、外链 rel/target、
 * 以及"这一页不再走 [slug] 模板"（旧模板会渲染文章元信息与目录）。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { fetchText, waitForFresh } from "./helpers/public-cache.mjs";

let server;
let cookie;

function api(route, { method = "GET", body } = {}) {
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

async function login() {
  const res = await fetch(server.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: server.fixture.username, password: server.fixture.password }),
  });
  assert.equal(res.status, 200, await res.text());
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/blog_session=([^;]+)/);
  assert.ok(m, "login must set session cookie: " + raw);
  cookie = m[1];
}

try {
  server = await startIsolatedServer({ label: "friend-links-page" });
  await login();

  /* -------------------- 1. 基础渲染（无 posts 种子） -------------------- */
  const first = await fetchText(server.base, "/friend-links");
  assert.equal(first.status, 200, "/friend-links should render");
  assert.match(first.text, /互联网的另一端，/, "主标题缺失");
  assert.match(first.text, /也有有趣的人。/, "主标题第二行缺失");
  assert.match(first.text, /FRIENDS &amp; CONNECTIONS|FRIENDS & CONNECTIONS/, "英文辅助标题缺失");
  assert.match(first.text, /01 \/ FRIEND DIRECTORY/, "目录编号缺失");
  assert.match(first.text, /02 \/ EXCHANGE/, "交换区编号缺失");
  assert.match(first.text, /让我们也成为彼此的链接。/, "交换区主标题缺失");
  assert.match(first.text, /想加入这份名单？/, "申请区标题缺失");
  assert.match(first.text, /感谢每一位愿意分享自己小世界的人。/, "页面页脚缺失");
  console.log("PASS page: hero / directory / exchange / apply / footer all render");

  /* -------------------- 2. 旧页面正文的数据没丢 -------------------- */
  for (const name of ["xaoxuu", "字节星球", "Xuan&#x27;s blog", "博客星球"]) {
    assert.match(first.text, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "正文里的友链丢失: " + name);
  }
  assert.match(first.text, /站点内容健康，以原创为主/, "申请要求（来自正文）缺失");
  assert.match(first.text, /已稳定运行一段时间，访问正常/, "申请要求第二条缺失");
  assert.match(first.text, /记录 AI、开发与折腾的日常/, "本站信息（来自正文）缺失");
  console.log("PASS data: legacy page content preserved (friends / rules / site info)");

  /* -------------------- 3. 后台新增的友链立即出现 -------------------- */
  const created = await api("/api/admin/links", {
    method: "POST",
    body: { name: "INTEGRATION_FRIEND", url: "https://integration.example.com/", desc: "来自后台", kind: "friend" },
  });
  assert.equal(created.status, 200, await created.text());
  const hidden = await api("/api/admin/links", {
    method: "POST",
    body: { name: "INTEGRATION_HIDDEN", url: "https://hidden.example.com/", desc: "不该出现", kind: "friend", visible: false },
  });
  assert.equal(hidden.status, 200, await hidden.text());

  // revalidateTag 是 stale-while-revalidate：失效后第一次仍可能读旧缓存，
  // 所以轮询到稳定结果再断言（与 tests/next-integration.mjs 同一条规则）。
  // 探针必须盯「卡片本身」而不是名称字符串：侧栏/手机抽屉也渲染同一份数据，
  // 页面主体可能还在上一次缓存里，只看名字会过早判定通过。
  const fresh = await waitForFresh(async () => {
    const r = await fetchText(server.base, "/friend-links");
    return { ok: /<a class="fr-card" href="https:\/\/integration\.example\.com\//.test(r.text), text: r.text };
  }, { label: "new friend link card visible" });
  const body = fresh.text;
  assert.match(body, /https:\/\/integration\.example\.com\//, "友链地址没有渲染");
  assert.doesNotMatch(body, /INTEGRATION_HIDDEN/, "visible=0 的条目不得出现在前台");
  assert.doesNotMatch(body, /hidden\.example\.com/, "隐藏条目的地址也不得泄露");
  console.log("PASS friend_links: created link visible, hidden link absent");

  /* -------------------- 4. 外链行为 -------------------- */
  const cardAnchor = body.match(/<a class="fr-card" href="https:\/\/integration\.example\.com\/"[^>]*>/);
  assert.ok(cardAnchor, "应渲染友链卡片链接");
  assert.match(cardAnchor[0], /target="_blank"/, "友链应在新标签页打开");
  assert.match(cardAnchor[0], /rel="noopener noreferrer"/, "外链必须带 noopener noreferrer");
  console.log("PASS links: target=_blank + rel=noopener noreferrer");

  /* -------------------- 5. 评论区仍挂在原来的 pageKey 上 -------------------- */
  assert.match(body, /id="comments"/, "评论区锚点缺失（申请入口会滚空）");
  assert.match(body, /class="comments"/, "Artalk 挂载容器缺失");
  assert.match(body, /data-post-id="\d+"/, "评论容器应带 post id 属性");
  assert.match(body, /pageKey[^,]*\/friend-links|"\/friend-links"/, "评论 pageKey 必须仍是 /friend-links");
  console.log("PASS comments: Artalk host + /friend-links pageKey preserved");

  /* -------------------- 6. SEO -------------------- */
  // 标题模板是 `%s · {author}`（layout 的 title.template），所以断言前缀而不是整串
  assert.match(body, /<title>友链 · flechazo<\/title>/, "页面标题不符合模板");
  assert.match(body, /<meta name="description" content="这里收藏着一些有趣的个人博客。每一个链接，都是一次跨越屏幕的相遇。"\/>/, "description 缺失");
  assert.match(body, /<link rel="canonical" href="https:\/\/blog\.yghsite\.cn\/friend-links"\/>/, "canonical 缺失");
  assert.match(body, /application\/ld\+json/, "缺少 JSON-LD");
  assert.match(body, /"@type":"CollectionPage"/, "JSON-LD 类型应为 CollectionPage");
  assert.match(body, /"@type":"ItemList"/, "JSON-LD 应带条目列表");
  assert.match(body, /<h1[^>]*class="fr-hero-title"/, "主标题必须是 h1");
  // 旧模板的残留：文章元信息条与目录不应出现
  assert.doesNotMatch(body, /article-meta-bar/, "不应再套用文章模板的元信息条");
  assert.doesNotMatch(body, /class="toc-col"/, "本页不需要右栏目录");
  console.log("PASS SEO: title / description / canonical / JSON-LD / semantic h1");

  /* -------------------- 7. 其它页面不受影响 -------------------- */
  const home = await fetchText(server.base, "/");
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.text, /fr-hero/, "友链页样式/结构泄漏到了首页");
  assert.match(home.text, /class="site-shell"/, "首页骨架应保持不变");
  const archives = await fetchText(server.base, "/archives");
  assert.equal(archives.status, 200);
  assert.match(archives.text, /class="page-title">归档</, "归档页标题应保持原样");
  console.log("PASS isolation: home / archives unaffected");

  console.log("All friend-links page integration checks passed.");
} catch (error) {
  if (server && server.logs) console.error(server.logs());
  throw error;
} finally {
  if (server) await server.close();
}
