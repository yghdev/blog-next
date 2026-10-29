/**
 * 写作工作台（Editorial Studio）改版的浏览器回归。
 *
 * 这一版改的是**壳**：操作条、工具栏分组、右侧设置栏、编辑/分屏/预览、专注模式。
 * 因此这里不再重复"发布是否真的发布"（tests/editor-publish-regression.mjs 已覆盖），
 * 只盯住改版最容易破坏的六件事：
 *
 *   1. 页面只有一层操作条，文章标题是最大的字 —— 不能被第二个人造大标题压下去
 *   2. 工具栏分组齐全、每个按钮都有可读名称，且键盘能走到
 *   3. 切换 编辑 → 分屏 → 预览 不销毁 textarea（光标/选区/撤销栈必须还在）
 *   4. 专注模式：侧栏与右栏消失，正文与保存流程不变，Esc 能退出
 *   5. 分类/标签是自动补全的芯片，新建与删除都会写进草稿
 *   6. 自定义摘要能保存、发布后进 posts.excerpt，重新打开还在；375px 无横向溢出
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server;
let controller;

const T = (name, fn) => { tests.push({ name, fn }); };
const tests = [];

/* ---------------------------- 用例 ---------------------------- */

T("布局：只有一层操作条，中央编辑区是视觉主体", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "工作台布局", slug: "workbench-layout" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });

  // 没有 PageHeader 的第二个大标题
  assert.equal(await page.locator(".page-head h1").count(), 0, "编辑页不应再渲染 PageHeader 大标题");
  assert.equal(await page.locator(".editor-chrome").count(), 1, "操作条只能有一条");

  // 标题输入是页面上字号最大的文本输入
  const size = await page.locator(".editor-title-input").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(size >= 28, "文章标题字号应显著大于正文，实际 " + size + "px");

  // 正文列有上限，但会随视口收缩
  const col = await page.locator(".editor-article").evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(col > 520 && col <= 821, "正文列宽度应在 520–820 之间，实际 " + col);

  // 右栏三组标题齐全
  const groups = await page.locator(".editor-group-title").allInnerTexts();
  for (const want of ["内容归档", "封面与摘要", "发布选项"]) {
    assert.ok(groups.some((g) => g.includes(want)), "右栏缺少分组「" + want + "」，实际 " + JSON.stringify(groups));
  }

  // 操作条里的主操作唯一：发布（btn-primary）
  const primaries = await page.locator(".editor-chrome .btn-primary").count();
  assert.equal(primaries, 1, "操作条里只能有一个主按钮（发布）");
});

T("工具栏：分组齐全、名称可读、键盘可达", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "工具栏", slug: "workbench-toolbar" });
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });

  const groupNames = await page.locator(".editor-tool-group").evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label") || "")
  );
  assert.deepEqual(groupNames, ["文本格式", "内容结构", "插入内容"], "工具栏分组不符：" + JSON.stringify(groupNames));

  const labels = await page.locator(".editor-tool").evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label") || "")
  );
  for (const want of ["二级标题", "粗体", "行内代码", "引用", "无序列表", "分隔线", "链接", "表格", "上传", "媒体库", "外链视频"]) {
    assert.ok(labels.some((l) => l.includes(want)), "工具栏缺少「" + want + "」，实际 " + JSON.stringify(labels));
  }

  // 用键盘走到第一个工具并回车：插入语法，且焦点回到 textarea
  await page.locator(".editor-tool").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  const active = await page.evaluate(() => document.activeElement?.className || "");
  assert.match(active, /editor-textarea/, "插入后焦点应回到正文，实际 " + active);
  assert.match(await page.locator(".editor-textarea").inputValue(), /## /, "H2 按钮应插入 ## ");
});

