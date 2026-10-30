import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 访客统计的语义测试（2026-10-30）。
 *
 * 必须独立成文件：lib/db.ts 的 getDb() 是进程级单例，在**任何 lib 动态导入之前**
 * 先把 DATA_DIR 指向临时目录，否则会写进仓库里的 data/blog.db。
 */
const TMP_ROOT = path.join(process.cwd(), ".tmp-tests");
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, "visitor-"));
process.env.DATA_DIR = TMP;

const dbMod = await import("../lib/db.ts");
const v = await import("../lib/visitor-stats.ts");
const timeMod = await import("../lib/time.ts");

const db = dbMod.getDb();

function seedPost(slug: string, title = slug): number {
  const now = timeMod.nowIso();
  const info = db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) " +
    "VALUES ('post', ?, ?, '正文', 'published', ?, ?, ?)"
  ).run(slug, title, now, now, now);
  return Number(info.lastInsertRowid);
}

/* ------------------------------ 路径归一化 ------------------------------ */

test("中文 slug 的两种形态归一到同一个 key（本站最危险的坑）", () => {
  const decoded = "/博客迁移记录";
  const encoded = "/%E5%8D%9A%E5%AE%A2%E8%BF%81%E7%A7%BB%E8%AE%B0%E5%BD%95";

  assert.equal(v.normalizePath(encoded), decoded, "编码态必须解码成中文");
  assert.equal(v.normalizePath(decoded), decoded, "解码态保持不变");
  assert.equal(v.normalizePath(encoded), v.normalizePath(decoded), "两种形态必须相等");
});

test("归一化：去 query/hash、折叠斜杠、去尾斜杠、补前导斜杠", () => {
  assert.equal(v.normalizePath("/p/12?from=rss"), "/p/12");
  assert.equal(v.normalizePath("/p/12#comments"), "/p/12");
  assert.equal(v.normalizePath("/p/12/"), "/p/12");
  assert.equal(v.normalizePath("//p//12"), "/p/12");
  assert.equal(v.normalizePath("p/12"), "/p/12");
  assert.equal(v.normalizePath("https://blog.yghsite.cn/p/12?x=1"), "/p/12", "完整 URL 也能吃");
  assert.equal(v.normalizePath("/"), "/", "根路径保留");
});

test("归一化：后台与接口路径一律拒绝（不该被统计）", () => {
  for (const p of ["/admin", "/admin/visitors", "/api/hit", "/_next/static/x.js", "/preview"]) {
    assert.equal(v.normalizePath(p), null, p + " 不该被记录");
  }
});

test("归一化：非法输入返回 null 而不是抛错", () => {
  assert.equal(v.normalizePath(""), null);
  assert.equal(v.normalizePath("   "), null);
  assert.equal(v.normalizePath(null as unknown as string), null);
  assert.equal(v.normalizePath("/" + "a".repeat(300)), null, "超长路径拒绝");
  // 残缺的百分号编码：不抛错，按原样保留
  assert.equal(v.normalizePath("/%E5%8D"), "/%E5%8D");
});

test("资源文件不统计（否则图标、favicon 会挤进 Top 列表）", () => {
  assert.equal(v.isTrackablePath("/favicon.ico"), false);
  assert.equal(v.isTrackablePath("/avatar.jpg"), false);
  assert.equal(v.isTrackablePath("/p/12"), true);
  assert.equal(v.isTrackablePath("/about"), true);
});

/* ------------------------------- 访客标识 ------------------------------- */

test("访客标识：稳定、不可逆、不含原始 IP", () => {
  const a1 = v.visitorId("1.2.3.4", "Mozilla/5.0 Chrome/120.0.6099.71 Safari/537.36");
  const a2 = v.visitorId("1.2.3.4", "Mozilla/5.0 Chrome/120.0.6099.71 Safari/537.36");
  const b = v.visitorId("5.6.7.8", "Mozilla/5.0 Chrome/120.0.6099.71 Safari/537.36");

  assert.equal(a1, a2, "同一人必须得到同一个 id（UV 靠这个去重）");
  assert.notEqual(a1, b, "不同 IP 必须不同");
  assert.equal(a1.length, 16);
  assert.ok(!a1.includes("1.2.3.4"), "标识里不能出现明文 IP");
});

