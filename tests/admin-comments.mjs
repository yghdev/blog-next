/**
 * 后台「评论历史」页（P0-7，2026-11-07 起只读）。
 *
 * 这一页的性质在 P0-7 变了：评论改由 Artalk 管理，本地 comments 表停止写入，
 * 页面保留为**只读历史**。所以断言也换了重点：
 *
 *   1. 必须**没有**任何写操作 —— 之前那三个「通过 / 垃圾 / 删除」按钮点下去
 *      只改本地表，读者端毫无变化，等于给运营者一个"我审过了"的错觉；
 *   2. 必须明确告诉人「去哪审」—— 只读页面如果没有出口，运营者只会更困惑；
 *   3. 只读不等于什么都看不到：状态筛选、分段计数、分页照旧要准；
 *   4. 长内容（无空格链接串）在 375px 不能撑出横向滚动 —— 评论正文是用户输入的。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server, controller, db;
try {
  server = await startIsolatedServer({ label: "phase02-comments" });
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  /* ---------- 1. 空状态：说明为什么空，并给出出口 ---------- */
  await page.goto(server.base + "/admin/comments", { waitUntil: "networkidle" });
  const emptyVisible = await page.locator(".empty-block").isVisible();
  assert.ok(emptyVisible, "没有历史评论时应显示空状态");
  const emptyLinks = await page.locator(".empty-block a").count();
  assert.ok(emptyLinks > 0, "空状态必须给出口（B 端门禁 14），实际 0 个");
  const emptyHint = await page.locator(".empty-block").innerText();
  assert.match(emptyHint, /Artalk/, "空状态要说明评论现在由 Artalk 管，而不是让人以为丢了");
  console.log("PASS P0-7: 空状态有出口且说明 Artalk（" + emptyLinks + " 个链接）");

  /* ---------- 2. 只读横幅 + 去 Artalk 的入口 ---------- */
  const banner = page.locator(".notice-info");
  assert.equal(await banner.count(), 1, "页面必须有只读说明横幅");
  const bannerText = await banner.innerText();
  assert.match(bannerText, /只读/, "横幅要写明「只读」");
  const artalkLink = banner.locator("a[href*='artalk']");
  assert.equal(await artalkLink.count(), 1, "横幅里要有 Artalk 后台入口");
  assert.equal(await artalkLink.getAttribute("target"), "_blank", "外链应新开窗口");
  assert.match(await artalkLink.getAttribute("rel") || "", /noopener/, "外链必须带 noopener");
  // 页头也应有同一个入口（横幅在列表很长时会被滚走）
  const headAction = await page.locator(".page-head-actions a[href*='artalk']").count();
  assert.equal(headAction, 1, "页头也应有「去 Artalk 审核」入口");
  console.log("PASS P0-7: 横幅写明只读，并提供 Artalk 后台入口");

  /* ---------- 造数据：一篇已发布文章 + 4 条不同状态的历史评论 ---------- */
  const post = await page.request.post(server.base + "/api/admin/posts", {
    data: { type: "post", title: "COMMENT_POST", slug: "comment-post", content: "x", status: "published" },
  });
  assert.equal(post.status(), 200, await post.text());
  const postId = (await post.json()).id;

  // 直接写库造评论：前台早已改走 Artalk，没有任何公开 / 后台的新建接口 ——
  // 这也正是 P0-7 要下线 /api/comments 的原因（没有调用方）。
  const D = (await import("better-sqlite3")).default;
  db = new D(path.join(server.dataDir, "blog.db"));
  db.pragma("busy_timeout = 5000");
  const ins = db.prepare(
    "INSERT INTO comments (post_id, author, email, url, content, status, ip, user_agent, parent_id, created_at) " +
    "VALUES (?, ?, '', '', ?, ?, ?, '', NULL, ?)"
  );
  const now = new Date().toISOString();
  ins.run(postId, "待审用户", "PENDING_CONTENT 这是一条历史待审评论", "pending", "10.0.0.1", now);
  ins.run(postId, "已通过用户", "APPROVED_CONTENT", "approved", "10.0.0.2", now);
  ins.run(postId, "垃圾用户", "SPAM_CONTENT", "spam", "10.0.0.3", now);
  // 超长无空格串：验证评论正文必须能断行，否则 375px 溢出
  ins.run(postId, "长串用户", "L" + "x".repeat(400), "pending", "10.0.0.4", now);
  db.close();
  db = null;

  /* ---------- 3. 只读：列表里不得出现任何写操作 ---------- */
  await page.goto(server.base + "/admin/comments", { waitUntil: "networkidle" });
  const rowButtons = await page.locator(".comment-item button").count();
  assert.equal(rowButtons, 0, "只读页面不得有任何操作按钮，实际 " + rowButtons + " 个");
  // 注意别用「通过」二字做全文匹配：状态徽标本身就叫「已通过」（只读展示），
  // 真正的判据是"没有操作按钮"。这里再点掉两个不会与徽标冲突的动作词。
  const privateWords = await page.locator(".data-panel").innerText();
  for (const word of ["标记垃圾", "删除"]) {
    assert.equal(privateWords.includes(word), false, "只读页面不应出现「" + word + "」操作");
  }
  // 只读列表本身要完整：状态徽标该在的还在
  assert.match(privateWords, /已通过/, "只读列表应保留状态展示（已通过）");
  console.log("PASS P0-7: 只读页面没有任何审核/删除按钮");

  /* ---------- 4. 计数与筛选仍然准（只读不等于看不到） ---------- */
  const tabs = await page.locator(".seg-tabs a").evaluateAll((els) =>
    els.map((e) => ({ text: (e.textContent || "").trim(), href: e.getAttribute("href"), current: e.getAttribute("aria-current") }))
  );
  assert.equal(tabs.length, 4, "应有 4 个状态筛选项");
  const pendingTab = tabs.find((t) => t.text.startsWith("待审核"));
  assert.match(pendingTab.text, /2/, "待审核计数应为 2（含超长串那条），实际=" + pendingTab.text);
  assert.equal(tabs.filter((t) => t.current === "true").length, 1, "默认应有且仅有一个 aria-current");

  await page.goto(server.base + "/admin/comments?status=pending", { waitUntil: "networkidle" });
  const pendingRows = await page.locator(".comment-item").count();
  assert.equal(pendingRows, 2, "待审筛选后应显示 2 条，实际 " + pendingRows);
  console.log("PASS P0-7: 分段计数与筛选结果一致（待审 2 条）");

  /* ---------- 5. 链接不产生脏 URL ---------- */
  const allHrefs = await page.locator(".seg-tabs a, .pager a").evaluateAll((els) =>
    els.map((e) => e.getAttribute("href")).filter(Boolean)
  );
  const dirty = allHrefs.filter((h) => /[?&][\w]+=(&|$)/.test(h));
  assert.deepEqual(dirty, [], "链接不得出现空参数（如 ?status=&page=2）： " + JSON.stringify(dirty));
  console.log("PASS P0-7: 筛选/分页链接无空参数");

  /* ---------- 6. 375px 超长内容不溢出 ---------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(server.base + "/admin/comments?status=pending", { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.sw <= overflow.cw + 1,
    "超长无空格串导致 375px 横向溢出：" + JSON.stringify(overflow));
  console.log("PASS P0-7: 400 字符无空格串不撑破 375px（" + overflow.sw + "/" + overflow.cw + "）");

  console.log("All admin comments (read-only) checks passed.");
} finally {
  if (db) try { db.close(); } catch {}
  if (controller) await controller.close();
  if (server) await server.close();
}
