/** 阶段 02-R：内容列表的任务效率、筛选与批量行为。 */
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
  ]) assert.equal((await make(body)).status(), 200);
  await page.reload({ waitUntil: "networkidle" });

  assert.equal(await page.locator(".kpi-card").count(), 0, "内容页不重复 KPI 筛选");
  assert.equal(await page.locator(".content-toolbar .seg-tabs").count(), 1, "状态筛选只能出现一次");
  assert.equal(await page.locator(".content-toolbar a[href='/admin?trash=1']").count(), 0, "工具条不重复回收站入口");
  assert.equal(await page.locator(".bulk-bar").count(), 0, "未选择时不显示批量操作");
  assert.equal(await page.locator(".mobile-topbar").count(), 0, "后台不得混入前台顶栏");
  console.log("PASS rework: no duplicate filters, chrome or persistent bulk buttons");

  const statusItems = await page.locator(".content-toolbar .seg-tabs a").evaluateAll((els) => els.map((e) => ({ text: e.textContent || "", current: e.getAttribute("aria-current"), selected: e.getAttribute("aria-selected") })));
  assert.equal(statusItems.filter((x) => x.current === "true").length, 1);
  assert.ok(statusItems.every((x) => x.selected === null));
  const draftTab = statusItems.find((x) => x.text.startsWith("草稿"));
  const draftCount = Number((draftTab.text.match(/(\d+)/) || [])[1]);
  await page.goto(server.base + "/admin?status=draft", { waitUntil: "networkidle" });
  assert.equal(await page.locator(".data-panel .data-row").count(), draftCount);
  console.log("PASS rework: status filter semantics and count remain correct");

  await page.selectOption(".content-type-select select", "post");
  await Promise.all([page.waitForURL(/type=post/), page.locator(".content-tools button[type='submit']").click()]);
  assert.match(page.url(), /status=draft/);
  await page.fill(".content-search input", "DRAFT_A");
  await Promise.all([page.waitForURL(/q=DRAFT_A/), page.locator(".content-tools button[type='submit']").click()]);
  assert.equal(await page.locator(".data-panel .data-row").count(), 1);
  console.log("PASS rework: type and search compose with current status");

  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  await page.locator(".content-row input[type='checkbox']").first().check();
  assert.ok(await page.locator(".bulk-bar").isVisible(), "选择后批量操作条出现");
  await page.locator(".bulk-bar .btn-ghost").click();
  assert.equal(await page.locator(".bulk-bar").count(), 0, "取消选择后操作条消失");
  console.log("PASS rework: bulk actions are contextual");

  await page.goto(server.base + "/admin?status=draft&type=shuoshuo", { waitUntil: "networkidle" });
  assert.ok(await page.locator(".empty-block a").first().isVisible());
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  const layout = await page.evaluate(() => {
    const first = document.querySelector(".content-row").getBoundingClientRect();
    const search = document.querySelector(".content-search input").getBoundingClientRect();
    const type = document.querySelector(".content-type-select select").getBoundingClientRect();
    return { firstTop: first.top, searchWidth: search.width, typeWidth: type.width, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
  assert.ok(layout.firstTop < 450, "首屏必须尽早看到真实内容: " + JSON.stringify(layout));
  assert.ok(layout.searchWidth > 60 && layout.typeWidth > 60, "375px 搜索和类型筛选必须可见可用: " + JSON.stringify(layout));
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, "375px 不得横向溢出");
  console.log("PASS rework: mobile content appears by " + Math.round(layout.firstTop) + "px; filters visible; no overflow");

  console.log("All content rework checks passed.");
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