test("UA 抹掉版本号：浏览器升级不该把人算成新访客", () => {
  const oldUa = "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.6099.71 Safari/537.36";
  const newUa = "Mozilla/5.0 (Windows NT 10.0) Chrome/121.0.6167.85 Safari/537.36";

  assert.equal(v.uaFamily(oldUa), v.uaFamily(newUa), "UA 家族应相同");
  assert.equal(
    v.visitorId("1.2.3.4", oldUa),
    v.visitorId("1.2.3.4", newUa),
    "Chrome 大版本升级后仍是同一个访客"
  );
});

/* -------------------------------- 来源 -------------------------------- */

test("来源分类：direct / site / search / social / referral", () => {
  const self = "blog.yghsite.cn";
  assert.equal(v.classifyReferrer("", self), "direct");
  assert.equal(v.classifyReferrer("blog.yghsite.cn", self), "site");
  assert.equal(v.classifyReferrer("www.google.com", self), "search");
  assert.equal(v.classifyReferrer("cn.bing.com", self), "search");
  assert.equal(v.classifyReferrer("t.co", self), "social");
  assert.equal(v.classifyReferrer("x.com", self), "social");
  assert.equal(v.classifyReferrer("someblog.example", self), "referral");
});

test("来源 host 归一化：去端口、去 www、小写", () => {
  assert.equal(v.normalizeHost("WWW.Google.COM:443"), "google.com");
  assert.equal(v.normalizeHost("  blog.yghsite.cn.  "), "blog.yghsite.cn");
});

/* ------------------------------- 写入与聚合 ------------------------------- */

test("写入：来源只对会话入口归因，后续 PV 记 site", () => {
  const id = seedPost("entry-test");
  db.prepare("DELETE FROM hits").run();

  // 同一个人、带 UA、从 Google 进来
  const ua = "Mozilla/5.0 Chrome/120.0";
  v.recordHit({ path: "/p/" + id, ip: "9.9.9.9", ua, referrer: "https://www.google.com/search?q=秘密" });
  // 紧接着点了另一条（60 秒内 -> 同一会话）
  v.recordHit({ path: "/archives", ip: "9.9.9.9", ua, referrer: "https://www.google.com/search?q=秘密" });

  const rows = db.prepare("SELECT path, is_entry, ref_kind, ref_host FROM hits ORDER BY id").all() as {
    path: string; is_entry: number; ref_kind: string; ref_host: string;
  }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].is_entry, 1, "第一条是会话入口");
  assert.equal(rows[0].ref_kind, "search");
  assert.equal(rows[0].ref_host, "google.com", "只存域名，不存完整 URL");
  assert.ok(!JSON.stringify(rows).includes("秘密"), "绝不能把别人的搜索词存下来");

  assert.equal(rows[1].is_entry, 0, "60 秒内是同一会话，不算新访问");
});

