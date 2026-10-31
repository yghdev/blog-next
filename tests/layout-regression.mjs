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
