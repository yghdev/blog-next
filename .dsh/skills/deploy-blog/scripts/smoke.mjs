#!/usr/bin/env node
/**
 * 生产构建冒烟（在**本地**跑，针对隔离实例或线上只读接口）。
 *
 * 为什么不能只信 healthz：healthz 只说明"进程活着、库能读"。它不会告诉你
 * 编辑页能不能渲染、自动保存有没有写进草稿、发布后摘要对不对、手机上有没有
 * 横向溢出 —— 而线上事故恰恰长这样（2026-10-29「发布只留了草稿壳」就是
 * healthz 全绿时发生的）。
 *
 * 本脚本只碰三类东西：
 *   1. 读接口（healthz / 页面 GET）
 *   2. 一个**可丢弃的草稿壳**（标题带时间戳，跑完软删除）
 *   3. 草稿接口的写入（只在草稿层，不触碰线上内容）
 *
 * 用法：
 *   # 针对隔离实例（推荐，先 staging.sh up + ssh 隧道）
 *   SMOKE_BASE=http://127.0.0.1:18091 SMOKE_USER=... SMOKE_PASS=... \
 *     node .dsh/skills/deploy-blog/scripts/smoke.mjs
 *
 *   # 只有明确愿意在线上建/删一条草稿壳时，才指向 https://blog.yghsite.cn
 *   SMOKE_BASE=https://blog.yghsite.cn SMOKE_USER=... SMOKE_PASS=... \
 *     node .dsh/skills/deploy-blog/scripts/smoke.mjs --allow-production
 *
 * 退出码：0 全过；1 有断言失败；2 缺少环境变量。
 */
import { chromium } from "@playwright/test";

const BASE = (process.env.SMOKE_BASE || "").replace(/\/+$/, "");
const USER = process.env.SMOKE_USER;
const PASS = process.env.SMOKE_PASS;
const ALLOW_PROD = process.argv.includes("--allow-production");

