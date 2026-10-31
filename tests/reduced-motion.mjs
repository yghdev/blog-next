/**
 * 减弱动效回归（A-5，2026-10-31）。
 *
 * ## 事故背景
 *
 * app/globals.css:1838 的「斜杠星号 + ═════…」只写了开头没写结尾，把紧接着的
 * 整个 `@media (prefers-reduced-motion: reduce)` 吞进注释，直到 1852 行
 * 另一个「星号斜杠」才闭合。CSS 注释不配平**不报错**，构建照过，只是那一段
 * 规则永远不会生效 —— 对普通用户完全没有症状，只有开了系统「减少动态
 * 效果」的人才会发现动画还在动。
 *
 * ## 断言策略
 *
 * 不比对具体类名清单（那样每加一个组件就要改测试），而是：
 *   1. reducedMotion=reduce 的 context 下，抽样若干带过渡的元素，
 *      断言 transition-duration ≤ 0.001s；
 *   2. 普通 context 下，同样元素的 transition-duration 必须仍在
 *      0.15~0.2s 区间 —— 这条防的是「把压缩写成全局」，那种改法会让
 *      所有用户都失去过渡，比 bug 本身更糟。
 *
 * 注意必须用独立的 browser context：reducedMotion 是 context 级
 * 选项，在已创建的 page 上用 emulateMedia 也能改，但 context 级更贴近
 * 真实的系统偏好，且能保证两次测量互不污染。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

const cjsRequire = createRequire(import.meta.url);

/** 抽样：主题切换按钮（.2s）、卡片（.18s 左右的过渡）、导航项 */
const SAMPLES = [".theme-toggle", ".post-card", ".nav-item", ".tag-pill"];

