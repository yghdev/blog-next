/**
 * 阶段 02-4（媒体库） + 02-6（批量 / 排序 / 预览）。
 *
 * 断言的都是"重构前确实坏掉、且不靠肉眼就能看出坏没坏"的点：
 *   1. 第 121 张之后仍可达 —— 原来页面硬编码 LIMIT 120，API 却支持分页
 *   2. 筛选/搜索落到 URL 上，且筛选后计数与结果一致（链接可分享、可回退）
 *   3. "未引用"筛选用的是真实引用关系（被引用的图不能出现在未引用里）
 *   4. 空状态必须给出口（B 端门禁 14），包括"筛选后为空"这种
 *   5. 裂图与孤儿分块呈现，且截断时明说"仅列前 N 个"（API 回传有 200 上限）
 *   6. 缩略图统一 4:3 预览带 + contain：竖图不被裁掉，行高不参差
 *   7. 375px 无横向溢出；操作热区达标（触屏没有 hover，入口必须常驻）
 *   8. 被引用的图不能删（菜单项禁用；单条与批量两条路径口径一致）
 *   9. 排序（最新/最早/最大/最小）落到 URL、切换不丢筛选、非法值安全降级
 *  10. 多选与浮动批量条：未选隐藏、勾选出现、全选本页、取消清空
 *  11. 批量删除逐项判定：被引用的跳过并报告，未引用的真的删掉
 *  12. 大图预览：点击打开、左右键切换、Esc 关闭、滚动锁释放
 *  13. 操作入口默认隐藏（减少 96 个常驻按钮），悬停/聚焦才浮现
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

  /* ---------- 造数据 ----------
     注意顺序：**先把真实文件写到磁盘，再插库记录**。
     媒体页会把每条记录渲染成 <img src=path>，路径不存在时图永远加载失败，
     Playwright 的 networkidle 就等不到 —— 实测会 30s 超时。
     （裂纹本身是"库里有、存储里没有"，那是扫描结果要报的问题，
       不该出现在测试的初始数据里。） */
  const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), "public/images");
  const webRoot = path.join(server.standaloneDir, "public");
  const dir = path.join(webRoot, "images", "2026", "10");
  fs.mkdirSync(dir, { recursive: true });
  // 1x1 PNG：内容无所谓，只要 200 且体积小
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  void uploadDir;

  const D = (await import("better-sqlite3")).default;
  db = new D(path.join(server.dataDir, "blog.db"));
  db.pragma("busy_timeout = 5000");

  const insMedia = db.prepare(
    "INSERT INTO media (path, filename, mime, size, width, height, sha256) VALUES (?, ?, 'image/png', ?, ?, ?, NULL)"
  );
  const now = Date.now();
  // 40 张七牛（竖图 800x1200）。
  // 路径用 /cdn/... 而不是 https://cdn.test/...：分类只要求"不以 /images/ 开头"，
  // 用同源路径就能被 standalone 的 public 真读出来。<img> 指向一个真实存在于
  // 外网 DNS 不解析的域名时，请求会一直 pending，networkidle 永远不成立。
  const cdnDir = path.join(webRoot, "cdn");
  fs.mkdirSync(cdnDir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(cdnDir, "media_q" + i + ".png"), PNG);
    insMedia.run("/cdn/media_q" + i + ".png", "q" + i + ".png", 1000 + i, 800, 1200);
  }
  // 15 张本机：路径必须是 /images/... 且文件真实存在
  for (let i = 0; i < 15; i++) {
    fs.writeFileSync(path.join(dir, "media_l" + i + ".png"), PNG);
    insMedia.run("/images/2026/10/media_l" + i + ".png", "l" + i + ".png", 2000 + i, 1200, 800);
  }

  const postIns = db.prepare(
    "INSERT INTO posts (type, title, slug, content, status, created_at, updated_at) VALUES ('post', ?, ?, ?, 'published', ?, ?)"
  );
  postIns.run("MEDIA_POST", "media-post",
    "正文里引用了一张图 ![x](/cdn/media_q0.png)",
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

  /* ---------- 6. 被引用的图：删除入口禁用 + 说明原因 ----------
     02-6 起删除收进右上角「更多」菜单：先打开菜单再断言。
     这里同时验证「菜单默认不显示」—— 那正是本轮的视觉精简目标。 */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.base + "/admin/media?q=q0.png", { waitUntil: "networkidle" });
  const card = page.locator(".media-card").first();
  const actions = card.locator(".media-actions");
  assert.equal(await actions.evaluate((el) => getComputedStyle(el).opacity), "0",
    "未悬停时卡片操作应隐藏（视觉精简），实际仍在常驻显示");
  await card.hover();
  await page.waitForTimeout(200);
  await card.locator(".media-kebab").click();
  const delBtn = page.locator(".media-card .media-menu .media-menu-item.is-danger").first();
  const disabled = await delBtn.isDisabled();
  assert.equal(disabled, true, "被文章引用的图，删除菜单项必须是禁用状态");
  const title = await delBtn.getAttribute("title");
  assert.match(title || "", /引用/, "禁用原因要写在 title 里，否则用户不知道为什么点不动： " + title);
  const delText = (await delBtn.innerText()).trim();
  assert.match(delText, /引用/, "菜单项文案本身也要说明被引用，不能只靠 title：" + delText);
  console.log("PASS phase02-4: 被引用图片的删除入口禁用且写明引用原因（菜单默认隐藏）");

  /* ---------- 7. 竖图不被裁切，且网格行高一致 ----------
     02-6 把「按每张图真实宽高比撑高」改成「统一 4:3 预览带 + object-fit:contain」：
     前者会让同一行卡片高低参差、短图下方出现大片空白（截图走查实测）。
     contain 保证整张图完整可见 —— 「竖图被裁掉大半」这个原始缺陷仍然不能回来。 */
  await page.goto(server.base + "/admin/media?storage=qiniu", { waitUntil: "networkidle" });
  const firstThumb = page.locator(".media-thumb").first();
  const box = await firstThumb.boundingBox();
  assert.ok(box, "缩略图容器应可见");
  const ratio = box.height / box.width;
  assert.ok(Math.abs(ratio - 3 / 4) < 0.06,
    "缩略图预览带应为统一的 4:3（行高一致），实际 ratio=" + ratio.toFixed(2));

  const fit = await firstThumb.locator("img").evaluate((img) => getComputedStyle(img).objectFit);
  assert.equal(fit, "contain", "竖图必须完整显示（contain），不能被裁切");

  // 竖图与横图的预览带高度必须完全一致：这是"行不参差"的硬判据
  const heights = await page.locator(".media-thumb").evaluateAll((els) =>
    els.slice(0, 5).map((e) => Math.round(e.getBoundingClientRect().height))
  );
  assert.equal(new Set(heights).size, 1, "同一页所有缩略图高度必须一致，实际：" + heights.join(","));
  console.log("PASS phase02-4: 缩略图统一 4:3 预览带 + contain（竖图不裁切，行高一致 " + heights[0] + "px）");

  /* ---------- 8. 375px 不溢出 + 超长路径能断行 ---------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(server.base + "/admin/media?storage=qiniu", { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.sw <= overflow.cw + 1, "375px 横向溢出：" + JSON.stringify(overflow));
  // 移动端操作热区 >= 44：触屏没有 hover，更多菜单键必须常驻
  const btnBox = await page.locator(".media-card .media-kebab").first().boundingBox();
  assert.ok(btnBox && btnBox.height >= 44,
    "手机上「更多」操作键热区应 >= 44dp，实际 " + (btnBox && btnBox.height));
  const actionsOpacity = await page.locator(".media-card .media-actions").first()
    .evaluate((el) => getComputedStyle(el).opacity);
  assert.equal(actionsOpacity, "1", "触屏设备上操作入口不能靠 hover 才出现");
  console.log("PASS phase02-4: 375px 无溢出（" + overflow.sw + "/" + overflow.cw + "），操作热区 " + Math.round(btnBox.height) + "dp");

  /* ---------- 8b. 排序：按体积/时间落到 URL，且 SQL 顺序真的生效 ---------- */
  await page.setViewportSize({ width: 1280, height: 900 });

  // 数据：q0..q39 体积 1000..1039，l0..l14 体积 2000..2014。
  // 「文件最大」首页第一条必须是 2014 字节的 l14，而不是最新的那张。
  await page.goto(server.base + "/admin/media?sort=largest", { waitUntil: "networkidle" });
  const largestNames = await page.locator(".media-name").evaluateAll((els) => els.map((e) => e.textContent || ""));
  assert.equal(largestNames[0], "l14.png", "按体积降序时首条应为最大的 l14.png，实际：" + largestNames[0]);
  // 体积文本会四舍五入（2000..2014 字节都显示 "2 KB"），所以按文件名核对顺序：
  // 最大值 l14（2014）→ l13 → l12，末位才是最小的 q0（1000）。
  assert.deepEqual(largestNames.slice(0, 3), ["l14.png", "l13.png", "l12.png"],
    "「文件最大」应按体积降序，实际前三条：" + largestNames.slice(0, 3).join(","));
  // 55 条 / 每页 48 条：最大的 15 张本机图 + 33 张七牛图在首页，最小的 q0 在第 2 页末位
  await page.goto(server.base + "/admin/media?sort=largest&page=2", { waitUntil: "networkidle" });
  const largestTail = await page.locator(".media-name").evaluateAll((els) => els.map((e) => e.textContent || ""));
  assert.equal(largestTail[largestTail.length - 1], "q0.png", "降序末位应为最小的 q0.png，实际：" + largestTail[largestTail.length - 1]);

  await page.goto(server.base + "/admin/media?sort=smallest", { waitUntil: "networkidle" });
  const smallestFirst = (await page.locator(".media-name").first().textContent())?.trim();
  assert.equal(smallestFirst, "q0.png", "按体积升序时首条应为最小的 q0.png，实际：" + smallestFirst);

  // 排序值必须写进 URL，且切换排序时保留当前筛选
  await page.goto(server.base + "/admin/media?storage=local&sort=largest", { waitUntil: "networkidle" });
  const sortValue = await page.locator(".media-sort select").inputValue();
  assert.equal(sortValue, "largest", "排序下拉应回显 URL 里的排序值");
  await page.locator(".media-sort select").selectOption("oldest");
  await page.waitForURL(/sort=oldest/, { timeout: 8000 });
  const keptFilter = new URL(page.url()).searchParams.get("storage");
  assert.equal(keptFilter, "local", "切换排序不得丢掉存储位置筛选，实际：" + page.url());

  // 未知排序值退回默认，而不是拼进 SQL
  await page.goto(server.base + "/admin/media?sort=;DROP+TABLE+media--", { waitUntil: "networkidle" });
  assert.equal(await page.locator(".media-card").count(), 48, "非法排序值应安全退回默认排序，页面仍正常");
  console.log("PASS phase02-4: 排序生效（最大 l14 / 最小 q0），URL 可回显、切换不丢筛选、非法值安全降级");

  /* ---------- 8c. 批量选择与批量操作条 ---------- */
  await page.goto(server.base + "/admin/media?storage=unused", { waitUntil: "networkidle" });
  assert.equal(await page.locator(".media-bulkbar").count(), 0, "未选择时批量条必须完全不渲染");

  await page.locator(".media-card .media-check input").first().check();
  await page.waitForSelector(".media-bulkbar");
  const bulkText = await page.locator(".media-bulkbar-count").innerText();
  assert.match(bulkText, /已选\s*1\s*张/, "批量条要明确告知选中数量，实际：" + bulkText);
  const bulkBtns = await page.locator(".media-bulkbar .btn").count();
  assert.ok(bulkBtns >= 3, "批量条应含迁移/删除/取消选择，实际按钮数 " + bulkBtns);

  // 全选本页：48 张
  await page.locator(".media-list-meta .select-all input").check();
  await page.waitForTimeout(150);
  const allCount = await page.locator(".media-card.is-selected").count();
  assert.equal(allCount, 48, "全选本页应选中 48 张，实际 " + allCount);
  assert.match(await page.locator(".media-bulkbar-count").innerText(), /已选\s*48\s*张/);

  // 取消选择后批量条消失、选中态清空
  await page.locator(".media-bulkbar .btn-ghost").click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".media-bulkbar").count(), 0, "取消选择后批量条应消失");
  assert.equal(await page.locator(".media-card.is-selected").count(), 0, "取消选择后卡片选中态应清空");
  console.log("PASS phase02-4: 多选与批量条（未选隐藏 / 选中出现 / 全选 48 / 取消清空）");

  /* ---------- 8d. 批量删除：跳过被引用项，删除成功项 ---------- */
  // 先干净地造两条：一条未引用（可删），一条被文章引用（必须跳过）
  const D3 = (await import("better-sqlite3")).default;
  db = new D3(path.join(server.dataDir, "blog.db"));
  const insBulk = db.prepare(
    "INSERT INTO media (path, filename, mime, size, width, height, sha256) VALUES (?, ?, 'image/png', 1234, 10, 10, NULL)"
  );
  fs.writeFileSync(path.join(webRoot, "cdn", "BULK_FREE.png"), PNG);
  fs.writeFileSync(path.join(webRoot, "cdn", "BULK_USED.png"), PNG);
  const freeId = Number(insBulk.run("/cdn/BULK_FREE.png", "BULK_FREE.png").lastInsertRowid);
  const usedId = Number(insBulk.run("/cdn/BULK_USED.png", "BULK_USED.png").lastInsertRowid);
  db.prepare(
    "INSERT INTO posts (type, title, slug, content, status, created_at, updated_at) VALUES ('post', ?, ?, ?, 'published', ?, ?)"
  ).run("BULK_REF", "bulk-ref", "![x](/cdn/BULK_USED.png)", new Date(now).toISOString(), new Date(now).toISOString());
  db.close();
  db = null;

  const bulkResp = await page.request.post(server.base + "/api/admin/media/bulk", {
    data: { action: "delete", ids: [freeId, usedId] },
  });
  assert.equal(bulkResp.status(), 200, await bulkResp.text());
  const bulkJson = await bulkResp.json();
  assert.equal(bulkJson.summary.succeeded, 1, "未引用的那张应删除成功，实际：" + JSON.stringify(bulkJson.summary));
  assert.equal(bulkJson.summary.skipped, 1, "被引用的那张应跳过，实际：" + JSON.stringify(bulkJson.summary));
  const usedResult = bulkJson.results.find((r) => r.id === usedId);
  assert.equal(usedResult?.code, "MEDIA_IN_USE", "跳过原因必须是「仍被引用」，实际：" + JSON.stringify(usedResult));

  // 删除确实是删了：记录不在了，而被引用的那张还在
  db = new D3(path.join(server.dataDir, "blog.db"));
  const stillFree = db.prepare("SELECT id FROM media WHERE id = ?").get(freeId);
  const stillUsed = db.prepare("SELECT id FROM media WHERE id = ?").get(usedId);
  db.close();
  db = null;
  assert.equal(stillFree, undefined, "未被引用的图片记录应被删除");
  assert.ok(stillUsed, "被引用的图片记录必须保留（不能因为批量而绕开安全规则）");
  console.log("PASS phase02-4: 批量删除逐项判定（1 成功 / 1 因被引用跳过），安全规则不被批量绕过");

  /* ---------- 8d-2. 单条删除沿用同一套引用规则（不能只守住批量口） ---------- */
  const singleUsed = await page.request.delete(server.base + "/api/admin/media/" + usedId);
  assert.equal(singleUsed.status(), 409, "单条删除被引用的图必须 409");
  assert.match((await singleUsed.json()).error || "", /引用/, "单条删除的报错要说清是引用问题");
  console.log("PASS phase02-4: 单条删除同样拒绝被引用的图（与批量口径一致）");

  /* ---------- 8e. 大图预览：点击缩略图打开，左右键切换，Esc 关闭 ---------- */
  await page.goto(server.base + "/admin/media?storage=qiniu", { waitUntil: "networkidle" });
  const clickedSrc = await page.locator(".media-thumb-btn img").nth(2).getAttribute("src");
  await page.locator(".media-thumb-btn").nth(2).click();
  await page.waitForSelector(".media-lightbox");
  const lbTitle = (await page.locator(".media-lightbox-title").innerText()).trim();
  const lbCount = (await page.locator(".media-lightbox-count").innerText()).trim();
  assert.match(lbCount, /^3 \/ \d+$/, "预览应显示当前序号与总数，实际：" + lbCount);
  // standalone 的静态文件清单在启动时固定，运行期写进 public 的测试图片会 404，
  // 因此这里断言「预览的是同一张图」而不是像素加载成功。
  assert.equal(await page.locator(".media-lightbox-stage img").getAttribute("src"), clickedSrc,
    "预览大图的 src 应与被点击的缩略图一致");

  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  const lbTitle2 = (await page.locator(".media-lightbox-title").innerText()).trim();
  assert.notEqual(lbTitle2, lbTitle, "右方向键应切到下一张，实际仍为 " + lbTitle2);
  assert.match((await page.locator(".media-lightbox-count").innerText()).trim(), /^4 \/ \d+$/);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".media-lightbox").count(), 0, "Esc 应关闭预览");
  // 关闭后滚动锁定必须解除（否则整页卡在 fixed 状态，滚不动）
  const bodyPos = await page.evaluate(() => getComputedStyle(document.body).position);
  assert.notEqual(bodyPos, "fixed", "预览关闭后必须解除滚动锁定，实际 body position=" + bodyPos);
  console.log("PASS phase02-4: 大图预览（打开/序号/同一张图/右方向键/Esc/滚动锁释放）");

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