if (!BASE || !USER || !PASS) {
  console.error("需要 SMOKE_BASE / SMOKE_USER / SMOKE_PASS");
  process.exit(2);
}
const isProd = /^https:\/\/(blog\.)?yghsite\.cn/.test(BASE);
if (isProd && !ALLOW_PROD) {
  console.error("拒绝在线上建临时内容：加 --allow-production 明确同意，或改用隔离实例。");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

let postId = null;
let keep = false;
try {
  /* ── 0. 基础可达性 ── */
  const health = await (await fetch(BASE + "/api/healthz")).json();
  check("healthz ok", health.ok === true, "commit=" + (health.commit ?? "?"));
  check("healthz 带可复现版本戳", typeof health.commit === "string" && health.reproducible === true);

  const home = await fetch(BASE + "/");
  check("首页 200", home.status === 200, String(home.status));

  /* ── 1. 登录与鉴权 ── */
  const login = await page.request.post(BASE + "/api/auth/login", { data: { username: USER, password: PASS } });
  check("管理员登录", login.ok(), "HTTP " + login.status());
  if (!login.ok()) throw new Error("登录失败，后续无法继续：" + (await login.text()));

  const anon = await browser.newContext();
  const anonRes = await anon.request.get(BASE + "/admin");
  check("未登录访问后台被挡", anonRes.status() === 307 || anonRes.status() === 302 || anonRes.url().includes("/admin/login"), "HTTP " + anonRes.status());
  await anon.close();

  /* ── 2. 编辑器渲染（改版后最容易坏的一层） ── */
  const created = await page.request.post(BASE + "/api/admin/posts", {
    data: {
      type: "post",
      title: "部署冒烟（可删） " + new Date().toISOString(),
      slug: "",
      content: "",
      categories: [],
      tags: [],
      comments_enabled: 1,
    },
  });
  const createdBody = await created.json();
  check("新建草稿壳", created.ok() && Number.isInteger(createdBody.id), "id=" + createdBody.id);
  if (!createdBody.id) throw new Error("建壳失败：" + JSON.stringify(createdBody));
  postId = createdBody.id;

  await page.setViewportSize({ width: 1440, height: 900 });
  const editorResp = await page.goto(BASE + "/admin/edit/" + postId, { waitUntil: "networkidle" });
  check("编辑页 200", editorResp?.status() === 200, String(editorResp?.status()));

  const shape = await page.evaluate(() => ({
    titleInput: document.querySelectorAll(".editor-title-input").length,
    textarea: document.querySelectorAll(".editor-textarea").length,
    pageHeads: document.querySelectorAll(".page-head h1").length,
    publishBtn: document.querySelectorAll(".editor-btn-publish, .editor-topbar .btn-primary").length,
  }));
  check("标题与正文可编辑", shape.titleInput === 1 && shape.textarea === 1, JSON.stringify(shape));
  check("有唯一的发布入口", shape.publishBtn >= 1, "buttons=" + shape.publishBtn);

  /* ── 3. 自动保存进草稿（不碰线上） ── */
  const marker = "冒烟正文 " + Date.now();
  await page.locator(".editor-textarea").fill("## 冒烟小节\n\n" + marker);
  const excerptBox = page.locator("#editor-excerpt");
  if (await excerptBox.count()) await excerptBox.fill("部署冒烟摘要");
  await page.waitForTimeout(3000);

  const draft = await (await page.request.get(BASE + "/api/admin/posts/" + postId + "/draft")).json();
  const snap = draft?.draft?.snapshot ?? {};
  check("自动保存写入服务端草稿", String(snap.content ?? "").includes(marker));
  if (await excerptBox.count()) check("自定义摘要进草稿快照", snap.excerpt === "部署冒烟摘要", JSON.stringify(snap.excerpt));

  const afterDraft = await (await page.request.get(BASE + "/api/admin/posts/" + postId)).json();
  check("存草稿不改动线上内容", afterDraft.post.content === "", "posts.content=" + JSON.stringify(afterDraft.post.content));

  /* ── 4. 视图模式与专注模式（新交互的退出门槛） ── */
  const viewBtns = page.locator(".editor-view-btn");
  if (await viewBtns.count()) {
    await page.locator(".editor-view-btn").filter({ hasText: "分屏" }).first().click();
    await page.locator(".editor-preview-pane").waitFor({ timeout: 8000 });
    check("分屏预览可用", true);
    await page.locator(".editor-view-btn").filter({ hasText: "编辑" }).first().click();
  }
  const focusBtn = page.locator('button[aria-label="专注写作模式"]');
  if (await focusBtn.count()) {
    await focusBtn.click();
    await page.waitForTimeout(300);
    const hidden = await page.locator(".admin-sidebar").isHidden();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const restored = await page.locator(".admin-sidebar").isVisible();
    check("专注模式进出正常", hidden && restored, `hidden=${hidden} restored=${restored}`);
    check("专注模式不清空正文", (await page.locator(".editor-textarea").inputValue()).includes(marker));
  }

  /* ── 5. 移动端：不许横向溢出，发布入口要在拇指区 ── */
  await page.setViewportSize({ width: 375, height: 780 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  check("375px 无横向溢出", overflow.sw <= overflow.cw + 1, JSON.stringify(overflow));

  /* ── 6. 发布链路（真发布再转草稿，验证 posts 层） ── */
  await page.setViewportSize({ width: 1440, height: 900 });
  const publishBtn = page.locator(".editor-btn-publish").first();
  if (await publishBtn.count() && !isProd) {
    await publishBtn.click();
    await page.waitForTimeout(3500);
    const afterPublish = await (await page.request.get(BASE + "/api/admin/posts/" + postId)).json();
    check("发布后 status=published", afterPublish.post?.status === "published", JSON.stringify(afterPublish.post?.status));
    check("发布后正文逐字节保留", String(afterPublish.post?.content ?? "").includes(marker));
    if (await excerptBox.count()) {
      check("发布后 posts.excerpt 为自定义摘要", afterPublish.post?.excerpt === "部署冒烟摘要", JSON.stringify(afterPublish.post?.excerpt));
    }
    const slug = afterPublish.post?.slug;
    if (slug) {
      const publicHtml = await (await fetch(BASE + "/" + encodeURIComponent(slug))).text();
      check("发布后前台可见", publicHtml.includes(marker));
    }
    // 转草稿下线，避免留下一条测试文章
    const bulk = await page.request.post(BASE + "/api/admin/posts/bulk", {
      data: { action: "unpublish", items: [{ id: postId, expectedRevision: afterPublish.post.revision }] },
    });
    const bulkBody = await bulk.json();
    check("冒烟文章已转回草稿", bulkBody?.summary?.succeeded === 1, JSON.stringify(bulkBody?.summary));
  } else if (isProd) {
    console.log("SKIP 发布链路（线上模式只验证草稿层）");
  }

  /* ── 7. 清理 ── */
  const cur = await (await page.request.get(BASE + "/api/admin/posts/" + postId)).json();
  const del = await page.request.delete(BASE + "/api/admin/posts/" + postId, {
    data: { expectedRevision: cur.post.revision },
  });
  check("冒烟文章移入回收站", del.ok(), "HTTP " + del.status());
  postId = null;

  const realErrors = consoleErrors.filter((t) => !/favicon|Download the React DevTools/i.test(t));
  check("浏览器控制台无报错", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("冒烟脚本执行完成", false, e.message);
  keep = true;
} finally {
  if (postId && !keep) {
    try {
      const cur = await (await page.request.get(BASE + "/api/admin/posts/" + postId)).json();
      await page.request.delete(BASE + "/api/admin/posts/" + postId, { data: { expectedRevision: cur.post.revision } });
    } catch { /* 清理尽力而为 */ }
  }
  if (keep && postId) console.error("留待人工检查的草稿壳 id=" + postId);
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " 通过");
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}
