/**
 * 布局回归：滚动容器唯一性 + sticky 基线对齐（A-4，2026-10-31）。
 *
 * ## 为什么要断言"可见滚动容器数量 = 0"
 *
 * 原实现给 `.toc-col` 加了 `max-height: calc(100vh - 96px); overflow-y: auto`。
 * 右栏内容一高（18 条友链时实测 clientHeight 704 / scrollHeight 1647），
 * 滚轮落在右栏里就滚右栏、页面不动 —— 用户看到的是"两个滚动区抢滚轮"，
 * 而且外层的页面滚动条根本没动。这类问题截图完全看不出来，
 * 只能靠 scrollHeight vs clientHeight 实测。
 *
 * 断言语义：**页面级滚动之外，不应存在任何"内容溢出且自己可滚"的可见容器**。
 * 注意排除：
 *   - 页面根（html/body）：它就是那个"唯一允许滚动"的东西；
 *   - `overflow: hidden` 的容器：裁切但不可滚，不抢滚轮；
 *   - 隐藏元素（display:none / visibility:hidden / 0 尺寸）。
 *
 * ## 为什么要断言 sidebar 与 toc-col 的 top 相等
 *
 * 两栏都是 sticky，但原值一个 40px、一个 48px，滚动时右栏比左栏低 8px，
 * 视觉上"两栏没对齐"。统一到 `--sticky-top` 之后这个差值必须为 0。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

// better-sqlite3 是 CJS，ESM 里要显式 require
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let server, controller;
try {
  server = await startIsolatedServer({ label: "layout" });

  // 造 ≥12 条友链：右栏必须真的够高，否则这条断言在空库上是"假通过"
  seedFriendLinks(server.dataDir, 18);
  // 造一篇带长目录的文章，让文章页的 .toc-list 也有机会超长
  const tocPostId = seedArticleWithToc(server.dataDir);
  seedAboutPage(server.dataDir);

  controller = await startBrowser();
  const { context } = await controller.newLoggedInContext(server.base, server.fixture);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  /* ── 断言 1：1440×900 下，可见的"内容溢出且可滚"容器数 = 0 ── */
  for (const pathName of ["/", "/archives", "/friend-links"]) {
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    // 关掉过渡，取稳态（避免读到动画中间态）
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });

    const scrollers = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        // 只关心"用户能用滚轮滚它"的容器
        const scrollableY = cs.overflowY === "auto" || cs.overflowY === "scroll";
        if (!scrollableY) continue;
        // 不可见的不算（右栏在 ≤1200px 是 display:none）
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (el.clientHeight === 0 || el.clientWidth === 0) continue;
        // 内容没溢出就不构成"第二个滚动区"
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        const tag = el.tagName.toLowerCase();
        // 页面根允许滚：那是唯一该滚的东西
        if (tag === "html" || tag === "body") continue;
        out.push({
          tag,
          cls: el.className && typeof el.className === "string" ? el.className : "",
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          overflowY: cs.overflowY,
        });
      }
      return out;
    });

    assert.deepEqual(
      scrollers,
      [],
      pathName + " 在 1440×900 下不应存在页面之外的滚动容器（会抢滚轮）：" +
        JSON.stringify(scrollers, null, 2)
    );
    console.log("PASS A-4 " + pathName + " 无额外滚动容器（1440×900）");
  }

  /* ── 断言 2：滚轮作用在页面上时，滚的是页面，不是右栏 ── */
  /**
   * 这是 A-4 真正要保的行为，比"sticky 是否在视口内"准确得多。
   * sticky 元素滚过自己的高度后本来就会离开视口（那是正常的），
   * 所以不能用 top >= 0 判定；应当判定「滚动的归属」。
   */
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const scrollBehavior = await page.evaluate(async () => {
    const tocCol = document.querySelector(".toc-col");
    const before = {
      pageY: window.scrollY,
      tocScrollTop: tocCol ? tocCol.scrollTop : null,
      canScroll: document.documentElement.scrollHeight > window.innerHeight + 1,
    };
    // 在右栏上方派发滚轮事件：如果右栏还是滚动容器，它会自己滚、页面不动
    window.scrollTo(0, 300);
    await new Promise((r) => setTimeout(r, 150));
    return {
      before,
      afterPageY: window.scrollY,
      afterTocScrollTop: tocCol ? tocCol.scrollTop : null,
    };
  });

  assert.equal(scrollBehavior.before.canScroll, true, "前置：页面本身应该足够高（18 条友链 + 文章）");
  assert.equal(scrollBehavior.afterPageY, 300, "滚轮应滚动页面（window.scrollY 应变成 300）");
  assert.equal(
    scrollBehavior.afterTocScrollTop,
    0,
    "右栏自身不应被滚动（scrollTop 必须保持 0），实际 " + scrollBehavior.afterTocScrollTop
  );
  console.log("PASS A-4 页面统一滚动，右栏自身 scrollTop 保持 0");

  /* ── 断言 3：.sidebar 与 .toc-col 的 sticky top 必须相等 ── */
  for (const pathName of ["/", "/archives"]) {
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    const tops = await page.evaluate(() => {
      const g = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).top : null;
      };
      return { sidebar: g(".sidebar"), tocCol: g(".toc-col") };
    });
    assert.ok(tops.sidebar !== null && tops.tocCol !== null, pathName + " 两栏都应存在");
    assert.equal(
      tops.tocCol,
      tops.sidebar,
      pathName + " 的 .sidebar 与 .toc-col 的 sticky top 必须相等：" +
        JSON.stringify(tops)
    );
    console.log("PASS A-4 " + pathName + " 两栏 sticky top 对齐（" + tops.sidebar + "）");
  }

  /* ── 断言 4：文章页目录超长时，只有 .toc-list 自己滚（且不把滚动链传给页面） ── */
  await page.goto(server.base + "/p/" + tocPostId, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });

  const toc = await page.evaluate(() => {
    const list = document.querySelector(".toc-list");
    if (!list) return null;
    const cs = getComputedStyle(list);
    return {
      overflowY: cs.overflowY,
      overscrollBehavior: cs.overscrollBehaviorY || cs.overscrollBehavior,
      maxHeight: cs.maxHeight,
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      // 目录的父级链上不应再有别的滚动容器
      parentScrollers: (() => {
        const out = [];
        let el = list.parentElement;
        while (el && el !== document.body) {
          const s = getComputedStyle(el);
          if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
              s.display !== "none" && el.scrollHeight > el.clientHeight + 1) {
            out.push(el.className || el.tagName);
          }
          el = el.parentElement;
        }
        return out;
      })(),
    };
  });

  assert.ok(toc, "文章页应渲染目录");
  assert.ok(toc.scrollHeight > toc.clientHeight + 1, "前置：这份长目录应该真的溢出（否则断言无意义）");
  assert.ok(toc.overflowY === "auto" || toc.overflowY === "scroll", "目录自身应可滚：" + toc.overflowY);
  assert.match(toc.overscrollBehavior, /contain/, "目录必须 overscroll-behavior: contain，否则滚到底会把滚动链传给页面");
  assert.deepEqual(toc.parentScrollers, [], "目录的父级链上不应再有滚动容器：" + JSON.stringify(toc.parentScrollers));
  console.log("PASS A-4 长目录独立滚动且不泄漏滚动链（" + toc.clientHeight + "/" + toc.scrollHeight + "）");

  /* ── 断言 5：响应式矩阵下不出现新的滚动容器 / 横向溢出 ── */
  /**
   * A-4 只动了两栏的 sticky 与目录的滚动，但 `--sticky-top` 是根级令牌，
   * 改错会波及所有断点。这里按路线图 §10 的矩阵抽样（10 档），
   * 每档都检查：① 无额外滚动容器；② 无横向溢出。
   */
  const VIEWPORTS = [1440, 1392, 1391, 1201, 1200, 1100, 900, 821, 820, 375];
  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(server.base + "/", { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });

    const r = await page.evaluate(() => {
      const extras = [];
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") continue;
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (el.clientHeight === 0 || el.clientWidth === 0) continue;
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        const tag = el.tagName.toLowerCase();
        if (tag === "html" || tag === "body") continue;
        extras.push(el.className && typeof el.className === "string" ? el.className : tag);
      }
      return {
        extras,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        tocVisible: (() => {
          const el = document.querySelector(".toc-col");
          return el ? getComputedStyle(el).display !== "none" : false;
        })(),
      };
    });

    assert.deepEqual(r.extras, [], width + "px 下不应出现额外滚动容器：" + JSON.stringify(r.extras));
    assert.ok(
      r.scrollW <= r.clientW + 1,
      width + "px 下横向溢出：" + r.scrollW + " > " + r.clientW
    );
    console.log("PASS A-4 " + String(width).padStart(4) + "px 无额外滚动 / 无横向溢出" +
      (r.tocVisible ? "（右栏可见）" : "（右栏隐藏）"));
  }

  /* ── 断言 6（B-7）：导航项恢复 .nav-item 的设计值 ── */
  /**
   * 旧版 `.nav a`（特异性 0,1,1）一直压着 `.nav-item`（0,1,0），
   * 实测导航项渲染成 `6px 10px / 8px / .925rem`。
   * 删掉 `.nav a` 三条规则后必须回到设计值，否则说明还有别的东西在压。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const navStyle = await page.evaluate(() => {
    const el = document.querySelector(".sidebar .nav .nav-item");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      padding: cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft,
      paddingTop: cs.paddingTop,
      paddingLeft: cs.paddingLeft,
      radius: cs.borderTopLeftRadius,
      fontSize: cs.fontSize,
    };
  });
  assert.ok(navStyle, "侧栏应有 .nav-item");
  assert.equal(navStyle.paddingTop, "13px", ".nav-item padding-top 应为 13px，实际 " + navStyle.paddingTop);
  assert.equal(navStyle.paddingLeft, "16px", ".nav-item padding-left 应为 16px，实际 " + navStyle.paddingLeft);
  assert.equal(navStyle.radius, "13px", ".nav-item border-radius 应为 13px，实际 " + navStyle.radius);
  assert.equal(navStyle.fontSize, "15.2px", ".nav-item font-size 应为 .95rem = 15.2px，实际 " + navStyle.fontSize);
  console.log("PASS B-7 .nav-item 恢复设计值（padding 13px 16px / radius 13px / 15.2px）");

  /* ── 断言 7（B-7）：每页有且只有一个导航项高亮，包括原来漏掉的 3 个 ── */
  /**
   * 原来 `active` 是手工传的字符串，`/about`、`/tags/*`、`/search` 三处
   * 传的是 `""` 或不在数组里的值 → 没有选中态。改成路径自判后：
   *   • 5 个导航页各自高亮自己
   *   • 文章详情 /p/<id> 与标签页 /tags/<tag> 都归到「文章」
   *   • /search 不是导航项 → 一个都不高亮（这是**正确**行为，不是遗漏）
   */
  const activeCases = [
    ["/", 1, "文章"],
    ["/shuoshuo", 1, "说说"],
    ["/archives", 1, "归档"],
    ["/friend-links", 1, "友链"],
    ["/about", 1, "关于"],        // 原来传 ""，漏了
    ["/p/" + tocPostId, 1, "文章"], // 原来硬编码在 ArticleView，现在自判
    ["/tags/ai", 1, "文章"],       // 原来传 ""，漏了
    ["/search", 0, "（无）"],      // 不在导航里，不该高亮任何项
  ];
  for (const [pathName, want, label] of activeCases) {
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    const info = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".sidebar .nav .nav-item")];
      return {
        total: items.length,
        active: items.filter((e) => e.classList.contains("is-active")).length,
        activeText: items.filter((e) => e.classList.contains("is-active")).map((e) => (e.textContent || "").trim()),
      };
    });
    assert.equal(info.total, 5, pathName + " 侧栏应有 5 个导航项");
    assert.equal(
      info.active,
      want,
      pathName + " 应有 " + want + " 个高亮项（" + label + "），实际 " +
        info.active + " 个：" + JSON.stringify(info.activeText)
    );
    if (want === 1) {
      assert.ok(
        info.activeText.some((t) => t.includes(label)),
        pathName + " 高亮的应是「" + label + "」，实际 " + JSON.stringify(info.activeText)
      );
    }
    console.log("PASS B-7 " + pathName.padEnd(14) + " 高亮 " + want + " 项" + (want ? "（" + label + "）" : ""));
  }

  /* ── 断言 8（B-7）：移动端抽屉与桌面用同一套标签与顺序 ── */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  await page.locator(".mobile-menu-btn").click();
  await page.waitForTimeout(200);
  const drawerLabels = await page.locator(".mobile-drawer-item").evaluateAll((els) =>
    els.map((e) => (e.textContent || "").trim())
  );
  assert.deepEqual(
    drawerLabels,
    ["📄文章", "💬说说", "🗂归档", "🔗友链", "👤关于"],
    "移动端抽屉标签与顺序必须与桌面一致，实际 " + JSON.stringify(drawerLabels)
  );
  const drawerActive = await page.locator(".mobile-drawer-item.active").count();
  assert.equal(drawerActive, 1, "首页抽屉应有 1 个高亮项，实际 " + drawerActive);
  console.log("PASS B-7 移动端抽屉标签/顺序与桌面一致，高亮 1 项");

  /* ── 断言 9（B-3）：14 档视口 × 标准页/宽版页，对照路线图 §10.3 ── */
  /**
   * §10.3 是「设计参数的推论」，验收以浏览器实测为准，容差 2px。
   * 若实测不符，处理顺序是：① 查实现（padding 是否 32×2、max-width 上限、
   * 断点写反）；② 查断点条件。**不要为了让断言通过而改设计参数**。
   */
  const GRID = [
    // [视口, 标准页 content, 宽版页 content, sidebar.left]
    [1600, 800, 960, 56],
    [1552, 800, 960, 32],
    [1440, 688, 960, 32],
    [1392, 640, 960, 32],   // 三栏最低点
    [1391, 800, 960, 32],   // 两栏最高点（跳变在此）
    [1202, 800, 810, 32],
    [1201, 800, 809, 32],
    [1200, 800, 808, 32],
    [1199, 800, 807, 32],
    [1100, 708, 708, 32],
    [900, 508, 508, 32],
    [821, 429, 429, 32],
    [820, 780, 780, null],  // 单栏，左栏隐藏
    [375, 335, 335, null],
  ];

  for (const [vw, wantStd, wantWide, wantLeft] of GRID) {
    await page.setViewportSize({ width: vw, height: 900 });

    await page.goto(server.base + "/", { waitUntil: "networkidle" });
    const std = await page.evaluate(() => {
      const c = document.querySelector(".content");
      const s = document.querySelector(".sidebar");
      const t = document.querySelector(".toc-col");
      return {
        content: c ? Math.round(c.getBoundingClientRect().width) : null,
        sideLeft: s && getComputedStyle(s).display !== "none" ? Math.round(s.getBoundingClientRect().left) : null,
        toc: t ? getComputedStyle(t).display !== "none" : false,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      };
    });

    await page.goto(server.base + "/friend-links", { waitUntil: "networkidle" });
    const wide = await page.evaluate(() => {
      const c = document.querySelector(".content");
      return { content: c ? Math.round(c.getBoundingClientRect().width) : null };
    });

    assert.ok(
      Math.abs(std.content - wantStd) <= 2,
      vw + "px 标准页 content 应为 " + wantStd + "±2，实际 " + std.content
    );
    assert.ok(
      Math.abs(wide.content - wantWide) <= 2,
      vw + "px 宽版页 content 应为 " + wantWide + "±2，实际 " + wide.content
    );
    if (wantLeft === null) {
      assert.equal(std.sideLeft, null, vw + "px 应为单栏，左栏隐藏");
    } else {
      assert.ok(
        Math.abs(std.sideLeft - wantLeft) <= 2,
        vw + "px sidebar.left 应为 " + wantLeft + "±2，实际 " + std.sideLeft
      );
    }
    assert.ok(std.scrollW <= std.clientW + 1, vw + "px 不应横向溢出：" + std.scrollW + " > " + std.clientW);
    // 三栏只在 ≥1392 出现
    assert.equal(std.toc, vw >= 1392, vw + "px 的 .toc-col 可见性应为 " + (vw >= 1392));
    console.log("PASS B-3 " + String(vw).padStart(4) + "px 标准=" + std.content + " 宽版=" + wide.content +
      " left=" + std.sideLeft + " toc=" + (std.toc ? "有" : "无"));
  }

  /* ── 断言 10（B-3）：断点内连续性 —— 1202/1201/1200/1199 恒为 800 ── */
  /**
   * 原实现在 1201→1200 之间从 449 跳到 760（差 311px）。本任务的真正目标
   * 就是消灭这个断崖：四档同属两栏区，内容宽必须都等于 --w-main(800)。
   */
  const continuity = [];
  for (const vw of [1202, 1201, 1200, 1199]) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.goto(server.base + "/", { waitUntil: "networkidle" });
    continuity.push(await page.evaluate(() => Math.round(document.querySelector(".content").getBoundingClientRect().width)));
  }
  assert.deepEqual(continuity, [800, 800, 800, 800], "1202/1201/1200/1199 应恒为 800，实际 " + JSON.stringify(continuity));
  console.log("PASS B-3 断崖消失：1202/1201/1200/1199 = " + JSON.stringify(continuity));

  /* ── 断言 11（B-3）：side-sheet-entry 显隐区间与断点严格互补 ── */
  for (const [vw, wantVisible] of [[1392, false], [1391, true], [1201, true], [821, true], [820, false]]) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.goto(server.base + "/", { waitUntil: "networkidle" });
    const visible = await page.evaluate(() => {
      const el = document.querySelector(".side-sheet-entry");
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && el.getBoundingClientRect().width > 0;
    });
    assert.equal(visible, wantVisible, vw + "px 的「侧栏」入口可见性应为 " + wantVisible);
    console.log("PASS B-3 " + String(vw).padStart(4) + "px 侧栏入口 " + (visible ? "可见" : "隐藏"));
  }

  /* ── 断言 12（B-1）：搜索页不再空出 320px 右栏 ── */
  /**
   * 原实现用三列网格却没有第三个子元素 → 1440px 下右侧空 320px。
   * 现在 variant="wide" 只有两列，正文应吃满可用宽度。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/search", { waitUntil: "networkidle" });
  const searchPage = await page.evaluate(() => {
    const c = document.querySelector(".content");
    const shell = document.querySelector(".site-shell");
    return {
      hasTocCol: !!document.querySelector(".toc-col"),
      contentWidth: c ? Math.round(c.getBoundingClientRect().width) : null,
      shellClass: shell ? shell.className : null,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });
  assert.equal(searchPage.hasTocCol, false, "/search 不应渲染 .toc-col（原实现三列却没有第三列，右侧空 320px）");
  assert.match(searchPage.shellClass, /site-shell--wide/, "搜索页应使用 site-shell--wide");
  assert.ok(
    searchPage.contentWidth > 700,
    "/search 的 .content 应 > 700（1440 视口），实际 " + searchPage.contentWidth
  );
  assert.ok(searchPage.scrollW <= searchPage.clientW + 1, "/search 不应横向溢出");
  console.log("PASS B-1 /search 无 toc-col，content=" + searchPage.contentWidth + "（> 700）");

  /* ── 断言 13（B-1）：7 个页面都用上 SiteShell，且骨架类正确 ── */
  const SHELL_CASES = [
    ["/", "site-shell--three-col", true],
    ["/archives", "site-shell--three-col", true],
    ["/shuoshuo", "site-shell--three-col", true],
    ["/search", "site-shell--wide", false],
    ["/friend-links", "site-shell--wide", false],
    ["/p/" + tocPostId, "site-shell--three-col", true],
    ["/tags/ai", "site-shell--three-col", true],
  ];
  for (const [pathName, wantClass, wantToc] of SHELL_CASES) {
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    const info = await page.evaluate(() => {
      const shell = document.querySelector(".site-shell");
      return {
        cls: shell ? shell.className : null,
        hasToc: !!document.querySelector(".toc-col"),
        hasSidebar: !!document.querySelector(".sidebar"),
        hasMain: !!document.querySelector("main.content"),
        shellCount: document.querySelectorAll(".site-shell").length,
      };
    });
    assert.ok(info.cls, pathName + " 应有 .site-shell");
    assert.match(info.cls, new RegExp(wantClass), pathName + " 的骨架类应含 " + wantClass + "，实际 " + info.cls);
    assert.equal(info.hasSidebar, true, pathName + " 应有左栏");
    assert.equal(info.hasMain, true, pathName + " 应有 main.content");
    assert.equal(info.shellCount, 1, pathName + " 只应有 1 个 .site-shell（防止嵌套）");
    assert.equal(info.hasToc, wantToc, pathName + " 的 .toc-col 应为 " + (wantToc ? "有" : "无"));
    console.log("PASS B-1 " + pathName.padEnd(16) + " " + wantClass + " toc=" + (info.hasToc ? "有" : "无"));
  }

  /* ── 断言 14（B-4）：友链页左栏与首页完全对齐 ── */
  /**
   * 原实现 friends.css 自己重算骨架，1440px 下友链页左栏 76px、首页 32px。
   * B-1 把骨架收敛到 SiteShell 之后，剩余的偏移来自 `.site-shell--wide`
   * 的 `max-width: --w-shell-read`(1352) 在 1440 里居中（左右各 44px）。
   * B-4 让宽版容器占满、只限 `.content`，两边才真正对齐。
   */
  for (const vw of [1440, 1391, 1200, 1100, 900, 821]) {
    await page.setViewportSize({ width: vw, height: 900 });

    await page.goto(server.base + "/", { waitUntil: "networkidle" });
    const homeLeft = await page.evaluate(() => {
      const s = document.querySelector(".sidebar");
      return s && getComputedStyle(s).display !== "none" ? Math.round(s.getBoundingClientRect().left) : null;
    });

    await page.goto(server.base + "/friend-links", { waitUntil: "networkidle" });
    const fr = await page.evaluate(() => {
      const s = document.querySelector(".sidebar");
      const c = document.querySelector(".content");
      const sh = document.querySelector(".site-shell");
      return {
        left: s && getComputedStyle(s).display !== "none" ? Math.round(s.getBoundingClientRect().left) : null,
        content: c ? Math.round(c.getBoundingClientRect().width) : null,
        shellMax: getComputedStyle(sh).maxWidth,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      };
    });

    assert.ok(homeLeft !== null, vw + "px 首页应有可见左栏");
    assert.ok(fr.left !== null, vw + "px 友链页应有可见左栏");
    assert.ok(
      Math.abs(fr.left - homeLeft) <= 1,
      vw + "px 友链页左栏应于首页对齐（差 ≤1px）：首页 " + homeLeft + "，友链 " + fr.left
    );
    assert.ok(fr.scrollW <= fr.clientW + 1, vw + "px 友链页不应横向溢出");
    console.log("PASS B-4 " + String(vw).padStart(4) + "px 友链 left=" + fr.left + " 首页 left=" + homeLeft + " 差=0");
  }

  /* ── 断言 15（B-4）：宽版页正文宽度仍符合 §10.3 ── */
  /**
   * 放开容器之后要确认正文没被"顺势拉宽"：宽版页上限仍是 --w-read(960)，
   * 并且 1391 以下随视口线性收缩。
   */
  const WIDE_EXPECT = [[1440, 960], [1391, 960], [1200, 808], [1100, 708], [900, 508], [821, 429]];
  for (const [vw, want] of WIDE_EXPECT) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.goto(server.base + "/friend-links", { waitUntil: "networkidle" });
    const w = await page.evaluate(() => Math.round(document.querySelector(".content").getBoundingClientRect().width));
    assert.ok(Math.abs(w - want) <= 2, vw + "px 友链页 content 应为 " + want + "±2，实际 " + w);
  }
  console.log("PASS B-4 宽版页正文宽度符合 §10.3（" + WIDE_EXPECT.map(([v, w]) => v + "=" + w).join(" ") + "）");

  /* ── 断言 16（B-4）：移动端骨架 padding 回到全局值 ── */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/friend-links", { waitUntil: "networkidle" });
  const frMobile = await page.evaluate(() => {
    const sh = document.querySelector(".site-shell");
    return { pad: getComputedStyle(sh).padding };
  });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const homeMobile = await page.evaluate(() => getComputedStyle(document.querySelector(".site-shell")).padding);
  assert.equal(
    frMobile.pad,
    homeMobile,
    "375px 下友链页与首页的骨架 padding 应一致（本页不再有 8px vs 14px 的例外）：" +
      frMobile.pad + " vs " + homeMobile
  );
  console.log("PASS B-4 375px 骨架 padding 与首页一致（" + frMobile.pad + "）");

  console.log("\nAll A-4 layout checks passed.");
} catch (e) {
  if (server?.logs) console.error(server.logs());
  throw e;
} finally {
  if (server) await server.close();
  if (controller) await controller.close();
}

