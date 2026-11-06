/**
 * 旧 WordPress 日期路径（`/YYYY/MM/DD/<slug>`）的真实 Next 集成测试。
 *
 * 只能在真进程 + 真 HTTP 这一层验证：路由是否被 catch-all 正确接管、
 * `permanentRedirect` 实际发出的状态码与 Location、以及 catch-all 有没有
 * 顺手把别处的 404 变成跳转（后者在只看代码时最容易漏）。
 *
 * 数据直接写隔离库，而不是走后台 API：这里测的是「老数据长什么样就怎么访问」，
 * 需要精确控制 wp_id / slug / published_at，后台 API 反而会把这些改写成新格式。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { startIsolatedServer } from "./helpers/next-server.mjs";

let server;

/** 用编码后的路径请求，模拟浏览器/爬虫真正发出的 URL */
function get(route) {
  return fetch(server.base + encodeURI(route), { redirect: "manual" });
}

try {
  server = await startIsolatedServer({ label: "legacy-path" });

  const D = (await import("better-sqlite3")).default;
  const db = new D(path.join(server.dataDir, "blog.db"));
  db.pragma("busy_timeout = 5000");
  const insert = db.prepare(
    "INSERT INTO posts (type,title,slug,content,status,wp_id,published_at) VALUES ('post',?,?,'','published',?,?)"
  );
  const imghubId = Number(insert.run("imghub图床", "imghub图床", 29, "2026-06-07T14:13:00.000Z").lastInsertRowid);
  const migrateId = Number(insert.run("博客迁移记录", "博客迁移记录", 232, "2026-09-03T14:49:42.000Z").lastInsertRowid);
  const numericId = Number(insert.run("本地部署开源大模型", "本地部署开源大模型", 35, "2026-05-25T14:17:00.000Z").lastInsertRowid);
  db.close();

  /* ---------------- 1. 旧日期路径：精确 / 前缀 / wp_id ---------------- */
  const exact = await get("/2026/06/07/imghub图床");
  assert.equal(exact.status, 308, "旧日期路径必须 308 到规范地址");
  assert.equal(exact.headers.get("location"), "/p/" + imghubId);
  console.log("PASS legacy dated path: /2026/06/07/imghub图床 -> /p/" + imghubId);

  const prefixed = await get("/2026/06/07/imghub");
  assert.equal(prefixed.status, 308, "被改短的旧 slug 走唯一前缀");
  assert.equal(prefixed.headers.get("location"), "/p/" + imghubId);
  console.log("PASS legacy prefix path: /2026/06/07/imghub -> /p/" + imghubId);

  const numeric = await get("/2026/05/25/35");
  assert.equal(numeric.status, 308, "纯数字旧 slug 按 wp_id 命中");
  assert.equal(numeric.headers.get("location"), "/p/" + numericId);
  console.log("PASS numeric legacy slug: /2026/05/25/35 -> /p/" + numericId);

  const migrate = await get("/2026/09/03/博客迁移记录");
  assert.equal(migrate.status, 308);
  assert.equal(migrate.headers.get("location"), "/p/" + migrateId);

  /* ---------------- 2. 归档类旧路径 ---------------- */
  for (const route of ["/2026/page/2", "/2026/06/07", "/2026/06"]) {
    const res = await get(route);
    assert.equal(res.status, 308, route + " 应跳归档");
    assert.equal(res.headers.get("location"), "/archives", route + " 的 Location 应是 /archives");
  }
  console.log("PASS legacy archive paths: /2026/page/2, /2026/06/07, /2026/06 -> /archives");

  /* ---------------- 3. 不能过度接管 ---------------- */
  for (const route of ["/2026/06/07/不存在的文章", "/2026/13/01/x", "/foo/bar", "/2026/06/07"]) {
    if (route === "/2026/06/07") continue; // 上面已断言为归档跳转
    const res = await get(route);
    assert.equal(res.status, 404, route + " 必须保持 404，不能被 catch-all 猜成跳转");
  }
  console.log("PASS catch-all does not over-reach: unknown multi-segment paths stay 404");

  /* ---------------- 4. 既有入口没被抢走 ---------------- */
  const single = await get("/imghub图床");
  assert.equal(single.status, 308, "单段旧 slug 仍由 [slug] 兼容层处理");
  assert.equal(single.headers.get("location"), "/p/" + imghubId);

  const canonical = await get("/p/" + imghubId);
  assert.equal(canonical.status, 200, "规范地址本身必须正常渲染");
  console.log("PASS existing routes intact: /imghub图床 308, /p/<id> 200");
} finally {
  await server?.close();
}
