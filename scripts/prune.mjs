#!/usr/bin/env node
/**
 * 定期清理（P2-2 / P4）。
 * 原先 sessions 只在被访问时惰性删除、rate_limits 只增不减，表会单调增长。
 * 建议每小时跑一次（deploy/blog-prune.timer）。
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB = path.join(DATA_DIR, "blog.db");
if (!fs.existsSync(DB)) { console.error("数据库不存在：" + DB); process.exit(1); }

const db = new Database(DB);
db.pragma("journal_mode = WAL");
const now = new Date().toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 86400 * 1000).toISOString();

const out = {};
out.sessions = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now).changes;
out.rate_limits = db.prepare("DELETE FROM rate_limits WHERE reset_at < ?").run(hoursAgo(24)).changes;
out.audit = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(daysAgo(180)).changes;
// 回收站超过 30 天的彻底删除（连带评论，与后台"彻底删除"语义一致）
out.trash = db.prepare("DELETE FROM posts WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(daysAgo(30)).changes;

/**
 * 访客事件**不删**（2026-10-30）。
 *
 * 当前量级：日均个位数 PV，一年约 2200 行、十年 2 万行 —— SQLite 毫无压力，
 * 而原始事件一旦删掉，UV / 来源 / 任意区间重算就永久失去能力
 * （累计值无法反推「上个月有多少访客」）。
 *
 * 什么时候才需要加保留期：hits 超过约 50 万行，或需要保留超过 3 年。
 * 那时正确的做法是先建一张按天的汇总表，再删原始行 —— 而不是直接 DELETE。
 * 另外注意：SQLite 删行后文件不会自动变小（WAL + 未开 auto_vacuum），
 * 单纯 DELETE 只会让库越来越碎，备份体积不会下降。
 */

console.log(new Date().toISOString(), "pruned", JSON.stringify(out));
db.close();
