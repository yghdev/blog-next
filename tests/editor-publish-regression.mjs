/**
 * 编辑器「编辑 → 发布」链路回归（2026-10-29 线上故障）。
 *
 * 这些用例全部来自真实日志，不是假想场景：
 *   1. POST /api/admin/posts/35/publish 只有 1 次，而「新建文章点发布」后
 *      文章仍在草稿里 —— 新文章首次发布被"建壳后直接 return"吞掉；
 *   2. 发布成功后继续输入，PUT /draft 立刻 409 —— 本地基线还停在发布前的 revision；
 *   3. 打开已有文章时两次 GET /draft，两个 clientDraftId 各说各话 ——
 *      随后 DRAFT_FORBIDDEN「该草稿属于另一个编辑会话」；
 *   4. 版本历史面板拿着打开那一刻的 draftRevision，点「恢复为草稿」409。
 *
 * 判据一律落在**服务端状态**（posts / post_drafts），不看按钮文案：
 * 文案会随设计改，数据不会骗人。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server;
let controller;

const T = (name, fn) => { tests.push({ name, fn }); };
const tests = [];

/* ------------------------------- 用例 ------------------------------- */

T("新建文章点「发布」：必须真的发布，而不是只留一份草稿", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  await page.goto(server.base + "/admin/new", { waitUntil: "networkidle" });
  await page.fill('input[placeholder="文章标题"]', "一键发布的新文章");
  await page.locator("textarea").first().fill("发布正文，必须逐字保留");
  await page.locator("button", { hasText: "发布" }).first().click();
  await page.waitForTimeout(3500);

  const id = Number(page.url().split("/").pop());
  assert.ok(Number.isInteger(id) && id > 0, "发布后 URL 应接管为 /admin/edit/<id>，实际：" + page.url());

  const post = await getPost(page, id);
  assert.equal(post.post.status, "published", "点「发布」后 posts.status 必须是 published");
  assert.equal(post.post.content, "发布正文，必须逐字保留", "正文必须逐字保存");
  assert.ok(post.post.published_at, "published_at 必须被写入");
  assert.equal(post.draft, null, "发布成功后服务端草稿应被清理");

  // 前台可见（发布语义的最终判据）
  const html = await (await fetch(server.base + "/" + post.post.slug)).text();
  assert.match(html, /发布正文，必须逐字保留/, "发布后公开页必须能读到正文");
});

T("发布后不刷新继续编辑：第一次自动保存不得 409", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "发布后继续写", slug: "publish-then-edit" });

  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="文章标题"]', "第一次保存");
  await page.waitForTimeout(2600);
  await page.locator("button", { hasText: /发布|更新/ }).first().click();
  await page.waitForTimeout(2600);

  let post = await getPost(page, id);
  assert.equal(post.post.status, "published", "第一次点发布应成功");

  // 关键：页面没刷新，直接接着改
  await page.fill('input[placeholder="文章标题"]', "发布之后的第二次修改");
  await page.waitForTimeout(3200);

  const statusText = await page.locator(".save-status").innerText();
  assert.ok(!/冲突/.test(statusText), "发布后继续编辑不得进入冲突态，实际：" + statusText);
  assert.ok(!/失败/.test(statusText), "发布后继续编辑不得报保存失败，实际：" + statusText);

  post = await getPost(page, id);
  const draftRes = (await (await page.request.get(server.base + "/api/admin/posts/" + id + "/draft")).json()).draft;
  assert.ok(draftRes, "应已生成新的服务端草稿");
  assert.equal(draftRes.snapshot.title, "发布之后的第二次修改", "新草稿必须包含发布后的修改");
  assert.equal(
    draftRes.identity.baseRevision,
    post.post.revision,
    "草稿基线必须等于发布后的 posts.revision"
  );
});