test("写入：30 分钟无活动切新会话", () => {
  db.prepare("DELETE FROM hits").run();
  const id = seedPost("session-test");
  const ua = "Mozilla/5.0 Firefox/121.0";

  // 手工插入一条「40 分钟前」的记录（recordHit 用 now，无法伪造时间）
  const old = new Date(Date.now() - 40 * 60000).toISOString();
  db.prepare(
    "INSERT INTO hits (path, post_id, visitor, is_entry, ref_host, ref_kind, day, created_at) " +
    "VALUES (?, ?, ?, 1, '', 'direct', ?, ?)"
  ).run("/p/" + id, id, v.visitorId("8.8.8.8", ua), timeMod.dateKeyIn(old), old);

  v.recordHit({ path: "/p/" + id, ip: "8.8.8.8", ua });
  const last = db.prepare("SELECT is_entry FROM hits ORDER BY id DESC LIMIT 1").get() as { is_entry: number };
  assert.equal(last.is_entry, 1, "超过 30 分钟应算新的一次访问");

  // 再立刻来一次 -> 同会话
  v.recordHit({ path: "/p/" + id, ip: "8.8.8.8", ua });
  const last2 = db.prepare("SELECT is_entry FROM hits ORDER BY id DESC LIMIT 1").get() as { is_entry: number };
  assert.equal(last2.is_entry, 0);
});

test("写入：path -> post_id，且 /p/<id> 与旧 slug 指向同一篇", () => {
  db.prepare("DELETE FROM hits").run();
  const id = seedPost("中文-slug");

  v.recordHit({ path: "/p/" + id, ip: "7.7.7.7", ua: "Mozilla/5.0 Chrome/120.0" });
  v.recordHit({ path: "/中文-slug", ip: "7.7.7.7", ua: "Mozilla/5.0 Chrome/120.0" });

  const rows = db.prepare("SELECT post_id FROM hits ORDER BY id").all() as { post_id: number }[];
  assert.equal(rows[0].post_id, id, "编号地址能解析出文章");
  assert.equal(rows[1].post_id, id, "旧 slug 地址也能解析出同一篇");
});

test("写入：草稿/回收站的 id 不会被记录成文章", () => {
  db.prepare("DELETE FROM hits").run();
  const now = timeMod.nowIso();
  const info = db.prepare(
    "INSERT INTO posts (type, slug, title, content, status, created_at, updated_at) " +
    "VALUES ('post', 'draft-one', '草稿', 'x', 'draft', ?, ?)"
  ).run(now, now);
  const draftId = Number(info.lastInsertRowid);

  v.recordHit({ path: "/p/" + draftId, ip: "6.6.6.6", ua: "Mozilla/5.0 Chrome/120.0" });
  const row = db.prepare("SELECT post_id FROM hits ORDER BY id DESC LIMIT 1").get() as { post_id: number | null };
  assert.equal(row.post_id, null, "草稿不可被统计归到文章上");
});

test("聚合：PV / UV / 访问次数三个指标口径互不混淆", () => {
  db.prepare("DELETE FROM hits").run();
  const id = seedPost("agg-test");
  const ua = "Mozilla/5.0 Chrome/120.0";

  // 访客 A 看 3 页（同一会话）
  v.recordHit({ path: "/p/" + id, ip: "1.1.1.1", ua });
  v.recordHit({ path: "/archives", ip: "1.1.1.1", ua });
  v.recordHit({ path: "/about", ip: "1.1.1.1", ua });
  // 访客 B 看 1 页
  v.recordHit({ path: "/p/" + id, ip: "2.2.2.2", ua });

  const s = v.getSummary("all");
  assert.equal(s.pv, 4, "PV = 4 次浏览");
  assert.equal(s.uv, 2, "UV = 2 个人");
  assert.equal(s.visits, 2, "访问次数 = 2 次会话（不是 4）");
});

test("聚合：浏览量按 post_id 累加，换 slug 也不拆", () => {
  db.prepare("DELETE FROM hits").run();
  const id = seedPost("before-rename");

  v.recordHit({ path: "/before-rename", ip: "3.3.3.3", ua: "Mozilla/5.0 Chrome/120.0" });
  // 模拟改名：slug 变了，但 id 没变
  db.prepare("UPDATE posts SET slug = 'after-rename' WHERE id = ?").run(id);
  v.recordHit({ path: "/p/" + id, ip: "3.3.3.3", ua: "Mozilla/5.0 Chrome/120.0" });

  assert.equal(v.getPageViews("/after-rename", id), 2, "按 id 聚合，改名不丢历史");
  assert.equal(v.getViewsMap().get(id), 2);
});

