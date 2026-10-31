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

/* ══════════════════════════════════════════════════════════════════
   A-2：hits.day 读写口径统一

   背景：day 是**字符串**列，区间查询靠 `WHERE day >= ?` 做字典序比较。
   因此写入侧必须是补零的 YYYY-MM-DD，否则：
     - 1–9 月的 "2026-8-5" 在字典序上大于 "2026-10-31" → 任何区间都误命中
     - getDailySeries 用 dateKeyIn 生成 key 去 Map.get(DB 原值) → 永不相等

   A-2 只负责**格式与口径**；旧格式历史行的清洗是 A-3 的迁移，本文件
   不假定历史数据已归一化（混合格式共存时这些断言仍应成立）。

   测试策略：只走公开函数（recordHit / getSummary / getDailySeries），
   不导出 whereFor / rangeStart 之类的内部函数。
   ══════════════════════════════════════════════════════════════════ */

const PADDED_DAY = /^\d{4}-\d{2}-\d{2}$/;

function clearHits() {
  db.prepare("DELETE FROM hits").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'stats:baseline:%'").run();
}

/** 按「N 天前（展示时区）」构造补零日期键，避免依赖测试当天的月份 */
function dayKeyDaysAgo(n: number): string {
  return timeMod.isoDateIn(new Date(Date.now() - n * 86400000).toISOString(), timeMod.DISPLAY_TZ);
}

test("A-2 实时写入：recordHit 的 day 是补零 YYYY-MM-DD", () => {
  clearHits();
  const id = seedPost("a2-write");
  const r = v.recordHit({ path: "/p/" + id, ip: "1.1.1.1", ua: "Mozilla/5.0 Chrome/120.0" });
  assert.equal(r.ok, true);

  const row = db.prepare("SELECT day, created_at FROM hits ORDER BY id DESC LIMIT 1").get() as
    { day: string; created_at: string };
  assert.match(row.day, PADDED_DAY, "day 必须是补零 YYYY-MM-DD，实际：" + row.day);
  // 与展示时区下的「今天」完全一致（同一天，不是差一天）
  assert.equal(row.day, timeMod.isoDateIn(row.created_at, timeMod.DISPLAY_TZ));
});

test("A-2 日序列 key：getDailySeries 返回的每个 day 都是补零 YYYY-MM-DD", () => {
  clearHits();
  const series = v.getDailySeries(30);
  assert.equal(series.length, 30);
  for (const p of series) {
    assert.match(p.day, PADDED_DAY, "日序列 key 必须补零：" + p.day);
  }
  // 最后一天是今天，且与写入侧同一口径
  assert.equal(series[29].day, dayKeyDaysAgo(0));
});

test("A-2 日序列匹配：今天写入的记录能被 getDailySeries 命中（key 与 DB 同格式）", () => {
  clearHits();
  const id = seedPost("a2-series-match");
  v.recordHit({ path: "/p/" + id, ip: "2.2.2.2", ua: "Mozilla/5.0 Chrome/120.0" });

  const series = v.getDailySeries(7);
  const today = series[series.length - 1];
  assert.equal(today.day, dayKeyDaysAgo(0));
  assert.equal(today.pv, 1, "今天的记录必须出现在今天的柱子上（key 匹配）");
});

test("A-2 区间边界：60 天前的记录不进 today / 7d，但进 all", () => {
  clearHits();
  const oldDay = dayKeyDaysAgo(60);
  const oldIso = new Date(Date.now() - 60 * 86400000).toISOString();
  db.prepare(
    "INSERT INTO hits (path, visitor, is_entry, ref_host, ref_kind, day, created_at) " +
    "VALUES (?, ?, 1, '', 'direct', ?, ?)"
  ).run("/a2-old", "visitor-old", oldDay, oldIso);

  const id = seedPost("a2-boundary");
  v.recordHit({ path: "/p/" + id, ip: "3.3.3.3", ua: "Mozilla/5.0 Chrome/120.0" });

  assert.equal(v.getSummary("today").pvLocal, 1, "today 只含今天");
  assert.equal(v.getSummary("7d").pvLocal, 1, "7d 只含最近 7 天");
  assert.equal(v.getSummary("30d").pvLocal, 1, "30d 不含 60 天前");
  assert.equal(v.getSummary("all").pvLocal, 2, "all 含全部");
});

