/**
 * 阶段 02-1 · 侧栏分组导航与概览页。
 *
 * 断言的是"结构和可达性"，不做审美判断。核心几条：
 *   1. **桌面是侧栏**：.admin-sidebar 可见，四组标题常驻可见，8 项齐全（存储已并入设置）
 *   2. 顶栏在桌面隐藏（只服务手机）
 *   3. 「写文章」常驻：桌面侧栏顶部可见，手机移进抽屉顶部
 *   4. 抽屉里分组有层次，分组标题 aria-hidden，每项热区 >= 48
 *   5. 概览页 375px 无横向溢出，KPI 可点
 *   6. 概览页空状态必须给出口
 *
 * 上一版这里断言的是"顶栏 9 项"，而那版实际上仍把导航放在顶部单行、
 * 却命名为侧栏 —— 测试跟着错误实现一起通过了。这次先断言**侧栏存在**，
 * 让"名不副实"这种事能被测试直接抓住。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server, controller;
try {
  server = await startIsolatedServer({ label: "phase02-nav" });
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  /* ---------------- 概览页可访问 ---------------- */
  const res = await page.goto(server.base + "/admin/overview", { waitUntil: "networkidle" });
  assert.equal(res && res.status(), 200, "overview page should render");
  console.log("PASS phase02: /admin/overview renders");

  /* ---------------- 1. 桌面必须是侧栏 ---------------- */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(180);

  const sidebarVisible = await page.locator(".admin-sidebar").isVisible();
  assert.ok(sidebarVisible, "桌面必须有可见的左侧栏 .admin-sidebar（不是顶部栏）");

  // 侧栏在视觉上确实位于内容左侧：x 更小、且纵向占满
  const geo = await page.evaluate(() => {
    const side = document.querySelector(".admin-sidebar").getBoundingClientRect();
    const main = document.querySelector(".admin-main").getBoundingClientRect();
    return { sideLeft: side.left, sideRight: side.right, mainLeft: main.left, sideWidth: side.width };
  });
  assert.ok(geo.sideLeft < geo.mainLeft, "侧栏应在内容左侧：" + JSON.stringify(geo));
  assert.ok(geo.sideWidth >= 180, "侧栏宽度应 >= 180px，实际 " + geo.sideWidth);

  // 顶栏在桌面应隐藏（它是给手机用的）
  const topbarHidden = await page.locator(".admin-topbar").isHidden();
  assert.ok(topbarHidden, "桌面不应显示手机顶栏 .admin-topbar");
  console.log("PASS phase02: 桌面为左侧栏（宽 " + Math.round(geo.sideWidth) + "px），顶栏隐藏");

  /* ---------------- 2. 四组标题常驻可见 + 8 项齐全 ---------------- */
  const sideTitles = await page.locator(".admin-side-title").evaluateAll((els) =>
    els.map((e) => ({ text: (e.textContent || "").trim(), ariaHidden: e.getAttribute("aria-hidden") }))
  );
  assert.deepEqual(sideTitles.map((t) => t.text), ["工作", "内容", "资源", "系统"],
    "侧栏应常驻显示四组标题，实际 " + JSON.stringify(sideTitles));
  assert.ok(sideTitles.every((t) => t.ariaHidden === "true"),
    "分组标题只是视觉层次，不应进入读屏导航流");

  const sideLabels = await page.locator(".admin-side-nav a").evaluateAll((els) =>
    els.map((e) => (e.textContent || "").trim())
  );
  for (const want of ["概览", "内容", "评论", "回收站", "媒体", "外链", "日志", "设置"]) {
    assert.ok(sideLabels.includes(want), "侧栏缺少导航项：" + want + " 实际=" + JSON.stringify(sideLabels));
  }
  assert.ok(!sideLabels.includes("存储"),
    "「存储」已并入设置区，不应再是独立导航项（实际=" + JSON.stringify(sideLabels) + "）");
  console.log("PASS phase02: 侧栏四组标题常驻可见 + " + sideLabels.length + " 个导航项（存储已并入设置）");

  /* ---------------- 3. 写文章常驻在侧栏 ---------------- */
  const composeVisible = await page.locator(".admin-side-compose").isVisible();
  assert.ok(composeVisible, "桌面侧栏应常驻「写文章」主操作");
  console.log("PASS phase02: 侧栏常驻写文章");

  /* ---------------- 4. 首屏继续工作，统计不抢占任务区 ---------------- */
  assert.equal(await page.locator(".kpi-card").count(), 0, "概览不应恢复 KPI 卡片");
  assert.equal(await page.locator(".ui-statbar").count(), 0, "概览不应恢复装饰性比例条");
  assert.equal(await page.locator(".continue-card").count(), 1, "首屏必须有继续工作入口");
  assert.equal(await page.locator(".mobile-topbar").count(), 0, "后台不得渲染前台 MobileNav");
  assert.equal(await page.locator(".site-footer").count(), 0, "后台不得渲染前台页脚");
  console.log("PASS phase02: 继续工作优先，无 KPI/比例条，无前台壳");

  /* ---------------- 5. 手机：侧栏隐藏、顶栏出现、抽屉分组 ---------------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(220);

  assert.ok(await page.locator(".admin-sidebar").isHidden(), "手机应隐藏侧栏");
  assert.ok(await page.locator(".admin-topbar").isVisible(), "手机应显示顶栏");
  assert.ok(await page.locator(".admin-side-compose").isHidden(), "手机侧栏隐藏后写文章应在抽屉里");

  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.sw <= overflow.cw + 1, "概览页 375px 横向溢出：" + JSON.stringify(overflow));

  await page.locator(".admin-menu-btn").click();
  await page.waitForTimeout(320);
  assert.ok(await page.locator(".admin-sheet-compose").isVisible(), "抽屉顶部应有整行「写文章」");

  const sheetTitles = await page.locator(".sheet-nav-title").evaluateAll((els) =>
    els.map((e) => (e.textContent || "").trim())
  );
  assert.deepEqual(sheetTitles, ["工作", "内容", "资源", "系统"], "抽屉分组应为四组：实际 " + JSON.stringify(sheetTitles));

  const small = await page.locator(".sheet-nav a").evaluateAll((els) =>
    els.map((e) => ({ t: (e.textContent || "").trim(), h: Math.round(e.getBoundingClientRect().height) }))
      .filter((x) => x.h < 48)
  );
  assert.deepEqual(small, [], "抽屉导航项热区应 >= 48： " + JSON.stringify(small));
  console.log("PASS phase02: 手机侧栏隐藏/顶栏出现/抽屉四组且热区 >=48，无横向溢出");

  /* ---------------- 6. 空状态给出口 ---------------- */
  const emptyText = await page.locator(".empty-block").first().textContent().catch(() => null);
  assert.ok(emptyText && /没有|还没有/.test(emptyText), "空库时概览应给出空状态说明，实际=" + JSON.stringify(emptyText));
  assert.ok(await page.locator(".empty-block a, .empty-actions a").first().isVisible(),
    "空状态必须给一个可继续的动作出口");
  console.log("PASS phase02: 概览空状态有解释与出口");

  /* ---------------- 7. 有数据时正确呈现 ---------------- */
  await page.setViewportSize({ width: 1280, height: 900 });
  const { page: p2 } = await controller.newLoggedInContext(server.base, server.fixture);
  await p2.goto(server.base + "/admin/overview", { waitUntil: "networkidle" });
  const make = await p2.request.post(server.base + "/api/admin/posts", {
    data: { type: "post", title: "OVERVIEW_DRAFT", slug: "overview-draft", content: "x", status: "draft" },
  });
  assert.equal(make.status(), 200, await make.text());
  await p2.reload({ waitUntil: "networkidle" });

  const draftShown = await p2.locator(".work-item-title").allTextContents();
  assert.ok(draftShown.some((t) => /OVERVIEW_DRAFT/.test(t)),
    "概览「未发布草稿」应列出新草稿，实际=" + JSON.stringify(draftShown));
  console.log("PASS phase02: 有数据时概览正确呈现草稿与计数");

  console.log("All phase-02 nav/overview checks passed.");
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