T("模式切换：编辑 / 分屏 / 预览 不销毁编辑器（光标与选区仍在）", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "模式切换", slug: "workbench-modes" });
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });

  const ta = page.locator(".editor-textarea");
  await ta.click();
  await ta.fill("第一段\n\n第二段");
  // 把光标放到第 3 个字符，并选中 2 个字符
  await ta.evaluate((el) => { el.focus(); el.setSelectionRange(3, 5); });

  await page.locator(".editor-view-btn", { hasText: "分屏" }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".editor-preview-pane").count(), 1, "分屏应出现预览面板");
  assert.equal(await ta.count(), 1, "分屏时 textarea 必须还在");
  assert.equal(await ta.isVisible(), true, "分屏时编辑区仍然可见");

  await page.locator(".editor-view-btn", { hasText: "预览" }).click();
  // 预览是 320ms 防抖 + 一次 /api/preview，不能只等固定时长
  await page.locator(".editor-preview p").first().waitFor({ timeout: 8000 });
  assert.equal(await ta.count(), 1, "预览时 textarea 只能隐藏，不能卸载（否则撤销栈丢失）");
  assert.equal(await ta.isVisible(), false, "预览时编辑区应隐藏");
  const html = await page.locator(".editor-preview").innerHTML();
  assert.match(html, /<p>/, "预览应渲染出 Markdown 段落");
  assert.match(html, /第二段/, "预览内容应来自当前正文");

  await page.locator(".editor-view-btn", { hasText: "编辑" }).click();
  await page.waitForTimeout(300);
  const sel = await ta.evaluate((el) => [el.selectionStart, el.selectionEnd]);
  assert.deepEqual(sel, [3, 5], "切回编辑后选区应保持，实际 " + JSON.stringify(sel));
  assert.equal(await ta.inputValue(), "第一段\n\n第二段", "正文不得因切换模式被改动");

  // 窄屏自动单栏：分屏按钮不应把正文挤成两半
  await page.setViewportSize({ width: 900, height: 800 });
  await page.locator(".editor-view-btn", { hasText: "分屏" }).click();
  await page.waitForTimeout(400);
  const cols = await page.locator(".editor-sheet").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  assert.equal(cols, 1, "窄屏分屏应落成单栏，实际列数 " + cols);
});

T("分屏：两侧各自滚动且按比例同步", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const long = Array.from({ length: 30 }, (_, i) => "### 小节 " + (i + 1) + "\n\n这是第 " + (i + 1) + " 段正文，用来制造足够的滚动高度。").join("\n\n");
  const id = await createDraft(page, { title: "滚动同步", slug: "workbench-scroll", content: long });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });
  await page.locator(".editor-view-btn", { hasText: "分屏" }).click();
  await page.locator(".editor-preview p").first().waitFor({ timeout: 8000 });

  // 把编辑区滚到一半
  await page.locator(".editor-textarea").evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; el.dispatchEvent(new Event("scroll")); });
  await page.waitForTimeout(300);
  const ratio = await page.evaluate(() => {
    const ta = document.querySelector(".editor-textarea");
    const pv = document.querySelector(".editor-preview-pane");
    const r = (el) => (el.scrollHeight - el.clientHeight) > 0 ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
    return { ta: r(ta), pv: r(pv), taScrollable: ta.scrollHeight > ta.clientHeight, pvScrollable: pv.scrollHeight > pv.clientHeight };
  });
  assert.equal(ratio.taScrollable, true, "长文分屏时编辑区应可滚动");
  assert.equal(ratio.pvScrollable, true, "长文分屏时预览应可滚动");
  assert.ok(Math.abs(ratio.ta - ratio.pv) < 0.12, "两侧滚动比例应大致同步，实际 " + JSON.stringify(ratio));
});

T("专注模式：隐藏侧栏与右栏，Esc 退出，正文与保存不受影响", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "专注模式", slug: "workbench-focus" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });

  await page.locator(".editor-textarea").fill("专注模式下写的正文");
  await page.locator('button[aria-label="专注写作模式"]').click();
  await page.waitForTimeout(300);

  assert.equal(await page.locator(".admin-sidebar").isVisible(), false, "专注模式应隐藏左侧导航");
  assert.equal(await page.locator(".editor-rail").isVisible(), false, "专注模式应隐藏右侧设置栏");
  assert.equal(await page.locator(".editor-title-input").isVisible(), true, "标题必须保留");
  assert.equal(await page.locator(".editor-toolbar").isVisible(), true, "工具栏必须保留");
  assert.equal(await page.locator(".editor-textarea").isVisible(), true, "正文必须保留");
  assert.equal(await page.locator(".editor-btn-publish").isVisible(), true, "发布入口必须保留");

  // 退出入口在顶栏，且 Esc 同样可用
  await page.locator('button[aria-label^="退出专注模式"]').waitFor({ timeout: 3000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".admin-sidebar").isVisible(), true, "Esc 应恢复正常布局");
  assert.equal(await page.locator(".editor-textarea").inputValue(), "专注模式下写的正文", "退出专注不得清空正文");

  // 保存流程照旧：等自动保存落地
  await page.waitForTimeout(2600);
  const draft = await getDraft(page, id);
  assert.equal(draft.snapshot.content, "专注模式下写的正文", "专注模式中的改动应正常进草稿");
});

