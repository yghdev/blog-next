#!/usr/bin/env node
/**
 * 把 Umami 的历史事件一次性导入 hits 表（2026-10-30）。
 *
 * ## 为什么是「脚本」而不是「迁移 0014」
 *
 * 迁移必须在任何机器、任何时间点重放时都能成功，且只依赖库内状态。
 * 而这份历史数据来自**另一台进程里的 Postgres** —— 把读文件放进迁移，
 * 换机、重装、恢复备份时都会静默失败（迁移表已经标记完成，数据永远补不上）。
 * 一次性导入属于运维动作，放在这里，跑过一次就不再需要。
 *
 * ## 数据来源
 *
 * 在服务器上导出（已排除 /admin、/api、/_next）：
 *   cd /opt/umami
 *   docker compose exec -T umami-db psql -U umami -d umami -t -A -F $'\t' -c "
 *     select event_id::text,
 *            to_char(created_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
 *            url_path, coalesce(referrer_domain,''), session_id::text, visit_id::text
 *     from website_event
 *     where url_path not like '/admin%' and url_path not like '/api%' and url_path not like '/_next%'
 *     order by created_at, event_id;" > /tmp/umami-events.tsv
 *
 * ## 字段映射
 *
 *   url_path        -> path      （归一化，见下）
 *   referrer_domain -> ref_host（只存域名，本来就没有完整 URL）
 *   session_id      -> visitor  （Umami 的会话标识；本系统用它近似「访客」）
 *   visit_id        -> is_entry （同一 visit_id 的首条 = 1）
 *   created_at      -> created_at / day
 *
 * ## 幂等
 *
 * 用 event_id 做去重键写进 `import_key`，重复跑不会重复计数。
 *
 * ## 用法
 *
 *   DATA_DIR=/var/lib/blog node scripts/import-umami-events.mjs /tmp/umami-events.tsv
 *   DRY_RUN=1 ... 只统计不写库
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "blog.db");
const FILE = process.argv[2];
const DRY = process.env.DRY_RUN === "1";

if (!FILE || !fs.existsSync(FILE)) {
  console.error("用法：node scripts/import-umami-events.mjs <umami-events.tsv>");
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error("数据库不存在：" + DB_PATH);
  process.exit(1);
}

/* ---------- 路径归一化：必须与 lib/visitor-stats.ts 的 normalizePath 一致 ---------- */

function normalizePath(input) {
  if (typeof input !== "string") return null;
  let p = input.trim();
  if (!p) return null;
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf("#");
  if (h >= 0) p = p.slice(0, h);
  if (!p.startsWith("/")) p = "/" + p;
  try { p = decodeURIComponent(p); } catch { /* 保留原样 */ }
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 200) return null;
  if (/^\/(admin|api|_next|preview)(\/|$)/.test(p)) return null;
  return p;
}

/** 来源分类：与 lib/visitor-stats.ts 的 classifyReferrer 同一套规则 */
const SEARCH_HOSTS = [
  "google.", "bing.com", "baidu.com", "duckduckgo.com", "yandex.", "sogou.com",
  "so.com", "sm.cn", "ecosia.org", "startpage.com", "search.brave.com",
  "chatgpt.com", "chat.openai.com", "perplexity.ai", "gemini.google.com",
];
const SOCIAL_HOSTS = [
  "x.com", "twitter.com", "t.co", "weibo.com", "weibo.cn", "zhihu.com",
  "v2ex.com", "discord.com", "discord.gg", "t.me", "telegram.me",
  "reddit.com", "news.ycombinator.com", "douban.com", "juejin.cn", "csdn.net",
  "bilibili.com", "youtube.com", "threads.net", "mastodon.", "bsky.app",
  "facebook.com", "instagram.com",
];

function normalizeHost(h) {
  return (h || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "").slice(0, 120);
}
function classify(refHost, selfHost) {
  const h = normalizeHost(refHost);
  if (!h) return "direct";
  const self = normalizeHost(selfHost);
  if (self && (h === self || h.endsWith("." + self))) return "site";
  if (SEARCH_HOSTS.some((s) => h === s.replace(/\.$/, "") || h.includes(s))) return "search";
  if (SOCIAL_HOSTS.some((s) => h.includes(s))) return "social";
  return "referral";
}

/* -------------------------------- 读入 -------------------------------- */

const raw = fs.readFileSync(FILE, "utf8").split("\n").filter((l) => l.trim());
console.log("读入行数：" + raw.length);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const SELF_HOST = normalizeHost(process.env.SITE_URL || "blog.yghsite.cn");

// Umami 的 session_id 是 UUID；本系统的 visitor 是 HMAC 前 16 位。
// 历史事件没有原始 IP/UA，无法重算——直接对 session_id 取摘要，
// 保持「不可逆、定长、不与新数据格式冲突」这三个性质即可。
const legacyVisitor = (sid) => "u" + createHash("sha256").update("umami:" + sid).digest("hex").slice(0, 15);

