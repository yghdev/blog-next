/**
 * 阶段 02 · 侧栏分组导航与概览页。
 *
 * 只断言"结构和可达性"，不做审美判断。核心几条：
 *   1. 四组导航都存在，且分组标题不参与导航语义（aria-hidden）
 *   2. 「写文章」常驻：桌面顶栏可见，手机端移进抽屉顶部
 *   3. 抽屉里分组有层次，且每项热区 >= 48（移动端门禁）
 *   4. 概览页在窄屏无横向溢出，且每个 KPI 可点进去
 *   5. 概览页的空状态必须给出口（没有待办时也要能继续走）
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

  /* ---------------- 桌面顶栏：四组项都在 + 写文章常驻 ---------------- */
  const navLabels = await page.locator(".admin-nav a").evaluateAll((els) =>
    els.map((e) => (e.textContent || "").trim())
  );
  for (const want of ["概览", "文章", "评论", "回收站", "媒体", "外链", "存储", "日志", "设置"]) {
    assert.ok(navLabels.includes(want), "顶栏缺少导航项：" + want + " 实际=" + JSON.stringify(navLabels));
  }
  const composeVisible = await page.locator(".admin-compose").isVisible();
  assert.ok(composeVisible, "桌面顶栏应有常驻「写文章」主操作");
  console.log("PASS phase02: 顶栏含 9 个导航项 + 常驻写文章（" + navLabels.length + " 项）");

  /* ---------------- 概览页 KPI 全部可点 ---------------- */
  const kpis = await page.locator(".kpi-card").evaluateAll((els) =>
    els.map((e) => ({ tag: e.tagName, href: e.getAttribute("href") }))
  );
  assert.ok(kpis.length >= 4, "概览页应有至少 4 个 KPI，实际 " + kpis.length);
  for (const k of kpis) {
    assert.equal(k.tag, "A", "每个 KPI 都应可点进对应筛选");
    assert.ok(k.href && k.href.startsWith("/admin"), "KPI 链接应指向后台： " + JSON.stringify(k));
  }
  console.log("PASS phase02: 概览 KPI 全部可点（" + kpis.length + " 个）");

  /* ---------------- 窄屏：无横向溢出 ---------------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.sw <= overflow.cw + 1, "概览页 375px 横向溢出：" + JSON.stringify(overflow));
  console.log("PASS phase02: 概览页 375px 无横向溢出（" + overflow.sw + "/" + overflow.cw + "）");

  /* ---------------- 手机端：写文章移进抽屉 ---------------- */
  const composeHiddenOnMobile = await page.locator(".admin-compose").isHidden();
  assert.ok(composeHiddenOnMobile, "手机端顶栏不应再挤着「写文章」，应移进抽屉");

  await page.locator(".admin-menu-btn").click();
  await page.waitForTimeout(300);

  const sheetCompose = await page.locator(".admin-sheet-compose");
  assert.ok(await sheetCompose.isVisible(), "抽屉顶部应有整行「写文章」主操作");

  const groups = await page.locator(".sheet-nav-title").evaluateAll((els) =>
    els.map((e) => ({ text: (e.textContent || "").trim(), ariaHidden: e.getAttribute("aria-hidden") }))
  );
  const titles = groups.map((g) => g.text);
  assert.deepEqual(titles, ["工作", "内容", "资源", "系统"], "抽屉分组应为四组：实际 " + JSON.stringify(titles));
  assert.ok(groups.every((g) => g.ariaHidden === "true"),
    "分组标题只是视觉层次，不应进入读屏导航流（aria-hidden=true）");
  console.log("PASS phase02: 手机抽屉四组导航 + 常驻写文章（分组标题 aria-hidden）");

  /* ---------------- 抽屉内每项热区 >= 48 ---------------- */
  const small = await page.locator(".sheet-nav a").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { text: (e.textContent || "").trim(), h: Math.round(r.height) };
    }).filter((x) => x.h < 48)
  );
  assert.deepEqual(small, [], "抽屉导航项热区应 >= 48： " + JSON.stringify(small));
  console.log("PASS phase02: 抽屉导航项热区 >= 48");

  /* ---------------- 概览页空状态给出口 ---------------- */
  // 新库没有任何内容，此时必须出现可行动的空状态
  const emptyText = await page.locator(".empty-block").first().textContent().catch(() => null);
  assert.ok(emptyText && /没有|还没有/.test(emptyText), "空库时概览应给出空状态说明，实际=" + JSON.stringify(emptyText));
  const emptyAction = await page.locator(".empty-block a, .empty-actions a").first().isVisible();
  assert.ok(emptyAction, "空状态必须给一个可继续的动作出口");
  console.log("PASS phase02: 概览空状态有解释与出口");

  /* ---------------- 有数据时的渲染 ---------------- */
  // 用 API 造内容，再看概览是否真的把它们呈现出来（而不是只有空状态能用）
  // 注意：会话 cookie 是 httpOnly 的，读不到也不用读 —— page.request 会自动带上
  // 该 context 的 cookie jar，所以这里直接用它发请求即可。
  const { page: p2 } = await controller.newLoggedInContext(server.base, server.fixture);
  await p2.goto(server.base + "/admin/overview", { waitUntil: "networkidle" });
  const make = await p2.request.post(server.base + "/api/admin/posts", {
    data: { type: "post", title: "OVERVIEW_DRAFT", slug: "overview-draft", content: "x", status: "draft" },
  });
  assert.equal(make.status(), 200, await make.text());
  await p2.reload({ waitUntil: "networkidle" });

  const draftShown = await p2.locator(".overview-item-main").allTextContents();
  assert.ok(draftShown.some((t) => /OVERVIEW_DRAFT/.test(t)),
    "概览「未发布草稿」应列出新草稿，实际=" + JSON.stringify(draftShown));

  const draftKpi = await p2.locator(".kpi-card").first().textContent();
  assert.match(draftKpi || "", /1/, "未发布草稿 KPI 应显示 1，实际=" + JSON.stringify(draftKpi));
  console.log("PASS phase02: 有数据时概览正确呈现草稿与计数");

  console.log("All phase-02 nav/overview checks passed.");
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