T("已发布文章点「存草稿」：不得把状态显示回“尚未发布”", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "存草稿不改状态", slug: "draft-keeps-status", publish: true });

  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="文章标题"]', "只改草稿");
  await page.locator("button", { hasText: "存草稿" }).first().click();
  await page.waitForTimeout(1600);

  const statusText = await page.locator(".save-status").innerText();
  assert.match(statusText, /线上版本/, "已发布文章存草稿后仍应显示线上版本，实际：" + statusText);
  assert.ok(!/尚未发布/.test(statusText), "存草稿不得把已发布文章显示成“尚未发布”");

  const post = await getPost(page, id);
  assert.equal(post.post.status, "published", "存草稿不得改动 posts.status");
  assert.equal(post.post.title, "存草稿不改状态", "存草稿不得改动线上标题");
});

T("连续点两次「发布」：第二次是幂等重试，不得报冲突", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "连点两次", slug: "double-publish" });

  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="文章标题"]', "连点两次发布");
  const btn = page.locator("button", { hasText: /发布|更新/ }).first();
  await btn.click();
  await page.waitForTimeout(2200);
  await btn.click();
  await page.waitForTimeout(2200);

  const post = await getPost(page, id);
  assert.equal(post.post.status, "published");
  // revision 只应 +1：第二次不该再造一个版本
  assert.equal(post.post.revision, 2, "第二次点发布必须是幂等重试，revision 仍为 2，实际：" + post.post.revision);

  const errText = await page.locator(".notice-error").allInnerTexts();
  assert.equal(errText.length, 0, "连点两次不得报错，实际：" + JSON.stringify(errText));
});

T("版本历史：恢复为草稿后继续编辑不得 409", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "版本恢复", slug: "version-restore", publish: true });

  // 造第二个版本
  const cur = await getPost(page, id);
  const cid = "cid-vr-" + Math.random().toString(36).slice(2, 8);
  const saved = await page.request.put(server.base + "/api/admin/posts/" + id + "/draft", {
    data: {
      clientDraftId: cid,
      snapshot: { type: "post", title: "版本恢复", slug: "version-restore", content: "第二版正文", cover: null, categories: [], tags: [], comments_enabled: 1 },
      expectedPostRevision: cur.post.revision,
      expectedDraftRevision: 0,
    },
  });
  assert.equal(saved.status(), 200, await saved.text());
  const ident = (await saved.json()).identity;
  const pub = await page.request.post(server.base + "/api/admin/posts/" + id + "/publish", {
    data: { publishRequestId: "vr-" + Math.random().toString(36).slice(2, 10), expectedPostRevision: ident.baseRevision, expectedDraftRevision: ident.draftRevision, slug: "version-restore" },
  });
  assert.equal(pub.status(), 200, await pub.text());

  // 打开编辑器，恢复第一版为草稿
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.locator("button", { hasText: "版本历史" }).click();
  await page.locator("button", { hasText: "恢复为草稿" }).first().click();
  await page.waitForTimeout(1800);

  // 恢复后继续打字：自动保存必须成功
  await page.fill('input[placeholder="文章标题"]', "恢复之后继续写");
  await page.waitForTimeout(3200);

  const statusText = await page.locator(".save-status").innerText();
  assert.ok(!/冲突/.test(statusText), "恢复历史后继续编辑不得冲突，实际：" + statusText);
  const draft = await (await page.request.get(server.base + "/api/admin/posts/" + id + "/draft")).json();
  assert.ok(draft.draft, "恢复后应能继续保存草稿");
});

/* ------------------------------- 辅助 ------------------------------- */

async function createDraft(page, { title, slug, publish = false }) {
  const res = await page.request.post(server.base + "/api/admin/posts", {
    data: {
      type: "post", title, slug, content: title + " 的正文",
      categories: [], tags: [], comments_enabled: 1,
      ...(publish ? { status: "published" } : {}),
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

/* ------------------------------- 运行 ------------------------------- */

try {
  server = await startIsolatedServer({ label: "editor-publish" });
  controller = await startBrowser();

  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log("PASS editor-publish: " + t.name);
      passed += 1;
    } catch (e) {
      failures.push({ name: t.name, message: e.message });
      console.error("FAIL editor-publish: " + t.name + "\n  " + e.message);
    }
  }
  console.log(passed + "/" + tests.length + " 通过");
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    console.log("All editor publish regressions passed.");
  }
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