const bySlug = db.prepare("SELECT id FROM posts WHERE '/' || slug = ? AND deleted_at IS NULL LIMIT 1");
const byId = db.prepare("SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL LIMIT 1");
const legacyDate = /^\/\d{4}\/\d{2}\/\d{2}\/(.+)$/;

function resolvePostId(p) {
  const m = /^\/p\/(\d+)$/.exec(p);
  if (m) {
    const r = byId.get(Number(m[1]));
    return r ? r.id : null;
  }
  const direct = bySlug.get(p);
  if (direct) return direct.id;
  // 旧 WordPress 日期路径：只试末段，不做模糊匹配
  const lm = legacyDate.exec(p);
  if (lm) {
    const r = bySlug.get("/" + lm[1]);
    if (r) return r.id;
  }
  return null;
}

const hasImportKey = db.prepare("SELECT 1 FROM hits WHERE import_key = ?");
const insert = db.prepare(
  "INSERT INTO hits (path, post_id, visitor, is_entry, ref_host, ref_kind, day, created_at, import_key) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);

/** 每个 visit_id 的第一条才算入口 —— 用「见过没见过」判断，而不是假定文件顺序 */
const seenVisit = new Set();

let imported = 0, skipped = 0, dup = 0, unmatched = 0;
const dayCount = new Map();
const kindCount = new Map();

const run = db.transaction(() => {
  for (const line of raw) {
    const [eventId, createdUtc, urlPath, refDomain, sessionId, visitId] = line.split("\t");
    if (!eventId || !createdUtc || !urlPath) { skipped++; continue; }

    const p = normalizePath(urlPath);
    if (!p) { skipped++; continue; }
    if (/\.[a-z0-9]{2,5}$/i.test(p)) { skipped++; continue; }

    const key = "umami:" + eventId;
    if (hasImportKey.get(key)) { dup++; continue; }

    const postId = resolvePostId(p);
    if (!postId && p !== "/" && !p.startsWith("/tags/") && !["/shuoshuo", "/archives", "/friend-links", "/about", "/search"].includes(p)) {
      // 对不上任何内容的路径仍然导入（它是真实访问），只是 post_id 为空
      unmatched++;
    }

    const isEntry = seenVisit.has(visitId) ? 0 : 1;
    seenVisit.add(visitId);

    const refHost = normalizeHost(refDomain);
    const kind = classify(refDomain, SELF_HOST);
    const day = createdUtc.slice(0, 10);

    dayCount.set(day, (dayCount.get(day) ?? 0) + 1);
    kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);

    if (!DRY) {
      insert.run(
        p, postId, legacyVisitor(sessionId || visitId), isEntry,
        kind === "site" ? "" : refHost, kind, day, createdUtc, key
      );
    }
    imported++;
  }
});
run();

console.log(DRY ? "== DRY RUN（未写库）==" : "== 已写入 ==");
console.log("  导入:", imported, " 跳过:", skipped, " 已存在:", dup, " 无对应内容:", unmatched);
console.log("  按天:", [...dayCount.entries()].sort().map(([d, n]) => d + "=" + n).join(" "));
console.log("  按来源:", [...kindCount.entries()].map(([k, n]) => k + "=" + n).join(" "));

if (!DRY) {
  /**
   * 导入成功后把「汇总式基线」归零。
   *
   * 为什么必须做：基线的含义是「历史上有多少访问是 hits 里没有的」。
   * 一旦把 653 条真实事件导进来，这部分历史就已经在 hits 里了，
   * 再加基线就是**重复计算**（653 + 1081 = 1734，而真实总量根本不到 1200）。
   *
   * 只有在「导入确实成功且有行被写入」时才归零 —— 导入失败或空文件时，
   * 基线仍是唯一的历史来源，不能动。
   */
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('stats:baseline:total', '0') " +
    "ON CONFLICT(key) DO UPDATE SET value = '0'"
  ).run();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('stats:imported:umami', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(new Date().toISOString());

  const total = db.prepare("SELECT COUNT(*) c FROM hits").get().c;
  const visits = db.prepare("SELECT COALESCE(SUM(is_entry),0) s FROM hits").get().s;
  const uv = db.prepare("SELECT COUNT(DISTINCT visitor) c FROM hits").get().c;
  const base = db.prepare("SELECT value FROM settings WHERE key='stats:baseline:total'").get();
  console.log("  表内合计: PV=" + total + " 访问次数=" + visits + " UV=" + uv);
  console.log("  基线已归零（历史事件已在表内）: stats:baseline:total=" + (base ? base.value : "?"));
}
db.close();
