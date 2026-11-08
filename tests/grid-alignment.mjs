/**
 * 栅格对齐体检（2026-11-08 栅格化）。
 *
 * ## 这个文件回答什么问题
 *
 * 静态测试（tests/grid-system.test.ts）只能证明「令牌与选择器写对了」，
 * 证明不了「屏幕上真的对齐」。这个文件把栅格化最核心的承诺变成可测量的事实：
 *
 *   · 前台：内容块的左右边缘是否落在同一条线上；卡片内部的标题 / 摘要 / 元信息
 *     是否共用同一条左基线；归档与说说的时间列是否定宽（不随日期位数跳）；
 *     右栏区块是否等宽；友链两列是否真的等分。
 *   · 后台：侧栏右缘 = 主体左缘；页面块（标题区 / 首屏卡 / 统计 / 两栏区）
 *     是否共用内容盒；列表行的选择框 / 状态 / 日期列是否在所有行上位置恒定；
 *     统计卡是否等宽。
 *   · 叠加层（?grid=1）：属性只在带参数时出现；伪元素绝对定位且不挡点击；
 *     列数确实按 12（≤820 切 4）算；开与关的布局完全一致（零位移）。
 *
 * ## 为什么用容差 1px 而不是 0
 *
 * 浏览器对小数宽度会做子像素取整，getBoundingClientRect() 在 1440 视口下
 * 经常返回 62.33 与 62.34。容差 1px 既能抓住「真的错位」（最小可见错位通常
 * ≥2px），又不会被渲染取整误判成 bug。
 *
 * ## 与既有测试的分工
 *
 *   · tests/layout-regression.mjs —— 断点矩阵下的宽度契约（14 档视口）；
 *   · 本文件 —— 对齐契约（谁和谁在同一条线上）。
 * 两者互不替代：宽度对了照样可能有一块往左偏 8px。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

/** 前后台共用的容差：1px 抓得住可见错位，也不会被子像素取整误判 */
const TOL = 1;