T("分类与标签：芯片可新建、可删除，并写入草稿", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, { title: "归档字段", slug: "workbench-taxonomy" });
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });

  const catInput = page.locator("#editor-cats");
  await catInput.click();
  await catInput.fill("临时分类");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#editor-cats").count(), 1, "创建后输入框应清空并继续可用");
  const catTokens = await page.locator(".editor-token").allInnerTexts();
  assert.ok(catTokens.some((t) => t.includes("临时分类")), "分类芯片应出现，实际 " + JSON.stringify(catTokens));

  const tagInput = page.locator("#editor-tags");
  await tagInput.click();
  await tagInput.fill("临时标签");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);

  // 删除：点芯片上的 ×
  await page.locator('.editor-token button[aria-label="移除分类 临时分类"]').click();
  await page.waitForTimeout(150);
  const afterRemove = await page.locator(".editor-token").allInnerTexts();
  assert.ok(!afterRemove.some((t) => t.includes("临时分类")), "删除后分类芯片应消失");

  await page.waitForTimeout(2600);
  const draft = await getDraft(page, id);
  assert.deepEqual(draft.snapshot.categories, [], "草稿分类应为空数组，实际 " + JSON.stringify(draft.snapshot.categories));
  assert.deepEqual(draft.snapshot.tags, ["临时标签"], "草稿标签应包含新建项，实际 " + JSON.stringify(draft.snapshot.tags));
});

T("摘要：自定义摘要进草稿、发布进 posts.excerpt，重开仍在；375px 无溢出", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const id = await createDraft(page, {
    title: "摘要字段", slug: "workbench-excerpt",
    content: "## 小标题\n\n这是正文的第一段，自动摘要会取到它。",
  });
  await page.goto(server.base + "/admin/edit/" + id, { waitUntil: "networkidle" });

  const excerpt = page.locator("#editor-excerpt");
  await excerpt.fill("这是手写摘要");
  await page.waitForTimeout(2600);

  let draft = await getDraft(page, id);
  assert.equal(draft.snapshot.excerpt, "这是手写摘要", "草稿快照应包含自定义摘要");

  await page.locator(".editor-btn-publish").click();
  await page.waitForTimeout(2800);
  const post = await getPost(page, id);
  assert.equal(post.post.status, "published", "应已发布");
  assert.equal(post.post.excerpt, "这是手写摘要", "发布后 posts.excerpt 应是自定义摘要，实际 " + post.post.excerpt);

  // 重新打开：摘要框要带出用户写过的内容，而不是自动截取
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator("#editor-excerpt").inputValue(), "这是手写摘要", "重开应恢复自定义摘要");

  // 375px：无横向溢出，发布入口在贴底操作条里
  await page.setViewportSize({ width: 375, height: 780 });
  await page.waitForTimeout(400);
  const of = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  assert.ok(of.sw <= of.cw + 1, "375px 不得横向溢出：" + JSON.stringify(of));
  assert.equal(await page.locator(".editor-mobile-actions").isVisible(), true, "手机上应出现贴底操作条");
});

/* ---------------------------- 辅助 ---------------------------- */

async function createDraft(page, { title, slug, content = "" }) {
  const res = await page.request.post(server.base + "/api/admin/posts", {
    data: { type: "post", title, slug, content, categories: [], tags: [], comments_enabled: 1 },
  });
  const body = await res.json();
  assert.equal(res.status(), 200, JSON.stringify(body));
  return body.id;
}

async function getDraft(page, id) {
  const res = await page.request.get(server.base + "/api/admin/posts/" + id + "/draft");
  const body = await res.json();
  assert.ok(body.draft, "应存在服务端草稿");
  return body.draft;
}

async function getPost(page, id) {
  const res = await page.request.get(server.base + "/api/admin/posts/" + id);
  assert.equal(res.status(), 200, await res.text());
  return res.json();
}

/* ---------------------------- 运行 ---------------------------- */

try {
  server = await startIsolatedServer({ label: "editor-workbench" });
  controller = await startBrowser();

  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log("PASS: " + t.name);
      passed += 1;
    } catch (e) {
      failures.push({ name: t.name, message: e.message });
      console.error("FAIL: " + t.name + "\n  " + e.message);
    }
  }
  console.log(passed + "/" + tests.length + " 通过");
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    console.log("All editor workbench checks passed.");
  }
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
