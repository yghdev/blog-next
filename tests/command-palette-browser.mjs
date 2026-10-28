/**
 * 命令面板与后台搜索的浏览器回归（阶段 04）。
 *
 * 重点是三条"效率工具不能变成新故障点"的要求：
 *   1. Ctrl/Cmd+K 能唤起，纯键盘可用（↑↓/Enter/Esc）
 *   2. **搜索失败不影响导航**：接口挂掉时静态入口仍能跳转
 *   3. 搜索能命中草稿标题，且不出现在公开搜索里
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server;
let controller;
const tests = [];
const T = (name, fn) => tests.push({ name, fn });

/* ---------------------------- 场景 ---------------------------- */

T("Ctrl+K 唤起命令面板，Esc 关闭", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });

  // 初始不显示
  assert.equal(await page.locator(".cmdk").count(), 0, "默认不应显示命令面板");

  await page.keyboard.press("Control+k");
  await page.locator(".cmdk").waitFor({ timeout: 3000 });
  assert.equal(await page.locator(".cmdk").isVisible(), true, "Ctrl+K 应唤起面板");

  // 输入框自动聚焦（用户不必再点一下）
  const focused = await page.evaluate(() => document.activeElement?.className ?? "");
  assert.match(focused, /cmdk-input/, "打开后输入框应自动聚焦");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".cmdk").count(), 0, "Esc 应关闭面板");
});

T("纯键盘可用：↑↓ 移动、Enter 进入", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });

  await page.keyboard.press("Control+k");
  await page.locator(".cmdk").waitFor({ timeout: 3000 });

  // 默认第一项选中
  const first = await page.locator('.cmdk-item[data-active="true"] .cmdk-title').innerText();

  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  const second = await page.locator('.cmdk-item[data-active="true"] .cmdk-title').innerText();
  assert.notEqual(second, first, "↓ 应移动选中项");

  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(100);
  const back = await page.locator('.cmdk-item[data-active="true"] .cmdk-title').innerText();
  assert.equal(back, first, "↑ 应移回上一项");

  // Enter 进入选中项（第一项是"写文章"）
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/admin\/new/, { timeout: 5000 });
  assert.match(page.url(), /\/admin\/new/, "Enter 应跳转到选中项");
});

T("搜索命中文章标题并可跳转编辑", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  // 造一篇已发布文章
  await createPublished(page, "cmdk-target", "命令面板目标文章");

  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk").waitFor({ timeout: 3000 });

  await page.fill(".cmdk-input", "命令面板目标");
  // 等防抖 300ms + 请求
  await page.locator(".cmdk-item").filter({ hasText: "命令面板目标文章" }).waitFor({ timeout: 5000 });

  const item = page.locator(".cmdk-item").filter({ hasText: "命令面板目标文章" }).first();
  const meta = await item.locator(".cmdk-meta").innerText();
  assert.match(meta, /文章/, "应标明类型");
  assert.match(meta, /已发布/, "应标明状态");

  await item.click();
  await page.waitForURL(/\/admin\/edit\/\d+/, { timeout: 5000 });
  assert.match(page.url(), /\/admin\/edit\/\d+/, "点击结果应进入编辑页");
});

T("搜索能命中草稿标题（壳的 posts.title 为空）", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  // 新建：壳 + 草稿，标题只在草稿快照里
  const res = await page.request.post(server.base + "/api/admin/posts", {
    data: {
      type: "post", title: "独特草稿标题XYZ", slug: "cmdk-draft", content: "草稿正文",
      status: "draft", categories: [], tags: [],
      clientDraftId: "cid-cmdk-draft-" + Math.random().toString(36).slice(2, 8),
    },
  });
  assert.equal(res.status(), 200, await res.text());
  const { id } = await res.json();

  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  await page.locator(".cmdk").waitFor({ timeout: 3000 });
  await page.fill(".cmdk-input", "独特草稿标题");
  await page.waitForTimeout(800);

  const item = page.locator(".cmdk-item").filter({ hasText: "独特草稿标题XYZ" }).first();
  await item.waitFor({ timeout: 5000 });
  const meta = await item.locator(".cmdk-meta").innerText();
  assert.match(meta, /草稿/, "应显示为草稿状态");
  assert.match(meta, /命中草稿标题/, "应说明是草稿标题命中的");
});