let server, controller;
try {
  server = await startIsolatedServer({ label: "reduced-motion" });

  // 造一篇已发布文章，保证首页有 .post-card
  seedPost(server.dataDir);

  controller = await startBrowser();

  /** 在指定 context 下采样一组元素的 transition-duration（秒） */
  async function sample(context, pathName) {
    const page = await context.newPage();
    try {
      await page.goto(server.base + pathName, { waitUntil: "networkidle" });
      // 注意：这里**不能**注入 transition:none 来"取稳态" —— 那会把要测的
      // computed transition-duration 一起改掉，测量结果恒为 0，测试永远绿。
      // transition-duration 是静态计算值，不需要等动画结束。
      const out = await page.evaluate((samples) => {
        const toSeconds = (v) => {
          if (!v) return null;
          const parts = String(v).split(",").map((x) => x.trim());
          return parts.map((p) => {
            if (p.endsWith("ms")) return parseFloat(p) / 1000;
            if (p.endsWith("s")) return parseFloat(p);
            return parseFloat(p);
          });
        };
        const res = {};
        for (const sel of samples) {
          const el = document.querySelector(sel);
          if (!el) { res[sel] = null; continue; }
          const cs = getComputedStyle(el);
          res[sel] = {
            duration: toSeconds(cs.transitionDuration),
            property: cs.transitionProperty,
          };
        }
        return res;
      }, SAMPLES);
      return out;
    } finally {
      await page.close();
    }
  }

  /* ── 1) 减弱动效 context：所有抽样元素的过渡必须被压到 ≤ 1ms ── */
  const reducedCtx = await controller.browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const reduced = await sample(reducedCtx, "/");

  let checked = 0;
  for (const sel of SAMPLES) {
    const v = reduced[sel];
    if (!v || !v.duration) continue; // 元素不存在或本来就没有过渡
    for (const d of v.duration) {
      assert.ok(
        d <= 0.001,
        "reducedMotion=reduce 下 " + sel + " 的 transition-duration 应 ≤ 0.001s，实际 " + d + "s（" + JSON.stringify(v.duration) + "）"
      );
      checked++;
    }
  }
  assert.ok(checked >= 2, "至少要检查到 2 个带过渡的元素，实际 " + checked + " 个（样本可能都选空了）");
  console.log("PASS A-5 reduce 上下文下 " + checked + " 个过渡值均 ≤ 1ms");

  /* ── 2) 普通 context：同样的元素必须保留正常过渡（不能被"全局压缩"误伤） ── */
  const normalCtx = await controller.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const normal = await sample(normalCtx, "/");

  let normalChecked = 0;
  for (const sel of SAMPLES) {
    const v = normal[sel];
    if (!v || !v.duration) continue;
    for (const d of v.duration) {
      // 过渡时长为 0 常常意味着"这个属性本来就没设过渡"，跳过；
      // 有值的必须落在正常区间，不能被压到毫秒级。
      if (d === 0) continue;
      assert.ok(
        d >= 0.1 && d <= 0.5,
        "普通上下文下 " + sel + " 的 transition-duration 应保持 0.1~0.5s，实际 " + d + "s —— 减弱动效不能写成全局"
      );
      normalChecked++;
    }
  }
  assert.ok(normalChecked >= 2, "普通上下文至少检查到 2 个过渡值，实际 " + normalChecked);
  console.log("PASS A-5 普通上下文保留 " + normalChecked + " 个正常过渡（0.1~0.5s）");

  /* ── 3) .slide-up 在 reduce 下必须直接显示（无位移、无透明度过渡） ── */
  const reducedPage = await reducedCtx.newPage();
  try {
    await reducedPage.goto(server.base + "/", { waitUntil: "networkidle" });
    const slide = await reducedPage.evaluate(() => {
      const el = document.querySelector(".slide-up");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { opacity: cs.opacity, transform: cs.transform };
    });
    if (slide) {
      assert.equal(slide.opacity, "1", ".slide-up 在减弱动效下应直接不透明，实际 " + slide.opacity);
      const t = slide.transform;
      assert.ok(
        t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)",
        ".slide-up 在减弱动效下不应有位移，实际 transform=" + t
      );
      console.log("PASS A-5 .slide-up 在 reduce 下直接显示");
    } else {
      console.log("SKIP A-5 页面没有 .slide-up（该元素由 JS 条件渲染）");
    }
  } finally {
    await reducedPage.close();
  }

  /* ── 4) reduce 下全站关键页面都不应报 JS 错、也不该有元素被"压没" ── */
  /**
   * 上一版把一大段 CSS 吞进注释，浏览器只会"少应用一些样式"，不会报错。
   * 所以反向检查也要做：reduce 开启后，页面必须仍然完整渲染（标题、导航、
   * 文章卡片都在），不能因为 `animation-duration: .01ms` 把入场动画的元素
   * 卡在 `opacity: 0`（这是 `!important` + 无限动画常见的翻车方式）。
   */
  const pages = ["/", "/archives", "/shuoshuo"];
  for (const pathName of pages) {
    const p2 = await reducedCtx.newPage();
    try {
      const errors = [];
      p2.on("pageerror", (e) => errors.push(String(e)));
      await p2.goto(server.base + pathName, { waitUntil: "networkidle" });
      const r = await p2.evaluate(() => {
        const invisible = [];
        for (const el of document.querySelectorAll("h1, h2, .post-card, .nav-item, .page-title")) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          if (parseFloat(cs.opacity) < 0.99) invisible.push((el.className || el.tagName) + " opacity=" + cs.opacity);
        }
        return { invisible, bodyText: document.body.innerText.trim().length };
      });
      assert.deepEqual(errors, [], pathName + " 在 reduce 下有 JS 错误：" + errors.join("; "));
      // 门槛只用来抓"整页渲染崩了"，不要求页面有内容 —— 空态页面本身是合法的
      assert.ok(r.bodyText >= 10, pathName + " 在 reduce 下不应渲染成空白页，实际 " + r.bodyText + " 字符");
      assert.deepEqual(r.invisible, [], pathName + " 在 reduce 下不应有内容被压成透明：" + JSON.stringify(r.invisible));
      console.log("PASS A-5 reduce 下 " + pathName + " 正常渲染（" + r.bodyText + " 字符）");
    } finally {
      await p2.close();
    }
  }

  await reducedCtx.close();
  await normalCtx.close();

  console.log("\nAll A-5 reduced-motion checks passed.");
} catch (e) {
  if (server?.logs) console.error(server.logs());
  throw e;
} finally {
  // context 由 browser.close() 一并回收；这里显式关掉能更早释放
  if (server) await server.close();
  if (controller) await controller.close();
}

function seedPost(dataDir) {
  // better-sqlite3 是 CJS；本文件是 ESM，用 createRequire 加载
  const Database = cjsRequire("better-sqlite3");
  const db = new Database(dataDir + "/blog.db");
  db.pragma("journal_mode = WAL");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) " +
    "VALUES ('post', 'rm-post', '减弱动效测试文章', '# 标题\n\n正文内容。', 'published', ?, ?, ?)"
  ).run(now, now, now);
  db.close();
}
