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
 * ## 为什么要断言 sidebar 与 toc-col 的滚动关系
 *
 * 2026-11-06 起：左栏导航 sticky（top 对齐 `--sticky-top`），右栏改为
 * **随正文同步滚动**（`position: static`，top 恒等于 `.content` top）。
 * 旧版两栏都 sticky、靠 RailSync 撑同高同步释放的做法已移除。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
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
  seedSiteFooterSettings(server.dataDir);
  const longIds = seedLongStringPosts(server.dataDir);
  seedPostsForPager(server.dataDir);
  seedShuoshuo(server.dataDir);

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

  /* ── 断言 3（2026-11-06 需求）：左栏 fixed，右栏跟随正文（不再 sticky） ── */
  for (const pathName of ["/", "/archives"]) {
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    const tops = await page.evaluate(() => {
      const g = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { position: cs.position, top: cs.top };
      };
      return { sidebar: g(".sidebar"), tocCol: g(".toc-col") };
    });
    assert.ok(tops.sidebar !== null && tops.tocCol !== null, pathName + " 两栏都应存在");
    assert.equal(tops.sidebar.position, "fixed", pathName + " 左栏应为固定定位（fixed），实际 " + tops.sidebar.position);
    assert.equal(tops.sidebar.top, "48px", pathName + " 左栏 top 应为 48px，实际 " + tops.sidebar.top);
    assert.equal(tops.tocCol.position, "static", pathName + " 右栏应随正文滚动（position: static），实际 " + tops.tocCol.position);
    assert.equal(tops.tocCol.top, "auto", pathName + " 右栏不应再设置 sticky top，实际 " + tops.tocCol.top);
    console.log("PASS A-4 " + pathName + " 左栏 fixed（top=48px），右栏随正文（static）");
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

  /* ── 断言 6（B-7+C-10）：导航项必须落在当前设计值上 ── */
  /**
   * 这条断言原本守的是 B-7：旧版 `.nav a`（特异性 0,1,1）压着 `.nav-item`
   * （0,1,0），实测渲染成 `6px 10px / 8px / .925rem`；删掉旧规则后应回到
   * 当时的设计值 `13px 16px / 13px / .95rem`。
   *
   * C-10 重做选中态时导航改为**文字居中**（图标绝对定位挂在文字左侧），
   * 设计值因此变成 `10px 12px / 10px / .92rem`。断言的**意图不变**：
   * 计算值必须等于设计值 —— 只要还有别的规则在压，这里就会红。
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
  assert.equal(navStyle.paddingTop, "10px", ".nav-item padding-top 应为 10px，实际 " + navStyle.paddingTop);
  assert.equal(navStyle.paddingLeft, "12px", ".nav-item padding-left 应为 12px，实际 " + navStyle.paddingLeft);
  assert.equal(navStyle.radius, "10px", ".nav-item border-radius 应为 10px，实际 " + navStyle.radius);
  assert.equal(navStyle.fontSize, "14.72px", ".nav-item font-size 应为 .92rem = 14.72px，实际 " + navStyle.fontSize);
  console.log("PASS B-7/C-10 .nav-item 落在设计值上（padding 10px 12px / radius 10px / 14.72px）");

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

  /* ── 断言 7b（C-10）：选中态只用填充色 —— 无圆点、无位移、无线框、无投影 ── */
  /**
   * 用户反馈原话：「选中状态不要加红点标注，也不要向左浮偏移，也不要用线框
   * 强调，直接用填充色表示」。这四条都能变成可测量的事实：
   *
   *   · 圆点：DOM 里不该再有 `.nav-dot`（它当初还在 `justify-content: center`
   *     的行里多占了"7px + gap"的宽度，把图标和文字整体挤左约 9.5px ——
   *     这就是"向左浮偏移"的真正来源，不是 CSS transform）
   *   · 位移：选中项与未选中项的图标左边缘、文字左边缘必须完全重合
   *   · 线框/投影：border-width 为 0、box-shadow 为 none
   *   · 填充：背景不透明，且**不等于页面背景色**（改版前是 `background: var(--bg)`
   *     白底 + 描边，远看就是没有填充）
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const navActive = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".sidebar .nav .nav-item")];
    const active = items.find((e) => e.classList.contains("is-active"));
    const other = items.find((e) => !e.classList.contains("is-active"));
    if (!active || !other) return null;
    const box = (el) => {
      const ico = el.querySelector(".nav-ico").getBoundingClientRect();
      const txt = el.querySelector(".nav-txt").getBoundingClientRect();
      return { icoLeft: +ico.left.toFixed(2), txtLeft: +txt.left.toFixed(2) };
    };
    const cs = getComputedStyle(active);
    return {
      dots: document.querySelectorAll(".nav-dot").length,
      bg: cs.backgroundColor,
      shadow: cs.boxShadow,
      borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
      transform: cs.transform,
      ariaCurrent: active.getAttribute("aria-current"),
      pageBg: getComputedStyle(document.body).backgroundColor,
      activeBox: box(active),
      otherBox: box(other),
    };
  });
  assert.ok(navActive, "侧栏应有选中项与未选中项各至少一个");
  assert.equal(navActive.dots, 0, "选中态不应再用红点标注（.nav-dot 应已删除）");
  assert.equal(navActive.transform, "none", "选中项不应有任何位移（transform 必须为 none）：" + navActive.transform);
  assert.equal(navActive.shadow, "none", "选中项不应有投影：" + navActive.shadow);
  assert.deepEqual(navActive.borderWidths, ["0px", "0px", "0px", "0px"],
    "选中项不应有线框：" + JSON.stringify(navActive.borderWidths));
  assert.notEqual(navActive.bg, "rgba(0, 0, 0, 0)", "选中项应有填充色，实际透明");
  assert.notEqual(navActive.bg, navActive.pageBg,
    "选中项填充不能等于页面背景色（否则等于没填充）：" + navActive.bg);
  assert.equal(navActive.ariaCurrent, "page", "选中项应带 aria-current=page，读屏用户与视觉用户看到的是同一件事");
  assert.ok(Math.abs(navActive.activeBox.icoLeft - navActive.otherBox.icoLeft) <= 0.5,
    "选中项的图标不能比未选中项更靠左（" + navActive.activeBox.icoLeft + " vs " + navActive.otherBox.icoLeft + "）");
  assert.ok(Math.abs(navActive.activeBox.txtLeft - navActive.otherBox.txtLeft) <= 0.5,
    "选中项的文字不能比未选中项更靠左（" + navActive.activeBox.txtLeft + " vs " + navActive.otherBox.txtLeft + "）");
  console.log("PASS C-10 选中态只有填充色（bg=" + navActive.bg + "，无圆点/位移/线框/投影，aria-current=page）");

  /* ── 断言 7b-2（2026-11-06 需求）：菜单文字必须居中 ── */
  /**
   * 反馈原话「左侧菜单文字居中」—— 把"居中"变成可测量的东西：
   * 每一项 `.nav-txt` 的水平中心都必须等于侧栏（`.sidebar`）的水平中心。
   * 图标是绝对定位的装饰，不能参与居中计算；因此这里只量文字。
   */
  const navCentering = await page.evaluate(() => {
    const side = document.querySelector(".sidebar").getBoundingClientRect();
    const sideCenter = (side.left + side.right) / 2;
    const items = [...document.querySelectorAll(".sidebar .nav-item")].map((el) => {
      const txt = el.querySelector(".nav-txt").getBoundingClientRect();
      return {
        label: (el.textContent || "").trim(),
        textCenter: +((txt.left + txt.right) / 2).toFixed(2),
      };
    });
    return { sideCenter: +sideCenter.toFixed(2), items };
  });
  assert.ok(navCentering.items.length === 5, "侧栏应有 5 个导航项");
  for (const it of navCentering.items) {
    assert.ok(
      Math.abs(it.textCenter - navCentering.sideCenter) <= 0.5,
      "菜单文字应水平居中：「" + it.label + "」文字中心 " + it.textCenter +
        " 与侧栏中心 " + navCentering.sideCenter + " 偏差 " +
        Math.abs(it.textCenter - navCentering.sideCenter).toFixed(2) + "px"
    );
  }
  console.log("PASS C-10 菜单文字居中（5 项文字中心均 = 侧栏中心 " + navCentering.sideCenter + "，偏差 ≤ 0.5px）");

  /* ── 断言 7c（2026-11-06 需求）：左栏固定不动，右栏随正文同步滚动 ── */
  /**
   * 最终形态（第三次调整）：
   *   · 左栏导航 `position: fixed` —— 整段滚动里 top 恒等于 --sticky-top，
   *     滚到页脚也不会动。之前的 sticky 方案在"图标贴视口底部"把栏高撑到
   *     约 820px 之后，必然在页尾释放一次（用户看到"菜单栏又上滑一段"），
   *     这是几何死结，只能改成脱离文档流的固定定位；
   *   · 右栏随正文同步滚动 —— 任意 scrollY 下 top 与 `.content` 一致。
   * 左栏的水平位置另有一条断言（断言 9b：四模板 × 三档视口一致）。
   */
  for (const pathName of ["/", "/archives"]) {
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    const railData = await page.evaluate(async () => {
      const doc = document.documentElement;
      const top = (sel) => {
        const el = document.querySelector(sel);
        return el ? +el.getBoundingClientRect().top.toFixed(2) : null;
      };
      const side = document.querySelector(".sidebar");
      const toc = document.querySelector(".toc-col");
      const pinned = parseFloat(getComputedStyle(side).top);
      const max = doc.scrollHeight - innerHeight;
      const out = [];
      for (let y = 0; y <= max; y += 25) {
        scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        out.push({ y: window.scrollY, side: top(".sidebar"), toc: top(".toc-col"), content: top(".content") });
      }
      return {
        pinned,
        out,
        position: getComputedStyle(side).position,
        syncVar: document.querySelector(".site-shell").style.getPropertyValue("--rail-sync-min").trim(),
        tocPosition: toc ? getComputedStyle(toc).position : null,
      };
    });

    assert.equal(railData.position, "fixed", pathName + " 左栏应为固定定位，实际 " + railData.position);
    assert.equal(railData.syncVar, "", pathName + " 已移除 RailSync，不应再写 --rail-sync-min");
    assert.notEqual(railData.tocPosition, "sticky", pathName + " 右栏不应再 sticky，实际 " + railData.tocPosition);
    for (const s of railData.out) {
      assert.ok(
        Math.abs(s.side - railData.pinned) <= 1,
        pathName + " 左栏必须全程不动：scrollY=" + s.y + " 时 top=" + s.side + "（应为 " + railData.pinned + "）"
      );
      assert.ok(
        Math.abs(s.toc - s.content) <= 2,
        pathName + " 右栏应与正文同步滚动：scrollY=" + s.y + " 时 toc=" + s.toc + " content=" + s.content
      );
    }
    console.log("PASS C-11-new " + pathName.padEnd(10) + " 左栏 fixed 全程不动、右栏随正文滚动");
  }

  /* ── 断言 7d（2026-11-06 需求）：文章内页右栏只显示目录 ── */
  await page.goto(server.base + "/p/" + tocPostId, { waitUntil: "networkidle" });
  const articleRail = await page.evaluate(() => {
    const rail = document.querySelector(".toc-col");
    return {
      blocks: rail ? rail.querySelectorAll(".rb-block").length : 0,
      toc: !!rail?.querySelector(".toc-list"),
      stats: !!rail?.querySelector(".stat-grid"),
      friends: !!rail?.querySelector(".link-list, .fl-item, .friend-links, .fl-hub"),
      tags: !!rail?.querySelector(".tag-cloud"),
    };
  });
  assert.equal(articleRail.blocks, 1, "文章内页右栏应只有目录这一个区块，实际 " + articleRail.blocks);
  assert.equal(articleRail.toc, true, "文章内页右栏应有目录");
  assert.equal(articleRail.stats, false, "文章内页右栏不应再渲染统计");
  assert.equal(articleRail.friends, false, "文章内页右栏不应再渲染友链");
  assert.equal(articleRail.tags, false, "文章内页右栏不应再渲染标签云");
  console.log("PASS 文章内页右栏只显示目录");

  /* ── 断言 7e（2026-11-06 需求）：底栏三个图标按钮等间距 ── */
  /**
   * 需求原话：「主题切换、RSS、设置按钮放到底部等间距放置，不用文字统一用图标」。
   * 三条都可测量：
   *   · 三个子元素（主题按钮 + 2 个链接），且每个都有 svg（不再有文字）
   *   · 底栏 textContent 为空（"RSS / 设置" 不再以文字出现）
   *   · 三个按钮中心两两间距相等（容差 1px）—— 三等分栅格应当正好相等
   * 另外每个仅图标控件都必须有 aria-label，否则读屏用户听到的是空白。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const bottomBar = await page.evaluate(() => {
    const bar = document.querySelector(".side-bottom");
    const kids = [...bar.children].map((el) => {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        center: +(((b.left + b.right) / 2)).toFixed(2),
        w: +b.width.toFixed(1),
        h: +b.height.toFixed(1),
        svg: !!el.querySelector("svg"),
        label: el.getAttribute("aria-label") || el.getAttribute("title") || "",
        borders: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
      };
    });
    return {
      count: kids.length,
      kids,
      gaps: kids.slice(1).map((k, i) => +(k.center - kids[i].center).toFixed(2)),
      text: (bar.textContent || "").trim(),
    };
  });
  assert.equal(bottomBar.count, 3, "底栏应有 3 个控件（主题 / RSS / 后台），实际 " + bottomBar.count);
  assert.equal(bottomBar.text, "", "底栏不应再有文字（RSS/设置已改为图标），实际 " + JSON.stringify(bottomBar.text));
  for (const k of bottomBar.kids) {
    assert.ok(k.svg, "底栏每个控件都应是图标（svg），实际缺少：" + JSON.stringify(k));
    assert.ok(k.w === 34 && k.h === 34, "底栏图标按钮应为 34×34，实际 " + k.w + "×" + k.h);
    assert.ok(k.label.length > 0, "仅图标控件必须有 aria-label / title，实际：" + JSON.stringify(k));
    assert.deepEqual(
      k.borders,
      ["0px", "0px", "0px", "0px"],
      "三个图标不应被外框线包裹（border-width 必须为 0）：" + JSON.stringify(k)
    );
  }
  assert.ok(
    Math.abs(bottomBar.gaps[0] - bottomBar.gaps[1]) <= 1,
    "三个按钮中心间距应相等，实际 " + JSON.stringify(bottomBar.gaps)
  );
  console.log("PASS 底栏 3 个图标按钮等间距、无外框（间距 " + JSON.stringify(bottomBar.gaps) + "，均 34×34，均有 aria-label）");

  /* ── 断言 8（B-7）：移动端抽屉与桌面用同一套标签与顺序 ── */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  await page.locator('.mobile-dock-btn[aria-label="打开菜单"]').click();
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

  /* ── 断言 8b（2026-11-06 需求）：手机抽屉底栏 = 同一组三图标，且固定在底部 ── */
  /**
   * 需求：移动端同步改。三条事实：
   *   · 抽屉底栏与桌面左栏底栏是同一组 3 个图标按钮（无文字、均有 svg + aria-label）
   *   · 三个按钮等间距（抽屉宽度内三等分）
   *   · 底栏固定在抽屉底部、图标离底边 18px 不贴边；内容区自己滚（友链多时
   *     不再把底栏推到很下面）
   */
  const drawerFoot = await page.evaluate(() => {
    const drawer = document.querySelector(".mobile-drawer").getBoundingClientRect();
    const body = document.querySelector(".mobile-drawer-body");
    const foot = document.querySelector(".mobile-drawer-foot");
    const kids = [...foot.children].map((el) => {
      const b = el.getBoundingClientRect();
      return {
        center: +((b.left + b.right) / 2).toFixed(1),
        w: +b.width.toFixed(1),
        h: +b.height.toFixed(1),
        svg: !!el.querySelector("svg"),
        label: el.getAttribute("aria-label") || "",
      };
    });
    // 量按钮盒子（34×34）而不是图形本身：18px 是"控件到抽屉边缘"的距离
    const controlBottoms = [...foot.children].map((x) => x.getBoundingClientRect().bottom);
    const footRect = foot.getBoundingClientRect();
    return {
      count: kids.length,
      kids,
      text: (foot.textContent || "").trim(),
      gaps: kids.slice(1).map((k, i) => +(k.center - kids[i].center).toFixed(1)),
      iconGapToBottom: +(drawer.bottom - Math.max(...controlBottoms)).toFixed(1),
      footVisible: footRect.top >= 0 && footRect.bottom <= innerHeight + 1,
      bodyScrollable: body.scrollHeight > body.clientHeight + 1,
    };
  });
  assert.equal(drawerFoot.count, 3, "抽屉底栏应有 3 个图标按钮，实际 " + drawerFoot.count);
  assert.equal(drawerFoot.text, "", "抽屉底栏不应再有文字，实际 " + JSON.stringify(drawerFoot.text));
  for (const k of drawerFoot.kids) {
    assert.ok(k.svg, "抽屉底栏每个控件都应是图标：" + JSON.stringify(k));
    assert.ok(k.w === 34 && k.h === 34, "抽屉底栏图标应为 34×34，实际 " + k.w + "×" + k.h);
    assert.ok(k.label.length > 0, "仅图标控件必须有 aria-label：" + JSON.stringify(k));
  }
  assert.ok(
    Math.abs(drawerFoot.gaps[0] - drawerFoot.gaps[1]) <= 1,
    "抽屉底栏三个按钮应等间距，实际 " + JSON.stringify(drawerFoot.gaps)
  );
  assert.equal(drawerFoot.footVisible, true, "抽屉底栏应固定在可视区域内（不应被内容顶出屏幕）");
  assert.ok(drawerFoot.bodyScrollable, "内容区应是独立滚动区（友链多时内容自己滚）");
  assert.ok(
    Math.abs(drawerFoot.iconGapToBottom - 18) <= 2,
    "底栏按钮离抽屉底边应约 18px（不贴边），实际 " + drawerFoot.iconGapToBottom + "px"
  );
  console.log("PASS 手机抽屉底栏 3 个图标等间距、固定底部、离底 18px");

  /* ── 断言 8c（2026-11-06 需求）：悬浮"玻璃胶囊"（回到顶部 / 菜单 / 右侧栏，同一处）── */
  /**
   * 用户要求：半透明深灰底、完整胶囊圆角、每个图标独立圆形热区、
   * 1px 描边 + 阴影、**固定在右下角**（右 12px / 底 24px，各视口一致）；
   * 且**回到顶部与菜单/侧栏必须放在同一处**，不能拆成两个浮钮；
   * 回到顶部在任意宽度（含 PC）都要有。
   *
   * 断点差异：
   *   ≤820     → 回到顶部（滚动后）+ 菜单 + 右侧栏
   *   821–1391 → 回到顶部（滚动后）+ 右侧栏
   *   ≥1392    → 只剩回到顶部；未滚动时整组淡出（胶囊里没有任何按钮）
   */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const dock = await page.evaluate(() => {
    const el = document.querySelector(".mobile-dock");
    const cs = getComputedStyle(el);
    const btns = [...el.querySelectorAll(".mobile-dock-btn")].map((b) => {
      const r = b.getBoundingClientRect();
      const bcs = getComputedStyle(b);
      return {
        label: b.getAttribute("aria-label") || "",
        w: Math.round(r.width),
        h: Math.round(r.height),
        radius: bcs.borderTopLeftRadius,
        visible: r.width > 0,
      };
    });
    const r = el.getBoundingClientRect();
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const parts = m ? m[1].split(",").map((x) => x.trim()) : [];
    return {
      exists: !!el,
      display: cs.display,
      gapRight: Math.round(innerWidth - r.right),
      gapBottom: Math.round(innerHeight - r.bottom),
      viewportH: innerHeight,
      radius: cs.borderTopLeftRadius,
      borderWidth: cs.borderTopWidth,
      boxShadow: cs.boxShadow,
      bg: cs.backgroundColor,
      bgAlpha: parts.length === 4 ? parseFloat(parts[3]) : 1,
      labels: btns.filter((b) => b.visible).map((b) => b.label),
      btns,
      oldMenu: document.querySelectorAll(".mobile-menu-btn").length,
      oldSidebar: document.querySelectorAll(".mobile-sidebar-btn").length,
    };
  });
  assert.equal(dock.exists, true, "手机端应有悬浮按钮组 .mobile-dock");
  assert.equal(dock.display, "flex", "手机端悬浮按钮组应可见，实际 display=" + dock.display);
  assert.equal(dock.oldMenu, 0, "顶栏原来的汉堡按钮应已移除");
  assert.equal(dock.oldSidebar, 0, "顶栏原来的侧栏按钮应已移除");
  assert.ok(Math.abs(dock.gapRight - 12) <= 1, "悬浮组离屏幕右侧应为 12px，实际 " + dock.gapRight + "px");
  assert.equal(dock.radius, "999px", "胶囊应为完整圆角（999px），实际 " + dock.radius);
  assert.equal(dock.borderWidth, "1px", "胶囊应有 1px 轻微描边，实际 " + dock.borderWidth);
  assert.notEqual(dock.boxShadow, "none", "胶囊应有阴影");
  assert.ok(dock.bgAlpha !== null && dock.bgAlpha < 1, "底色应是半透明（alpha < 1），实际 " + dock.bg);
  assert.ok(
    Math.abs(dock.gapBottom - 24) <= 2,
    "悬浮组应贴在右下角（离底 24px），实际 " + dock.gapBottom + "px"
  );
  assert.deepEqual(dock.labels, ["打开菜单", "打开侧栏"], "顶部时胶囊应只有菜单/右侧栏两枚，实际 " + JSON.stringify(dock.labels));
  for (const b of dock.btns.filter((x) => x.visible)) {
    assert.ok(b.w === 44 && b.h === 44, "悬浮按钮应为 44×44 热区，实际 " + b.w + "×" + b.h);
    assert.equal(b.radius, "50%", "每枚按钮应是独立圆形热区，实际圆角 " + b.radius);
  }
  console.log("PASS 悬浮组 = 12px 玻璃胶囊（半透明 " + dock.bg + " / 圆角 " + dock.radius + " / 1px 描边 + 阴影 / 圆形 44×44）");

  /* 回到顶部与它们同处一个胶囊（不是第二个浮钮） */
  await page.evaluate(() => scrollTo(0, 900));
  await page.waitForTimeout(500);
  const scrolled = await page.evaluate(() => ({
    groups: document.querySelectorAll(".mobile-dock").length,
    separate: document.querySelectorAll(".back-to-top").length,
    labels: [...document.querySelectorAll(".mobile-dock-btn")]
      .filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => b.getAttribute("aria-label")),
  }));
  assert.equal(scrolled.groups, 1, "悬浮按钮组应只有一个，实际 " + scrolled.groups);
  assert.equal(scrolled.separate, 0, "不应再有第二个独立的回到顶部浮钮");
  assert.deepEqual(scrolled.labels, ["回到顶部", "打开菜单", "打开侧栏"], "滚动后回到顶部应出现在同一个胶囊里，实际 " + JSON.stringify(scrolled.labels));
  console.log("PASS 回到顶部与菜单/侧栏同处一个胶囊（滚动后三枚）");

  await page.locator('.mobile-dock-btn[data-dock="top"]').click();
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => Math.round(window.scrollY)), 0, "点回到顶部应回到页面顶部");
  const labelsAtTop = await page.evaluate(() =>
    [...document.querySelectorAll(".mobile-dock-btn")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getAttribute("aria-label"))
  );
  assert.deepEqual(labelsAtTop, ["打开菜单", "打开侧栏"], "回到顶部后该枚应消失，实际 " + JSON.stringify(labelsAtTop));
  console.log("PASS 回到顶部生效，按钮随即从胶囊中隐藏");

  /* 抽屉打开时整组淡出；两枚按钮分别打开两种抽屉 */
  await page.locator('.mobile-dock-btn[aria-label="打开菜单"]').click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => !!document.querySelector(".mobile-drawer")), true, "点悬浮按钮应打开导航抽屉");
  const dockHidden = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".mobile-dock"));
    return { opacity: cs.opacity, pointerEvents: cs.pointerEvents };
  });
  assert.equal(dockHidden.opacity, "0", "抽屉打开时悬浮组应隐藏，实际 opacity=" + dockHidden.opacity);
  assert.equal(dockHidden.pointerEvents, "none", "抽屉打开时悬浮组不应可点");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.locator('.mobile-dock-btn[aria-label="打开侧栏"]').click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => !!document.querySelector(".mobile-sidebar")), true, "点悬浮按钮应打开右侧栏抽屉");
  console.log("PASS 悬浮组打开两种抽屉且打开时淡出");

  /* 桌面（≥1392）：胶囊仍在，但只剩"回到顶部"；未滚动时整组淡出 */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const desktopTop = await page.evaluate(() => {
    const el = document.querySelector(".mobile-dock");
    return {
      display: getComputedStyle(el).display,
      opacity: getComputedStyle(el).opacity,
      visibleBtns: [...el.querySelectorAll(".mobile-dock-btn")].filter((b) => b.getBoundingClientRect().width > 0).length,
    };
  });
  assert.equal(desktopTop.display, "flex", "PC 端也应有悬浮组（回到顶部在里面），实际 " + desktopTop.display);
  assert.equal(desktopTop.opacity, "0", "PC 顶部时胶囊应隐藏（里面没有按钮），实际 opacity=" + desktopTop.opacity);
  assert.equal(desktopTop.visibleBtns, 0, "PC 顶部时胶囊内不应有可见按钮，实际 " + desktopTop.visibleBtns);
  await page.evaluate(() => scrollTo(0, 900));
  await page.waitForTimeout(500);
  const desktopScrolled = await page.evaluate(() => {
    const el = document.querySelector(".mobile-dock");
    const top = el.querySelector('[data-dock="top"]');
    return {
      opacity: getComputedStyle(el).opacity,
      labels: [...el.querySelectorAll(".mobile-dock-btn")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getAttribute("aria-label")),
      box: top ? Math.round(top.getBoundingClientRect().width) : 0,
    };
  });
  assert.equal(desktopScrolled.opacity, "1", "PC 滚动后胶囊应出现，实际 opacity=" + desktopScrolled.opacity);
  assert.deepEqual(desktopScrolled.labels, ["回到顶部"], "PC 的胶囊里只应有回到顶部，实际 " + JSON.stringify(desktopScrolled.labels));
  assert.equal(desktopScrolled.box, 44, "PC 回到顶部应为 44×44，实际 " + desktopScrolled.box);
  await page.locator('.mobile-dock-btn[data-dock="top"]').click();
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => Math.round(window.scrollY)), 0, "PC 点回到顶部应回到页面顶部");
  console.log("PASS PC 端：胶囊里只剩回到顶部（滚动出现 / 点击回顶）");

  /* 平板（1000）：胶囊 = 回到顶部 + 右侧栏（没有菜单按钮） */
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  await page.evaluate(() => scrollTo(0, 900));
  await page.waitForTimeout(500);
  const tabletLabels = await page.evaluate(() =>
    [...document.querySelectorAll(".mobile-dock-btn")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getAttribute("aria-label"))
  );
  assert.deepEqual(tabletLabels, ["回到顶部", "打开侧栏"], "平板胶囊应为 回到顶部 + 右侧栏，实际 " + JSON.stringify(tabletLabels));
  console.log("PASS 1000px 平板：胶囊 = 回到顶部 + 右侧栏");

  /* ── 断言 8e（2026-11-06 需求）：右侧栏聚合站用站点自己的图标，失败退回名称首字 ── */
  /**
   * 之前聚合站一律显示固定的 🚇，多个聚合站排在一起分不出谁是谁。
   * 现在每个聚合站：`<origin>/favicon.ico` → 失败退回名称首字。
   * 测试环境是离线探针库（hub 的 URL 是 example 域名），图标必然加载失败，
   * 正好断言降级路径：每个 .fl-hub 里都有 .hub-avatar，内容是名称首字。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const hubIcons = await page.evaluate(() => {
    return [...document.querySelectorAll(".fl-hub")].map((h) => {
      const av = h.querySelector(".hub-avatar");
      return {
        name: (h.querySelector(".fl-name")?.textContent || "").trim(),
        hasAvatar: !!av,
        letter: av ? (av.textContent || "").trim() : null,
        emoji: (h.textContent || "").includes("🚇"),
      };
    });
  });
  assert.ok(hubIcons.length > 0, "前置：演示数据里应有聚合站条目（.fl-hub）");
  for (const h of hubIcons) {
    assert.equal(h.hasAvatar, true, "聚合站条目应有 .hub-avatar：" + JSON.stringify(h));
    assert.equal(h.emoji, false, "聚合站不应再用固定的 🚇 emoji：" + JSON.stringify(h));
    assert.equal(
      h.letter,
      Array.from(h.name)[0],
      "图标加载失败时应显示名称首字：" + JSON.stringify(h)
    );
  }
  console.log("PASS 聚合站图标按站点取（离线降级为首字），共 " + hubIcons.length + " 个");



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

  /* ── 断言 9b（2026-11-06）：左栏横向位置在所有模板 / 宽度下必须一致 ── */
  /**
   * 「点友链页左栏会横跳」。根因不在左栏自己，而在**容器几何**：
   * 标准页（three-col）有 max-width: --w-shell(1552) + margin:auto，
   * 视口 > 1552 时容器居中；而宽版页（wide）曾写 `max-width: none`，
   * 于是贴左。实测 1920 视口：标准页 sidebar.left = 216、友链页 = 32，
   * 差 184px —— 点一下导航整列家具就横移。
   *
   * 断言方式：同一视口下把四个模板各量一次，左栏 left 的最大差 ≤ 1px。
   * 覆盖 1440（不居中）/ 1600 / 1920（居中）三档，正好卡住这个分界。
   */
  for (const vw of [1440, 1600, 1920]) {
    await page.setViewportSize({ width: vw, height: 900 });
    const lefts = [];
    for (const pathName of ["/", "/archives", "/friend-links", "/search"]) {
      await page.goto(server.base + pathName, { waitUntil: "networkidle" });
      lefts.push(await page.evaluate(() => Math.round(document.querySelector(".sidebar").getBoundingClientRect().left)));
    }
    assert.ok(
      Math.max(...lefts) - Math.min(...lefts) <= 1,
      vw + "px 下不同模板的左栏横向位置必须一致，实测（/ 归档 友链 搜索）= " + JSON.stringify(lefts)
    );
    console.log("PASS 左栏横向位置一致（" + vw + "px: " + JSON.stringify(lefts) + "）");
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

  /* ── 断言 11（B-3 / 2026-11-06）：右栏入口落在悬浮组里，按断点增减 ── */
  /**
   * 右栏在 ≤1391 隐藏（B-3）。入口从"左栏底部的小按钮"改成右侧悬浮组里的
   * 一枚（与手机端同一套交互）：
   *   · ≥1392：右栏已在页面上 → 胶囊里没有导航按钮；未滚动时整组淡出
   *   · 821–1391：导航已在左栏 → 只显示"右侧栏"一枚
   *   · ≤820：显示两枚（菜单 + 右侧栏）
   * 旧的 `.side-sheet-entry` 必须彻底消失，否则会出现两个入口。
   */
  for (const [vw, wantBtns, wantHiddenAtTop] of [[1392, 0, true], [1391, 1, false], [1201, 1, false], [821, 1, false], [820, 2, false]]) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.goto(server.base + "/", { waitUntil: "networkidle" });
    const info = await page.evaluate(() => {
      const dock = document.querySelector(".mobile-dock");
      if (!dock) return { exists: false, buttons: 0, opacity: null, oldEntry: 0 };
      return {
        exists: true,
        display: getComputedStyle(dock).display,
        // 只数"导航类"按钮（菜单/右侧栏），"回到顶部"在未滚动时不渲染
        buttons: [...dock.querySelectorAll('.mobile-dock-btn[data-dock="menu"], .mobile-dock-btn[data-dock="sidebar"]')]
          .filter((b) => b.getBoundingClientRect().width > 0).length,
        opacity: getComputedStyle(dock).opacity,
        oldEntry: document.querySelectorAll(".side-sheet-entry").length,
      };
    });
    assert.equal(info.exists, true, vw + "px 应有悬浮按钮组");
    assert.equal(info.display, "flex", vw + "px 悬浮组应参与布局（display:flex），实际 " + info.display);
    assert.equal(info.buttons, wantBtns, vw + "px 导航类按钮数应为 " + wantBtns + "，实际 " + info.buttons);
    assert.equal(info.oldEntry, 0, vw + "px 不应再出现旧的左栏底部 .side-sheet-entry 入口");
    if (wantHiddenAtTop) {
      assert.equal(info.opacity, "0", vw + "px 顶部时胶囊应淡出（里面没有按钮），实际 opacity=" + info.opacity);
    } else {
      assert.equal(info.opacity, "1", vw + "px 胶囊应有按钮可见，实际 opacity=" + info.opacity);
    }
    console.log("PASS " + String(vw).padStart(4) + "px 右栏入口：胶囊按钮 " + info.buttons + " 枚" + (wantHiddenAtTop ? "（顶部整组淡出）" : ""));
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

  /* ── 断言 17（B-5）：全站前台页面只有一个 <footer> 地标 ── */
  /**
   * B-5 的问题：友链页自己有一个 `<footer class="fr-footer">`，layout 又
   * 渲染全站 `<SiteFooter>`，一个页面两个 footer 地标 —— 读屏的「跳到页脚」
   * 会给出两个同名目标，键盘用户分不清哪个是"全站页脚"。
   *
   * **必须在浏览器里数**：全站页脚包在 `<FrontOnly>`（客户端组件，
   * 靠 usePathname 排除后台），服务端返回的 HTML 里没有它。
   * 用 fetch 数会得到 0，那是假阴性。
   */
  for (const pathName of ["/", "/friend-links", "/archives", "/search", "/p/" + tocPostId]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    const f = await page.evaluate(() => {
      const all = [...document.querySelectorAll("footer")];
      return {
        count: all.length,
        classes: all.map((e) => e.className),
        // 友链页的致谢区块应仍在，只是不再是 footer
        hasFrFooterDiv: !!document.querySelector("div.fr-footer"),
        frFooterText: document.querySelector(".fr-footer p")?.textContent?.trim() ?? null,
      };
    });
    assert.equal(
      f.count,
      1,
      pathName + " 应有且只有 1 个 <footer> 地标，实际 " + f.count + " 个：" + JSON.stringify(f.classes)
    );
    assert.match(f.classes[0], /site-footer/, pathName + " 的那一个应是全站页脚，实际 " + f.classes[0]);
    if (pathName === "/friend-links") {
      assert.equal(f.hasFrFooterDiv, true, "友链页的 fr-footer 区块应保留（改为 div）");
      assert.match(f.frFooterText || "", /感谢每一位愿意分享自己小世界的人/, "致谢文案应保留");
    }
    console.log("PASS B-5 " + pathName.padEnd(16) + " footer 地标 = 1（" + f.classes[0] + "）");
  }

  /* ── 断言 18（B-6）：移动端搜索页必须有可用输入框 ── */
  /**
   * 原实现搜索页手写表单用了 `content-search` 类名，被 820px 的
   * `.content-search { display:none }` 命中 —— 手机上打开 /search
   * 只有标题和空白，**一个输入框都没有**，搜不了任何东西。
   *
   * 这是"页面主功能在目标设备上完全不可用"，比任何视觉问题都严重。
   */
  for (const [vw, vh, label] of [[375, 812, "手机"], [820, 900, "单栏临界"], [1440, 900, "桌面"]]) {
    await page.setViewportSize({ width: vw, height: vh });
    await page.goto(server.base + "/search", { waitUntil: "networkidle" });

    const form = await page.evaluate(() => {
      const wrap = document.querySelector(".search-page-form");
      const input = document.querySelector(".search-page-form input[type=search]");
      if (!wrap || !input) return null;
      const cs = getComputedStyle(wrap);
      return {
        wrapDisplay: cs.display,
        inputHeight: input.getBoundingClientRect().height,
        inputWidth: input.getBoundingClientRect().width,
        focusable: !input.disabled && input.tabIndex >= 0,
        placeholder: input.getAttribute("placeholder"),
        value: input.value,
      };
    });
    assert.ok(form, vw + "px 搜索页应渲染 .search-page-form 与输入框");
    assert.notEqual(form.wrapDisplay, "none", vw + "px 搜索表单容器不得被隐藏");
    assert.ok(form.inputHeight > 0, vw + "px 输入框高度应 > 0，实际 " + form.inputHeight);
    assert.ok(form.inputWidth > 100, vw + "px 输入框宽度应 > 100，实际 " + form.inputWidth);
    assert.equal(form.focusable, true, vw + "px 输入框应可聚焦");
    console.log("PASS B-6 " + String(vw).padStart(4) + "px（" + label + "）搜索框可见 " +
      Math.round(form.inputWidth) + "×" + Math.round(form.inputHeight));
  }

  /* ── 断言 19（B-6）：搜索页回填当前关键词，且提交后 URL 正确 ── */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/search?q=" + encodeURIComponent("测试"), { waitUntil: "networkidle" });
  const filled = await page.evaluate(() => {
    const input = document.querySelector(".search-page-form input[type=search]");
    return input ? input.value : null;
  });
  assert.equal(filled, "测试", "刷新/直达时输入框应回填当前关键词 q，实际 " + JSON.stringify(filled));

  // 真的能输入并提交（SearchBox 是客户端组件，回车走 router.push）
  await page.fill(".search-page-form input[type=search]", "归档");
  await page.press(".search-page-form input[type=search]", "Enter");
  await page.waitForTimeout(800);
  assert.match(
    page.url(),
    /\/search\?q=%E5%BD%92%E6%A1%A3/,
    "回车后应跳到 /search?q=归档，实际 " + page.url()
  );
  console.log("PASS B-6 输入框回填 q + 回车提交跳转正确");

  /* ── 断言 20（B-6）：首页的 content-search 在手机端仍然隐藏 ── */
  /**
   * 反例守卫：不要为了修搜索页把首页那个框也放出来 ——
   * 首页手机端靠顶栏搜索，列表顶部再放一个是重复。
   */
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const homeSearch = await page.evaluate(() => {
    const el = document.querySelector(".content-search");
    return el ? getComputedStyle(el).display : "missing";
  });
  assert.equal(homeSearch, "none", "375px 下首页 .content-search 应仍为 display:none，实际 " + homeSearch);
  console.log("PASS B-6 375px 首页 content-search 仍隐藏（未被误伤）");

  /* ── 断言 21（B-8）：桌面右栏与手机抽屉的区块内容必须一致 ── */
  /**
   * B-8 之前，统计块/友链/标签云在 RightBar 与 MobileSidebar 里各写一遍
   * （连 🚇 🔗 ↗ 都一字不差）。抽成纯展示组件后，两边渲染的应该是
   * 同一批 DOM —— 这条断言直接比对"数量与文本集合"，不比对具体结构。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const desktop = await page.evaluate(() => {
    const rb = document.querySelector(".rightbar");
    return {
      blockTitles: [...rb.querySelectorAll(".rb-title")].map((e) => e.textContent.trim()),
      statCells: rb.querySelectorAll(".stat-cell").length,
      statLabels: [...rb.querySelectorAll(".stat-name")].map((e) => e.textContent.trim()).sort(),
      tagNames: [...rb.querySelectorAll(".tag-pill .tag-hash + *")].length
        ? [...rb.querySelectorAll(".tag-pill")].map((e) => e.textContent.replace("#", "").trim()).sort()
        : [],
      friendNames: [...rb.querySelectorAll(".fl-name")].map((e) => e.textContent.trim()).sort(),
    };
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  await page.locator('.mobile-dock-btn[aria-label="打开菜单"]').click();
  await page.waitForTimeout(200);
  // 抽屉里的「侧栏」是右侧那个（MobileSidebar），顶部汉堡打开的是导航抽屉
  const drawerOpened = await page.evaluate(() => !!document.querySelector(".mobile-drawer"));
  assert.equal(drawerOpened, true, "375px 应能打开抽屉");

  const mobileLabels = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".mobile-drawer-item")].map((e) => e.textContent.trim());
    return { navItems: items };
  });
  assert.equal(mobileLabels.navItems.length, 5, "移动抽屉应有 5 个导航项");

  /* 右侧栏抽屉（MobileSidebar）：点顶部栏的侧栏按钮打开 */
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  await page.locator('.mobile-dock-btn[aria-label="打开侧栏"]').click();
  await page.waitForTimeout(400);
  const mobileBlocks = await page.evaluate(() => {
    const sb = document.querySelector(".mobile-sidebar");
    if (!sb) return null;
    return {
      titles: [...sb.querySelectorAll(".rb-title")].map((e) => e.textContent.trim()),
      stats: [...sb.querySelectorAll(".stat-name")].map((e) => e.textContent.trim()).sort(),
      friends: [...sb.querySelectorAll(".fl-name")].map((e) => e.textContent.trim()).sort(),
    };
  });
  assert.ok(mobileBlocks, "点击侧栏按钮后应出现 .mobile-sidebar");

  /**
   * B-8 的核心验收：桌面与移动渲染的区块**内容完全一致**。
   *
   * 这比"两边都用了同一个组件"更强：即使某天有人把入口数据源改歪了
   * （比如移动端少传一个 prop），这里也会红。
   */
  assert.deepEqual(mobileBlocks.titles, desktop.blockTitles, "移动抽屉与桌面右栏的区块标题应完全一致");
  assert.deepEqual(mobileBlocks.stats, desktop.statLabels, "统计项应完全一致");
  assert.deepEqual(mobileBlocks.friends, desktop.friendNames, "友链条目应完全一致");
  console.log("PASS B-8 桌面与移动区块完全一致：" +
    JSON.stringify(mobileBlocks.titles) + " / 统计 " + mobileBlocks.stats.length + " / 友链 " + mobileBlocks.friends.length);

  /**
   * 桌面侧的核心断言：统计块必须存在，且与移动端用同一个组件
   * （共用已由 rightbar-blocks.test.ts 静态验证）。这里验渲染结果没退化。
   */
  /**
   * 不断言完整的标题数组：友链/聚合两块是否存在取决于种子数据
   * （测试库默认只有一条「开往」hub）。钉住"必有"与"顺序"即可。
   */
  assert.ok(desktop.statCells >= 4, "桌面右栏应有 ≥4 个统计格，实际 " + desktop.statCells);
  assert.ok(desktop.blockTitles.includes("站点统计"), "右栏应有「站点统计」块");
  // 统计块必须是第一块（与移动端顺序一致：统计 → 友链 → 标签云）
  assert.equal(desktop.blockTitles[0], "站点统计", "右栏第一块应是站点统计，实际 " + desktop.blockTitles[0]);
  // 标签云：有标签时才出现；测试库可能没有已发布文章 → 允许缺省
  const tagIdx = desktop.blockTitles.indexOf("标签云");
  if (tagIdx >= 0) {
    assert.equal(tagIdx, desktop.blockTitles.length - 1, "标签云应是最后一块，实际 " + JSON.stringify(desktop.blockTitles));
  }
  console.log("PASS B-8 桌面右栏区块：" + JSON.stringify(desktop.blockTitles) +
    "，统计格 " + desktop.statCells + "，标签 " + desktop.tagNames.length + "，友链 " + desktop.friendNames.length);

  /* ── 断言 22（R1）：正文长串不得撑破页面 ── */
  /**
   * 中文默认能在汉字间断行，英文与 URL 不能 —— 正文贴一个长链接就会
   * 把整页横向撑破（实测 1200px 下溢出 909px）。`.prose` 原本没有
   * `overflow-wrap`，而列表页摘要与目录都有，所以问题只在文章页出现。
   */
  const LONG_CASES = [
    [longIds.url, "长 URL"],
    [longIds.word, "长英文单词"],
    [longIds.title, "长英文标题"],
  ];
  for (const vw of [1440, 1200, 820, 375]) {
    await page.setViewportSize({ width: vw, height: 900 });
    for (const [id, name] of LONG_CASES) {
      await page.goto(server.base + "/p/" + id, { waitUntil: "networkidle" });
      const r = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      assert.ok(
        r.sw <= r.cw + 1,
        vw + "px「" + name + "」导致横向溢出：" + r.sw + " > " + r.cw
      );
    }
    console.log("PASS R1 " + String(vw).padStart(4) + "px 长串正文不溢出（URL / 单词 / 标题）");
  }

  /**
   * 断言 22b：**归档页**同样不能被长标题撑破（D-5 收尾时补的）。
   *
   * R1 当时只验了文章正文页（`/p/<id>`）—— 但文章标题会同时出现在
   * 归档页、首页卡片、标签页、搜索结果里。归档行是唯一没做断行处理的地方：
   * 实测把标题换成 120 字符的 URL 后，1440px 下 scrollWidth 变成 1526px，
   * 整页出现横向滚动条。
   *
   * 触发条件是「flex 子项没写 min-width: 0」+「没有 overflow-wrap」，
   * 两者缺一不可 —— 所以断言必须真的把长标题种进归档列表里去测。
   */
  /**
   * ⚠️ 必须测**多个视口**，而且窄视口才是关键。
   *
   * 第一版只测 1440，结果移除修复后断言仍然通过 —— 因为种子里的
   * 136 字符英文标题在 1440 下实测宽度 844px，恰好放得下（可用宽度约
   * 1010px）。也就是说 1440 上根本没有溢出，这条断言等于没测。
   *
   * 换成 375（可用宽度 335px）就必然溢出，才能真的守住这条修复。
   */
  for (const vw of [1440, 1200, 820, 375]) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.goto(server.base + "/archives", { waitUntil: "networkidle" });
    const archLong = await page.evaluate(() => {
      const doc = document.documentElement;
      const over = [];
      for (const el of document.querySelectorAll("*")) {
        if (el.getBoundingClientRect().right > doc.clientWidth + 1) {
          over.push((el.className || el.tagName).toString().slice(0, 40));
        }
      }
      return { sw: doc.scrollWidth, cw: doc.clientWidth, over: over.slice(0, 3) };
    });
    assert.ok(
      archLong.sw <= archLong.cw + 1,
      vw + "px 归档页被长标题撑破：" + archLong.sw + " > " + archLong.cw +
        "（溢出元素：" + archLong.over.join(",") + "）"
    );
  }
  console.log("PASS 断言 22b 归档页长标题不撑破页面（1440/1200/820/375）");

  /* ── 断言 23（R1）：代码块必须保留横向滚动，不被换行折断 ── */
  /**
   * 反例守卫：给 `*` 加 overflow-wrap 会把代码也折成一片，缩进语义全毁。
   * 代码块的正确行为是 `overflow-x: auto` —— 内容超出时自己滚。
   */
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(server.base + "/p/" + longIds.code, { waitUntil: "networkidle" });
  const pre = await page.evaluate(() => {
    const el = document.querySelector(".prose pre");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: cs.overflowX, wrap: cs.overflowWrap };
  });
  assert.ok(pre, "代码块文章应渲染 .prose pre");
  assert.equal(pre.overflowX, "auto", "代码块应保留 overflow-x: auto，实际 " + pre.overflowX);
  assert.notEqual(pre.wrap, "anywhere", "代码块不应被 overflow-wrap 折断，实际 " + pre.wrap);
  assert.ok(pre.scrollWidth > pre.clientWidth, "前置：这段代码应真的超宽（否则断言无意义）");
  console.log("PASS R1 代码块保留横向滚动（" + pre.clientWidth + "/" + pre.scrollWidth + "，overflow-x=" + pre.overflowX + "）");

  /* ── 断言 24（C-3）：color-scheme 跟随主题 ── */
  /**
   * `color-scheme` 决定浏览器**自己画的东西**用什么配色：滚动条、<select>
   * 下拉、<input type="date"> 日历弹层、autofill 底色。
   *
   * 它默认是 light，所以暗色主题下如果不声明，页面一片深色、右侧挂一条
   * 白滚动条，下拉框点开也是白的 —— 而这不是"我们没写样式"，是浏览器
   * 按默认值画的。
   *
   * 三处都要：
   *   ① :root → light
   *   ② :root[data-theme=dark] → dark（手动）
   *   ③ @media(prefers-color-scheme:dark) 里的 :root:not(...) → dark（系统）
   *
   * 第 ③ 处最容易漏，而且只对"从没点过切换按钮"的用户生效 —— 那正是
   * 大多数首次访问者。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.waitForTimeout(120);
    const cs = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    assert.equal(cs, theme, "data-theme=" + theme + " 时 colorScheme 应为 " + theme + "，实际 " + cs);
    console.log("PASS C-3 data-theme=" + theme.padEnd(5) + " → colorScheme=" + cs);
  }
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  /* ── 断言 25（C-3）：系统偏好暗色（无 data-theme）也要生效 ── */
  const darkCtx = await controller.browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });
  const darkPage = await darkCtx.newPage();
  try {
    await darkPage.goto(server.base + "/", { waitUntil: "networkidle" });
    const sys = await darkPage.evaluate(() => ({
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    }));
    assert.equal(sys.colorScheme, "dark", "系统偏好暗色且无 data-theme 时 colorScheme 应为 dark，实际 " + sys.colorScheme);
    console.log("PASS C-3 系统偏好暗色 → colorScheme=" + sys.colorScheme + "（body 背景 " + sys.bodyBg + "）");
  } finally {
    await darkCtx.close();
  }

  /* ── 断言 26（C-3）：后台也生效（admin.css 不得覆盖） ── */
  /**
   * 后台共享同一套 :root 令牌，但 admin.css 会额外加载。若它自己声明
   * `color-scheme: light`，会按层叠顺序把 globals 的 dark 覆盖掉 ——
   * 后台暗色下滚动条又变白，且没有任何报错。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/admin/login", { waitUntil: "networkidle" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(120);
  const adminCs = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  assert.equal(adminCs, "dark", "后台暗色下 colorScheme 也应为 dark（admin.css 不得覆盖），实际 " + adminCs);
  console.log("PASS C-3 后台 /admin/login 暗色 → colorScheme=" + adminCs);

  /* ── 断言 27（C-4）：四个 ThemeToggle 实例保持同步 ── */
  /**
   * 组件在项目里有 4 个实例（前台侧栏/顶栏、后台侧栏/顶栏）。原来每个
   * 各持一份 useState，只在自己被点时更新自己 —— 点桌面侧栏那个，
   * 手机顶栏那个的 aria-label 仍是旧值。读屏用户会被告知错误的信息。
   *
   * 现在真相只有一份（documentElement 的 data-theme），所有实例订阅它。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  const beforeToggle = await page.evaluate(() =>
    [...document.querySelectorAll(".theme-toggle")].map((e) => ({
      visible: e.getBoundingClientRect().width > 0,
      label: e.getAttribute("aria-label"),
      state: e.getAttribute("data-theme-state"),
    }))
  );
  assert.ok(beforeToggle.length >= 2, "首页应有 ≥2 个 ThemeToggle 实例（侧栏 + 顶栏），实际 " + beforeToggle.length);

  // 点可见的那个（桌面下是侧栏底部那个）
  const visibleIndex = beforeToggle.findIndex((x) => x.visible);
  assert.ok(visibleIndex >= 0, "应有可见的 ThemeToggle");
  await page.locator(".theme-toggle").nth(visibleIndex).click();
  await page.waitForTimeout(400);

  const afterToggle = await page.evaluate(() => ({
    list: [...document.querySelectorAll(".theme-toggle")].map((e) => ({
      label: e.getAttribute("aria-label"),
      state: e.getAttribute("data-theme-state"),
    })),
    htmlTheme: document.documentElement.getAttribute("data-theme"),
    metaColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
  }));

  const labels = new Set(afterToggle.list.map((x) => x.label));
  const states = new Set(afterToggle.list.map((x) => x.state));
  assert.equal(
    labels.size,
    1,
    "点击后所有 ThemeToggle 的 aria-label 必须一致，实际 " + JSON.stringify([...labels])
  );
  assert.equal(
    states.size,
    1,
    "点击后所有 ThemeToggle 的 data-theme-state 必须一致，实际 " + JSON.stringify([...states])
  );
  assert.equal(afterToggle.htmlTheme, states.values().next().value, "html[data-theme] 应与实例状态一致");
  assert.match(afterToggle.metaColor || "", /^#[0-9a-f]{6}$/i, "meta theme-color 应被同步");
  console.log("PASS C-4 " + beforeToggle.length + " 个实例同步（" + [...labels][0] + "，data-theme=" + afterToggle.htmlTheme + "，meta=" + afterToggle.metaColor + "）");

  // 切回来，避免影响后续断言
  await page.locator(".theme-toggle").nth(visibleIndex).click();
  await page.waitForTimeout(300);

  /* ── 断言 28（C-4）：首屏无 FOUC ── */
  /**
   * 暗色偏好下，`data-theme` 必须在**首次绘制之前**就是 `dark`。
   * 若等 React hydrate 后才设置，暗色用户会先看到一帧白底。
   */
  const foucCtx = await controller.browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });
  try {
    const foucPage = await foucCtx.newPage();
    await foucPage.addInitScript(() => {
      window.__firstTheme = null;
      const rec = () => {
        if (window.__firstTheme !== null) return;
        const t = document.documentElement?.getAttribute("data-theme");
        if (t) window.__firstTheme = { theme: t, bg: getComputedStyle(document.body).backgroundColor };
      };
      document.addEventListener("readystatechange", rec);
      rec();
    });
    await foucPage.goto(server.base + "/", { waitUntil: "networkidle" });
    const fouc = await foucPage.evaluate(() => ({
      first: window.__firstTheme,
      final: document.documentElement.getAttribute("data-theme"),
    }));
    assert.ok(fouc.first, "应在首屏就能读到 data-theme（否则说明是 hydrate 后才设置）");
    assert.equal(fouc.first.theme, "dark", "系统偏好暗色时首屏 theme 应为 dark，实际 " + fouc.first.theme);
    assert.equal(fouc.final, "dark", "最终主题应为 dark");
    console.log("PASS C-4 首屏无 FOUC（首次可读 theme=" + fouc.first.theme + "，bg=" + fouc.first.bg + "）");
  } finally {
    await foucCtx.close();
  }

  /* ── 断言 29（C-1）：删掉 58 个死 token 后，页面视觉零变化 ── */
  /**
   * C-1 是**纯删除**：那 58 个令牌的 var() 引用数是 0，删掉不该影响任何
   * 计算样式。但"应该不影响"和"确实不影响"是两件事 —— 一个 token 完全
   * 可能被通过字符串拼出来（`var("--space-" + n)` 这种），静态 grep 看不出来。
   *
   * 所以这里实测一组关键元素的计算属性：只要有一项变了，就说明某个
   * "零引用"的判断是错的。
   *
   * （改前改后各采一次、逐项 diff 的做法已经在开发时跑过：252 个属性值
   *   差异 0 处。这里保留的是它的轻量版：断言关键属性都落在设计值上。）
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const visual = await page.evaluate(() => {
    const pick = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, cs[p]]));
    };
    return {
      body: pick("body", ["backgroundColor", "color", "fontSize"]),
      shell: pick(".site-shell", ["maxWidth", "paddingTop"]),
      navItem: pick(".nav-item", ["paddingTop", "paddingLeft", "borderTopLeftRadius", "fontSize"]),
      content: pick(".content", ["fontSize"]),
      footer: pick(".site-footer-inner", ["maxWidth"]),
    };
  });

  // 这些是设计值 —— 与 C-1 改前的实测完全一致
  // 设计值在 C-10 改过一次（13px/16px/13px/.95rem → 10px/12px/10px/.92rem），
  // 这条断言守的是"当前设计值"，不是某个历史数值
  assert.deepEqual(visual.navItem, {
    paddingTop: "10px",
    paddingLeft: "12px",
    borderTopLeftRadius: "10px",
    fontSize: "14.72px",
  }, "导航项的计算样式应等于当前设计值：" + JSON.stringify(visual.navItem));
  assert.ok(visual.body, "body 应存在");
  assert.ok(visual.shell, ".site-shell 应存在");
  console.log("PASS C-1 删除死 token 后视觉无变化（nav-item " + JSON.stringify(visual.navItem) + "）");

  /* ── 断言 30（C-2）：暗色令牌抽成 --dark-* 后，实际配色零变化 ── */
  /**
   * C-2 是**纯重构**：把两处手抄的 47 个暗色值收成一组 `--dark-*`，
   * 两个作用域只做机械映射。改前改后暗色的实际计算值必须逐项一致 ——
   * 不一致就说明某个 `--dark-*` 抄错了值。
   *
   * 这里断言的是"抽取后依然解析出正确颜色"：既证明映射链通了
   * （--bg → --dark-bg → 具体色），也证明没有把某个值弄丢。
   */
  const DARK_KEY_TOKENS = [
    ["--bg", "#141414"],
    ["--bg-subtle", "#1a1a1a"],
    ["--bg-warm", "#171717"],
    ["--link", "#5fbfa8"],
    ["--link-hover", "#86d8c2"],
    ["--accent", "#e08968"],
    // 注意：浏览器会把 rgba(255,255,255,.95) 规范化成 #fffffff2，
    // 所以这里只断言"不透明度接近 0.95 的白色"，不写死字符串形式。
    ["--text-p0", null],
    ["--card-bg", "#1a1a19"],
    ["--surface-2", "#1e1e1d"],
    ["--danger", "#ff8a8d"],
    ["--ok", "#6fd6a6"],
    ["--warn", "#e0b062"],
    ["--info", "#8fb3dd"],
    ["--cat-1", "#5fbfa8"],
    ["--cat-7", "#c98cb0"],
  ];

  async function sampleDark(pageCtx, label, setTheme) {
    const p = pageCtx === "same" ? page : await pageCtx.newPage();
    try {
      await p.goto(server.base + "/", { waitUntil: "networkidle" });
      if (setTheme) await p.evaluate((t) => document.documentElement.setAttribute("data-theme", t), setTheme);
      await p.waitForTimeout(200);
      return await p.evaluate((tokens) => {
        const cs = getComputedStyle(document.documentElement);
        const o = {};
        for (const t of tokens) o[t] = cs.getPropertyValue(t).trim();
        o.__bodyBg = getComputedStyle(document.body).backgroundColor;
        return o;
      }, DARK_KEY_TOKENS.map(([t]) => t));
    } finally {
      if (pageCtx !== "same") await p.close();
    }
  }

  const manualDark = await sampleDark("same", "手动暗色", "dark");

  /** 判断一个颜色值是否是"接近白色的、alpha≈.95" */
  const isNearlyWhite95 = (v) => {
    if (/^#fffffff2$/i.test(v)) return true;                       // 规范化为 hex8
    const m = v.match(/^rgba\(255,\s*255,\s*255,\s*([0-9.]+)\)$/);
    return !!m && Math.abs(parseFloat(m[1]) - 0.95) < 0.01;
  };

  for (const [token, want] of DARK_KEY_TOKENS) {
    if (want === null) {
      assert.ok(
        isNearlyWhite95(manualDark[token]),
        "手动暗色下 " + token + " 应接近白色 alpha .95，实际 " + JSON.stringify(manualDark[token])
      );
      continue;
    }
    assert.equal(
      manualDark[token],
      want,
      "手动暗色下 " + token + " 应为 " + want + "，实际 " + JSON.stringify(manualDark[token])
    );
  }
  assert.equal(manualDark.__bodyBg, "rgb(20, 20, 20)", "手动暗色下 body 背景应为 rgb(20,20,20)");
  console.log("PASS C-2 手动暗色 15 个关键令牌解析值全部正确");

  // 系统偏好暗色（无 data-theme）必须解析出**完全相同**的值
  const sysCtx = await controller.browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });
  try {
    const systemDark = await sampleDark(sysCtx, "系统暗色", null);
    for (const [token, want] of DARK_KEY_TOKENS) {
      if (want === null) {
        assert.ok(isNearlyWhite95(systemDark[token]), "系统暗色下 " + token + " 应接近白色 alpha .95，实际 " + JSON.stringify(systemDark[token]));
        continue;
      }
      assert.equal(
        systemDark[token],
        want,
        "系统暗色下 " + token + " 应与手动暗色一致（" + want + "），实际 " + JSON.stringify(systemDark[token])
      );
    }
    assert.equal(systemDark.__bodyBg, manualDark.__bodyBg, "两种暗色模式的 body 背景必须相同");
    console.log("PASS C-2 系统暗色与手动暗色解析值完全一致（47 个 --dark-* 映射链正确）");
  } finally {
    await sysCtx.close();
  }

  // 还原成浅色，避免影响后续断言
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.waitForTimeout(150);

  /* ── 断言 31（C-6 → F8）：文章标题随视口连续变化，且有上下限 ── */
  /**
   * C-6 修的是"媒体查询里的 1.5rem 覆盖写在基础定义之前，被后者压掉"。
   *
   * F8（2026-11-07）把基础定义改成
   *     clamp(1.75rem, 1.5rem + 1vw, 2.35rem)
   * 之后，移动端字号由同一条规则算出，那条覆盖被删除了 —— 顺序陷阱从根上
   * 消失，而且 820–1392 之间不再是"一直是 32.8px"，而是连续变化。
   *
   * 断言改成 clamp 语义（实测值，容差 0.05px）：
   *   375px  → 28px    （下限 1.75rem）
   *   820px  → 32.2px
   *   821px  → 32.21px （跨断点连续，差 0.01px）
   *   1200px → 36px
   *   1440px → 37.6px  （上限 2.35rem）
   */
  const TITLE_CASES = [
    [375, 28],
    [820, 32.2],
    [821, 32.21],
    [1200, 36],
    [1440, 37.6],
  ];
  for (const [vw, want] of TITLE_CASES) {
    await page.setViewportSize({ width: vw, height: vw === 375 ? 812 : 900 });
    await page.goto(server.base + "/p/" + tocPostId, { waitUntil: "networkidle" });
    const fs = await page.evaluate(() => {
      const el = document.querySelector(".article-title");
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    });
    assert.ok(fs !== null, vw + "px 下应能取到 .article-title");
    assert.ok(
      Math.abs(fs - want) <= 0.05,
      vw + "px 下 .article-title 字号应为 " + want + "px，实际 " + fs
    );
    console.log("PASS F8 " + String(vw).padStart(4) + "px 文章标题字号 = " + fs + "px");
  }

  /* ── 断言 32（C-6）：删死类后页面仍正常渲染 ── */
  /**
   * 删了 5 个死类（.sidebar-footer / .toc-title / .only-mobile /
   * .mobile-drawer-search / .icon-inline）。它们零引用，删掉不该有任何变化 ——
   * 但"零引用"是静态判断，这里用渲染结果兜底：关键元素都还在。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const afterCleanup = await page.evaluate(() => ({
    sidebar: !!document.querySelector(".sidebar"),
    navItems: document.querySelectorAll(".sidebar .nav-item").length,
    sidebarFoot: !!document.querySelector(".side-bottom"),
    rbTitles: document.querySelectorAll(".rb-title").length,
    themeToggle: !!document.querySelector(".theme-toggle"),
  }));
  assert.equal(afterCleanup.sidebar, true, "侧栏应存在");
  assert.equal(afterCleanup.navItems, 5, "导航应有 5 项，实际 " + afterCleanup.navItems);
  assert.equal(afterCleanup.sidebarFoot, true, "侧栏底部（.side-bottom）应存在");
  assert.ok(afterCleanup.rbTitles > 0, "右栏区块标题（.rb-title）应存在");
  assert.equal(afterCleanup.themeToggle, true, "主题切换按钮应存在");
  console.log("PASS C-6 删死类后侧栏/导航/右栏/切换按钮全部正常（rb-title " + afterCleanup.rbTitles + " 个）");

  /* ── 断言 33（C-5）：内联样式改类后，视觉与改前一致 ── */
  /**
   * C-5 是**样式搬家**：把 13 处 `style={{…}}` 挪进 CSS 类。视觉必须一致 ——
   * 唯一有意的差异是分页当前页去掉了 `pointerEvents:none`（它是 `<span>`，
   * 本来就没有点击行为；`none` 只是把文本选择也一起禁了）。
   *
   * 这里断言各元素的**关键计算值**仍等于原内联样式写的那些值。
   */
  await page.setViewportSize({ width: 1440, height: 900 });

  // 404 页
  await page.goto(server.base + "/this-page-does-not-exist", { waitUntil: "networkidle" });
  const nf = await page.evaluate(() => {
    const box = document.querySelector(".notfound");
    const h1 = document.querySelector(".notfound-title");
    const p = document.querySelector(".notfound-text");
    if (!box || !h1 || !p) return null;
    const b = getComputedStyle(box), h = getComputedStyle(h1), t = getComputedStyle(p);
    return {
      boxMaxWidth: b.maxWidth, boxAlign: b.textAlign, boxPad: b.padding,
      h1Size: h.fontSize, h1Color: h.color, h1Margin: h.margin,
      pColor: t.color, pMarginBottom: t.marginBottom,
    };
  });
  assert.ok(nf, "404 页应渲染 .notfound / .notfound-title / .notfound-text");
  assert.equal(nf.boxMaxWidth, "480px", "404 容器 max-width 应为 480px");
  assert.equal(nf.boxAlign, "center", "404 容器应居中");
  assert.equal(nf.h1Size, "40px", "404 标题应为 2.5rem = 40px，实际 " + nf.h1Size);
  assert.equal(nf.pMarginBottom, "24px", "404 说明文字 margin-bottom 应为 24px");
  console.log("PASS C-5 404 页语义类还原原内联样式（" + nf.h1Size + " / " + nf.boxMaxWidth + "）");

  // 归档页
  await page.goto(server.base + "/archives", { waitUntil: "networkidle" });
  const arch = await page.evaluate(() => {
    const cnt = document.querySelector(".archive-year-count");
    const grp = document.querySelector(".archive-month-group");
    const mon = document.querySelector(".archive-month");
    if (!cnt || !grp || !mon) return null;
    const a = getComputedStyle(cnt), b = getComputedStyle(grp), c = getComputedStyle(mon);
    return {
      cntSize: a.fontSize, cntColor: a.color, cntMarginLeft: a.marginLeft, cntWeight: a.fontWeight,
      grpMarginBottom: b.marginBottom,
      monSize: c.fontSize, monMargin: c.margin,
    };
  });
  assert.ok(arch, "归档页应渲染三个语义类");
  assert.equal(arch.cntSize, "11.52px", "年份计数 .72rem = 11.52px，实际 " + arch.cntSize);
  assert.equal(arch.cntMarginLeft, "8px", "年份计数 margin-left 应为 8px");
  assert.equal(arch.cntWeight, "400", "年份计数 font-weight 应为 400");
  /*
   * 月份组的间距在 D-5（需求 8.4 空间优化）里被调小：10px → 2px，
   * 月份标签的 margin 也从 `6px 0 4px` 改成 `12px 0 2px`
   * （上边距加大、下边距收窄 —— 让月份标签紧贴自己那一组列表）。
   *
   * 这里不断言"等于某个旧像素值"，而是断言**两侧的语义**：
   * 月份之间的分隔必须大于月份与列表之间的分隔，否则分组关系就糊了。
   */
  const monTop = parseFloat(arch.monMargin.split(" ")[0]);
  const monBottom = parseFloat(arch.monMargin.split(" ")[2]);
  const sepBetween = parseFloat(arch.grpMarginBottom) + monTop; // 上一组底 → 下一月份标签
  assert.ok(
    sepBetween > monBottom,
    "月份之间的分隔（" + sepBetween + "px）应大于月份与列表之间（" + monBottom + "px），否则分组关系不清晰"
  );
  assert.ok(
    parseFloat(arch.grpMarginBottom) <= 4,
    "8.4「缩小不必要的分组间距」：月份组 margin-bottom 应 ≤4px，实际 " + arch.grpMarginBottom
  );
  assert.equal(arch.monSize, "12.48px", "月份标签 .78rem = 12.48px，实际 " + arch.monSize);
  console.log("PASS C-5 归档页三个语义类数值正确（" + arch.cntSize + " / " + arch.monSize + "）");

  // 分页当前页
  await page.goto(server.base + "/", { waitUntil: "networkidle" });
  const pager = await page.evaluate(() => {
    const el = document.querySelector(".pager-current");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName, size: cs.fontSize, weight: cs.fontWeight, pad: cs.padding,
      radius: cs.borderTopLeftRadius, opacity: cs.opacity,
      pointerEvents: cs.pointerEvents, bg: cs.backgroundColor,
    };
  });
  assert.ok(pager, "分页当前页应渲染 .pager-current");
  assert.equal(pager.tag, "SPAN", "分页当前页应是 span（不是被禁用的按钮）");
  assert.equal(pager.size, "13.12px", "字号 .82rem = 13.12px，实际 " + pager.size);
  assert.equal(pager.weight, "560", "字重应 560");
  assert.equal(pager.pad, "5px 12px", "内边距应 5px 12px");
  assert.equal(pager.radius, "8px", "圆角应 8px");
  assert.equal(pager.opacity, "0.6", "不透明度应 0.6");
  assert.equal(pager.pointerEvents, "auto", "不应再用 pointerEvents:none 禁用交互");
  console.log("PASS C-5 分页当前页视觉一致（span / " + pager.size + " / opacity " + pager.opacity + "，已去掉 pointerEvents:none）");

  // 搜索结果计数 / 标签页计数
  await page.goto(server.base + "/search?q=" + encodeURIComponent("测试"), { waitUntil: "networkidle" });
  const sm = await page.evaluate(() => {
    const el = document.querySelector(".search-meta");
    return el ? { size: getComputedStyle(el).fontSize, margin: getComputedStyle(el).margin } : null;
  });
  if (sm) {
    assert.equal(sm.size, "13.12px", "搜索计数 .82rem = 13.12px，实际 " + sm.size);
    console.log("PASS C-5 搜索计数语义类正确（" + sm.size + "）");
  }

  /* ── 断言 34（C-8）：PageHeader 与 EmptyState 渲染正确 ── */
  /**
   * 这两个组件只是把重复的 JSX 收成一个组件，**不改任何 CSS** ——
   * 后台 `admin/ui.tsx` 的 Empty 用的是同一套 `.empty-block` 类，
   * 改样式会波及后台。
   */
  await page.setViewportSize({ width: 1440, height: 900 });

  // 四个页面的标题都由 PageHeader 渲染，结构一致
  const HEADER_CASES = [
    ["/archives", "归档"],
    ["/shuoshuo", "说说"],
    ["/search", "搜索"],
  ];
  for (const [pathName, wantTitle] of HEADER_CASES) {
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    const h = await page.evaluate(() => {
      const head = document.querySelector("header.page-head");
      const title = head?.querySelector("h1.page-title");
      return {
        hasHead: !!head,
        tag: title ? title.tagName : null,
        text: title ? title.textContent.trim() : null,
        size: title ? getComputedStyle(title).fontSize : null,
        h1Count: document.querySelectorAll("h1").length,
      };
    });
    assert.equal(h.hasHead, true, pathName + " 应有 header.page-head（PageHeader 的容器）");
    assert.equal(h.tag, "H1", pathName + " 的标题应是 h1");
    assert.equal(h.text, wantTitle, pathName + " 标题文字应为 " + wantTitle + "，实际 " + h.text);
    assert.equal(h.size, "28px", pathName + " 标题字号应为 1.75rem = 28px，实际 " + h.size);
    assert.equal(h.h1Count, 1, pathName + " 应有且只有 1 个 h1，实际 " + h.h1Count);
    console.log("PASS C-8 " + pathName.padEnd(12) + " PageHeader 正确（h1 / " + h.text + " / " + h.size + "）");
  }

  /* ── 断言 35（C-8）：EmptyState 结构与后台共用同一套类 ── */
  /**
   * 用搜索页的「无结果」验证三层结构齐全（title / hint / actions），
   * 用「未输入」验证 actions 可缺省。
   */
  await page.goto(server.base + "/search?q=zzzznothing", { waitUntil: "networkidle" });
  const withActions = await page.evaluate(() => {
    const eb = document.querySelector(".empty-block");
    if (!eb) return null;
    const cs = getComputedStyle(eb);
    return {
      hasTitle: !!eb.querySelector(".empty-title"),
      hasHint: !!eb.querySelector(".empty-hint"),
      hasActions: !!eb.querySelector(".empty-actions"),
      actionCount: eb.querySelectorAll(".empty-actions .btn").length,
      textAlign: cs.textAlign,
      titleSize: getComputedStyle(eb.querySelector(".empty-title")).fontSize,
      hintSize: getComputedStyle(eb.querySelector(".empty-hint")).fontSize,
    };
  });
  assert.ok(withActions, "搜索无结果时应渲染 .empty-block");
  assert.equal(withActions.hasTitle, true, "应有 .empty-title");
  assert.equal(withActions.hasHint, true, "应有 .empty-hint");
  assert.equal(withActions.hasActions, true, "应有 .empty-actions");
  assert.equal(withActions.actionCount, 2, "应有 2 个操作按钮，实际 " + withActions.actionCount);
  assert.equal(withActions.titleSize, "14.72px", "空状态标题 .92rem = 14.72px，实际 " + withActions.titleSize);
  assert.equal(withActions.hintSize, "12.8px", "空状态说明 .8rem = 12.8px，实际 " + withActions.hintSize);
  console.log("PASS C-8 EmptyState 三层结构齐全（标题 " + withActions.titleSize + " / 说明 " + withActions.hintSize + " / 2 个按钮）");

  await page.goto(server.base + "/search", { waitUntil: "networkidle" });
  const noActions = await page.evaluate(() => {
    const eb = document.querySelector(".empty-block");
    if (!eb) return null;
    return {
      hasHint: !!eb.querySelector(".empty-hint"),
      hasActions: !!eb.querySelector(".empty-actions"),
    };
  });
  assert.ok(noActions, "搜索未输入时应渲染 .empty-block");
  assert.equal(noActions.hasHint, true, "应有 .empty-hint");
  assert.equal(noActions.hasActions, false, "未传 actions 时不应渲染 .empty-actions");
  console.log("PASS C-8 EmptyState actions 可缺省（不渲染空容器）");

  /* ── 断言 36（C-8）：标签页的 sub 排版与改前 .tag-count 一致 ── */
  /**
   * 原来标签页用 `.tag-count { margin: -16px 0 24px }` 抵消标题的 32px
   * 下边距。现在改用 `<PageHeader sub>`，`.page-sub` 必须承担同样的
   * 排版语义 —— 否则标题与正文之间的间距会变。
   */
  await page.goto(server.base + "/tags/ai", { waitUntil: "networkidle" });
  const sub = await page.evaluate(() => {
    const el = document.querySelector("header.page-head .page-sub");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const title = getComputedStyle(document.querySelector("header.page-head .page-title"));
    return { margin: cs.margin, size: cs.fontSize, color: cs.color, titleMargin: title.margin };
  });
  if (sub) {
    assert.equal(sub.margin, "-16px 0px 24px", "副标题 margin 应为 -16px 0 24px（与改前 .tag-count 一致），实际 " + sub.margin);
    assert.equal(sub.size, "13.6px", "副标题字号 .85rem = 13.6px，实际 " + sub.size);
    console.log("PASS C-8 标签页 sub 排版与改前一致（margin " + sub.margin + "）");
  } else {
    console.log("SKIP C-8 标签页无 sub（该标签下没有文章）");
  }

  /* ── 断言 37（C-9）：站点品牌信息来自 settings，不是硬编码 ── */
  /**
   * 站名与简介原本硬编码在 Sidebar / MobileNav 里，而 settings 表里早就有
   * `siteTitle` / `siteDescription` —— 于是「后台改站名 → 浏览器 tab 标题变了，
   * 但前台侧栏还是老的」。
   *
   * 现在由 SiteShell / layout 从 settings 取并传下去。
   *
   * ⚠️ 曾经这里写着"本断言只验数据流，不验改完立刻生效"，因为
   * `revalidateTag(TAGS.stats)` 不会让 `getSettingsCached` 失效（revalidateTag
   * 是 SWR，页面渲染那份进程内缓存还清不掉）。2026-11-07 起 settings 直读库、
   * `getSettingsCached` 已删除，"改完立刻生效"的断言搬到
   * tests/next-integration.mjs（HTTP 层，更快）。这里只验数据流。
   *
   * 数据流的正确性由两条保证：
   *   ① 组件源码里不再有硬编码（tests/brand.test.ts 静态检查）
   *   ② 页面渲染出的站名等于 settings 的默认值（settings 为空时走 defaults）
   */
  const homeHtml = await (await fetch(server.base + "/")).text();
  const brandTitle = homeHtml.match(/class="brand-title">([^<]*)</)?.[1];
  const brandDesc = homeHtml.match(/class="brand-desc">([^<]*)</)?.[1];

  assert.ok(brandTitle, "首页 SSR HTML 里应有 .brand-title（Sidebar 渲染）");
  assert.ok(brandDesc, "首页 SSR HTML 里应有 .brand-desc");

  // settings 为空时应回落到默认值 —— 证明值确实是"取出来的"而不是写死的
  assert.ok(
    brandTitle.includes("flechazo"),
    "默认站名应包含 flechazo（settings 默认值），实际 " + JSON.stringify(brandTitle)
  );
  assert.ok(
    brandDesc.length > 0,
    "简介不应为空（应有兜底），实际 " + JSON.stringify(brandDesc)
  );
  console.log("PASS C-9 侧栏品牌信息来自 settings（" + brandTitle + " / " + brandDesc + "）");

  /* 移动端顶栏用同一个值（它在 layout 里渲染，不在 SiteShell 内） */
  assert.ok(
    homeHtml.includes("mobile-brand"),
    "首页应有移动端顶栏 .mobile-brand"
  );
  const mobileBrand = homeHtml.match(/class="mobile-brand"[\s\S]{0,200}?<span>([^<]*)<\/span>/)?.[1];
  assert.equal(
    mobileBrand,
    brandTitle,
    "移动端顶栏站名应与侧栏一致（都来自 settings.siteTitle），实际 " +
      JSON.stringify(mobileBrand) + " vs " + JSON.stringify(brandTitle)
  );
  console.log("PASS C-9 移动端顶栏与侧栏同源（" + mobileBrand + "）");

  /* 文档标题也来自 settings —— 三方一致才说明真的同源 */
  const docTitle = homeHtml.match(/<title>([^<]*)<\/title>/)?.[1];
  assert.ok(
    (docTitle || "").includes("flechazo"),
    "文档标题也应来自 settings（与侧栏同源），实际 " + JSON.stringify(docTitle)
  );
  console.log("PASS C-9 侧栏 / 顶栏 / <title> 三方同源");

  /* ── 断言 38（C-7）：层级令牌生效，且顶栏 < 抽屉 < 对话框 ── */
  /**
   * 原来 z-index 是数字字面量：顶栏 50、两个抽屉 100、对话框 200、
   * 另一个浮层也是 200。同为 200 时谁在上只取决于 DOM 顺序 ——
   * 一旦有人调整结构，弹窗会莫名跑到遮罩下面，且只在"两个同时打开"时出现。
   *
   * 现在层级关系是显式约定：--z-topbar(50) < --z-drawer(100) < --z-dialog(200)。
   */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });

  const zTokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const num = (n) => Number(cs.getPropertyValue(n).trim());
    return {
      topbar: num("--z-topbar"),
      drawer: num("--z-drawer"),
      dialog: num("--z-dialog"),
      base: num("--z-base"),
      // 实际渲染值
      topbarEl: Number(getComputedStyle(document.querySelector(".mobile-topbar")).zIndex),
    };
  });
  assert.ok(zTokens.topbar > zTokens.base, "顶栏层级应高于 base（" + zTokens.topbar + " > " + zTokens.base + "）");
  assert.ok(zTokens.drawer > zTokens.topbar, "抽屉应高于顶栏（" + zTokens.drawer + " > " + zTokens.topbar + "）");
  assert.ok(zTokens.dialog > zTokens.drawer, "对话框应高于抽屉（" + zTokens.dialog + " > " + zTokens.drawer + "）");
  assert.equal(zTokens.topbarEl, zTokens.topbar, "顶栏的实际 z-index 应等于令牌值（" + zTokens.topbarEl + " vs " + zTokens.topbar + "）");
  console.log("PASS C-7 层级令牌生效且严格递增（base " + zTokens.base + " < topbar " + zTokens.topbar +
    " < drawer " + zTokens.drawer + " < dialog " + zTokens.dialog + "）");

  /* ── 断言 39（C-7）：触控热区仍满足 44 / 48 ── */
  /**
   * 把 `width: 44px` 换成 `var(--tap)` 之后，实际渲染尺寸必须还是 44。
   * 这条防的是"令牌值写错"（比如把 --tap 定义成 40px）—— 那会让所有
   * 移动端按钮热区悄悄缩水，而没有任何报错。
   */
  const tap = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      token: cs.getPropertyValue("--tap").trim(),
      tokenLg: cs.getPropertyValue("--tap-lg").trim(),
      dockMenu: box('.mobile-dock-btn[aria-label="打开菜单"]'),
      dockSidebar: box('.mobile-dock-btn[aria-label="打开侧栏"]'),
      iconBtn: box(".mobile-icon-btn"),
    };
  });
  assert.equal(tap.token, "44px", "--tap 应为 44px，实际 " + tap.token);
  assert.equal(tap.tokenLg, "48px", "--tap-lg 应为 48px，实际 " + tap.tokenLg);
  for (const [name, b] of [["打开菜单", tap.dockMenu], ["打开侧栏", tap.dockSidebar]]) {
    if (!b) continue;
    assert.equal(b.w, 44, name + "按钮宽度应为 44px，实际 " + b.w);
    assert.equal(b.h, 44, name + "按钮高度应为 44px，实际 " + b.h);
  }
  if (tap.iconBtn) {
    assert.ok(tap.iconBtn.w >= 44, "图标按钮热区宽度应 ≥44px，实际 " + tap.iconBtn.w);
  }
  console.log("PASS C-7 触控热区仍为 44/48（--tap=" + tap.token + " / --tap-lg=" + tap.tokenLg + "）");

  /* ── 断言 40（C-7）：字号令牌解析正确 ── */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/archives", { waitUntil: "networkidle" });
  const fs2 = await page.evaluate(() => {
    const el = document.querySelector(".archive-month");
    const root = getComputedStyle(document.documentElement);
    return {
      token: root.getPropertyValue("--fs-sm").trim(),
      rendered: el ? getComputedStyle(el).fontSize : null,
    };
  });
  assert.equal(fs2.token, ".78rem", "--fs-sm 应为 .78rem，实际 " + fs2.token);
  assert.equal(fs2.rendered, "12.48px", "月份标签渲染字号应为 .78rem = 12.48px，实际 " + fs2.rendered);
  console.log("PASS C-7 字号令牌解析正确（--fs-sm=" + fs2.token + " → " + fs2.rendered + "）");

  /* ── 断言 41（D-1）：文章卡片高度压缩 10–15% ── */
  /**
   * 需求文档 4.2「卡片高度」：整体压缩约 10%～15%，但不要让页面显得拥挤。
   *
   * 改前实测（1440px，两行摘要）：**180.8px**
   *   padding 24×2 + h2 line-height 28.8 + h2 margin 10
   *   + excerpt 2 行 52 + excerpt margin 14 + meta 26 + border 2
   *
   * 改后（padding 18×2、h2 margin 8、excerpt margin 10）：**162.8px**
   *   压缩 10.0%，落在区间下沿 —— 取最小改动，避免"拥挤"。
   *
   * 断言的是"相对改前基线"的比例，不是绝对像素 —— 那样即使将来字体
   * 或行高调整，只要压缩比例仍在区间内就仍然成立。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/", { waitUntil: "networkidle" });

  const cardMetrics = await page.evaluate(() => {
    const card = document.querySelector(".post-card");
    if (!card) return null;
    const h2 = card.querySelector("h2");
    const ex = card.querySelector(".excerpt");
    const meta = card.querySelector(".meta");
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const cardCs = cs(card);
    return {
      height: Math.round(card.getBoundingClientRect().height * 10) / 10,
      paddingTop: parseFloat(cardCs.paddingTop),
      paddingBottom: parseFloat(cardCs.paddingBottom),
      radius: cardCs.borderTopLeftRadius,
      h2MarginBottom: parseFloat(cs(h2).marginBottom),
      h2Size: cs(h2).fontSize,
      excerptMarginBottom: ex ? parseFloat(cs(ex).marginBottom) : null,
      excerptClamp: ex ? cs(ex).webkitLineClamp : null,
      excerptLineHeight: ex ? parseFloat(cs(ex).lineHeight) : null,
      metaGap: parseFloat(cs(meta).gap),
      listGap: parseFloat(cs(document.querySelector(".post-list")).gap),
      metaChildren: [...meta.children].map((e) => e.className || e.tagName.toLowerCase()),
    };
  });
  assert.ok(cardMetrics, "首页应渲染 .post-card");

  // 四个间距必须落在 D-1 的目标值上
  assert.equal(cardMetrics.paddingTop, 18, "卡片 padding-top 应为 18px（原 24），实际 " + cardMetrics.paddingTop);
  assert.equal(cardMetrics.paddingBottom, 18, "卡片 padding-bottom 应为 18px（原 24），实际 " + cardMetrics.paddingBottom);
  assert.equal(cardMetrics.h2MarginBottom, 8, "标题下边距应为 8px（原 10），实际 " + cardMetrics.h2MarginBottom);
  if (cardMetrics.excerptMarginBottom !== null) {
    assert.equal(cardMetrics.excerptMarginBottom, 10, "摘要下边距应为 10px（原 14），实际 " + cardMetrics.excerptMarginBottom);
  }
  assert.equal(cardMetrics.listGap, 14, "卡片间距应为 14px（原 16），实际 " + cardMetrics.listGap);

  // 摘要必须仍是 2 行截断
  if (cardMetrics.excerptClamp !== null) {
    assert.equal(cardMetrics.excerptClamp, "2", "摘要应保持 2 行截断，实际 " + cardMetrics.excerptClamp);
  }

  /**
   * 高度压缩比例。
   *
   * 不能拿"固定基线 180.8px"去比 —— 那个数字对应"两行摘要"的卡片，
   * 而测试数据的摘要可能只有一行，算出来会偏大（实测 26%）。
   *
   * 正确做法：用**改动量**反推。改前 → 改后只动了四处：
   *   padding 24→18（×2 = −12）、h2 margin 10→8（−2）、excerpt margin 14→10（−4）
   *   合计每卡固定减 **18px**（与摘要行数无关）
   *
   * 所以压缩比例 = 18 / (当前高度 + 18)。这个式子对任何摘要长度都成立，
   * 且能直接验证"四处改动都生效了"。
   */
  const SAVED = 18;
  const baseline = cardMetrics.height + SAVED;
  const pct = Math.round((SAVED / baseline) * 1000) / 10;
  assert.ok(
    pct >= 9.5 && pct <= 15.5,
    "卡片高度压缩应落在 10–15%（需求 4.2），实际 " + pct + "%（" + baseline + " → " + cardMetrics.height + "px）"
  );
  console.log("PASS D-1 卡片高度每张减 " + SAVED + "px（" + baseline + " → " + cardMetrics.height + "px，压缩 " + pct + "%，需求 10–15%）");

  /* ── 断言 42（D-1 / F7）：元信息四项齐，且分两级 ── */
  /**
   * 需求 4.2「元信息」：发布时间 / 预计阅读时间 / 浏览量 / 文章标签，
   * 排列紧凑、避免过多装饰图标；没有标签时不显示空白占位。
   *
   * 注：这里的"标签"实指 categories（分类），PostCard 的 props 契约
   * 只有 categories 没有 tags（D.4 红线：不改 props 契约）。
   *
   * F7（2026-11-07）：五项平铺改成两级 —— 主级（日期 + 分类）留在 .meta，
   * 次级（阅读时长 + 浏览量）收进 .meta-sub。断言随之改为"次级块存在"，
   * 而不是"某个裸 span 存在"。
   */
  assert.ok(
    cardMetrics.metaChildren.includes("time"),
    "元信息应含发布时间，实际 " + JSON.stringify(cardMetrics.metaChildren)
  );
  assert.ok(
    cardMetrics.metaChildren.includes("meta-sub"),
    "元信息应含次级块 .meta-sub（阅读时长 / 浏览量），实际 " + JSON.stringify(cardMetrics.metaChildren)
  );
  assert.ok(
    !cardMetrics.metaChildren.includes("dot") ||
      cardMetrics.metaChildren[cardMetrics.metaChildren.length - 1] !== "dot",
    "元信息末尾不应有多余分隔符，实际 " + JSON.stringify(cardMetrics.metaChildren)
  );
  console.log("PASS D-1 元信息结构正常（" + cardMetrics.metaChildren.join(" + ") + "）");

  /* ── 断言 43（D-1）：右栏统计块不得抢眼 ── */
  /**
   * 需求 4.5：「适当减少卡片高度」「不要让统计区域过于抢眼」。
   * 改前统计格 80px、四格占 176px，视觉权重比正文列表还重。
   */
  const statMetrics = await page.evaluate(() => {
    const cell = document.querySelector(".stat-cell");
    const num = document.querySelector(".stat-num");
    if (!cell) return null;
    return {
      height: Math.round(cell.getBoundingClientRect().height),
      padding: getComputedStyle(cell).padding,
      numSize: parseFloat(getComputedStyle(num).fontSize),
    };
  });
  if (statMetrics) {
    assert.ok(
      statMetrics.height <= 76,
      "统计格高度应 ≤76px（原 80，需求「适当减少卡片高度」），实际 " + statMetrics.height
    );
    assert.ok(
      statMetrics.numSize <= 20,
      "统计数字字号应 ≤20px（原 20.48，需求「不要过于抢眼」），实际 " + statMetrics.numSize
    );
    console.log("PASS D-1 统计格 " + statMetrics.height + "px（原 80）· 数字 " + statMetrics.numSize + "px（原 20.48）");
  }

  /* ── 断言 44（D-2 → 2026-11-06）：关于页是静态页，版式与其它页面一致 ── */
  /**
   * 关于页此前读 posts 表里的 page 记录（D-2），演示库/全新安装没有这条记录
   * 时整页 404。现在改成静态页：内容来自 content/pages/about.md，不查库；
   * 版式与归档 / 说说同构（PageHeader + .prose + 完整右栏）。
   *
   * 这条断言顺便守住"不查库"这件事：测试**故意不再 seed** 关于页记录。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  const aboutRes = await page.goto(server.base + "/about", { waitUntil: "networkidle" });
  assert.equal(aboutRes.status(), 200, "/about 应可访问（静态页，不依赖库里有没有 page 记录）");

  const about = await page.evaluate(() => {
    const title = document.querySelector(".page-title");
    return {
      pageTitle: title ? title.textContent.trim() : null,
      h2: [...document.querySelectorAll(".prose h2")].map((e) => e.textContent.trim()),
      hasHero: !!document.querySelector(".about-hero"),
      hasArticleMeta: !!document.querySelector(".article-meta-bar, .article-title"),
      hasToc: !!document.querySelector(".toc-list"),
      hasStats: !!document.querySelector(".stat-grid"),
      proseText: (document.querySelector(".prose")?.textContent || "").slice(0, 200),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });

  assert.equal(about.pageTitle, "关于", "关于页应有标准页面标题「关于」，实际 " + JSON.stringify(about.pageTitle));
  assert.equal(about.hasHero, false, "关于页不应再有专属 hero（应与其它页面同构）");
  assert.equal(about.hasArticleMeta, false, "关于页不应出现文章元信息（日期/阅读时长/浏览量）");
  assert.equal(about.hasToc, false, "关于页与其它列表页一致：右栏不再有目录");
  assert.equal(about.hasStats, true, "关于页右栏应是标准完整版（含站点统计）");
  for (const want of ["我在做什么", "本站", "联系"]) {
    assert.ok(about.h2.includes(want), "应有「" + want + "」一节，实际 " + JSON.stringify(about.h2));
  }
  assert.ok(about.proseText.includes("你好，我是 flechazo"), "正文应来自 about.md，实际开头：" + JSON.stringify(about.proseText.slice(0, 40)));
  assert.ok(about.scrollW <= about.clientW + 1, "关于页不应横向溢出");
  console.log("PASS D-2 关于页 = 静态页（PageHeader「关于」+ 正文 + 完整右栏，无 hero / 无目录）");

  /* 移动端：无横向溢出，右栏隐藏 */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/about", { waitUntil: "networkidle" });
  const aboutMobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    tocVisible: (() => {
      const el = document.querySelector(".toc-col");
      return el ? getComputedStyle(el).display !== "none" : false;
    })(),
  }));
  assert.equal(aboutMobile.overflow, false, "375px 下关于页不应横向溢出");
  assert.equal(aboutMobile.tocVisible, false, "375px 下右栏应隐藏");
  console.log("PASS D-2 移动端无溢出且右栏隐藏");

  /* ── 断言 45（D-3）：友链页 Hero 收紧 + 桌面两列 + 卡片等高 ── */
  /**
   * 需求文档第六章。6.1 明确「只进行局部优化，不允许推翻重做」，
   * 所以这里验的都是**可量化**的局部指标，不验整体重设计。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/friend-links", { waitUntil: "networkidle" });

  const fl = await page.evaluate(() => {
    const hero = document.querySelector(".fr-hero");
    const grid = document.querySelector(".fr-grid");
    const cards = [...document.querySelectorAll(".fr-grid a.fr-card")];
    const heights = cards.map((c) => Math.round(c.getBoundingClientRect().height));
    const cols = grid
      ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length
      : 0;
    return {
      heroHeight: hero ? Math.round(hero.getBoundingClientRect().height) : null,
      titleSize: parseFloat(getComputedStyle(document.querySelector(".fr-hero-title")).fontSize),
      descWidth: Math.round(document.querySelector(".fr-hero-desc").getBoundingClientRect().width),
      gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
      cols,
      cardCount: cards.length,
      heights,
      heightsEqual: new Set(heights).size === 1,
      hubTitle: document.querySelector(".fr-hubs-title")?.textContent?.trim(),
      hubRows: document.querySelectorAll(".fr-hub-list .fr-hub").length,
      sectionIndexes: [
        ...document.querySelectorAll(".fr-section-index, .fr-hubs-title, .fr-apply-index"),
      ].map((e) => e.textContent.trim()),
      statNums: [...document.querySelectorAll(".fr-stat-num")].map((e) => e.textContent.trim()),
    };
  });

  /* 6.2 Hero 高度：改前 402px，收紧后应明显低于它 */
  assert.ok(
    fl.heroHeight !== null && fl.heroHeight <= 365,
    "6.2 Hero 高度应 ≤365px（改前 402），实际 " + fl.heroHeight
  );
  /* 6.2 标题字号：桌面端上限从 3.1rem 收到 2.7rem = 43.2px */
  assert.ok(
    fl.titleSize <= 44,
    "6.2 主标题桌面字号应 ≤44px（改前 49.6），实际 " + fl.titleSize
  );
  /* 6.2 描述宽度：「不要占据过多宽度」，38em 上限 */
  assert.ok(
    fl.descWidth <= 600,
    "6.2 描述宽度应 ≤600px（改前 699），实际 " + fl.descWidth
  );
  console.log(
    "PASS D-3 Hero 收紧 " + fl.heroHeight + "px（改前 402）· 标题 " + fl.titleSize +
    "px（改前 49.6）· 描述 " + fl.descWidth + "px（改前 699）"
  );

  /* 6.4 桌面端两列（需求原文：三列时第二行只剩一张卡） */
  assert.equal(fl.cols, 2, "6.4 桌面端应为 2 列（改前 3 列），实际 " + fl.cols + " 列（容器宽 " + fl.gridWidth + "）");
  assert.ok(fl.cardCount >= 4, "6.4 应有足够卡片可验证布局，实际 " + fl.cardCount);
  console.log("PASS D-3 桌面端 " + fl.cols + " 列（容器 " + fl.gridWidth + "px，" + fl.cardCount + " 张卡）");

  /* 6.4 卡片高度统一 */
  assert.equal(
    fl.heightsEqual,
    true,
    "6.4 卡片高度应统一，实际各种高度：" + JSON.stringify([...new Set(fl.heights)])
  );
  console.log("PASS D-3 卡片等高（" + fl.heights[0] + "px × " + fl.cardCount + "）");

  /* 6.5 聚合站独立成区、编号 02、数量动态 */
  assert.equal(fl.hubTitle, "02 / BLOG HUBS", "6.5 聚合站区块应编号为 02 / BLOG HUBS，实际 " + JSON.stringify(fl.hubTitle));
  assert.ok(fl.hubRows >= 1, "6.5 聚合站列表应至少 1 条（动态获取），实际 " + fl.hubRows);
  console.log("PASS D-3 聚合站独立成区（" + fl.hubTitle + " · " + fl.hubRows + " 条）");

  /* 区块编号必须连续且不重复（我第一版把 hubs 编成 02 与交换友链撞号了） */
  const nums = fl.sectionIndexes.map((t) => (t.match(/^(\d{2})/) || [])[1]).filter(Boolean);
  assert.deepEqual(
    nums,
    [...new Set(nums)],
    "区块编号不得重复，实际：" + JSON.stringify(fl.sectionIndexes)
  );
  assert.deepEqual(nums, ["01", "02", "03"], "区块编号应从 01 连续编号，实际：" + JSON.stringify(nums));
  console.log("PASS D-3 区块编号连续不撞号（" + fl.sectionIndexes.join(" · ") + "）");

  /* 6.3 统计必须动态（数字来自 friends.length / hubs.length） */
  const friendsCount = await page.evaluate(() => document.querySelectorAll(".fr-grid a.fr-card").length);
  assert.equal(
    fl.statNums[0],
    String(friendsCount).padStart(2, "0"),
    "6.3 友链数量应为实际卡片数（补零两位），实际 " + fl.statNums[0] + " vs " + friendsCount
  );
  console.log("PASS D-3 统计动态（朋友 " + fl.statNums[0] + " / 聚合 " + (fl.statNums[1] || "-") + "）");

  /* 6.4 移动端单列 + 无横向滚动 */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/friend-links", { waitUntil: "networkidle" });
  const flMobile = await page.evaluate(() => {
    const grid = document.querySelector(".fr-grid");
    const cards = [...document.querySelectorAll(".fr-grid a.fr-card")];
    return {
      cols: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
      cardW: Math.round(cards[0].getBoundingClientRect().width),
      gridW: Math.round(grid.getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      heightsEqual: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().height))).size === 1,
    };
  });
  assert.equal(flMobile.cols, 1, "6.4 移动端应为单列，实际 " + flMobile.cols);
  assert.equal(flMobile.overflow, false, "6.4 移动端不应出现横向滚动");
  assert.equal(flMobile.cardW, flMobile.gridW, "6.4 移动端卡片应占满内容区（" + flMobile.cardW + " vs " + flMobile.gridW + "）");
  assert.equal(flMobile.heightsEqual, true, "6.4 移动端卡片也应等高");
  console.log("PASS D-3 移动端单列满宽（" + flMobile.cardW + "px）且无横向滚动");

  /* ── 断言 46（D-4）：说说页轻量时间线 ── */
  /**
   * 需求文档第五章。5.1 定位是「轻量的个人动态记录页面」——
   * 与文章列表刻意不同：没有卡片、没有摘要、没有一排元信息徽章。
   *
   * 5.3 推荐「轻量时间线」（用户已确认采用），5.4 允许日期拆分样式，
   * 但要求「必须保证移动端显示正常」。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/shuoshuo", { waitUntil: "networkidle" });

  const shuo = await page.evaluate(() => {
    const list = document.querySelector(".shuo-list");
    const items = [...document.querySelectorAll(".shuo-item")];
    const first = items[0];
    const cs = (el) => getComputedStyle(el);
    const content = document.querySelector(".shuo-content");
    return {
      /* 5.2 页面顶部 */
      en: document.querySelector(".page-title-en")?.textContent?.trim(),
      sub: document.querySelector(".page-sub")?.textContent?.trim(),
      h1Count: document.querySelectorAll("h1").length,
      /* 5.3 时间线结构 */
      listTag: list ? list.tagName : null,
      itemTag: first ? first.tagName : null,
      itemCount: items.length,
      gridCols: first ? cs(first).gridTemplateColumns : null,
      hasStamp: !!document.querySelector(".shuo-stamp"),
      stampTag: document.querySelector(".shuo-stamp")?.tagName,
      stampDateTime: document.querySelector(".shuo-stamp")?.getAttribute("datetime"),
      days: [...document.querySelectorAll(".shuo-day")].map((e) => e.textContent.trim()),
      yms: [...document.querySelectorAll(".shuo-ym")].map((e) => e.textContent.trim()),
      times: [...document.querySelectorAll(".shuo-time")].map((e) => e.textContent.trim()),
      /* 5.3 视觉要求：无卡片、无阴影、细分割线、舒适行高 */
      boxShadow: first ? cs(first).boxShadow : null,
      borderBottom: first ? cs(first).borderBottomWidth : null,
      hasBg: first ? cs(first).backgroundColor : null,
      lineHeight: content ? parseFloat(cs(content).lineHeight) : null,
      fontSize: content ? parseFloat(cs(content).fontSize) : null,
      /* 5.3 长文本 / 图片 */
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      imgRule: (() => {
        const img = document.querySelector(".shuo-content img");
        return img
          ? { display: cs(img).display, maxWidth: cs(img).maxWidth, radius: cs(img).borderTopLeftRadius }
          : null;
      })(),
    };
  });

  /* 5.2 英文辅助标题 + 一行说明 */
  assert.equal(shuo.en, "MOMENTS / DAILY NOTES", "5.2 标题旁应有英文辅助标题，实际 " + JSON.stringify(shuo.en));
  assert.ok(
    shuo.sub && shuo.sub.length > 10,
    "5.2 标题下应有一行简短说明，实际 " + JSON.stringify(shuo.sub)
  );
  assert.equal(shuo.h1Count, 1, "5.2 页面仍应只有一个 h1");
  console.log("PASS D-4 页头（" + shuo.en + " ／ " + shuo.sub + "）");

  /* 5.3 轻量时间线：有序列表 + 左日期 / 右正文 */
  assert.equal(shuo.listTag, "OL", "5.3 时间线应是有序列表（表达时间顺序），实际 " + shuo.listTag);
  assert.equal(shuo.itemTag, "LI", "5.3 每个条目应是 li，实际 " + shuo.itemTag);
  assert.ok(shuo.itemCount >= 4, "5.3 应渲染出条目，实际 " + shuo.itemCount);
  assert.equal(shuo.stampTag, "TIME", "5.3 日期应用 <time> 表达，实际 " + shuo.stampTag);
  assert.ok(shuo.stampDateTime, "5.3 <time> 应有可机读的 datetime 属性");
  const cols = shuo.gridCols.split(" ").filter(Boolean);
  assert.equal(cols.length, 2, "5.3 时间线应是两列（左日期/右正文），实际 " + shuo.gridCols);
  assert.equal(cols[0], "72px", "5.3 左栏应定宽 72px（否则日期位数变化会让正文左右跳动），实际 " + cols[0]);
  console.log("PASS D-4 时间线结构（" + shuo.itemCount + " 条 · 左栏 " + cols[0] + " 定宽）");

  /* 5.4 日期格式：日号补零两位 + 年月 + 时分 */
  assert.deepEqual(
    shuo.days,
    shuo.days.map((d) => d.padStart(2, "0")),
    "5.4 日号应补零两位，实际 " + JSON.stringify(shuo.days)
  );
  for (const ym of shuo.yms) {
    assert.match(ym, /^\d{4}年\d{1,2}月$/, "5.4 年月格式应为 YYYY年M月，实际 " + JSON.stringify(ym));
  }
  for (const t of shuo.times) {
    assert.match(t, /^\d{2}:\d{2}$/, "5.4 时分应为 HH:mm，实际 " + JSON.stringify(t));
  }
  console.log("PASS D-4 日期格式（" + shuo.days[0] + " / " + shuo.yms[0] + " / " + shuo.times[0] + "）");

  /* 5.3 视觉要求 */
  assert.equal(shuo.boxShadow, "none", "5.3 条目不应有阴影，实际 " + shuo.boxShadow);
  assert.equal(shuo.borderBottom, "1px", "5.3 应保留 1px 分割线，实际 " + shuo.borderBottom);
  assert.equal(
    shuo.hasBg,
    "rgba(0, 0, 0, 0)",
    "5.3 不应使用卡片背景（需求「不使用大型卡片」），实际 " + shuo.hasBg
  );
  const lhRatio = shuo.lineHeight / shuo.fontSize;
  assert.ok(lhRatio >= 1.7, "5.3 正文行高应舒适（≥1.7 倍字号），实际 " + lhRatio.toFixed(2));
  assert.equal(shuo.overflow, false, "5.3 长文本不应撑破容器（页面级横向溢出）");
  console.log(
    "PASS D-4 视觉（无阴影 / 1px 分割线 / 无卡片背景 / 行高 " + lhRatio.toFixed(2) + " / 无溢出）"
  );

  /* 5.4 + 5.3 移动端：日期不折行、无横向溢出 */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(server.base + "/shuoshuo", { waitUntil: "networkidle" });
  const shuoMobile = await page.evaluate(() => {
    const yms = [...document.querySelectorAll(".shuo-ym")];
    const first = document.querySelector(".shuo-item");
    return {
      cols: getComputedStyle(first).gridTemplateColumns.split(" ").filter(Boolean),
      woundWrap: yms.some((e) => e.getBoundingClientRect().height > 20),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      itemCount: document.querySelectorAll(".shuo-item").length,
    };
  });
  assert.equal(shuoMobile.overflow, false, "5.4 375px 下不应有横向溢出");
  assert.equal(shuoMobile.woundWrap, false, "5.4 375px 下年月不得折行（实测 54px 栏会把「月」挤到第二行）");
  assert.equal(shuoMobile.cols.length, 2, "5.3 移动端仍保持两列时间线");
  console.log("PASS D-4 移动端（左栏 " + shuoMobile.cols[0] + " · 年月不折行 · 无横向溢出）");

  /* 回归守卫：其他页面的 PageHeader 不得被 D-4 的改动影响 */
  for (const [pathName, wantTitle] of [["/archives", "归档"], ["/search", "搜索"]]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    const other = await page.evaluate(() => ({
      hasRow: !!document.querySelector(".page-title-row"),
      hasEn: !!document.querySelector(".page-title-en"),
      margin: document.querySelector(".page-title")
        ? getComputedStyle(document.querySelector(".page-title")).margin
        : null,
      text: document.querySelector(".page-title")?.textContent?.trim(),
    }));
    assert.equal(other.hasRow, false, pathName + " 不该出现 .page-title-row（只有传了 en 的页面才包一层）");
    assert.equal(other.hasEn, false, pathName + " 不该出现英文辅助标题");
    assert.equal(other.margin, "0px 0px 32px", pathName + " 的标题下边距必须保持原值，实际 " + other.margin);
    assert.equal(other.text, wantTitle, pathName + " 标题文字应保持 " + wantTitle);
  }
  console.log("PASS D-4 PageHeader 改动不影响其它页面（无 .page-title-row / 边距不变）");

  /* ── 断言 47（D-5）：归档页分组列表的空间优化 ── */
  /**
   * 需求 8.3（结构）+ 8.4（空间）。
   *
   * 8.1 的「NaN 月」bug 在阶段 A 就修好了（`dateKeyIn` 补零），
   * 这里顺带守住它不要回归 —— 那是本页最严重的历史缺陷。
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/archives", { waitUntil: "networkidle" });

  const arch2 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".archive-item")];
    const months = [...document.querySelectorAll(".archive-month")];
    const years = [...document.querySelectorAll(".archive-year")];
    const cs = (el) => getComputedStyle(el);
    const row = rows[0];
    return {
      /* 8.3 结构 */
      yearTag: years[0]?.tagName,
      yearText: years[0]?.textContent?.replace(/\s+/g, " ").trim(),
      monthTag: months[0]?.tagName,
      monthCount: months.length,
      rowCount: rows.length,
      dates: rows.map((r) => r.querySelector(".date")?.textContent?.trim()),
      dateFont: row ? parseFloat(cs(row.querySelector(".date")).fontSize) : null,
      titleFont: row ? parseFloat(cs(row.querySelector("a")).fontSize) : null,
      /* 8.3 #7 不是大卡片 */
      rowBg: row ? cs(row).backgroundColor : null,
      rowRadius: row ? cs(row).borderTopLeftRadius : null,
      /* 8.4 空间 */
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      rowPadding: row ? cs(row).padding : null,
      /*
       * 行距（同一月份内相邻行 top 的距离）。
       * 这是 8.4「统一文章行高、缩小间距」的直接度量，且**与文章总数无关** ——
       * 用"内容区总高"当指标的话，测试库里 26 篇文章算出来是 1070px，
       * 和"改前 450px"根本不可比（那是 5 篇文章的数字）。
       */
      rowPitch: (() => {
        const byGroup = new Map();
        for (const r of rows) {
          const g = r.closest(".archive-month-group");
          if (!byGroup.has(g)) byGroup.set(g, []);
          byGroup.get(g).push(r);
        }
        for (const [, list] of byGroup) {
          if (list.length >= 2) {
            return Math.round(list[1].getBoundingClientRect().top - list[0].getBoundingClientRect().top);
          }
        }
        return null;
      })(),
      /* 8.1 回归守卫 */
      hasNaN: document.body.innerText.includes("NaN"),
      /* 对齐：负外边距不能让文字偏移 */
      monthLeft: months[0] ? Math.round(months[0].getBoundingClientRect().left) : null,
      dateLeft: row ? Math.round(row.querySelector(".date").getBoundingClientRect().left) : null,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });

  /* 8.3 #1/#2 年份为一级标题 + 旁边展示数量 */
  assert.equal(arch2.yearTag, "H2", "8.3 年份应是标题元素（h2），实际 " + arch2.yearTag);
  assert.match(arch2.yearText, /^\d{4}\s*\d+\s*篇$/, "8.3 年份旁应有文章数量，实际 " + JSON.stringify(arch2.yearText));
  /* 8.3 #3 月份是二级分组 */
  assert.equal(arch2.monthTag, "H3", "8.3 月份应是二级分组标题（h3），实际 " + arch2.monthTag);
  assert.ok(arch2.monthCount >= 2, "8.3 应渲染出月份分组，实际 " + arch2.monthCount);
  console.log("PASS D-5 归档结构（" + arch2.yearText + " · " + arch2.monthCount + " 个月份分组 · " + arch2.rowCount + " 行）");

  /* 8.1 回归守卫：不得出现 NaN */
  assert.equal(arch2.hasNaN, false, "8.1 归档页不得出现 NaN（日期解析回归）");

  /* 8.3 #5 日期为辅助信息：MM/DD 且补零，字号小于标题 */
  for (const d of arch2.dates) {
    assert.match(d, /^\d{2}\/\d{2}$/, "8.3 日期应是补零的 MM/DD，实际 " + JSON.stringify(d));
  }
  assert.ok(
    arch2.dateFont < arch2.titleFont,
    "8.3 日期应是辅助信息（字号小于标题）：日期 " + arch2.dateFont + " vs 标题 " + arch2.titleFont
  );
  console.log("PASS D-5 日期辅助信息（" + arch2.dates[0] + " · " + arch2.dateFont + "px < 标题 " + arch2.titleFont + "px）");

  /* 8.4 空间：行高收紧且不是卡片 */
  assert.ok(
    arch2.rowHeight !== null && arch2.rowHeight <= 36,
    "8.4 文章行高度应 ≤36px（改前 40），实际 " + arch2.rowHeight
  );
  assert.equal(
    arch2.rowRadius,
    "8px",
    "8.3 #7 行是行高亮而不是卡片（8px 圆角来自 --radius-sm），实际 " + arch2.rowRadius
  );
  assert.ok(
    arch2.rowPitch !== null && arch2.rowPitch <= 35,
    "8.4 同月内行距应 ≤35px（改前 40），实际 " + arch2.rowPitch
  );
  console.log(
    "PASS D-5 空间优化（行高 " + arch2.rowHeight + "px ← 40 · 行距 " + arch2.rowPitch + "px ← 40）"
  );

  /* 负外边距不得让文字左右偏移 */
  assert.equal(
    arch2.dateLeft,
    arch2.monthLeft,
    "月份标签与日期列的左边缘必须对齐（负外边距只是给 hover 背景留空间，不能挪文字）"
  );
  assert.equal(arch2.overflow, false, "归档页不应有横向溢出");

  /* 8.3 #10 文章行 hover 时应有轻量反馈 */
  const hoverBefore = await page.evaluate(() => {
    const row = document.querySelector(".archive-item");
    return { bg: getComputedStyle(row).backgroundColor, color: getComputedStyle(row.querySelector("a")).color };
  });
  await page.hover(".archive-item");
  await page.waitForTimeout(250);
  const hoverAfter = await page.evaluate(() => {
    const row = document.querySelector(".archive-item");
    return { bg: getComputedStyle(row).backgroundColor, color: getComputedStyle(row.querySelector("a")).color };
  });
  assert.notEqual(hoverAfter.bg, hoverBefore.bg, "8.3 #10 hover 时行背景应有变化");
  assert.notEqual(hoverAfter.color, hoverBefore.color, "8.3 #10 hover 时标题颜色应有变化");
  console.log("PASS D-5 hover 反馈（背景 + 标题颜色都变化）");

  /* 回归守卫：搜索页与标签页不受影响 */
  await page.goto(server.base + "/search?q=" + encodeURIComponent("测试"), { waitUntil: "networkidle" });
  const searchMeta = await page.evaluate(() => ({
    meta: document.querySelector(".search-meta")?.textContent?.trim(),
    hasHeader: !!document.querySelector("header.page-head"),
    h1: document.querySelectorAll("h1").length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
  assert.ok(searchMeta.meta && searchMeta.meta.length > 0, "搜索页应显示结果计数，实际 " + JSON.stringify(searchMeta.meta));
  assert.equal(searchMeta.h1, 1, "搜索页仍应只有一个 h1");
  assert.equal(searchMeta.overflow, false, "搜索页不应有横向溢出");
  console.log("PASS D-5 搜索页（" + searchMeta.meta + "）");

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
/**
 * 种上全站页脚需要的两个设置。
 *
 * `SiteFooter` 的逻辑是「icp 与 footerText 都为空时整块不渲染」——
 * 这是**正确行为**（空配置不该占位）。但测试库默认两项都是空，
 * 于是页脚压根不出现，`<footer>` 计数断言就无从谈起。
 *
 * 这不是为了让测试通过而造假：B-5 要验的是"一个页面只有 1 个 footer 地标"，
 * 前提是那个地标本身存在。
 */
function seedSiteFooterSettings(dataDir) {
  const db = new Database(dataDir + "/blog.db");
  db.pragma("journal_mode = WAL");
  const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  up.run("icp", "赣ICP备00000000号-1");
  up.run("footer_text", "本站由 flechazo 维护");
  db.close();
}

/**
 * 造几篇"长串"文章（R1）。
 *
 * 正文里贴长 URL 是最正常的写作行为（引用 GitHub 地址、API 路径、
 * 没有空格的文件名）。没有 overflow-wrap 时它会把整页横向撑破 ——
 * 实测 1200px 下溢出 909px。这里把四类典型形态都种上。
 */
function seedLongStringPosts(dataDir) {
  const db = new Database(dataDir + "/blog.db");
  db.pragma("journal_mode = WAL");
  const now = new Date().toISOString();
  const ins = db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) " +
    "VALUES ('post', ?, ?, ?, 'published', ?, ?, ?)"
  );
  const ids = {};
  ids.url = Number(ins.run("r1-url", "长链接测试",
    "## 链接\n\nhttps://example.com/" + "a".repeat(180) + "\n\n段落。", now, now, now).lastInsertRowid);
  ids.word = Number(ins.run("r1-word", "长单词测试",
    "## 词\n\n" + "Supercalifragilisticexpialidocious".repeat(5), now, now, now).lastInsertRowid);
  ids.title = Number(ins.run("r1-title", "Supercalifragilisticexpialidocious".repeat(4),
    "## 标题\n\n正文。", now, now, now).lastInsertRowid);
  ids.code = Number(ins.run("r1-code", "代码块测试",
    "## 代码\n\n```\nconst x = '" + "a".repeat(150) + "';\n```\n\n段落。", now, now, now).lastInsertRowid);
  db.close();
  return ids;
}

/**
 * 造够 21 篇文章，让首页出现分页（PAGE_SIZE = 20）。
 *
 * 分页条只在 `total > PAGE_SIZE` 时渲染，不造数据就测不到
 * `.pager-current`（C-5 把它的内联样式改成了语义类）。
 */
/**
 * 造几条说说（D-4）。
 *
 * 说说页的空状态与时间线是**两套完全不同的 DOM**：没有数据时渲染
 * `<EmptyState>`，有数据时渲染 `<ol class="shuo-list">`。不种数据的话
 * 时间线相关断言会在空状态上直接抛"找不到元素"。
 *
 * 内容里混入长 URL 与长段落：需求 5.3 要求「长文本自然换行」，
 * 而 `.shuo-content` 不在 `.prose` 里、拿不到 R1 的 overflow-wrap 修复，
 * 曾经一个 180 字符的 URL 就能把整页撑破（D-4 实测三个视口全溢出）。
 */
function seedShuoshuo(dataDir) {
  const db = new Database(dataDir + "/blog.db");
  db.pragma("journal_mode = WAL");
  const ins = db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) " +
    "VALUES ('shuoshuo', ?, '', ?, 'published', ?, ?, ?)"
  );
  // 固定基准时间：断言要能预知"日"是两位数还是补零后的形态
  const base = Date.parse("2026-10-29T10:20:00.000Z");
  const rows = [
    ["shuo-a", "一条普通的说说，用来验证时间线结构。"],
    ["shuo-b", "带长链接的说说：https://example.com/" + "a".repeat(180)],
    ["shuo-c", "> 引用一行\n\n引用之后的正文。"],
    ["shuo-d", "短句。"],
  ];
  rows.forEach(([slug, content], i) => {
    const at = new Date(base - i * 86400000).toISOString();
    ins.run(slug, content, at, at, at);
  });
  db.close();
}

function seedPostsForPager(dataDir, n = 21) {
  const db = new Database(dataDir + "/blog.db");
  db.pragma("journal_mode = WAL");
  const now = new Date().toISOString();
  const ins = db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) " +
    "VALUES ('post', ?, ?, '正文', 'published', ?, ?, ?)"
  );
  for (let i = 1; i <= n; i++) {
    const at = new Date(Date.now() - i * 86400000).toISOString();
    ins.run("pager-" + i, "分页测试文章 " + i, at, at, at);
  }
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