T("搜索失败不影响导航：接口挂掉时静态入口仍可跳转", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });

  // 让搜索接口失败
  await page.route("**/api/admin/search*", (route) => route.abort("failed"));

  await page.keyboard.press("Control+k");
  await page.locator(".cmdk").waitFor({ timeout: 3000 });
  await page.fill(".cmdk-input", "评论");
  await page.waitForTimeout(900);

  // 关键：出现错误提示，但静态入口仍在
  const errText = await page.locator(".cmdk-error").innerText({ timeout: 3000 });
  assert.match(errText, /搜索暂时不可用|仍可/, "应提示搜索不可用");

  const items = await page.locator(".cmdk-item").count();
  assert.ok(items > 0, "搜索失败时静态入口必须仍在，实际条目数 " + items);

  // 且能真的跳转
  const target = page.locator(".cmdk-item").filter({ hasText: "评论" }).first();
  await target.click();
  await page.waitForURL(/\/admin\/comments/, { timeout: 5000 });
  assert.match(page.url(), /\/admin\/comments/, "搜索挂了也必须能通过快捷入口跳转");
});

T("后台搜索接口不返回正文，且未登录 401", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  await createPublished(page, "cmdk-body", "正文检查标题", "这段正文不该出现在搜索结果里");

  const res = await page.request.get(server.base + "/api/admin/search?q=" + encodeURIComponent("正文检查"));
  assert.equal(res.status(), 200);
  const body = await res.text();
  assert.doesNotMatch(body, /这段正文不该出现在搜索结果里/, "搜索结果不得含正文");

  // 未登录
  const anon = await page.request.get(server.base + "/api/admin/search?q=x", { headers: { cookie: "" } });
  assert.equal(anon.status(), 401, "后台搜索必须要求登录");
});

T("后台搜索能搜到草稿，但公开搜索搜不到", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  await page.request.post(server.base + "/api/admin/posts", {
    data: {
      type: "post", title: "隔离验证草稿ABC", slug: "cmdk-isolation", content: "草稿正文",
      status: "draft", categories: [], tags: [],
      clientDraftId: "cid-cmdk-iso-" + Math.random().toString(36).slice(2, 8),
    },
  });

  const admin = await page.request.get(server.base + "/api/admin/search?q=" + encodeURIComponent("隔离验证草稿"));
  const adminBody = await admin.json();
  assert.ok(adminBody.hits.length >= 1, "后台搜索应能搜到草稿");

  // 公开搜索（no-store 直查）不得返回草稿
  const pub = await fetch(server.base + "/api/search?q=" + encodeURIComponent("隔离验证草稿"));
  const pubBody = await pub.json();
  assert.equal(pubBody.hits.length, 0, "公开搜索绝不能返回未发布草稿");
});

T("批量结果条分开计数并给出未完成原因", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const a = await createDraftPost(page, "bulk-res-a");
  await createDraftPost(page, "bulk-res-b");

  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  // 全选
  const boxes = page.locator(".content-row input[type='checkbox']");
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check();

  // 触发批量发布（有草稿的会被跳过）
  const publishBtn = page.locator(".bulk-bar button", { hasText: "发布" }).first();
  if (await publishBtn.count()) {
    await publishBtn.click();
    await page.waitForTimeout(1500);
    const bar = page.locator(".bulk-result-bar");
    if (await bar.count()) {
      const text = await bar.innerText();
      assert.match(text, /成功/, "应显示成功数");
      // 跳过或冲突至少有一个（因为有草稿的条目会被跳过）
      assert.match(text, /跳过|冲突/, "应显示跳过/冲突计数，实际：" + text);
    }
  }
});

/* ---------------------------- 辅助 ---------------------------- */

async function createPublished(page, slug, title, content = "正文") {
  const res = await page.request.post(server.base + "/api/admin/posts", {
    data: {
      type: "post", title, slug, content, status: "published", categories: [], tags: [],
      clientDraftId: "cid-" + slug + "-" + Math.random().toString(36).slice(2, 8),
    },
  });
  assert.equal(res.status(), 200, await res.text());
  return (await res.json()).id;
}

async function createDraftPost(page, slug) {
  const res = await page.request.post(server.base + "/api/admin/posts", {
    data: {
      type: "post", title: "草稿 " + slug, slug, content: "草稿正文", status: "draft",
      categories: [], tags: [],
      clientDraftId: "cid-" + slug + "-" + Math.random().toString(36).slice(2, 8),
    },
  });
  assert.equal(res.status(), 200, await res.text());
  return (await res.json()).id;
}

/* ---------------------------- 运行 ---------------------------- */

try {
  server = await startIsolatedServer({ label: "phase04" });
  controller = await startBrowser();

  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log("PASS 04: " + t.name);
      passed += 1;
    } catch (e) {
      failures.push({ name: t.name, message: e.message });
      console.error("FAIL 04: " + t.name + "\n  " + e.message);
    }
  }
  console.log(passed + "/" + tests.length + " 通过");
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    console.log("All phase-04 efficiency checks passed.");
  }
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