let server, controller;
try {
  server = await startIsolatedServer({ label: "grid" });
  const articleId = seed(server.dataDir);
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  /* ═══════════════════════════ 前台 ═══════════════════════════ */

  await page.setViewportSize({ width: 1440, height: 900 });

  /* ── 1. 首页：内容块共用同一条左右边线 ── */
  await open(page, server.base + "/");
  const home = await measure(page, {
    content: ".content",
    search: ".content-search",
    list: ".post-list",
    cards: ".post-card",
    titles: ".post-card h2",
    excerpts: ".post-card .excerpt",
    metas: ".post-card .meta",
  });
  assert.ok(home.content.length === 1, "首页应有 .content");
  const content = home.content[0];
  assertEdges(home.search, content, "首页搜索框");
  assertEdges(home.list, content, "文章列表容器");
  assertEdges(home.cards, content, "文章卡片");
  // 卡片内部：标题 / 摘要 / 元信息必须共用同一条左基线（否则右侧会参差）
  assertUniform(home.titles.concat(home.excerpts, home.metas), "卡片内文字左基线");
  // 左右内边距对称：标题左缘到卡片左缘 == 卡片右缘到标题右缘
  for (let i = 0; i < home.cards.length; i++) {
    const padL = home.titles[i].left - home.cards[i].left;
    const padR = home.cards[i].right - home.titles[i].right;
    assert.ok(
      Math.abs(padL - padR) <= TOL,
      "第 " + (i + 1) + " 张卡片左右内边距不对称：" + padL.toFixed(1) + " vs " + padR.toFixed(1)
    );
  }
  console.log("PASS 前台首页：搜索框 / 列表 / " + home.cards.length + " 张卡片共用内容盒左右边线，卡内文字同基线");

  /* ── 2. 归档：时间列必须定宽（否则日期位数一变，正文就左右跳） ── */
  await open(page, server.base + "/archives");
  const arch = await measure(page, {
    content: ".content",
    years: ".archive-year",
    dates: ".archive-item .date",
    items: ".archive-item",
  });
  assert.ok(arch.items.length >= 2, "归档应有至少 2 行（种子 3 篇）");
  assertUniform(arch.dates, "归档日期列（左缘 + 宽度）");
  assertEdges(arch.years, arch.content[0], "归档年份标题");
  console.log("PASS 前台归档：" + arch.dates.length + " 行日期列宽恒等（" + arch.dates[0].width.toFixed(1) + "px），年份标题与内容盒对齐");

  /* ── 3. 说说：同一条时间轴，同样定宽 ── */
  await open(page, server.base + "/shuoshuo");
  const shuo = await measure(page, {
    content: ".content",
    stamps: ".shuo-stamp",
    items: ".shuo-item",
  });
  assert.ok(shuo.items.length >= 2, "说说应有至少 2 行");
  assertUniform(shuo.stamps, "说说时间列（左缘 + 宽度）");
  assertUniform(shuo.items, "说说行");
  console.log("PASS 前台说说：" + shuo.stamps.length + " 行时间列宽恒等（" + shuo.stamps[0].width.toFixed(1) + "px）");

  /* ── 4. 右栏：区块等宽、统计格等分 ── */
  await open(page, server.base + "/");
  const rail = await measure(page, {
    blocks: ".rb-block",
    cells: ".stat-grid > .stat-cell",
  });
  assert.ok(rail.blocks.length >= 1, "首页右栏应有区块");
  assertUniform(rail.blocks, "右栏区块（左缘 + 宽度）");
  if (rail.cells.length >= 2) {
    const firstRow = sameRow(rail.cells);
    assert.ok(firstRow.length >= 2, "统计格首排应至少 2 个");
    assert.ok(
      spread(firstRow.map((c) => c.width)) <= TOL,
      "统计格首排不等宽：" + firstRow.map((c) => c.width.toFixed(1)).join(", ")
    );
  }
  console.log("PASS 前台右栏：" + rail.blocks.length + " 个区块等宽，统计格等分");

  /* ── 5. 文章页：正文框内的所有块共用同一条边线 ── */
  await open(page, server.base + "/p/" + articleId);
  const article = await measure(page, {
    content: ".content",
    header: ".article-header",
    prose: ".prose",
    author: ".author-card",
    related: ".related",
    nav: ".article-nav",
  });
  const articleBlocks = [].concat(article.header, article.prose, article.author, article.related, article.nav);
  assert.ok(articleBlocks.length >= 4, "文章页应有标题区 / 正文 / 作者卡 / 相关 / 上下篇（实际 " + articleBlocks.length + " 块）");
  assertUniform(articleBlocks, "文章页各块（左缘 + 宽度）");
  assertEdges([article.header[0]], article.content[0], "文章标题区");
  console.log("PASS 前台文章页：" + articleBlocks.length + " 个块共用同一左右边线（宽 " + article.prose[0].width.toFixed(1) + "px）");

  /* ── 6. 搜索页：输入框与结果卡片同宽 ── */
  await open(page, server.base + "/search?q=" + encodeURIComponent("栅格"));
  const search = await measure(page, {
    content: ".content",
    form: ".search-page-form",
    meta: ".search-meta",
    cards: ".post-card",
  });
  assertEdges(search.form, search.content[0], "搜索输入框");
  if (search.meta.length > 0) assertEdges(search.meta, search.content[0], "搜索结果摘要");
  if (search.cards.length > 0) assertEdges(search.cards, search.content[0], "搜索结果卡片");
  console.log("PASS 前台搜索页：输入框与 " + search.cards.length + " 张结果卡片同宽");

  /* ── 7. 友链页：两列真的等分，列与列各自对齐 ── */
  await open(page, server.base + "/friend-links");
  const friends = await measure(page, { content: ".content", cards: ".fr-grid .fr-card" });
  assert.ok(friends.cards.length >= 4, "友链应有至少 4 张卡（种子 6 条）");
  const rows = groupRows(friends.cards);
  assert.ok(rows.length >= 2, "友链应至少两行");
  for (const row of rows) {
    assert.ok(row.length === 2, "友链每行应为 2 张，实际 " + row.length);
    assert.ok(
      Math.abs(row[0].width - row[1].width) <= TOL,
      "友链同行两张卡不等宽：" + row[0].width.toFixed(1) + " vs " + row[1].width.toFixed(1)
    );
  }
  for (const col of [0, 1]) {
    const lefts = rows.map((r) => r[col].left);
    assert.ok(spread(lefts) <= TOL, "友链第 " + (col + 1) + " 列左缘漂移：" + lefts.join(", "));
  }
  console.log("PASS 前台友链页：" + rows.length + " 行 × 2 列等宽，两列列线对齐");

  /* ═══════════════════════════ 后台 ═══════════════════════════ */

  /* ── 8. 后台骨架：侧栏右缘 = 主体左缘，页面块落在内容盒里 ── */
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, server.base + "/admin/overview");
  const overview = await page.evaluate(() => {
    const side = document.querySelector(".admin-sidebar").getBoundingClientRect();
    const main = document.querySelector(".admin-main");
    const cs = getComputedStyle(main);
    const mr = main.getBoundingClientRect();
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: +r.left.toFixed(2), right: +r.right.toFixed(2), top: +r.top.toFixed(2), width: +r.width.toFixed(2) };
    };
    return {
      sideRight: +side.right.toFixed(2),
      mainLeft: +mr.left.toFixed(2),
      contentLeft: +(mr.left + parseFloat(cs.paddingLeft)).toFixed(2),
      contentRight: +(mr.right - parseFloat(cs.paddingRight)).toFixed(2),
      blocks: [...main.children].map((el) => Object.assign({ cls: String(el.className) }, box(el))),
      statCards: [...document.querySelectorAll(".stat-grid > .stat-card")].map(box),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });
  assert.ok(
    Math.abs(overview.sideRight - overview.mainLeft) <= TOL,
    "后台侧栏右缘应等于主体左缘：" + overview.sideRight + " vs " + overview.mainLeft
  );
  for (const b of overview.blocks) {
    assert.ok(
      Math.abs(b.left - overview.contentLeft) <= TOL && Math.abs(b.right - overview.contentRight) <= TOL,
      "后台页面块应落在内容盒里（" + b.cls + "）：" + b.left + "/" + b.right + " vs " + overview.contentLeft + "/" + overview.contentRight
    );
  }
  const statRow = sameRow(overview.statCards);
  assert.ok(statRow.length >= 2, "概览统计卡应有同排多张（实际 " + statRow.length + "）");
  assert.ok(
    spread(statRow.map((c) => c.width)) <= TOL,
    "概览统计卡不等宽：" + statRow.map((c) => c.width.toFixed(1)).join(", ")
  );
  assert.ok(overview.scrollW <= overview.clientW + 1, "后台概览横向溢出：" + overview.scrollW + " > " + overview.clientW);
  console.log("PASS 后台骨架：侧栏与主体相接，页面块与 " + statRow.length + " 张统计卡都在内容盒内且等宽");

  /* ── 9. 后台列表：行内各列在所有行上位置恒定 ── */
  await open(page, server.base + "/admin");
  const list = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: +r.left.toFixed(2), right: +r.right.toFixed(2), top: +r.top.toFixed(2), width: +r.width.toFixed(2) };
    };
    const panel = box(document.querySelector(".data-panel"));
    const rows = [...document.querySelectorAll(".data-panel .data-row")].map((row) => ({
      row: box(row),
      check: box(row.querySelector('input[type="checkbox"]')),
      state: box(row.querySelector(".fx-state")),
      title: box(row.querySelector(".data-row-title")),
      meta: box(row.querySelector(".data-row-meta")),
    }));
    return { panel, rows };
  });
  assert.ok(list.panel, "后台列表应有 .data-panel");
  assert.ok(list.rows.length >= 2, "后台列表应有至少 2 行（种子 3 篇 + 说说）");
  for (const key of ["check", "state", "title"]) {
    const items = list.rows.map((r) => r[key]).filter(Boolean);
    assert.equal(items.length, list.rows.length, "每一行都应有 " + key + " 列");
    assertUniform(items, "列表 " + key + " 列（左缘）");
  }
  const metas = list.rows.map((r) => r.meta).filter(Boolean);
  if (metas.length === list.rows.length) {
    assert.ok(spread(metas.map((m) => m.right)) <= TOL, "列表日期列右缘不一致：" + metas.map((m) => m.right).join(", "));
  }
  for (const r of list.rows) {
    assert.ok(
      Math.abs(r.row.left - list.panel.left) <= TOL && Math.abs(r.row.right - list.panel.right) <= TOL,
      "列表行应铺满面板：" + JSON.stringify(r.row) + " vs " + JSON.stringify(list.panel)
    );
  }
  console.log("PASS 后台列表：" + list.rows.length + " 行的选择框 / 状态 / 标题 / 日期列位置恒定");

  /* ── 10. 后台设置：面板等宽 ── */
  await open(page, server.base + "/admin/settings");
  // 设置页的"块"是 .settings-group（后台设置分五组），不是 Card 的 .fx-panel
  const settings = await measure(page, { groups: ".settings-group" });
  assert.ok(settings.groups.length >= 1, "设置页应有 .settings-group");
  assertUniform(settings.groups, "设置分组（左缘 + 宽度）");
  console.log("PASS 后台设置：" + settings.groups.length + " 个设置分组等宽对齐");

  /* ── 11. 后台手机：单列、内边距 16、无横向溢出 ── */
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, server.base + "/admin/overview");
  const adminMobile = await page.evaluate(() => {
    const main = document.querySelector(".admin-main");
    const cs = getComputedStyle(main);
    const cells = [...document.querySelectorAll(".stat-grid > .stat-card")].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: +r.left.toFixed(2), right: +r.right.toFixed(2), top: +r.top.toFixed(2), width: +r.width.toFixed(2) };
    });
    return {
      padLeft: parseFloat(cs.paddingLeft),
      cells,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });
  assert.ok(Math.abs(adminMobile.padLeft - 16) <= 0.5, "后台手机内边距应为 16px，实际 " + adminMobile.padLeft);
  const mobileRow = sameRow(adminMobile.cells);
  assert.equal(mobileRow.length, 2, "后台手机统计卡首排应为 2 张，实际 " + mobileRow.length);
  assert.ok(
    spread(mobileRow.map((c) => c.width)) <= TOL,
    "后台手机统计卡不等宽：" + mobileRow.map((c) => c.width.toFixed(1)).join(", ")
  );
  assert.ok(adminMobile.scrollW <= adminMobile.clientW + 1, "后台手机横向溢出：" + adminMobile.scrollW + " > " + adminMobile.clientW);
  console.log("PASS 后台手机：内容区 16px 内边距、统计卡两列等宽、无横向溢出");

  /* ═══════════════════════ 叠加层（?grid=1） ═══════════════════════ */

  await page.setViewportSize({ width: 1440, height: 900 });

  /* ── 12. 不带参数：没有任何痕迹 ── */
  await open(page, server.base + "/");
  const off = await overlayState(page, ".content");
  assert.equal(off.attr, false, "不带 ?grid=1 时 html 不应有 data-grid");
  assert.equal(off.content, "none", "不带 ?grid=1 时 .content::before 不应生成内容，实际 " + off.content);
  console.log("PASS 叠加层：默认关闭（无 data-grid、无伪元素内容）");

  /* ── 13. 前台 ?grid=1：12 列、不挡点击、零位移 ── */
  const beforeOn = await layoutFingerprint(page, server.base + "/");
  await open(page, server.base + "/?grid=1");
  await page.waitForFunction(() => document.documentElement.getAttribute("data-grid") === "1", null, { timeout: 5000 });
  const frontOverlay = await overlayState(page, ".content");
  assert.equal(frontOverlay.attr, true, "?grid=1 应给 html 打 data-grid=1");
  assert.equal(frontOverlay.position, "absolute", "叠加层应为绝对定位，实际 " + frontOverlay.position);
  assert.equal(frontOverlay.pointerEvents, "none", "叠加层不能挡点击，实际 " + frontOverlay.pointerEvents);
  const frontCols = overlayColumns(frontOverlay, frontOverlay.contentWidth);
  assert.ok(Math.abs(frontCols - 12) <= 0.6, "前台叠加层应为 12 列，实测 " + frontCols.toFixed(2) + " 列");
  const frontAfter = await layoutFingerprint(page, null);
  assertSameLayout(beforeOn, frontAfter, "前台叠加层开/关");
  console.log("PASS 叠加层：前台 " + frontCols.toFixed(0) + " 列、绝对定位、不挡点击，开/关零位移");

  /* ── 14. 后台 ?grid=1：画在内容盒里、12 列、零位移 ── */
  const beforeAdmin = await layoutFingerprint(page, server.base + "/admin/overview");
  await open(page, server.base + "/admin/overview?grid=1");
  await page.waitForFunction(() => document.documentElement.getAttribute("data-grid") === "1", null, { timeout: 5000 });
  const adminOverlay = await overlayState(page, ".admin-main");
  assert.equal(adminOverlay.position, "absolute", "后台叠加层应为绝对定位");
  assert.equal(adminOverlay.pointerEvents, "none", "后台叠加层不能挡点击");
  // 两层背景 → 计算值是 "content-box, content-box"，所以用包含而不是相等
  assert.ok(
    String(adminOverlay.backgroundOrigin).includes("content-box"),
    "后台叠加层应画在内容盒里（background-origin: content-box），实际 " + adminOverlay.backgroundOrigin
  );
  const adminCols = overlayColumns(adminOverlay, adminOverlay.contentWidth);
  assert.ok(Math.abs(adminCols - 12) <= 0.6, "后台叠加层应为 12 列，实测 " + adminCols.toFixed(2) + " 列");
  const afterAdmin = await layoutFingerprint(page, null);
  assertSameLayout(beforeAdmin, afterAdmin, "后台叠加层开/关");
  console.log("PASS 叠加层：后台 " + adminCols.toFixed(0) + " 列、内容盒原点、零位移");

  /* ── 15. 手机 ?grid=1：切 4 列 ── */
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, server.base + "/?grid=1");
  await page.waitForFunction(() => document.documentElement.getAttribute("data-grid") === "1", null, { timeout: 5000 });
  const mobileOverlay = await overlayState(page, ".content");
  const mobileCols = overlayColumns(mobileOverlay, mobileOverlay.contentWidth);
  assert.ok(Math.abs(mobileCols - 4) <= 0.6, "手机叠加层应切 4 列，实测 " + mobileCols.toFixed(2) + " 列");
  console.log("PASS 叠加层：375px 下切 " + mobileCols.toFixed(0) + " 列（12 列在手机上不可读）");

  console.log("\nAll grid-alignment checks passed.");
} catch (e) {
  if (server?.logs) console.error(server.logs());
  throw e;
} finally {
  if (server) await server.close();
  if (controller) await controller.close();
}

