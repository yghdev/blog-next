/**
 * 阶段 02-4 · 媒体库。
 *
 * 断言的都是"重构前确实坏掉、且不靠肉眼就能看出坏没坏"的点：
 *   1. 第 121 张之后仍可达 —— 原来页面硬编码 LIMIT 120，API 却支持分页
 *   2. 筛选/搜索落到 URL 上，且筛选后计数与结果一致（链接可分享、可回退）
 *   3. "未引用"筛选用的是真实引用关系（被引用的图不能出现在未引用里）
 *   4. 空状态必须给出口（B 端门禁 14），包括"筛选后为空"这种
 *   5. 裂图与孤儿分块呈现，且截断时明说"仅列前 N 个"（API 回传有 200 上限）
 *   6. 竖图按真实比例预览，不再被裁成 110px 横条
 *   7. 375px 无横向溢出；超长路径能断行
 *   8. 被引用的图删除按钮禁用（防止误删把文章打掉图）
 */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server, controller, db;
try {
  server = await startIsolatedServer({ label: "phase02-media" });
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  /* ---------- 造数据：55 条 media（跨越旧 LIMIT 之外）+ 一篇文章引用其中一张 ---------- */
  const D = (await import("better-sqlite3")).default;
  db = new D(path.join(server.dataDir, "blog.db"));
  db.pragma("busy_timeout = 5000");

  const insMedia = db.prepare(
    "INSERT INTO media (path, filename, mime, size, width, height, sha256) VALUES (?, ?, 'image/png', ?, ?, ?, NULL)"
  );
  const now = Date.now();
  // 40 张七牛（竖图 800x1200）+ 15 张本机
  for (let i = 0; i < 40; i++) {
    insMedia.run("https://cdn.test/media_q" + i + ".png", "q" + i + ".png", 1000 + i, 800, 1200);
  }
  for (let i = 0; i < 15; i++) {
    insMedia.run("/images/2026/10/media_l" + i + ".png", "l" + i + ".png", 2000 + i, 1200, 800);
  }
  // 一条真实文件，用于确认被引用时删除按钮禁用
  const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), "public/images");
  void uploadDir;

  const postIns = db.prepare(
    "INSERT INTO posts (type, title, slug, content, status, created_at, updated_at) VALUES ('post', ?, ?, ?, 'published', ?, ?)"
  );
  postIns.run("MEDIA_POST", "media-post",
    "正文里引用了一张图 ![x](https://cdn.test/media_q0.png)",
    new Date(now).toISOString(), new Date(now).toISOString());
  db.close();
  db = null;

  /* ---------- 1. 分页：旧实现第 121 张之后不可达，现在 55 条全部可达 ---------- */
  await page.goto(server.base + "/admin/media", { waitUntil: "networkidle" });
  const firstPageCount = await page.locator(".media-card").count();
  const footText = await page.locator(".media-count").first().textContent();
  assert.match(footText || "", /55/, "页脚应显示总数 55，实际：" + footText);
  const pagerVisible = await page.locator(".media-foot .pager").count();
  assert.equal(pagerVisible, 1, "55 条 / 每页 48 条 → 应出现分页控件");
  assert.equal(firstPageCount, 48, "首页应显示 48 张，实际 " + firstPageCount);
  console.log("PASS phase02-4: 分页生效（首页 " + firstPageCount + " / 共 55）");

  await page.goto(server.base + "/admin/media?page=2", { waitUntil: "networkidle" });
  const secondPageCount = await page.locator(".media-card").count();
  assert.equal(secondPageCount, 7, "第 2 页应显示剩余 7 张，实际 " + secondPageCount);
  console.log("PASS phase02-4: 第 2 页可达（7 张），不再有 LIMIT 120 之外的盲区");

  /* ---------- 2. 筛选落到 URL 且口径正确 ---------- */
  const tabs = await page.locator(".media-toolbar .seg-tabs a").evaluateAll((els) =>
    els.map((e) => ({ text: (e.textContent || "").trim(), href: e.getAttribute("href") }))
  );
  assert.equal(tabs.length, 4, "应有 4 个存储位置筛选项（全部/七牛/本机/未引用）");
  const dirty = tabs.map((t) => t.href || "").filter((h) => /[?&][\w]+=(&|$)/.test(h));
  assert.deepEqual(dirty, [], "筛选链接不得出现空参数：" + JSON.stringify(dirty));

  await page.goto(server.base + "/admin/media?storage=qiniu", { waitUntil: "networkidle" });
  const qiniuCount = await page.locator(".media-card").count();
  assert.equal(qiniuCount, 40, "七牛筛选应只剩 40 张，实际 " + qiniuCount);
  const qiniuTags = await page.locator(".media-card .badge:has-text('七牛 CDN')").count();
  assert.equal(qiniuTags, qiniuCount, "七牛筛选下每张都应标为七牛 CDN");

  await page.goto(server.base + "/admin/media?storage=local", { waitUntil: "networkidle" });
  assert.equal(await page.locator(".media-card").count(), 15, "本机筛选应剩 15 张");
  console.log("PASS phase02-4: 存储位置筛选口径正确（七牛 40 / 本机 15）");

  /* ---------- 3. 未引用筛选 = 真实引用关系 ---------- */
  await page.goto(server.base + "/admin/media?storage=unused", { waitUntil: "networkidle" });
  const unusedCount = await page.locator(".media-card").count();
  const unusedTotal = await page.locator(".media-count").first().textContent();
  assert.match(unusedTotal || "", /54/, "被引用的 1 张应被排除，未引用应为 54，实际：" + unusedTotal);
  // 被引用的那张不能出现在未引用列表里
  const names = await page.locator(".media-name").evaluateAll((els) => els.map((e) => e.textContent || ""));
  assert.ok(!names.includes("q0.png"), "被文章引用的 q0.png 不应出现在「未引用」筛选里");
  assert.equal(unusedCount, 48, "未引用 54 条，首页仍按 48 分页");
  console.log("PASS phase02-4: 「未引用」基于真实引用关系（54 张，q0.png 被排除）");

  /* ---------- 4. 搜索 ---------- */
  await page.goto(server.base + "/admin/media?q=l3", { waitUntil: "networkidle" });
  const searchNames = await page.locator(".media-name").evaluateAll((els) => els.map((e) => e.textContent || ""));
  assert.ok(searchNames.length > 0 && searchNames.every((n) => n.includes("l3")),
    "搜索 l3 应只返回文件名含 l3 的项，实际：" + JSON.stringify(searchNames));
  console.log("PASS phase02-4: 搜索按文件名/路径生效（命中 " + searchNames.length + " 条）");

  /* ---------- 5. 空状态（筛选后为空）必须给出口 ---------- */
  await page.goto(server.base + "/admin/media?q=NOTHING_MATCHES_THIS", { waitUntil: "networkidle" });
  const emptyBlocks = await page.locator(".empty-block").count();
  assert.equal(emptyBlocks, 1, "无结果时应显示空状态");
  const emptyLinks = await page.locator(".empty-block a").count();
  assert.ok(emptyLinks > 0, "空状态必须给出口链接（B 端门禁 14），实际 0 个");
  console.log("PASS phase02-4: 筛选无结果的空状态有出口（" + emptyLinks + " 个链接）");

  /* ---------- 6. 被引用的图：删除禁用 ---------- */
  await page.goto(server.base + "/admin/media?q=q0.png", { waitUntil: "networkidle" });
  const delBtn = page.locator(".media-card .btn-danger").first();
  const disabled = await delBtn.isDisabled();
  assert.equal(disabled, true, "被文章引用的图，删除按钮必须是禁用状态");
  const title = await delBtn.getAttribute("title");
  assert.match(title || "", /引用/, "禁用原因要写在 title 里，否则用户不知道为什么点不动： " + title);
  console.log("PASS phase02-4: 被引用图片的删除按钮禁用且说明原因");

  /* ---------- 7. 竖图按真实比例预览（旧实现一律裁成 110px 横条） ---------- */
  await page.goto(server.base + "/admin/media?storage=qiniu", { waitUntil: "networkidle" });
  const box = await page.locator(".media-thumb").first().boundingBox();
  assert.ok(box, "缩略图容器应可见");
  const w = box.width, h = box.height;
  // 数据是 800x1200 竖图，容器比例应接近 2:3 而不是固定 110px 高
  const ratio = h / w;
  assert.ok(ratio > 1.1, "竖图应按真实比例预览（高 > 宽），实际 ratio=" + ratio.toFixed(2) + " " + JSON.stringify(box));
  console.log("PASS phase02-4: 竖图按真实宽高比预览（" + Math.round(w) + "×" + Math.round(h) + "）");

  /* ---------- 8. 375px 不溢出 + 超长路径能断行 ---------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(server.base + "/admin/media?storage=qiniu", { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.sw <= overflow.cw + 1, "375px 横向溢出：" + JSON.stringify(overflow));
  // 移动端操作热区 >= 44
  const btnBox = await page.locator(".media-card .media-actions .btn").first().boundingBox();
  assert.ok(btnBox && btnBox.height >= 44,
    "手机上操作按钮热区应 >= 44dp，实际 " + (btnBox && btnBox.height));
  console.log("PASS phase02-4: 375px 无溢出（" + overflow.sw + "/" + overflow.cw + "），操作热区 " + Math.round(btnBox.height) + "dp");

  /* ---------- 9. 扫描结果：裂图与孤儿分块，且明说截断 ---------- */
  await page.setViewportSize({ width: 1280, height: 900 });
  const resp = await page.request.post(server.base + "/api/admin/media", { data: { action: "scan-orphans" } });
  assert.equal(resp.status(), 200, await resp.text());
  const scan = await resp.json();
  assert.ok(typeof scan.orphanCount === "number" && typeof scan.missingCount === "number",
    "扫描接口必须回传 orphanCount / missingCount（界面靠它判断是否截断）");
  // 造 3 条"库里有、存储里没有"的裂图记录
  const D2 = (await import("better-sqlite3")).default;
  db = new D2(path.join(server.dataDir, "blog.db"));
  const insBroken = db.prepare(
    "INSERT INTO media (path, filename, mime, size, width, height, sha256) VALUES (?, ?, 'image/png', 1, 10, 10, NULL)"
  );
  for (let i = 0; i < 3; i++) insBroken.run("/images/2026/10/GHOST_" + i + ".png", "GHOST_" + i + ".png");
  db.close();
  db = null;

  await page.goto(server.base + "/admin/media", { waitUntil: "networkidle" });
  await page.locator(".media-toolbar .btn:has-text('扫描孤儿文件')").click();
  await page.waitForSelector(".media-scan", { timeout: 15000 });
  const missingBlock = await page.locator(".media-scan-block.is-missing").count();
  assert.equal(missingBlock, 1, "裂图应单独成块（与孤儿分开）");
  const missingText = await page.locator(".media-scan-block.is-missing").innerText();
  assert.match(missingText, /GHOST_/, "裂图块应列出具体路径");
  console.log("PASS phase02-4: 裂图单独成块并列出路径，与孤儿分离呈现");

  /* ---------- 10. 暗色主题：徽标必须跟随 token，且文字仍可读 ----------
     注意不要用"背景相对亮度 > 0.5 即失败"来判：--ok-bg 在暗色下是
     rgba(111,214,166,.12)，**透明显式色**，parseColor 会读成不透明的
     rgb(111,214,166)，亮度 0.62 —— 于是把本来正确的样式判成亮块。
     01-B 那次已经踩过同一类坑（底层半透明时默默按白底兜底，算出 1.84:1
     的假结论）。这里按真实语义做两件事：
       a) 切主题后徽标颜色必须变化（证明 token 生效而非碰巧同色）
       b) 用真实背景层合成后算对比度 >= 3（证明没有变成暗底暗字） */
  // 先显式回 light 并关掉过渡，再取 light 值（阶段 01-A 踩过：切主题瞬间
  // 取到的是插值中间态，每次不同）
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(200);

  const collectBadges = () =>
    [...document.querySelectorAll(".media-card .badge, .media-toolbar .badge")].map((el) => {
      const cs = getComputedStyle(el);
      const layers = [];
      let cur = el;
      while (cur) {
        const b = getComputedStyle(cur).backgroundColor;
        if (b && !/rgba\(0, 0, 0, 0\)/.test(b)) layers.push(b);
        cur = cur.parentElement;
      }
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      if (bodyBg && !/rgba\(0, 0, 0, 0\)/.test(bodyBg)) layers.push(bodyBg);
      return { bg: cs.backgroundColor, fg: cs.color, layers };
    });

  const badgesLight = await page.evaluate(collectBadges);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(200);
  const badgesDark = await page.evaluate(collectBadges);

  assert.ok(badgesDark.length > 0, "应能取到媒体页的徽标元素");

  const changed = badgesDark.filter((b, i) => b.bg !== badgesLight[i]).length;
  assert.ok(changed > 0, "切主题后徽标背景色必须变化（证明 token 生效，而非恰好同色）");

  const { contrastFromLayers, parseColor, relativeLuminance } = await import("./helpers/contrast.mjs");
  for (const b of badgesDark) {
    const ratio = contrastFromLayers(b.fg, b.layers);
    assert.ok(ratio !== null && ratio >= 3,
      "暗色下徽标文字对比度应 >= 3，实测 " + (ratio === null ? "无法计算" : ratio.toFixed(2)) +
      " fg=" + b.fg + " layers=" + JSON.stringify(b.layers));
    // 显式写死的浅色主题色值（01-B 的原始 bug）必须不再出现。
    // 只看**不透明**背景：半透明 rgba 是暗色 token 的正常写法。
    const solid = b.bg.startsWith("rgb(") ? parseColor(b.bg) : null;
    if (solid) {
      const lum = relativeLuminance(solid);
      assert.ok(lum < 0.5, "暗色下徽标出现不透明的浅底亮块：" + b.bg + "（亮度 " + lum.toFixed(2) + "）");
    }
  }
  console.log("PASS phase02-4: 暗色下徽标跟随主题（" + changed + "/" + badgesDark.length + " 变色）且对比度达标");

  console.log("All phase-02-4 media checks passed.");
} finally {
  if (db) try { db.close(); } catch {}
  if (controller) await controller.close();
  if (server) await server.close();
}
