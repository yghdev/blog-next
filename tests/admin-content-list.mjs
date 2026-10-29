/**
 * 内容列表：拆页后的任务效率、筛选与批量行为。
 *
 * 本轮结构变化（2026-10-29）：文章 / 说说 / 页面拆成三条路由，
 * 回收站从 `?trash=1` 变成 /admin/trash。因此断言里**不再有类型下拉**：
 * 类型已经是路由，留着下拉等于让用户在「文章的页面」里筛出页面。
 *
 * 断言的是行为，不是观感：
 *   1. 三条列表各自只出现自己类型的内容，且状态计数与列表条数一致
 *   2. 状态筛选、搜索在三条路由里都能用，且能互相组合
 *   3. 批量操作条只在选中时出现，取消后消失
 *   4. 说说行显示正文而不是「(无标题)」，且**任何页面都不出现**「无标题」
 *   5. 375px 不横向溢出，首屏能看到真实内容
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server, controller;
try {
  server = await startIsolatedServer({ label: "phase02-rework-list" });
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  const make = (body) => page.request.post(server.base + "/api/admin/posts", { data: body });
  for (const body of [
    { type: "post", title: "PUB_A", slug: "pub-a", content: "x", status: "published" },
    { type: "post", title: "PUB_B", slug: "pub-b", content: "x", status: "published" },
    { type: "post", title: "DRAFT_A", slug: "draft-a", content: "x", status: "draft" },
    { type: "page", title: "PAGE_A", slug: "page-a", content: "x", status: "published" },
    { type: "shuoshuo", title: "", slug: "shuo-a", content: "今天风很大，但云很好看。", status: "published" },
    { type: "shuoshuo", title: "", slug: "shuo-b", content: "说说的草稿正文。", status: "draft" },
  ]) assert.equal((await make(body)).status(), 200);

  /* ---------------- 1. 三条路由各自只出自己的类型 ---------------- */
  const routes = [
    { path: "/admin", label: "文章", expect: ["PUB_A", "PUB_B", "DRAFT_A"], absent: ["PAGE_A", "今天风很大"] },
    { path: "/admin/shuoshuo", label: "说说", expect: ["今天风很大", "说说的草稿正文"], absent: ["PUB_A", "PAGE_A"] },
    { path: "/admin/pages", label: "页面", expect: ["PAGE_A"], absent: ["PUB_A", "今天风很大"] },
  ];
  for (const r of routes) {
    await page.goto(server.base + r.path, { waitUntil: "networkidle" });
    const labels = await page.locator(".content-row").evaluateAll((els) =>
      els.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
    );
    for (const want of r.expect) {
      assert.ok(labels.some((t) => t.includes(want)), r.label + " 列表缺少「" + want + "」： " + JSON.stringify(labels));
    }
    for (const no of r.absent) {
      assert.ok(!labels.some((t) => t.includes(no)), r.label + " 列表混入了「" + no + "」： " + JSON.stringify(labels));
    }
  }
  console.log("PASS split: 文章/说说/页面三条列表各自只包含自己的类型");

  /* ---------------- 2. 说说按正文显示，绝不出现「无标题」 ---------------- */
  await page.goto(server.base + "/admin/shuoshuo", { waitUntil: "networkidle" });
  assert.equal(await page.locator(".data-row.is-body").count(), 2, "说说应使用正文型行");
  const bodies = await page.locator(".shuo-text").allTextContents();
  assert.ok(bodies.some((t) => t.includes("今天风很大")), "说说正文应直接显示内容：" + JSON.stringify(bodies));
  const allText = await page.locator("body").innerText();
  assert.ok(!/无标题|未命名/.test(allText), "说说列表不得出现「无标题/未命名」占位：" + allText.slice(0, 300));
  assert.equal(await page.locator(".data-row.is-body .data-row-title").count(), 0, "正文型行不应再有标题元素");
  console.log("PASS split: 说说直接显示正文，无「无标题」占位");

  /* ---------------- 3. 状态筛选与计数 ---------------- */
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  assert.equal(await page.locator(".kpi-card").count(), 0, "内容页不重复 KPI 筛选");
  assert.equal(await page.locator(".content-toolbar .seg-tabs").count(), 1, "状态筛选只能出现一次");
  assert.equal(await page.locator(".content-toolbar .content-type-select").count(), 0,
    "类型已是路由，工具栏不应再有类型下拉");
  assert.equal(await page.locator(".bulk-bar").count(), 0, "未选择时不显示批量操作");

  const statusItems = await page.locator(".content-toolbar .seg-tabs a").evaluateAll((els) =>
    els.map((e) => ({ text: e.textContent || "", current: e.getAttribute("aria-current"), selected: e.getAttribute("aria-selected") }))
  );
  assert.equal(statusItems.filter((x) => x.current === "true").length, 1);
  assert.ok(statusItems.every((x) => x.selected === null), "状态切换用 aria-current，不挂 aria-selected");
  const draftTab = statusItems.find((x) => x.text.startsWith("草稿"));
  const draftCount = Number((draftTab.text.match(/(\d+)/) || [])[1]);
  await page.goto(server.base + "/admin?status=draft", { waitUntil: "networkidle" });
  assert.equal(await page.locator(".data-panel .data-row").count(), draftCount, "草稿计数必须与列表条数一致");
  console.log("PASS split: 状态筛选语义与计数正确（草稿 " + draftCount + " 条）");

  /* ---------------- 4. 搜索可以与状态组合，且说说按正文搜索 ---------------- */
  await page.goto(server.base + "/admin?status=draft", { waitUntil: "networkidle" });
  await page.fill(".content-search input", "DRAFT_A");
  await Promise.all([page.waitForURL(/q=DRAFT_A/), page.locator(".content-tools button[type='submit']").click()]);
  assert.equal(await page.locator(".data-panel .data-row").count(), 1);
  assert.match(page.url(), /status=draft/, "搜索必须保留当前状态筛选");

  await page.goto(server.base + "/admin/shuoshuo?q=" + encodeURIComponent("风很大"), { waitUntil: "networkidle" });
  assert.equal(await page.locator(".data-panel .data-row").count(), 1, "说说应支持按正文搜索");
  console.log("PASS split: 搜索与状态组合正确；说说按正文可搜");

  /* ---------------- 5. 批量操作是上下文相关的 ---------------- */
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  await page.locator(".content-row input[type='checkbox']").first().check();
  assert.ok(await page.locator(".bulk-bar").isVisible(), "选择后批量操作条出现");
  await page.locator(".bulk-bar .btn-ghost").click();
  assert.equal(await page.locator(".bulk-bar").count(), 0, "取消选择后操作条消失");
  console.log("PASS split: 批量操作条条件出现");

  /* ---------------- 6. 回收站独立成页 ---------------- */
  // 先删一条说说，回收站里才既有文章又有说说
  const shuoList = await page.request.get(server.base + "/api/admin/posts?type=shuoshuo");
  const shuoRow = (await shuoList.json()).rows?.[0];
  assert.ok(shuoRow, "夹具里应有一条说说用于回收站断言");
  const delRes = await page.request.delete(server.base + "/api/admin/posts/" + shuoRow.id, {
    data: { expectedRevision: shuoRow.revision },
  });
  assert.equal(delRes.status(), 200, await delRes.text());
  const tr = await page.goto(server.base + "/admin/trash", { waitUntil: "networkidle" });
  assert.equal(tr.status(), 200, "/admin/trash 应可直接访问");
  assert.equal(await page.locator(".content-toolbar .seg-tabs").count(), 0, "回收站没有发布状态分段");
  /**
   * 回收站里的每条都是「已删除」。说说行如果沿用发布状态，会显示「已发布」——
   * 那等于告诉用户这条还在线上。这条断言就是钉住这个歧义。
   */
  const trashStates = await page.locator(".data-row .fx-state").allTextContents();
  assert.ok(trashStates.every((t) => t.trim() === "已删除"),
    "回收站每行状态都应是「已删除」，实际 " + JSON.stringify(trashStates));
  // 回收站类型混杂，说说仍按正文型行渲染（否则又会退化成一段带标题痕迹的行）
  const trashBodyRows = await page.locator(".data-row.is-body").count();
  assert.ok(trashBodyRows >= 1, "回收站里的说说应按正文型行渲染，实际 " + trashBodyRows);
  console.log("PASS split: 回收站独立成页、无状态分段、每行都是「已删除」、说说仍为正文行");

  /* ---------------- 7. 375px 无溢出且首屏可见内容 ---------------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(server.base + "/admin/shuoshuo", { waitUntil: "networkidle" });
  const layout = await page.evaluate(() => {
    const first = document.querySelector(".content-row").getBoundingClientRect();
    const search = document.querySelector(".content-search input").getBoundingClientRect();
    return {
      firstTop: first.top, searchWidth: search.width,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    };
  });
  assert.ok(layout.firstTop < 500, "375px 首屏必须尽早看到真实内容: " + JSON.stringify(layout));
  assert.ok(layout.searchWidth > 60, "375px 搜索框必须可用: " + JSON.stringify(layout));
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, "375px 不得横向溢出: " + JSON.stringify(layout));
  console.log("PASS split: 手机端首屏可见内容、搜索可用、无横向溢出");

  console.log("All content list checks passed.");
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
