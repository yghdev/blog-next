/**
 * 阶段 02-3 · 评论管理页。
 *
 * 重点不是"页面能打开"，而是三条容易反复出错的点：
 *   1. 空状态必须给出口 —— 原来"一条评论都没有"时 actions=undefined，
 *      用户看到说明却无处可去（违反 B 端门禁 14）
 *   2. 分页/筛选链接不能拼出 "?status=&page=2" 这种脏 URL
 *   3. 长内容（无空格链接串）在 375px 不能把页面撑出横向滚动
 *      —— 评论正文是用户输入的，这一条直接对应真实数据
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

  /* ---------- 1. 空状态（一条评论都没有）必须有出口 ---------- */
  await page.goto(server.base + "/admin/comments", { waitUntil: "networkidle" });
  const emptyVisible = await page.locator(".empty-block").isVisible();
  assert.ok(emptyVisible, "没有评论时应显示空状态");
  const emptyLinks = await page.locator(".empty-block a").count();
  assert.ok(emptyLinks > 0, "空状态必须给出口链接（B 端门禁 14），实际 0 个");
  console.log("PASS phase02-3: 无评论时空状态有出口（" + emptyLinks + " 个链接）");

  /* ---------- 造数据：一篇已发布文章 + 3 条不同状态评论 ---------- */
  const post = await page.request.post(server.base + "/api/admin/posts", {
    data: { type: "post", title: "COMMENT_POST", slug: "comment-post", content: "x", status: "published" },
  });
  assert.equal(post.status(), 200, await post.text());
  const postId = (await post.json()).id;

  // 直接写库造评论：评论没有公开的新建 API（前台走 Artalk），
  // 这里用 SQLite 直连更贴近真实数据形态，也顺便验证列表对脏数据的容忍。
  const D = (await import("better-sqlite3")).default;
  db = new D(path.join(server.dataDir, "blog.db"));
  db.pragma("busy_timeout = 5000");
  const ins = db.prepare(
    "INSERT INTO comments (post_id, author, email, url, content, status, ip, user_agent, parent_id, created_at) " +
    "VALUES (?, ?, '', '', ?, ?, ?, '', NULL, ?)"
  );
  const now = new Date().toISOString();
  ins.run(postId, "待审用户", "PENDING_CONTENT 这是一条待审评论", "pending", "10.0.0.1", now);
  ins.run(postId, "已通过用户", "APPROVED_CONTENT", "approved", "10.0.0.2", now);
  ins.run(postId, "垃圾用户", "SPAM_CONTENT", "spam", "10.0.0.3", now);
  // 超长无空格串：验证评论正文必须能断行，否则 375px 溢出
  ins.run(postId, "长串用户", "L" + "x".repeat(400), "pending", "10.0.0.4", now);
  db.close();
  db = null;

  /* ---------- 2. 分段计数与筛选一致 ---------- */
  await page.goto(server.base + "/admin/comments", { waitUntil: "networkidle" });
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
  console.log("PASS phase02-3: 分段计数与筛选结果一致（待审 2 条）");

  /* ---------- 3. 链接不产生脏 URL ---------- */
  // 分页/筛选链接里不应出现空参数
  const allHrefs = await page.locator(".seg-tabs a, .pager a").evaluateAll((els) =>
    els.map((e) => e.getAttribute("href")).filter(Boolean)
  );
  const dirty = allHrefs.filter((h) => /[?&][\w]+=(&|$)/.test(h));
  assert.deepEqual(dirty, [], "链接不得出现空参数（如 ?status=&page=2）： " + JSON.stringify(dirty));
  console.log("PASS phase02-3: 筛选/分页链接无空参数");

  /* ---------- 4. 375px 超长内容不溢出 ---------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(server.base + "/admin/comments?status=pending", { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.sw <= overflow.cw + 1,
    "超长无空格串导致 375px 横向溢出：" + JSON.stringify(overflow));
  console.log("PASS phase02-3: 400 字符无空格串不撑破 375px（" + overflow.sw + "/" + overflow.cw + "）");

  /* ---------- 5. 审核动作仍然可用（不因重构破坏功能） ---------- */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.base + "/admin/comments?status=pending", { waitUntil: "networkidle" });
  const approveBtns = await page.locator(".comment-item .btn:has-text('通过')").count();
  assert.ok(approveBtns > 0, "待审评论应提供「通过」按钮");

  await page.locator(".comment-item").first().locator(".btn:has-text('通过')").click();
  await page.waitForTimeout(1200);
  const afterApprove = await page.locator(".comment-item").count();
  assert.ok(afterApprove < 2, "通过后该条应离开待审列表，实际剩余 " + afterApprove);
  console.log("PASS phase02-3: 审核动作在重构后仍可用（通过后离开待审队列）");

  console.log("All phase-02-3 comments checks passed.");
} finally {
  if (db) try { db.close(); } catch {}
  if (controller) await controller.close();
  if (server) await server.close();
}