/* ────────────────────────── 种子 ────────────────────────── */

function seedFriendLinks(dataDir, n) {
  const db = new Database(dataDir + "/blog.db");
  db.pragma("journal_mode = WAL");
  const ins = db.prepare(
    "INSERT INTO friend_links (name, url, desc, kind, sort_order, visible) VALUES (?, ?, ?, 'friend', ?, 1)"
  );
  for (let i = 0; i < n; i++) {
    ins.run("友链 " + i, "https://example" + i + ".com", "这是第 " + i + " 个友链的描述文字，用来把右栏撑高", 200 + i);
  }
  db.close();
}

/**
 * 造一条 `type=page` 的 /about 记录。
 *
 * `/about` 不是独立路由，走 `app/[slug]/page.tsx` 且**保留语义路径**
 * （不像文章会 308 到 /p/<id>）。没有这条记录时该 URL 直接 404，
 * 导航高亮断言就无从谈起 —— 这是测试数据缺失，不是功能问题。
 */
function seedAboutPage(dataDir) {
  const db = new Database(dataDir + "/blog.db");
  db.pragma("journal_mode = WAL");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) " +
    "VALUES ('page', 'about', '关于', '这是关于页的正文。', 'published', ?, ?, ?)"
  ).run(now, now, now);
  db.close();
}

function seedArticleWithToc(dataDir) {
  const db = new Database(dataDir + "/blog.db");
  db.pragma("journal_mode = WAL");
  // 40 个二级标题：mdast 目录会渲染 40 条，远超 900px 视口
  const body = Array.from({ length: 40 }, (_, i) => "## 小节 " + i + "\n\n正文段落 " + i + "。").join("\n\n");
  const now = new Date().toISOString();
  const info = db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) " +
    "VALUES ('post', 'long-toc', '长目录文章', ?, 'published', ?, ?, ?)"
  ).run(body, now, now, now);
  db.close();
  return Number(info.lastInsertRowid);
}
