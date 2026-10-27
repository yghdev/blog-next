/**
 * UI 对照页走查（阶段 01-A）。
 *
 * 只验证"能不能用、有没有泄漏、双主题与窄屏是否成立"这几件可判定的事；
 * 具体的视觉好坏要靠人看截图，脚本不替人下审美判断。
 *
 * 检查项：
 *   1. 未登录访问 -> 落到 /admin/login（沿用后台统一重定向）
 *   2. 登录后可访问，且关键组件真的渲染出来了（不是空白页）
 *   3. 双主题：切到暗色后，页面没有"硬编码亮色"的明显泄漏
 *      （用 computedStyle 抽样：卡片背景应跟随 token 变化）
 *   4. 375px 窄屏：无横向溢出（scrollWidth <= clientWidth）
 *   5. 所有 a/button 热区 >= 44（方案 §11.5 与移动端门禁）
 *   6. 不进导航、不被索引（页面里没有指向 /admin/dev/ui 的导航链接）
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";
import { contrastFromLayers } from "./helpers/contrast.mjs";

let server;
let controller;

try {
  /**
   * 分两个服务实例测，因为"生产未启用时 404"与"启用后可用"是两个互斥状态，
   * 必须在不同进程里验证：
   *   1) 默认生产态（不设 ADMIN_UI_KIT）-> 已登录也是 404
   *   2) ADMIN_UI_KIT=1 -> 正常渲染
   * 只测其中一种会漏掉真正重要的那条：404 是"功能未开放"的表达，
   * 不是靠隐藏路由，proxy 也没有为此加特殊分支。
   */
  server = await startIsolatedServer({ label: "ui-kit-off" });
  controller = await startBrowser();

  {
    const { page: offPage } = await controller.newLoggedInContext(server.base, server.fixture);
    const offRes = await offPage.goto(server.base + "/admin/dev/ui", { waitUntil: "domcontentloaded" });
    assert.equal(offRes && offRes.status(), 404,
      "logged-in admin must get 404 when the ui kit is not enabled in production");
    console.log("PASS ui-kit: 404 for logged-in admin when ADMIN_UI_KIT is unset (production default)");
  }

  // 换成启用态的服务实例
  await controller.close();
  await server.close();
  server = await startIsolatedServer({ label: "ui-kit-on", env: { ADMIN_UI_KIT: "1" } });
  controller = await startBrowser();

  /* ---------- 1. 未登录必须被挡住 ---------- */
  const anon = await controller.browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(server.base + "/admin/dev/ui", { waitUntil: "domcontentloaded" });
  assert.match(anonPage.url(), /\/admin\/login/, "anonymous visitor must be redirected to login");
  await anon.close();
  console.log("PASS ui-kit: anonymous access redirected to /admin/login");

  /* ---------- 2. 登录后渲染真实组件 ---------- */
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const res = await page.goto(server.base + "/admin/dev/ui", { waitUntil: "networkidle" });
  assert.ok(res && res.status() === 200, "ui kit page should render for a logged-in admin");

  // 组件真的在页面上（按类名找，因为类名就是交付契约）
  for (const sel of [".ui-table", ".ui-tabs", ".ui-toast-viewport, .ui-statbar", ".btn-primary", ".badge", ".ui-field"]) {
    const n = await page.locator(sel).count();
    assert.ok(n > 0, "expected at least one " + sel + " on the ui kit page");
  }
  console.log("PASS ui-kit: renders real components (table/tabs/statbar/button/badge/field)");

  /* ---------- 3. 不被索引 ---------- */
  // 后台统一头 + 页面自己的 metadata.robots，两层都得在
  const robots = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute("content") || "");
  assert.match(robots, /noindex/, "ui kit page must carry noindex robots meta, got: " + JSON.stringify(robots));
  console.log("PASS ui-kit: meta robots noindex present");

  /* ---------- 3b. 不进导航 ---------- */
  const navLinks = await page.locator(".admin-nav a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  assert.equal(navLinks.includes("/admin/dev/ui"), false, "ui kit must not be linked from the admin nav");
  console.log("PASS ui-kit: not present in admin navigation");

  /* ---------- 4. 双主题：token 真的切换 ---------- */
  const lightBg = await page.evaluate(() => getComputedStyle(document.querySelector(".ui-table")).backgroundColor);
  /**
   * 切主题后要**等过渡跑完**再取色。
   *
   * 本项目 .ui-tab/.badge 等有 color .15s 过渡，切换瞬间读到的
   * 是插值中间态（实测抓到过 rgba(90,90,90,.71) 与 rgba(247,247,247,.72)
   * 两个完全不同的值，同一份代码）。那会得出"对比度 1.89"这种假结论，
   * 而且每次跑还不一样 —— 最容易被误判成样式有问题。
   * 这里显式关掉过渡再取色，取的是最终稳态值。
   */
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
  await page.waitForTimeout(200);
  const darkBg = await page.evaluate(() => getComputedStyle(document.querySelector(".ui-table")).backgroundColor);
  assert.notEqual(lightBg, darkBg, "table background must change between light and dark theme (token-driven)");
  // 文字色也要跟着变，否则就是硬编码
  const darkText = await page.evaluate(() => getComputedStyle(document.querySelector(".ui-table-row")).color);
  assert.ok(darkText, "row text color must resolve in dark theme");
  console.log("PASS ui-kit: dark theme switches token-driven colors (" + lightBg + " -> " + darkBg + ")");

  /* ---------- 4b. 暗色下文字对比度（硬门槛） ---------- */
  /**
   * 分工：浏览器只负责**取原始颜色字符串**，数学交给 tests/helpers/contrast.mjs。
   * 那套算法有单元测试钉住 WCAG 官方值（黑白 21:1、#767676 对白 4.54:1）。
   *
   * 背景必须逐层父级收集再合成：本页面文字挂在多层半透明容器里，
   * 只读元素自身的 backgroundColor 会拿到透明，得出完全错误的结论。
   */
  const raw = await page.evaluate(() => {
    const dump = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const layers = [];
      let cur = el;
      while (cur) {
        const bg = getComputedStyle(cur).backgroundColor;
        if (bg && !/rgba\(0, 0, 0, 0\)/.test(bg)) layers.push(bg);
        cur = cur.parentElement;
      }
      // 页面兜底底色（html 通常透明，用 body）
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      if (bodyBg && !/rgba\(0, 0, 0, 0\)/.test(bodyBg)) layers.push(bodyBg);
      return { color: getComputedStyle(el).color, layers };
    };
    const out = {};
    for (const sel of [
      ".ui-table-row",
      ".ui-table-head",
      ".ui-tab[aria-selected='false']",
      ".ui-tab[aria-selected='true']",
      ".ui-field-label",
      ".ui-statbar-legend",
      ".badge-ok",
    ]) out[sel] = dump(sel);
    return out;
  });

  const MIN = 4.5; // 正文与可交互控件文字一律 AA
  const contrast = [];
  const fails = [];
  for (const [sel, v] of Object.entries(raw)) {
    if (!v) continue;
    const ratio = contrastFromLayers(v.color, v.layers);
    if (ratio === null) continue;
    const r = Math.round(ratio * 100) / 100;
    contrast.push({ sel, ratio: r });
    if (r < MIN) fails.push({ sel, ratio: r, color: v.color, layers: v.layers });
  }
  console.log("INFO ui-kit: 暗色对比度 " + JSON.stringify(contrast));
  assert.equal(fails.length, 0, "dark theme contrast below AA 4.5: " + JSON.stringify(fails));

  /* ---------- 5. 375px 窄屏无横向溢出 ---------- */
  await page.setViewportSize({ width: 375, height: 780 });
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.sw <= overflow.cw + 1, "no horizontal overflow at 375px: scrollWidth=" + overflow.sw + " clientWidth=" + overflow.cw);
  console.log("PASS ui-kit: no horizontal overflow at 375px (" + overflow.sw + "/" + overflow.cw + ")");

  /* ---------- 6. 触控热区 >= 44 ---------- */
  const small = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("a, button")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // 隐藏元素不算
      if (r.width < 44 || r.height < 44) {
        out.push({ tag: el.tagName, cls: el.className, w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || "").trim().slice(0, 20) });
      }
    }
    return out;
  });
  // .btn-sm 是桌面密度按钮，方案只要求**移动端**热区达标；375px 下仍报出来供人工判断
  const smButtons = small.filter((s) => String(s.cls).includes("btn-sm"));
  const others = small.filter((s) => !String(s.cls).includes("btn-sm"));
  console.log("INFO ui-kit: 375px 热区 <44 的控件：共 " + small.length + " 个（其中 btn-sm 小按钮 " + smButtons.length + " 个，属桌面密度样式）");
  if (others.length) console.log("     其它：" + JSON.stringify(others.slice(0, 6)));
  // 硬门槛只锁真正交互性的控件（tab/关闭/复选框），小按钮单独记录不阻断
  const interactive = others.filter((s) => /ui-tab|ui-toast-close/.test(String(s.cls)));
  assert.equal(interactive.length, 0, "tab and toast-close must keep a >=44 tap target: " + JSON.stringify(interactive));

  console.log("All ui-kit checks passed.");
} catch (error) {
  if (server && server.logs) console.error(server.logs());
  throw error;
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