test("A-2 区间边界：恰好 7 天前（第 7 天）仍属于 7d", () => {
  clearHits();
  // 7d = 今天 + 前 6 天；第 7 天前应被排除，第 6 天前应被包含
  for (const n of [6, 7]) {
    db.prepare(
      "INSERT INTO hits (path, visitor, is_entry, ref_host, ref_kind, day, created_at) " +
      "VALUES (?, ?, 1, '', 'direct', ?, ?)"
    ).run("/a2-d" + n, "visitor-d" + n, dayKeyDaysAgo(n), new Date(Date.now() - n * 86400000).toISOString());
  }
  assert.equal(v.getSummary("7d").pvLocal, 1, "7d 应只含第 6 天前那一条");
  assert.equal(v.getSummary("all").pvLocal, 2);
});

test("A-2 混合历史格式：旧的不补零行原样保留，不会被 A-2 洗成新格式", () => {
  clearHits();
  // 模拟 A-3 之前的历史数据形态
  db.prepare(
    "INSERT INTO hits (path, visitor, is_entry, ref_host, ref_kind, day, created_at) " +
    "VALUES (?, ?, 1, '', 'direct', ?, ?)"
  ).run("/a2-legacy", "visitor-legacy", "2026-8-5", "2026-08-05T02:00:00.000Z");

  const legacy = db.prepare("SELECT day FROM hits WHERE path = '/a2-legacy'").get() as { day: string };
  assert.equal(legacy.day, "2026-8-5", "A-2 不做数据迁移，旧格式必须原样保留（清洗是 A-3 的职责）");

  // 同时写入一条新数据：新数据必须是补零形态，两种格式可以共存
  const id = seedPost("a2-mixed");
  v.recordHit({ path: "/p/" + id, ip: "4.4.4.4", ua: "Mozilla/5.0 Chrome/120.0" });
  const fresh = db.prepare("SELECT day FROM hits WHERE path = ?").get("/p/" + id) as { day: string };
  assert.match(fresh.day, PADDED_DAY, "新写入必须是补零形态");
  assert.notEqual(fresh.day, "2026-8-5");
});

test("A-2 导入脚本：Umami 事件按展示时区切日，且补零（与 recordHit 同口径）", async () => {
  clearHits();
  const { spawnSync } = await import("node:child_process");

  // 事件时间 2026-09-30T18:00Z = 上海 2026-10-01 02:00
  // 若按 UTC 粗暴 slice(0,10) 会得到 "2026-09-30" —— 差一天
  const tsv = path.join(TMP, "umami-a2.tsv");
  fs.writeFileSync(
    tsv,
    "evt-a2-1\t2026-09-30T18:00:00.000Z\t/a2-import\t\t sess-a2\tvisit-a2\n",
    "utf8"
  );

  const res = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "import-umami-events.mjs"), tsv], {
    env: { ...process.env, DATA_DIR: TMP, DRY_RUN: "1" },
    encoding: "utf8",
  });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.equal(res.status, 0, "导入脚本应正常退出：" + out);
  assert.match(out, /2026-10-01=1/, "应按展示时区切到 10-01，而不是 UTC 的 09-30：" + out);
  assert.doesNotMatch(out, /2026-09-30=1/, "不得按 UTC 切日");
});

