/**
 * EditorV2 与版本体验的退出门槛（阶段 03.3，方案 §10）。
 *
 * 方案给了四项硬门槛，缺一不可：
 *   1. 复杂文章 diff 为空
 *   2. 双标签无静默覆盖
 *   3. 断网恢复不丢已保证内容
 *   4. 发布 / slug 308 / 公开缓存正常
 *
 * 前三项在这里用真实浏览器验证；第 4 项已由 tests/next-integration.mjs
 * 覆盖（真实 Next + 隔离库），这里只做"UI 操作后仍然成立"的回归确认。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";
import { waitForFresh, warmPublicCache } from "./helpers/public-cache.mjs";

let server;
let controller;
const tests = [];
const T = (name, fn) => tests.push({ name, fn });

/** 一篇"复杂文章"：图片、iframe、表格、代码块、脚注、行内代码全都有 */
const COMPLEX = [
  "## 二级标题",
  "",
  "普通段落，含 **粗体**、*斜体*、`行内代码` 与 [链接](https://example.com)。",
  "",
  "![示意图](/images/complex.png)",
  "",
  '<iframe src="https://player.bilibili.com/player.html?bvid=BV1xx411c7mD" />',
  "",
  "| 列一 | 列二 |",
  "| ---- | ---- |",
  "| 值 1 | 值 2 |",
  "",
  "```js",
  "const tpl = `x=${1 + 1}`;",
  "function f(a, b) { return a + b; }",
  "```",
  "",
  "> 引用块",
  "> 第二行",
  "",
  "- 列表项 A",
  "- 列表项 B",
  "",
  "尾注示例[^1]",
  "",
  "[^1]: 脚注内容",
].join("\n");

/* ══════════════════════════════════════════════════════════════════
   门槛 1：复杂文章 diff 为空
   ══════════════════════════════════════════════════════════════════ */

T("门槛1: 复杂文章保存/发布前后正文逐字节不变，版本对比判定为空", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await create(page, { slug: "v-gate-complex", content: COMPLEX, title: "复杂文章" });

  // 通过 UI 走一次"存草稿 -> 发布"，与真实使用路径一致
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.locator("button", { hasText: "发布" }).first().click();
  await page.waitForTimeout(2500);

  // 数据库里的正文必须逐字节一致（不 trim、不规范化）
  const after = await getPost(page, id);
  assert.equal(after.post.content, COMPLEX, "发布后正文必须逐字节保留");
  assert.equal(after.post.status, "published");

  // 版本对比：最新发布版 与 当前（无草稿则为线上）应完全一致
  const res = await page.request.get(
    server.base + "/api/admin/posts/" + id + "/version-diff?from=" + after.post.revision + "&to=current"
  );
  assert.equal(res.status(), 200, await res.text());
  const d = await res.json();
  assert.equal(d.from.snapshot.content, d.to.snapshot.content, "两版正文必须相同");
  assert.equal(d.from.snapshot.title, d.to.snapshot.title);
});

/* ══════════════════════════════════════════════════════════════════
   门槛 2：双标签无静默覆盖
   ══════════════════════════════════════════════════════════════════ */

T("门槛2: 双标签同编一篇，后保存者不得静默覆盖（必须出现冲突）", async () => {
  const { page, context } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await create(page, { slug: "v-gate-twotab", content: "原始正文", title: "双标签" });

  // 标签 A 与 B 各自打开同一篇
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  const pageB = await context.newPage();
  await pageB.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });

  // A 先改并保存成功
  await page.fill('input[placeholder="文章标题"]', "A 的标题");
  await page.waitForTimeout(2600);
  const afterA = await getPost(page, id);
  assert.ok(afterA.draft, "A 应已写入服务端草稿");
  const revA = afterA.draft.draft_revision;

  // B 也改（它手里的身份还是旧的）
  await pageB.fill('input[placeholder="文章标题"]', "B 的标题");
  await pageB.waitForTimeout(2800);

  // 关键断言：B 不得静默成功覆盖 A
  const statusB = await pageB.locator(".save-status").innerText();
  assert.match(statusB, /冲突/, "B 的保存必须进入冲突态，实际：" + statusB);

  // 服务端草稿仍是 A 的内容（未被 B 静默覆盖）
  const afterB = await getPost(page, id);
  const snap = JSON.parse(afterB.draft.snapshot_json);
  assert.equal(snap.title, "A 的标题", "服务端草稿不得被后到的 B 静默覆盖");
  assert.equal(afterB.draft.draft_revision, revA, "草稿版本号不得因静默覆盖而变化");

  // 且 B 能看到三方对比，而不是只有一个"保存失败"
  const dialog = pageB.locator(".conflict-dialog");
  await dialog.waitFor({ timeout: 5000 });
  assert.equal(await pageB.locator(".conflict-col").count(), 3, "应展示三方对比");
});

