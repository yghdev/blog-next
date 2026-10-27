/**
 * 阶段 02-2 · 内容列表页。
 *
 * 重点断言"筛选是否真的能用、语义是否挂对"：
 *   1. 状态筛选是分段**链接**，用 aria-current 而不是 aria-selected
 *      （方案 §9.3：筛选链接用 aria-current，不把 aria-selected 挂到普通按钮）
 *   2. 类型筛选是 aria-pressed 按钮组（它是过滤维度，不是切换面板）
 *   3. 筛选可分享：URL 带参数，且 type 与 status 互相保留
 *   4. 计数与筛选联动：点"草稿 N"进去，条数应该和 N 一致
 *   5. 空结果时必须给出口，而不是空白
 *   6. 375px 无横向溢出，筛选控件热区足够
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server, controller;
try {
  server = await startIsolatedServer({ label: "phase02-list" });
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });

  // 造数据：2 已发布 + 1 草稿 + 1 页面
  const make = (body) => page.request.post(server.base + "/api/admin/posts", { data: body });
  assert.equal((await make({ type: "post", title: "PUB_A", slug: "pub-a", content: "x", status: "published" })).status(), 200);
  assert.equal((await make({ type: "post", title: "PUB_B", slug: "pub-b", content: "x", status: "published" })).status(), 200);
  assert.equal((await make({ type: "post", title: "DRAFT_A", slug: "draft-a", content: "x", status: "draft" })).status(), 200);
  assert.equal((await make({ type: "page", title: "PAGE_A", slug: "page-a", content: "x", status: "published" })).status(), 200);

  await page.reload({ waitUntil: "networkidle" });

  /* ---------- 1. 状态筛选：seg-tabs 用 aria-current ---------- */
  const statusItems = await page.locator(".content-toolbar .seg-tabs a").evaluateAll((els) =>
    els.map((e) => ({
      text: (e.textContent || "").trim(),
      ariaCurrent: e.getAttribute("aria-current"),
      ariaSelected: e.getAttribute("aria-selected"),
    }))
  );
  assert.ok(statusItems.length >= 3, "状态筛选应至少有 3 项，实际 " + statusItems.length);
  assert.ok(statusItems.every((x) => x.ariaSelected === null),
    "筛选链接不应挂 aria-selected（那是 tab 的语义）： " + JSON.stringify(statusItems));
  const activeStatus = statusItems.filter((x) => x.ariaCurrent === "true");
  assert.equal(activeStatus.length, 1, "当前筛选应恰有一项 aria-current=true，实际 " + JSON.stringify(activeStatus));
  console.log("PASS phase02-2: 状态筛选为链接 + aria-current（无 aria-selected）");

  /* ---------- 2. 类型筛选：aria-pressed ---------- */
  const typeItems = await page.locator(".type-filter-item").evaluateAll((els) =>
    els.map((e) => ({ text: (e.textContent || "").trim(), pressed: e.getAttribute("aria-pressed") }))
  );
  assert.equal(typeItems.length, 4, "类型筛选应有 4 项（全部/文章/页面/说说），实际 " + typeItems.length);
  assert.ok(typeItems.every((x) => x.pressed === "true" || x.pressed === "false"),
    "类型筛选必须用 aria-pressed 表达选中态： " + JSON.stringify(typeItems));
  assert.equal(typeItems.filter((x) => x.pressed === "true").length, 1, "应恰有一项被按下");
  console.log("PASS phase02-2: 类型筛选为 aria-pressed 按钮组");

  /* ---------- 3. 计数与筛选联动 ---------- */
  // 「草稿」的计数应等于点进去后的条数
  const draftTab = statusItems.find((x) => x.text.startsWith("草稿"));
  assert.ok(draftTab, "应存在「草稿」筛选项");
  const draftCount = Number((draftTab.text.match(/(\d+)/) || [])[1]);
  assert.equal(draftCount, 1, "草稿计数应为 1（只建了 1 篇草稿），实际=" + draftCount);

  await page.goto(server.base + "/admin?status=draft", { waitUntil: "networkidle" });
  const rows = await page.locator(".data-panel .data-row").count();
  assert.equal(rows, draftCount, "草稿筛选后的行数应等于计数： rows=" + rows + " count=" + draftCount);
  console.log("PASS phase02-2: 计数与筛选结果一致（草稿 " + draftCount + " 条）");

  /* ---------- 4. 筛选可分享：type 与 status 互相保留 ---------- */
  const links = await page.locator(".type-filter-item").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  assert.ok(links.every((h) => h !== null), "类型筛选应是真实链接，便于分享/收藏");
  // 当前在 status=draft，点击类型"文章"应同时保留 status=draft
  const postTypeLink = await page.locator('.type-filter-item:has-text("文章")').getAttribute("href");
  assert.match(postTypeLink || "", /status=draft/, "切换类型时应保留当前状态筛选，实际=" + postTypeLink);
  assert.match(postTypeLink || "", /type=post/, "类型链接应带 type=post，实际=" + postTypeLink);
  console.log("PASS phase02-2: 筛选链接保留其它维度（status+type 可组合）");

  /* ---------- 5. 空结果必须有出口 ---------- */
  await page.goto(server.base + "/admin?status=draft&type=shuoshuo", { waitUntil: "networkidle" });
  const emptyBlock = page.locator(".empty-block");
  assert.ok(await emptyBlock.isVisible(), "无匹配内容时应显示空状态而不是空白");
  const emptyLink = await page.locator(".empty-block a").first().isVisible();
  assert.ok(emptyLink, "空状态必须给一个可继续的动作出口");
  console.log("PASS phase02-2: 空结果给出口");

  /* ---------- 6. 375px 无横向溢出 + 热区 ---------- */
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.sw <= overflow.cw + 1, "内容列表 375px 横向溢出：" + JSON.stringify(overflow));

  const smallTap = await page.locator(".type-filter-item").evaluateAll((els) =>
    els.map((e) => ({ t: (e.textContent || "").trim(), h: Math.round(e.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44)
  );
  assert.deepEqual(smallTap, [], "类型筛选在 375px 热区应 >= 44： " + JSON.stringify(smallTap));
  console.log("PASS phase02-2: 375px 无横向溢出（" + overflow.sw + "/" + overflow.cw + "）+ 筛选热区达标");

  console.log("All phase-02-2 content list checks passed.");
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