/* ══════════════════════════ 断言小工具 ══════════════════════════ */

/** 极差 */
function spread(values) {
  return Math.max.apply(null, values) - Math.min.apply(null, values);
}

/** 一组盒子共用同一条左边缘 + 同一条右边缘 */
function assertUniform(items, label) {
  assert.ok(items.length > 0, label + "：找不到元素");
  const lefts = items.map((i) => i.left);
  const rights = items.map((i) => i.right);
  assert.ok(spread(lefts) <= TOL, label + " 左边缘不一致：" + lefts.map((v) => v.toFixed(1)).join(", "));
  assert.ok(spread(rights) <= TOL, label + " 右边缘不一致：" + rights.map((v) => v.toFixed(1)).join(", "));
}

/** 一组盒子与目标盒子的左右边缘对齐 */
function assertEdges(items, box, label) {
  assert.ok(items.length > 0, label + "：找不到元素");
  assert.ok(
    spread(items.map((i) => i.left)) <= TOL,
    label + " 自身左边缘不一致：" + items.map((i) => i.left.toFixed(1)).join(", ")
  );
  assert.ok(
    Math.abs(items[0].left - box.left) <= TOL,
    label + " 左边缘应等于内容盒：" + items[0].left.toFixed(2) + " vs " + box.left.toFixed(2)
  );
  assert.ok(
    Math.abs(items[0].right - box.right) <= TOL,
    label + " 右边缘应等于内容盒：" + items[0].right.toFixed(2) + " vs " + box.right.toFixed(2)
  );
}