test("聚合：Top 页面与 Top 来源不把同一会话的每个 PV 都算成外部来源", () => {
  db.prepare("DELETE FROM hits").run();
  const id = seedPost("source-test");
  const ua = "Mozilla/5.0 Chrome/120.0";

  v.recordHit({ path: "/p/" + id, ip: "4.4.4.4", ua, referrer: "https://www.google.com/" });
  v.recordHit({ path: "/archives", ip: "4.4.4.4", ua, referrer: "https://www.google.com/" });

  const sources = v.getTopSources(10, "all");
  assert.equal(sources.length, 1, "一次访问只有一个来源");
  assert.equal(sources[0].kind, "search");
  assert.equal(sources[0].hits, 1, "只计会话入口那一条");
});

test("日序列：缺失日期补 0，长度固定", () => {
  db.prepare("DELETE FROM hits").run();
  const id = seedPost("series-test");
  v.recordHit({ path: "/p/" + id, ip: "5.5.5.5", ua: "Mozilla/5.0 Chrome/120.0" });

  const series = v.getDailySeries(14);
  assert.equal(series.length, 14, "14 天，缺的天补 0");
  assert.equal(series[13].pv, 1, "最后一天是今天");
  assert.equal(series[0].pv, 0, "最早那天没有数据 -> 0 而不是空");
});

/* ------------------------------- 历史基线 ------------------------------- */

test("基线：只加在 PV 上，不污染 UV / 访问次数 / 来源", () => {
  db.prepare("DELETE FROM hits").run();
  const id = seedPost("baseline-test");
  const ua = "Mozilla/5.0 Chrome/120.0";

  // 键必须用字符串拼接（与迁移 0013 一致）。若用 SQL 的 `|| ?` 拼数字，
  // SQLite 可能渲染成 "1.0"，键对不上 -> 基线静默变 0，且不报错。
  db.prepare("INSERT INTO settings (key, value) VALUES (?, '77') ON CONFLICT(key) DO UPDATE SET value = '77'")
    .run("stats:baseline:post:" + id);

  v.recordHit({ path: "/p/" + id, ip: "6.6.6.6", ua });

  assert.equal(v.getPageViews("/p/" + id, id), 78, "本地 1 + 历史 77");
  const s = v.getSummary("all");
  assert.equal(s.uv, 1, "基线不制造一个假访客");
  assert.equal(s.visits, 1, "基线不制造一次假访问");
  assert.equal(v.getTopSources(10, "all")[0].hits, 1, "基线不出现在来源里");
});

test("基线只加在「全部」区间：选「今天」不该看到历史总量", () => {
  /**
   * 回归测试。第一版把基线**无条件**加进 getSummary，
   * 于是选「今天」也显示 1081 —— 那个数字显然不是今天的访问量。
   * 基线描述的是「过去累计多少」，只属于「全部」这一个区间。
   */
  db.prepare("DELETE FROM hits").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('stats:baseline:total', '1000') " +
    "ON CONFLICT(key) DO UPDATE SET value = '1000'").run();

  const id = seedPost("range-test");
  v.recordHit({ path: "/p/" + id, ip: "7.7.7.7", ua: "Mozilla/5.0 Chrome/120.0" });

  assert.equal(v.getSummary("all").pv, 1001, "全部 = 实时 1 + 历史 1000");
  assert.equal(v.getSummary("today").pv, 1, "今天只有今天真实发生的 1 次，不带历史");
  assert.equal(v.getSummary("7d").pv, 1, "7 天同理");
  assert.equal(v.getSummary("30d").pv, 1, "30 天同理");

  db.prepare("DELETE FROM settings WHERE key = 'stats:baseline:total'").run();
});

test("cleanup", () => {
  dbMod.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});