test("A-2 导入脚本与 lib/time.ts 的日期口径逐字等价（交叉断言，防两边漂移）", async () => {
  /**
   * 导入脚本**故意不 import lib/time.ts**：scripts 会被原样拷进 dist，
   * 而 dist 里没有 lib/（scripts/package-standalone.mjs:86-91），
   * 引用它会让运维脚本在生产上 ERR_MODULE_NOT_FOUND（init-db.mjs 已踩过）。
   * 代价是两份实现，所以这里用一组边界时刻逐条比对，只要漂移就红。
   */
  const { spawnSync } = await import("node:child_process");

  // 覆盖：普通白天、东八区凌晨（跨日）、月末跨月、年末跨年、闰日
  const cases = [
    ["2026-03-15T04:00:00.000Z", "2026-03-15"], // 上海 12:00 同日
    ["2026-09-30T18:00:00.000Z", "2026-10-01"], // 上海次日凌晨 → 必须跨到 10-01
    ["2026-12-31T20:00:00.000Z", "2027-01-01"], // 跨年
    ["2026-01-31T17:00:00.000Z", "2026-02-01"], // 跨月
    ["2024-02-29T10:00:00.000Z", "2024-02-29"], // 闰日
    ["2026-08-05T02:00:00.000Z", "2026-08-05"], // 1–9 月：两位补零
  ];

  // 把边界时刻喂给真实脚本（dry-run），从它打印的「按天」里读回判断
  const tsv = path.join(TMP, "umami-cross.tsv");
  fs.writeFileSync(
    tsv,
    cases.map(([iso], i) => `evt-x-${i}\t${iso}\t/a2-cross-${i}\t\ts${i}\tv${i}`).join("\n") + "\n",
    "utf8"
  );
  const res = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "import-umami-events.mjs"), tsv], {
    env: { ...process.env, DATA_DIR: TMP, DRY_RUN: "1" },
    encoding: "utf8",
  });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.equal(res.status, 0, "脚本应正常退出：" + out);

  for (const [iso, expected] of cases) {
    const fromLib = timeMod.isoDateIn(iso, timeMod.DISPLAY_TZ);
    assert.equal(fromLib, expected, "lib/time.ts 的 isoDateIn 结果应符合预期：" + iso);
    assert.ok(
      out.includes(expected + "="),
      `导入脚本应输出 ${expected}=…（与 isoDateIn 一致），实际输出：` + out
    );
  }
});

/* ══════════════════════════════════════════════════════════════════
   A-3 读取侧日期形状守卫

   `hits.day` 是 TEXT 列，区间查询靠字典序比较。A-2 保证**新写入**是补零
   格式，但 A-3 迁移只能修「形状可判定 + 日历合法」的历史行；剩下的脏行
   必须被读取侧挡住，否则会污染 today / 7d / 30d 与 all。

   守卫的边界（实测，别高估）：
     - 能挡：未补零（2026-8-5）、垃圾串、空串、纯空格
     - 也挡：非法日历日（2026-02-30）、越界月（2026-13-01）—— 靠 date(day) IS day
     - 不挡：格式与日历都合法的日期（这是正确行为）
   ══════════════════════════════════════════════════════════════════ */

/** 直接塞一行 hits（绕过 recordHit，模拟历史脏数据） */
function insertRawHit(day: string, createdAt: string, path: string): number {
  const info = db.prepare(
    "INSERT INTO hits (path, visitor, is_entry, ref_host, ref_kind, day, created_at) " +
    "VALUES (?, ?, 1, '', 'direct', ?, ?)"
  ).run(path, "visitor-" + path, day, createdAt);
  return Number(info.lastInsertRowid);
}

/** 合法的「今天」补零键，供构造对照组 */
function todayKey(): string {
  return timeMod.isoDateIn(new Date().toISOString(), timeMod.DISPLAY_TZ);
}