/** 同一排（top 相同）的盒子 */
function sameRow(items) {
  if (items.length === 0) return [];
  const top = items[0].top;
  return items.filter((i) => Math.abs(i.top - top) <= TOL);
}

/** 按 top 分组成行 */
function groupRows(items) {
  const rows = [];
  for (const item of items) {
    const row = rows.find((r) => Math.abs(r[0].top - item.top) <= TOL);
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows;
}

/* ══════════════════════════ 页面小工具 ══════════════════════════ */

/** 打开页面并关掉过渡（取稳态，避免读到动画中间值） */
async function open(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
}

/** 取一组选择器的盒子（按选择器分组） */
async function measure(page, sels) {
  return page.evaluate((map) => {
    const out = {};
    for (const key of Object.keys(map)) {
      out[key] = [...document.querySelectorAll(map[key])].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: +r.left.toFixed(2),
          right: +r.right.toFixed(2),
          top: +r.top.toFixed(2),
          width: +r.width.toFixed(2),
        };
      });
    }
    return out;
  }, sels);
}

/** 叠加层状态：属性、伪元素的计算样式、内容宽 */
async function overlayState(page, containerSel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error("找不到容器 " + sel);
    const cs = getComputedStyle(el, "::before");
    const own = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // 列宽相对**内容盒**算：后台 .admin-main 有 40px 内边距，用 border-box 会多算
    const contentWidth = r.width - parseFloat(own.paddingLeft) - parseFloat(own.paddingRight);
    return {
      attr: document.documentElement.getAttribute("data-grid") === "1",
      content: cs.content,
      position: cs.position,
      pointerEvents: cs.pointerEvents,
      backgroundOrigin: cs.backgroundOrigin,
      backgroundSize: cs.backgroundSize,
      contentWidth: +contentWidth.toFixed(2),
      left: +r.left.toFixed(2),
      right: +r.right.toFixed(2),
      width: +r.width.toFixed(2),
    };
  }, containerSel);
}