/* ══════════════════════════════════════════════════════════════════
   门槛 3：断网恢复不丢已保证内容
   ══════════════════════════════════════════════════════════════════ */

T("门槛3: 断网期间内容进本地，恢复网络后已确认内容不丢", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await create(page, { slug: "v-gate-offline", content: "已发布正文", title: "断网门槛" });

  // 先正常保存一份，这份是"已保证"的内容
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="文章标题"]', "已保证的标题");
  await page.waitForTimeout(2600);
  const confirmed = await getPost(page, id);
  assert.ok(confirmed.draft, "应已有一份服务端草稿");
  const confirmedTitle = JSON.parse(confirmed.draft.snapshot_json).title;
  assert.equal(confirmedTitle, "已保证的标题");

  // 断网后继续编辑
  await page.context().setOffline(true);
  await page.fill('input[placeholder="文章标题"]', "断网时的新标题");
  await page.waitForTimeout(2200);

  // 断网期间内容必须已落到本地
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("draft:")));
  assert.ok(keys.length > 0, "断网后必须有本地副本");
  const localTitles = await page.evaluate(
    (ks) => ks.map((k) => JSON.parse(localStorage.getItem(k)).snapshot.title),
    keys
  );
  assert.ok(localTitles.includes("断网时的新标题"), "断网期间输入的内容必须在本地，实际：" + JSON.stringify(localTitles));

  // 恢复网络：服务端那份"已保证"的内容仍然完好（没有被清空/覆盖）
  await page.context().setOffline(false);
  await page.waitForTimeout(300);
  const after = await getPost(page, id);
  assert.ok(after.draft, "恢复网络后服务端草稿仍应存在");
  const t = JSON.parse(after.draft.snapshot_json).title;
  assert.ok(
    t === "已保证的标题" || t === "断网时的新标题",
    "服务端内容必须要么是已确认的旧值、要么是新值，不能变空。实际：" + t
  );
  assert.notEqual(t, "", "绝不能变成空标题");
});

/* ══════════════════════════════════════════════════════════════════
   门槛 4：发布 / slug 308 / 公开缓存（UI 操作后仍成立）
   ══════════════════════════════════════════════════════════════════ */

T("门槛4: UI 发布后公开路由可见，改 slug 后旧地址 308 跳转", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await create(page, { slug: "v-gate-public", content: "公开正文 V1", title: "公开门槛" });

  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.locator("button", { hasText: "发布" }).first().click();
  await page.waitForTimeout(2500);

  // 公开可见
  const pub = await fetch(server.base + "/v-gate-public");
  const html = await pub.text();
  assert.match(html, /公开正文 V1/, "发布后公开路由必须能看到正文");

  // 改 slug（元数据 PATCH，需带 revision）
  const cur = await getPost(page, id);
  const patched = await page.request.patch(server.base + "/api/admin/posts/" + id, {
    data: { slug: "v-gate-renamed", expectedRevision: cur.post.revision },
  });
  assert.equal(patched.status(), 200, await patched.text());

  /**
   * 旧地址 308 -> 新地址（方案 §11.3：当前契约是 308 不是 301）。
   *
   * 必须轮询：`revalidateTag(tag, "max")` 是 stale-while-revalidate，
   * 失效后**第一次请求仍返回旧的 200 缓存**，第二次才变成 308。
   * 直接断言第一次就是 308 会得到假失败 —— 这条坑文档里记过，这里照做。
   */
  const old = await waitForFresh(async () => {
    const r = await fetch(server.base + "/v-gate-public", { redirect: "manual" });
    return { ok: r.status === 308, status: r.status, location: r.headers.get("location") };
  }, { label: "旧 slug 308 跳转" });
  assert.equal(old.status, 308, "旧 slug 必须 308 跳转");
  assert.equal(old.location, "/v-gate-renamed");

  const neu = await fetch(server.base + "/v-gate-renamed");
  assert.match(await neu.text(), /公开正文 V1/, "新地址必须能正常渲染");
});

