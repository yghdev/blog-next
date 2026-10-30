#!/usr/bin/env node
/**
 * Umami 历史数据的最后一次同步（2026-10-30 起冻结）。
 *
 * ## 为什么这个脚本要保留、但已退出定时任务
 *
 * 博客的浏览量在 2026-10-30 换成自建埋点（lib/visitor-stats.ts），运行时
 * 不再依赖 Umami。但 Umami 里有一份上线之前的历史数据，直接丢掉就等于
 * 把所有文章的浏览量归零。
 *
 * 处理方式：迁移 0013 已把 settings 里的 `umami:*` 冻结成 `stats:baseline:*`，
 * 读取时与新增数据相加。所以**这个脚本从此不需要定时跑**。
 * 保留它是为了：① 想核对历史数字时还能手动跑一次；② 它是
 * 「基线是从哪来的」的唯一书面记录。
 *
 * ## 它写的仍是 umami:*，不是 stats:baseline:*
 *
 * 刻意如此。基线必须冻结 —— 若定时任务继续把新数据写进基线，而新数据
 * 又已经被 hits 表统计过，就会**重复计算**。
 *
 * 用法（手动）：node scripts/sync-umami.mjs
 * 环境：UMAMI_API_URL、UMAMI_WEBSITE_ID、UMAMI_TOKEN、DATA_DIR
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB = path.join(DATA_DIR, "blog.db");
const BASE = process.env.UMAMI_API_URL;
const SITE = process.env.UMAMI_WEBSITE_ID;
const TOKEN = process.env.UMAMI_TOKEN;

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

if (!BASE || !SITE || !TOKEN) {
  log("Umami 未配置（需要 UMAMI_API_URL / UMAMI_WEBSITE_ID / UMAMI_TOKEN），跳过");
  process.exit(0);
}
if (!fs.existsSync(DB)) {
  log("数据库不存在：" + DB);
  process.exit(1);
}

const db = new Database(DB);
const setStmt = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

const end = Date.now();
// 取「全部时间」：冻结后不再更新，滚动窗口会漏掉站龄之外的数据
const start = 0;

/** 带超时的 fetch：绝不因为统计服务挂住而拖住同步任务 */
async function jget(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN }, signal: ac.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

try {
  // 1) 总浏览量
  const stats = await jget(BASE + "/api/websites/" + SITE + "/stats?startAt=" + start + "&endAt=" + end);
  const pv = typeof stats?.pageviews === "number" ? stats.pageviews : stats?.pageviews?.value;
  const write = db.transaction(() => {
    if (typeof pv === "number") {
      setStmt.run("umami:total", String(pv));
    }
    setStmt.run("umami:synced_at", new Date().toISOString());
  });
  write();
  log("总浏览量：" + (typeof pv === "number" ? pv : "(无数据)"));

  // 2) 各路径浏览量（写 umami:path:<path>）
  const rows = await jget(BASE + "/api/websites/" + SITE + "/metrics?startAt=" + start + "&endAt=" + end + "&type=path&limit=500");
  const arr = Array.isArray(rows) ? rows : [];
  db.transaction(() => {
    for (const r of arr) {
      if (typeof r?.x === "string" && typeof r?.y === "number") setStmt.run("umami:path:" + r.x, String(r.y));
    }
  })();
  log("路径统计写入：" + arr.length + " 条（仅 umami:*，不影响 stats:baseline:*）");
} catch (e) {
  log("同步失败（保留旧值，不影响站点）：" + e.message);
  process.exit(1);
} finally {
  db.close();
}
