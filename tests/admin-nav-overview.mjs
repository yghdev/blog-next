/**
 * 阶段 02-1 · 侧栏分组导航与概览页。
 *
 * 断言的是"结构和可达性"，不做审美判断。核心几条：
 *   1. **桌面是侧栏**：.admin-sidebar 可见，四组标题常驻可见，10 项齐全（内容拆成文章/说说/页面，存储已并入设置）
 *   2. 顶栏在桌面隐藏（只服务手机）
 *   3. 「写文章」常驻：桌面侧栏顶部可见，手机移进抽屉顶部
 *   4. 组头是折叠开关：button + aria-expanded + aria-controls，收起后面板高度 0 且 inert，
 *      收起状态写 cookie 且跨刷新保留（侧栏与抽屉同一套状态，首帧即最终状态）
 *   5. 抽屉里分组有层次，组头热区 >= 48，导航项热区 >= 48
 *   6. 概览页 375px 无横向溢出，KPI 可点
 *   7. 概览页空状态必须给出口
 *
 * 上一版这里断言的是"顶栏 9 项"，而那版实际上仍把导航放在顶部单行、
 * 却命名为侧栏 —— 测试跟着错误实现一起通过了。这次先断言**侧栏存在**，
 * 让"名不副实"这种事能被测试直接抓住。
 *
 * 2026-10-29 导航改版：分组从"不可交互的装饰性小字"变成可折叠章节按钮。
 * 断言随之从 aria-hidden 改为 aria-expanded —— 组头现在控制内容可见性，
 * 读屏必须能读到它；继续断言 aria-hidden 会把可访问性缺陷固化成契约。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";
import { contrastFromLayers } from "./helpers/contrast.mjs";

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
    els.map((e) => (e.textContent || "").trim())
  );
  // 分组名按本轮设计规范：工作台 / 内容 / 资源 / 系统。
  // 「日志」从「资源」移到「系统」（它是运维排查，不是资源配置）。
  assert.deepEqual(sideTitles, ["工作台", "内容", "资源", "系统"],
    "侧栏应常驻显示四组标题，实际 " + JSON.stringify(sideTitles));

  // 组头是折叠开关：必须是 <button aria-expanded>，不能只是装饰性小字。
  // 先前这里断言 aria-hidden="true"（组头是纯视觉标签），改成可折叠后语义变了：
  // 它现在是控制正文可见性的控件，读屏必须能读到。
  const toggles = await page.locator(".admin-side-group-toggle").evaluateAll((els) =>
    els.map((e) => ({
      tag: e.tagName,
      expanded: e.getAttribute("aria-expanded"),
      controls: e.getAttribute("aria-controls"),
      hasPanel: !!document.getElementById(e.getAttribute("aria-controls") || ""),
    }))
  );
  assert.equal(toggles.length, 4, "侧栏应有 4 个可折叠组头，实际 " + JSON.stringify(toggles));
  assert.ok(toggles.every((t) => t.tag === "BUTTON"), "组头必须是 button（可聚焦、可回车）：" + JSON.stringify(toggles));
  assert.ok(toggles.every((t) => t.expanded === "true"), "默认应全部展开：" + JSON.stringify(toggles));
  assert.ok(toggles.every((t) => t.controls && t.hasPanel), "aria-controls 必须指向真实存在的面板：" + JSON.stringify(toggles));

  const sideLabels = await page.locator(".admin-side-nav a").evaluateAll((els) =>
    els.map((e) => (e.textContent || "").trim())
  );
  // 2026-10-29：内容拆成「文章 / 说说 / 页面」三项。
  // 菜单项不能再叫「内容」—— 分组标题已经叫「内容」，会与分组语义打架；
  // 名称必须说清这一页管的是什么。
  for (const want of ["概览", "文章", "说说", "页面", "评论", "回收站", "媒体", "外链", "日志", "设置"]) {
    assert.ok(sideLabels.includes(want), "侧栏缺少导航项：" + want + " 实际=" + JSON.stringify(sideLabels));
  }
  assert.ok(!sideLabels.includes("存储"),
    "「存储」已并入设置区，不应再是独立导航项（实际=" + JSON.stringify(sideLabels) + "）");
  assert.equal(sideLabels.length, 10, "侧栏应恰好 10 个导航项（文章/说说/页面已拆开，存储已并入设置），实际=" + JSON.stringify(sideLabels));

  // 当前页（概览 / 工作台组）必须可见；折叠永远不能把「我在哪」藏起来
  assert.ok(await page.locator(".admin-side-nav a.is-active").isVisible(), "当前页所在组必须展开，选中项应可见");

  /* ---------------- 2a. 组头「不像装饰」：字号与对比度都要够读 ---------------- */
  // 这次改版的起因就是组头「字号较小且颜色偏淡」。审美不能自动判定，
  // 但「12px 起」和「AA 4.5:1」是可判定的下限，先钉住，避免下次改回去。
  const headStyle = await page.evaluate(() => {
    const el = document.querySelector(".admin-side-title");
    const layers = [];
    let cur = el;
    while (cur) {
      const bg = getComputedStyle(cur).backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)/.test(bg)) layers.push(bg);
      cur = cur.parentElement;
    }
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    if (bodyBg && !/rgba\(0, 0, 0, 0\)/.test(bodyBg)) layers.push(bodyBg);
    return { size: parseFloat(getComputedStyle(el).fontSize), weight: getComputedStyle(el).fontWeight, color: getComputedStyle(el).color, layers };
  });
  assert.ok(headStyle.size >= 12, "组头字号应 >= 12px（旧版 11px 过小），实际 " + headStyle.size);
  assert.ok(Number(headStyle.weight) >= 600, "组头应加粗到 600，实际 " + headStyle.weight);

  // 四组都要过：当前组的颜色比非当前组深，只测一组会漏掉「其它组仍然偏淡」的回归
  const headSamples = await page.evaluate(() => {
    const lay = (el) => {
      const layers = [];
      let cur = el;
      while (cur) {
        const bg = getComputedStyle(cur).backgroundColor;
        if (bg && !/rgba\(0, 0, 0, 0\)/.test(bg)) layers.push(bg);
        cur = cur.parentElement;
      }
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      if (bodyBg && !/rgba\(0, 0, 0, 0\)/.test(bodyBg)) layers.push(bodyBg);
      return { text: (el.textContent || "").trim(), color: getComputedStyle(el).color, layers };
    };
    return Array.from(document.querySelectorAll(".admin-side-title")).map(lay);
  });
  const headRatios = headSamples.map((s) => ({ text: s.text, ratio: contrastFromLayers(s.color, s.layers) }));
  const lowHead = headRatios.filter((h) => h.ratio === null || h.ratio < 4.5);
  assert.deepEqual(lowHead, [], "组头文字对底色应全部达 AA 4.5:1：" + JSON.stringify(headRatios));
  const headRatio = Math.min(...headRatios.map((h) => h.ratio));

  // 子项缩进必须大于组头缩进：层级靠缩进与导轨区分，而不是靠字号差
  const indent = await page.evaluate(() => {
    const head = document.querySelector(".admin-side-group-toggle");
    const link = document.querySelector(".admin-side-group-links a");
    return {
      head: Math.round(head.getBoundingClientRect().left + parseFloat(getComputedStyle(head).paddingLeft)),
      link: Math.round(link.getBoundingClientRect().left + parseFloat(getComputedStyle(link).paddingLeft)),
    };
  });
  assert.ok(indent.link > indent.head, "子项文字应缩进到组头右侧：" + JSON.stringify(indent));
  console.log("PASS phase02: 侧栏四组可折叠标题 + " + sideLabels.length + " 个导航项（存储已并入设置），组头 " + headStyle.size + "px/" + headStyle.weight + " 对比度 " + headRatio.toFixed(2) + ":1");

  /* ---------------- 2b. 折叠 → 持久化 → 展开 ---------------- */
  const contentToggle = page.locator(".admin-side-group[data-key='content'] .admin-side-group-toggle");
  await contentToggle.click();
  await page.waitForTimeout(280); // 等 grid-template-rows 过渡结束
  assert.equal(await contentToggle.getAttribute("aria-expanded"), "false", "点组头后应变为收起");
  const contentPanel = await page.locator(".admin-side-group[data-key='content'] .admin-side-group-body").evaluate((el) => ({
    h: Math.round(el.getBoundingClientRect().height),
    inert: el.hasAttribute("inert"),
  }));
  assert.equal(contentPanel.h, 0, "收起后该组面板高度应为 0，实际=" + JSON.stringify(contentPanel));
  assert.equal(contentPanel.inert, true, "收起后该组内容应加 inert（键盘与读屏都进不去），实际=" + JSON.stringify(contentPanel));
  // 偏好写 cookie 而不是 localStorage：服务端要能在首帧读出它，
  // 否则导航瞬间会先"全部展开"再自己合上（实测 80–90ms 的闪烁）。
  const stored = await page.evaluate(() => document.cookie);
  assert.match(stored, /admin_nav_collapsed=content/, "收起状态应写入 cookie，实际 cookie=" + stored);
  assert.equal(await page.evaluate(() => window.localStorage.getItem("admin-nav-collapsed:v1")), null,
    "不应再往 localStorage 写折叠状态（首帧读不到，会造成闪烁）");

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".admin-side-group[data-key='content'] .admin-side-group-toggle").getAttribute("aria-expanded"), "false",
    "刷新后应保留收起状态");
  console.log("PASS phase02: 组可收起且状态跨刷新保留（cookie，服务端首帧生效）");

  // 展开回去，后面的断言在完整展开的侧栏上做
  await page.locator(".admin-side-group[data-key='content'] .admin-side-group-toggle").click();
  await page.waitForTimeout(280);
  assert.equal(await page.locator(".admin-side-group[data-key='content'] .admin-side-group-toggle").getAttribute("aria-expanded"), "true",
    "再次点击应展开");
  assert.doesNotMatch(await page.evaluate(() => document.cookie), /admin_nav_collapsed=content/,
    "全部展开后不应遗留收起记录");

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
  // 折叠状态是侧栏与抽屉共用的：桌面收起了哪些组，抽屉里也是收起的。
  // 两处各存一份状态会出现「桌面收起了、手机又展开」的割裂，所以把共享钉住。
  {
    const sheetStates = await page.locator(".sheet-nav-toggle").evaluateAll((els) =>
      els.map((e) => [e.closest(".sheet-nav-group")?.getAttribute("data-key"), e.getAttribute("aria-expanded")])
    );
    const sideStates = await page.evaluate(() => Array.from(document.querySelectorAll(".admin-side-group-toggle"))
      .map((e) => [e.closest(".admin-side-group")?.getAttribute("data-key"), e.getAttribute("aria-expanded")]));
    assert.deepEqual(sheetStates, sideStates, "侧栏与抽屉应共用同一份折叠状态");
  }

  const sheetTitles = await page.locator(".sheet-nav-title").evaluateAll((els) =>
    els.map((e) => (e.textContent || "").trim())
  );
  assert.deepEqual(sheetTitles, ["工作台", "内容", "资源", "系统"], "抽屉分组应为四组：实际 " + JSON.stringify(sheetTitles));

  // 抽屉里的组头同样是折叠开关，且组头热区也要 >= 48（手机不能靠 hover 才能操作）
  const sheetToggles = await page.locator(".sheet-nav-toggle").evaluateAll((els) =>
    els.map((e) => ({
      tag: e.tagName,
      expanded: e.getAttribute("aria-expanded"),
      h: Math.round(e.getBoundingClientRect().height),
    }))
  );
  assert.equal(sheetToggles.length, 4, "抽屉应有 4 个可折叠组头，实际 " + JSON.stringify(sheetToggles));
  assert.ok(sheetToggles.every((t) => t.tag === "BUTTON" && t.expanded === "true"),
    "抽屉组头必须是默认展开的 button：" + JSON.stringify(sheetToggles));
  assert.deepEqual(sheetToggles.filter((t) => t.h < 48), [], "抽屉组头热区应 >= 48：" + JSON.stringify(sheetToggles));

  // 抽屉里折叠也生效：收起「资源」后它的两项不可见
  await page.locator(".sheet-nav-group[data-key='assets'] .sheet-nav-toggle").click();
  await page.waitForTimeout(280);
  assert.equal(await page.locator(".sheet-nav-group[data-key='assets'] .sheet-nav-toggle").getAttribute("aria-expanded"), "false",
    "抽屉组头点击后应收起");
  const assetsPanel = await page.locator(".sheet-nav-group[data-key='assets'] .sheet-nav-body").evaluate((el) => ({
    h: Math.round(el.getBoundingClientRect().height),
    inert: el.hasAttribute("inert"),
  }));
  assert.equal(assetsPanel.h, 0, "抽屉收起后该组面板高度应为 0，实际=" + JSON.stringify(assetsPanel));
  assert.equal(assetsPanel.inert, true, "抽屉收起后该组内容应加 inert，实际=" + JSON.stringify(assetsPanel));

  const small = await page.locator(".sheet-nav a").evaluateAll((els) =>
    els.map((e) => ({ t: (e.textContent || "").trim(), h: Math.round(e.getBoundingClientRect().height) }))
      .filter((x) => x.h < 48)
  );
  assert.deepEqual(small, [], "抽屉导航项热区应 >= 48： " + JSON.stringify(small));
  console.log("PASS phase02: 手机侧栏隐藏/顶栏出现/抽屉四组可折叠且热区 >=48，无横向溢出");

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