/**
 * 从 background-size 反推列数。
 *
 * 叠加层用 tile = (100% + gutter) / N 铺列（推导见 docs/grid-system.md），
 * 所以 N = (内容宽 + 24) / 第一层 tile 宽。
 */
function overlayColumns(state, width) {
  /**
   * Chromium 会把背景尺寸算成 `calc(8.33333% + 2px) 100%` 而不是一个像素值
   * （12 栅格的 tile 本来就是「宽度的 1/12 + 栅距」），所以要看两种形态。
   * 复算：tile = W/12 + 2，列数 = (W + 24) / tile = 12（与 W 无关）。
   */
  const first = String(state.backgroundSize || "").split(",")[0].trim();
  const calc = first.match(/calc\(\s*([\d.]+)%\s*\+\s*([\d.]+)px\s*\)/);
  const tile = calc
    ? (width * Number(calc[1])) / 100 + Number(calc[2])
    : parseFloat(first);
  assert.ok(Number.isFinite(tile) && tile > 0, "叠加层 background-size 解析失败：" + state.backgroundSize);
  return (width + 24) / tile;
}

/** 布局指纹：叠加层开关前后必须完全一致的那几个数 */
async function layoutFingerprint(page, url) {
  if (url) await open(page, url);
  return page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((v) => +v.toFixed(2));
    };
    return {
      shell: box(".site-shell") || box(".admin-shell"),
      main: box(".content") || box(".admin-main"),
      firstBlock: box(".post-card") || box(".page-head"),
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
}

