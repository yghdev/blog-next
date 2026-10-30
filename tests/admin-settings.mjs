/**
 * 阶段 02-5 · 设置拆页 / 外链 / 操作日志。
 *
 * 断言的都是"重构前确实坏掉、且能自动化判定"的点：
 *   1. 设置真的拆成三个独立页，且各自 active 状态正确
 *   2. 旧地址 /admin/storage 是 308 永久跳转，不是 404（书签不能变死路）
 *   3. 站点表单：dirty 才可保存，保存后变"已保存"；未保存提示出现
 *   4. 友链文本框已从前台生效链路里移除（保存了也不生效的输入框不该留在表单里）
 *   5. 外链表单默认收起、点开才展开；在**发请求前**拦住空名称与非 http(s) 链接，
 *      并说明原因；列表的搜索与「已显示 / 已隐藏」筛选真的生效
 *   6. 日志动作筛选是链接且翻页不丢筛选（原来翻页会静默丢掉 action）
 *   7. 375px 三页都不横向溢出
 */
import assert from "node:assert/strict";
import path from "node:path";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server, controller, db;
try {
  server = await startIsolatedServer({ label: "phase02-settings" });
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  /* ---------- 1. 设置拆成三页 ---------- */
  for (const [url, tab] of [
    ["/admin/settings", "站点"],
    ["/admin/settings/security", "账号安全"],
    ["/admin/settings/storage", "图片存储"],
  ]) {
    const res = await page.goto(server.base + url, { waitUntil: "networkidle" });
    assert.equal(res.status(), 200, url + " 应返回 200，实际 " + res.status());
    const current = await page.locator('.seg-tabs a[aria-current="page"]').innerText();
    assert.equal(current.trim(), tab, url + " 的 active 子标签应为「" + tab + "」，实际「" + current + "」");
  }
  console.log("PASS phase02-5: 设置拆为三个独立页，active 子标签正确");

  /* ---------- 2. 旧地址 308 永久跳转 ---------- */
  const legacy = await page.request.get(server.base + "/admin/storage", { maxRedirects: 0 });
  assert.ok([301, 307, 308].includes(legacy.status()),
    "/admin/storage 应为跳转而不是 404，实际 " + legacy.status());
  const loc = legacy.headers()["location"] || "";
  assert.match(loc, /\/admin\/settings\/storage$/, "应跳到 /admin/settings/storage，实际 " + loc);
  console.log("PASS phase02-5: 旧地址 /admin/storage → " + legacy.status() + " " + loc);

  /* ---------- 3. 站点表单：dirty 控制与保存反馈 ---------- */
  await page.goto(server.base + "/admin/settings", { waitUntil: "networkidle" });
  const saveBtn = page.locator(".settings-savebar .btn-primary");
  assert.equal(await saveBtn.isDisabled(), true, "没有改动时保存按钮应为禁用");

  const titleInput = page.locator("#set-siteTitle");
  await titleInput.fill("PHASE025_TITLE");
  assert.equal(await saveBtn.isDisabled(), false, "有改动后保存按钮应可点");
  const dirtyText = await page.locator(".settings-dirty").innerText();
  assert.match(dirtyText, /1 处未保存/, "应提示 1 处未保存改动，实际：" + dirtyText);

  await saveBtn.click();
  await page.waitForSelector(".notice-ok", { timeout: 10000 });
  const savedText = await page.locator(".settings-saved").innerText();
  assert.match(savedText, /已保存/, "保存后应显示「已保存 · 时间」，实际：" + savedText);
  assert.equal(await saveBtn.isDisabled(), true, "保存后（无新改动）按钮应回到禁用");
  console.log("PASS phase02-5: 站点表单 dirty 提示与保存反馈正确");

  /* ---------- 4. 友链自由文本框已移除 ---------- */
  const hasFriendLinksField = await page.locator("#set-friendLinks, [id*=friendLinks]").count();
  assert.equal(hasFriendLinksField, 0,
    "「每行 名称|链接」文本框前台已不再读取，不应继续出现在表单里（填了保存成功但前台无变化）");
  // 设置分组不再是卡片（每组套一个边框盒子会让整页变成一叠白方块），
  // 所以断言改成「页面上存在通向 /admin/links 的出口」，不绑定容器样式类。
  const linksEntry = await page.locator('.settings-group a[href="/admin/links"]').count();
  assert.ok(linksEntry > 0, "移除输入框后必须给出「去外链管理」的出口");
  console.log("PASS phase02-5: 友链文本框已移除并指向 /admin/links");

  /* ---------- 5. 外链表单：发请求前就拦住非法输入 ---------- */
  await page.goto(server.base + "/admin/links", { waitUntil: "networkidle" });
  let requestSent = false;
  page.on("request", (r) => {
    if (r.url().includes("/api/admin/links") && r.method() !== "GET") requestSent = true;
  });

  // 5-pre. 表单默认收起：首屏先出列表，点「添加外链」才展开
  assert.equal(await page.locator(".link-form-body").isHidden(), true,
    "新增表单默认应收起，把「已有外链」让到首屏");
  await page.locator(".link-compose-trigger").click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".link-form-body").isVisible(), true, "点「添加外链」后表单应展开");
  assert.equal(await page.locator(".link-compose-trigger").count(), 0, "展开后入口带应换成表单标题栏");

  // 5a. 全空点添加
  await page.locator(".link-form-actions .btn-primary").click();
  await page.waitForTimeout(300);
  assert.equal(requestSent, false, "名称为空时不该发请求");
  const nameErr = await page.locator("#link-name-err").innerText();
  assert.match(nameErr, /名称必填/, "应提示名称必填，实际：" + nameErr);

  // 5b. 名称填了、链接是 javascript:
  await page.locator("#link-name").fill("危险链接");
  await page.locator("#link-url").fill("javascript:alert(1)");
  await page.locator(".link-form-actions .btn-primary").click();
  await page.waitForTimeout(300);
  assert.equal(requestSent, false, "javascript: 链接不应发请求");
  const urlErr = await page.locator("#link-url-err").innerText();
  assert.match(urlErr, /http/, "应说明只接受 http/https，实际：" + urlErr);
  assert.match(urlErr, /不会显示|过滤/, "还应说明为什么（前台会过滤，保存了也不显示）");
  console.log("PASS phase02-5: 外链表单在发请求前拦住空名称与 javascript: 链接");

  // 5c. 合法输入可以真的保存
  // 注意：迁移 0011 会预置一条常驻的「开往」聚合外链（表为空时才插），
  // 所以基数是 1 不是 0 —— 断言必须按"新增了 1 条"而不是"总共 1 条"。
  const before = await page.locator(".link-row").count();
  await page.locator("#link-url").fill("https://example.com/ok");
  requestSent = false;
  await page.locator(".link-form-actions .btn-primary").click();
  await page.waitForSelector(".notice-ok", { timeout: 10000 });
  assert.equal(requestSent, true, "合法输入应真的发出保存请求");
  await page.waitForTimeout(500);
  const after = await page.locator(".link-row").count();
  assert.equal(after, before + 1, "保存后列表应多 1 条（" + before + " → " + after + "）");
  // 新增成功后保持展开（方便连填），字段清空
  assert.equal(await page.locator(".link-form-body").isVisible(), true, "新增成功后表单保持展开，方便继续添加");
  assert.equal(await page.locator("#link-name").inputValue(), "", "新增成功后名称应清空");

  // 新加的那条排最后（sort_order 100 大于预置的 10）：显隐状态要有明确徽标，
  // 不能只靠 opacity —— 那只说明"看起来淡了"，不说明"已隐藏"
  const newRow = page.locator(".link-row").last();
  assert.match(await newRow.innerText(), /example\.com/, "最后一行应是刚添加的那条");
  // 显隐状态在列表行里用 .fx-state（圆点 + 文案）而不是彩色胶囊：
  // 一屏十几行每行挂一个 badge，会让整页变成彩虹，反而更难扫读。
  const visibleBadge = await newRow.locator(".fx-state").last().innerText();
  assert.match(visibleBadge, /已显示/, "显隐状态应有明确文案，实际：" + visibleBadge);

  // 5d. 顶部搜索即时过滤
  await page.locator(".link-search input").fill("example.com");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".link-row").count(), 1, "按链接搜索应只留下刚添加的那一条");
  await page.locator(".link-search-clear").click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".link-row").count(), after, "清除搜索后应恢复全部");

  // 5e. 状态分段筛选：隐藏后切到「已隐藏」能找到它
  await newRow.locator('.link-act[aria-label^="隐藏"]').click();
  await page.waitForSelector(".notice-ok", { timeout: 10000 });
  await page.locator('.link-filter-item[aria-pressed]', { hasText: "已隐藏" }).click();
  await page.waitForTimeout(200);
  const hiddenRows = await page.locator(".link-row").count();
  assert.ok(hiddenRows >= 1, "切到「已隐藏」后应能看到刚隐藏的那一条");
  const hiddenStates = await page.locator(".link-row .fx-state").allInnerTexts();
  assert.deepEqual([...new Set(hiddenStates)], ["已隐藏"],
    "「已隐藏」筛选里的每一行都应是隐藏项，实际：" + JSON.stringify(hiddenStates));
  assert.match(await page.locator(".link-row").last().innerText(), /example\.com/,
    "刚隐藏的那条应在「已隐藏」列表里");
  await page.locator('.link-filter-item', { hasText: "全部" }).click();
  console.log("PASS phase02-5: 合法外链可保存（" + before + " → " + after + "），状态有文案，搜索与状态筛选可用");

  /* ---------- 6. 日志：动作筛选是链接，且翻页不丢筛选 ---------- */
  // 先造 >100 条日志，逼出分页
  const D = (await import("better-sqlite3")).default;
  db = new D(path.join(server.dataDir, "blog.db"));
  db.pragma("busy_timeout = 5000");
  const insLog = db.prepare(
    "INSERT INTO audit_log (actor_user_id, actor_name, action, target_type, target_id, meta_json, ip, user_agent, created_at) " +
    "VALUES (1, 'integration-admin', ?, 'post', '1', ?, '10.0.0.9', 'test', ?)"
  );
  const base0 = Date.now();
  for (let i = 0; i < 130; i++) {
    insLog.run(i % 2 === 0 ? "post.update" : "post.delete", JSON.stringify({ i }), new Date(base0 - i * 1000).toISOString());
  }
  db.close();
  db = null;

  await page.goto(server.base + "/admin/audit", { waitUntil: "networkidle" });
  const groupTabs = await page.locator(".log-toolbar .seg-tabs a").count();
  assert.ok(groupTabs >= 8, "动作筛选应是分组链接（全部/文章/评论/...），实际 " + groupTabs + " 个");

  await page.goto(server.base + "/admin/audit?group=post", { waitUntil: "networkidle" });
  const summary = await page.locator(".log-summary").innerText();
  assert.match(summary, /130/, "文章分组应有 130 条，实际：" + summary);

  // 关键：翻页链接必须带着 group，否则筛选被静默丢弃
  const pagerHrefs = await page.locator(".list-pager a").evaluateAll((els) =>
    els.map((e) => e.getAttribute("href") || "")
  );
  assert.ok(pagerHrefs.length > 0, "130 条 / 每页 100 → 应出现分页");
  const missingGroup = pagerHrefs.filter((h) => !h.includes("group=post"));
  assert.deepEqual(missingGroup, [], "翻页链接丢了 group 筛选（原来只拼 page）：" + JSON.stringify(pagerHrefs));

  // 危险动作要有区分色
  const dangerCount = await page.locator(".log-action.is-danger").count();
  assert.ok(dangerCount > 0, "post.delete 这类删除动作应有危险色标记");
  console.log("PASS phase02-5: 日志分组筛选为链接，翻页保留筛选，删除类动作用危险色");

  /* ---------- 7. 375px 三页都不溢出 ---------- */
  await page.setViewportSize({ width: 375, height: 800 });
  for (const url of ["/admin/settings", "/admin/links", "/admin/audit"]) {
    await page.goto(server.base + url, { waitUntil: "networkidle" });
    await page.waitForTimeout(200);
    const o = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    }));
    assert.ok(o.sw <= o.cw + 1, url + " 在 375px 横向溢出：" + JSON.stringify(o));
  }
  // 手机外链操作热区 >= 44（操作已图标化，选择器随之改成 .link-act）
  await page.goto(server.base + "/admin/links", { waitUntil: "networkidle" });
  const box = await page.locator(".link-actions .link-act").first().boundingBox();
  assert.ok(box && box.height >= 44, "手机外链操作按钮热区应 >= 44dp，实际 " + (box && box.height));
  console.log("PASS phase02-5: 375px 三页均无溢出（外链操作热区 " + Math.round(box.height) + "dp）");

  console.log("All phase-02-5 checks passed.");
} finally {
  if (db) try { db.close(); } catch {}
  if (controller) await controller.close();
  if (server) await server.close();
}