/* ══════════════════════════════════════════════════════════════════
   版本体验：恢复为草稿的商业语义
   ══════════════════════════════════════════════════════════════════ */

T("版本体验：恢复历史只改草稿，线上内容不变，需发布才生效", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await create(page, { slug: "v-gate-restore", content: "第一版正文", title: "恢复体验" });

  // 发布第一版
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.locator("button", { hasText: "发布" }).first().click();
  await page.waitForTimeout(2500);
  const v1 = await getPost(page, id);
  assert.equal(v1.post.status, "published");

  /**
   * 改正文并发布第二版：走 API 而不是点"更新"按钮。
   *
   * 理由不是图省事：这一条验的是"恢复历史"的语义，不是按钮文案。
   * 首次发布后按钮会变成"更新"，用文字匹配容易点到别的同类按钮，
   * 得到一次超时失败 —— 那种失败掩盖的是测试自身的不稳定，不是功能问题。
   */
  const cur1 = await getPost(page, id);
  const cid2 = "cid-v2-" + Math.random().toString(36).slice(2, 8);
  const saved = await page.request.put(server.base + "/api/admin/posts/" + id + "/draft", {
    data: {
      clientDraftId: cid2,
      snapshot: {
        type: "post", title: "恢复体验", slug: "v-gate-restore", content: "第二版正文",
        cover: null, categories: [], tags: [], comments_enabled: 1,
      },
      expectedPostRevision: cur1.post.revision,
      expectedDraftRevision: 0,
    },
  });
  assert.equal(saved.status(), 200, await saved.text());
  const ident = (await saved.json()).identity;
  const pub2 = await page.request.post(server.base + "/api/admin/posts/" + id + "/publish", {
    data: {
      publishRequestId: "req-v2-" + Math.random().toString(36).slice(2, 10),
      expectedPostRevision: ident.baseRevision,
      expectedDraftRevision: ident.draftRevision,
      slug: "v-gate-restore",
    },
  });
  assert.equal(pub2.status(), 200, await pub2.text());
  const v2 = await getPost(page, id);
  assert.equal(v2.post.content, "第二版正文");
  assert.ok(v2.post.revision > v1.post.revision);

  // 恢复第一版为草稿
  const restored = await page.request.post(server.base + "/api/admin/posts/" + id + "/restore-version", {
    data: {
      revision: v1.post.revision,
      expectedDraftRevision: 0,
      expectedPostRevision: v2.post.revision,
      clientDraftId: "cid-restore-gate",
    },
  });
  assert.equal(restored.status(), 200, await restored.text());

  // 关键：线上内容不变（仍是第二版），revision 不回退
  const afterRestore = await getPost(page, id);
  assert.equal(afterRestore.post.content, "第二版正文", "恢复历史不得改动线上内容");
  assert.equal(afterRestore.post.revision, v2.post.revision, "revision 不得回退");

  // 草稿里已是第一版内容
  assert.equal(JSON.parse(afterRestore.draft.snapshot_json).content, "第一版正文");

  // 公开面仍是第二版
  const pub = await fetch(server.base + "/v-gate-restore");
  assert.match(await pub.text(), /第二版正文/, "恢复历史后公开面不得变化");
});