function assertSameLayout(before, after, label) {
  for (const key of Object.keys(before)) {
    const a = before[key];
    const b = after[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < a.length; i++) {
        assert.ok(Math.abs(a[i] - b[i]) <= 0.5, label + "：" + key + " 第 " + i + " 个数值位移 " + a[i] + " → " + b[i]);
      }
    } else {
      assert.ok(Math.abs(a - b) <= 0.5, label + "：" + key + " 位移 " + a + " → " + b);
    }
  }
}

/* ══════════════════════════ 种子数据 ══════════════════════════ */

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "blog.db"));
  db.pragma("journal_mode = WAL");
  const now = Date.now();
  const at = (i) => new Date(now - i * 86400000).toISOString();

  // 三篇同分类文章：中间那篇同时有「上一篇 / 下一篇」，且能凑出「相关文章」
  const insPost = db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, categories, tags, published_at, created_at, updated_at) " +
    "VALUES ('post', ?, ?, ?, 'published', ?, ?, ?, ?, ?)"
  );
  const postIds = [];
  for (let i = 0; i < 3; i++) {
    const iso = at(i + 1);
    const id = Number(insPost.run(
      "grid-post-" + (i + 1),
      "栅格化测试文章 " + String.fromCharCode(65 + i),
      "## 小节一\n\n用来验证正文与其他块是否共用同一条左右边线的段落。\n\n## 小节二\n\n再一段。",
      '["栅格"]',
      '["grid"]',
      iso, iso, iso
    ).lastInsertRowid);
    postIds.push(id);
  }

  // 说说：时间列定宽的对齐检查需要多行
  const insShuo = db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) " +
    "VALUES ('shuoshuo', ?, '', ?, 'published', ?, ?, ?)"
  );
  for (let i = 0; i < 4; i++) {
    const iso = at(i);
    insShuo.run("grid-shuo-" + i, "第 " + (i + 1) + " 条说说，用来验证时间列是否真的定宽。", iso, iso, iso);
  }

  // 友链 6 条：两列 × 三行
  const insLink = db.prepare(
    "INSERT INTO friend_links (name, url, desc, kind, sort_order, visible) VALUES (?, ?, ?, 'friend', ?, 1)"
  );
  for (let i = 0; i < 6; i++) {
    insLink.run("友链 " + i, "https://example" + i + ".com", "第 " + i + " 个友链的描述文字，用来验证两列等分。", i);
  }

  // 关掉评论：隔离环境没有 Artalk，外部脚本只会拖慢 networkidle
  const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  up.run("comment_enabled", "0");
  up.run("site_title", "栅格测试站");

  db.close();
  return postIds[1];
}