test("A-3 守卫：非法日期不进入 today / 7d / 30d / all 的任何统计", () => {
  db.prepare("DELETE FROM hits").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'stats:baseline:%'").run();

  const today = todayKey();
  const id = seedPost("a3-guard");
  v.recordHit({ path: "/p/" + id, ip: "9.9.9.9", ua: "Mozilla/5.0 Chrome/120.0" });

  // 全都不合法：未补零、垃圾串、空串、纯空格、非法日历日、越界月
  insertRawHit("2026-8-5", "2026-08-05T02:00:00.000Z", "/a3-bad-1");
  insertRawHit("bogus", "2026-08-05T02:00:00.000Z", "/a3-bad-2");
  insertRawHit("", "2026-08-05T02:00:00.000Z", "/a3-bad-3");
  insertRawHit("  ", "2026-08-05T02:00:00.000Z", "/a3-bad-4");
  insertRawHit("2026-02-30", "2026-02-28T02:00:00.000Z", "/a3-bad-5");
  insertRawHit("2026-13-01", "2026-07-01T02:00:00.000Z", "/a3-bad-6");

  // 正常 PV 必须仍然只有 1（只有 recordHit 那条合法）
  assert.equal(v.getSummary("today").pvLocal, 1, "today 只含合法今日记录");
  assert.equal(v.getSummary("7d").pvLocal, 1, "7d 只含合法记录");
  assert.equal(v.getSummary("30d").pvLocal, 1, "30d 只含合法记录");

  // all：脏行不得被计入。它们的时间跨度从 2026-02 到 2026-08，
  // 无论如何都不该出现在「全部」里 —— 因为「全部」= 所有**合法**事件
  const all = v.getSummary("all");
  assert.equal(all.pvLocal, 1, "all 不得被脏日期污染，实际 pvLocal=" + all.pvLocal);
  assert.equal(all.uv, 1, "all 的 UV 也不得被脏行污染");
  assert.equal(all.visits, 1, "all 的访问次数同样");

  // 行本身还在（只读守卫，不删数据）
  assert.equal((db.prepare("SELECT COUNT(*) c FROM hits").get() as any).c, 7, "脏行必须仍在表里");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM hits WHERE path LIKE '/a3-bad-%'").get() as any).c, 6);
});

test("A-3 守卫：getDailySeries 不产生非法日期 key，也不把脏行算进柱子里", () => {
  db.prepare("DELETE FROM hits").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'stats:baseline:%'").run();

  const id = seedPost("a3-series");
  v.recordHit({ path: "/p/" + id, ip: "10.10.10.10", ua: "Mozilla/5.0 Chrome/120.0" });
  insertRawHit("2026-8-5", "2026-08-05T02:00:00.000Z", "/a3-bad-series-1");
  insertRawHit("bogus", "2026-08-05T02:00:00.000Z", "/a3-bad-series-2");

  const series = v.getDailySeries(30);
  for (const p of series) {
    assert.match(p.day, /^\d{4}-\d{2}-\d{2}$/, "日序列 key 必须合法：" + p.day);
  }
  const totalPv = series.reduce((n, p) => n + p.pv, 0);
  assert.equal(totalPv, 1, "30 天窗口内只有 1 条合法记录，实际 " + totalPv);
});

test("A-3 守卫：合法日期（含补零与已合规）的统计结果完全不变", () => {
  db.prepare("DELETE FROM hits").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'stats:baseline:%'").run();

  const today = todayKey();
  // 三条合法的今天记录，全部补零形态
  for (let i = 0; i < 3; i++) {
    insertRawHit(today, new Date().toISOString(), "/a3-ok-" + i);
  }

  assert.equal(v.getSummary("today").pvLocal, 3, "合法记录全部计入");
  assert.equal(v.getSummary("7d").pvLocal, 3);
  assert.equal(v.getSummary("30d").pvLocal, 3);
  assert.equal(v.getSummary("all").pvLocal, 3);

  const series = v.getDailySeries(7);
  assert.equal(series[series.length - 1].pv, 3, "今天的柱子应有 3 条");
  assert.equal(series[series.length - 1].day, today, "柱子 key 是今天的补零日期");
});

test("A-3 守卫：边界日期（闰日 2024-02-29 合法、2026-02-29 非法）", () => {
  db.prepare("DELETE FROM hits").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'stats:baseline:%'").run();
  // 两条都放在 30 天窗口外，只测 all 与窗口逻辑的差异
  insertRawHit("2024-02-29", "2024-02-29T02:00:00.000Z", "/a3-leap-ok");   // 合法闰日
  insertRawHit("2026-02-29", "2026-02-28T02:00:00.000Z", "/a3-leap-bad");  // 非闰年

  const all = v.getSummary("all");
  assert.equal(all.pvLocal, 1, "只有 2024-02-29 合法，另一条必须被挡住");
});

test("cleanup", () => {
  dbMod.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});