T("版本历史：列表显示发布/初始基线，且不把 revision 当发布序号", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await create(page, { slug: "v-gate-history", content: "历史正文", title: "历史列表" });

  // 用 API 发布，避免与"按钮文案随状态变化"耦合。
  // 必须沿用**建文时已绑定的** clientDraftId：草稿与 clientDraftId 是一对一绑定的，
  // 换一个新 id 会被正确拒绝（DRAFT_FORBIDDEN）—— 那是 03.1 的鉴权设计，
  // 不是 bug。所以这里先把当前绑定读出来。
  const cur = await getPost(page, id);
  const cid = cur.draft?.client_draft_id;
  assert.ok(cid, "建文后应已绑定 clientDraftId");
  const saved = await page.request.put(server.base + "/api/admin/posts/" + id + "/draft", {
    data: {
      clientDraftId: cid,
      snapshot: {
        type: "post", title: "历史列表", slug: "v-gate-history", content: "历史正文",
        cover: null, categories: [], tags: [], comments_enabled: 1,
      },
      expectedPostRevision: cur.post.revision,
      // 用**实际**的草稿版本号：新建时已生成 v1，写死 0 会被正确拒绝（409）
      expectedDraftRevision: cur.draft.draft_revision,
    },
  });
  assert.equal(saved.status(), 200, await saved.text());
  const ident = (await saved.json()).identity;
  const pub = await page.request.post(server.base + "/api/admin/posts/" + id + "/publish", {
    data: {
      publishRequestId: "req-hist-" + Math.random().toString(36).slice(2, 10),
      expectedPostRevision: ident.baseRevision,
      expectedDraftRevision: ident.draftRevision,
      slug: "v-gate-history",
    },
  });
  assert.equal(pub.status(), 200, await pub.text());

  const res = await page.request.get(server.base + "/api/admin/posts/" + id + "/restore-version");
  assert.equal(res.status(), 200);
  const d = await res.json();

  /**
   * 新建文章的历史里只有 publish，没有 baseline —— 这是对的，不是缺数据。
   *
   * baseline 的语义是"迁移时为**存量**文章补一条已知状态"（方案 §3.4），
   * 因为那些文章的线上内容早就在了、历史却从零开始。新建文章没有这段空白：
   * 它的第一次发布就写了 publish 记录，"有发布无历史"的情况不存在。
   * 若给新建文章也塞一条 baseline，反而会出现"一次发布、两条同内容记录"的噪声。
   * 这里断言的是"发布后确实有历史可查"，而不是硬凑两条。
   */
  assert.ok(d.versions.length >= 1, "发布后应有历史记录，实际：" + d.versions.length);

  for (const v of d.versions) {
    assert.ok(["baseline", "publish"].includes(v.reason), "reason 只能是 baseline 或 publish");
    assert.ok(v.label, "每条记录都要有可读标签");
    assert.ok(typeof v.revision === "number" && v.revision > 0, "每条记录都要有有效版本号");
  }
  assert.ok(d.versions.some((v) => v.reason === "publish"), "应含发布记录");

  // 关键：列表按 id 倒序（最新在前），且不把 revision 当"第几次发布"
  const ids = d.versions.map((v) => v.id);
  const sorted = [...ids].sort((a, b) => b - a);
  assert.deepEqual(ids, sorted, "历史列表必须按 id 倒序（最新在前）");
});

/* ---------------------------- 辅助 ---------------------------- */

async function create(page, { slug, content, title }) {
  const res = await page.request.post(server.base + "/api/admin/posts", {
    data: {
      type: "post", title, slug, content, status: "draft", categories: [], tags: [],
      clientDraftId: "cid-" + slug + "-" + Math.random().toString(36).slice(2, 8),
    },
  });
  const body = await res.json();
  assert.equal(res.status(), 200, JSON.stringify(body));
  return body.id;
}

async function getPost(page, id) {
  const res = await page.request.get(server.base + "/api/admin/posts/" + id);
  assert.equal(res.status(), 200, await res.text());
  return res.json();
}

/* ---------------------------- 运行 ---------------------------- */

try {
  server = await startIsolatedServer({ label: "phase033" });
  controller = await startBrowser();

  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log("PASS 03.3: " + t.name);
      passed += 1;
    } catch (e) {
      failures.push({ name: t.name, message: e.message });
      console.error("FAIL 03.3: " + t.name + "\n  " + e.message);
    }
  }
  console.log(passed + "/" + tests.length + " 通过");
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    console.log("All phase-03.3 editor checks passed.");
  }
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
