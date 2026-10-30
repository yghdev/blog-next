import { getDb } from "./db";
import { hmac, hashToken } from "./crypto";
import { dateKeyIn, DISPLAY_TZ, nowIso } from "./time";
import { getRawSetting } from "./settings";

/**
 * 自建访客统计（2026-10-30）。
 *
 * 设计只有一句话：**只存事件，所有指标查询时聚合**。
 *
 * 对比原来的 Umami 方案：那边把「近 365 天 PV」算好后写进 settings 的 KV，
 * 于是没有时间维度、算不了 UV、做不了来源归因，而且站龄满一年后
 * 那个数字会开始往下掉（窗口在滚动，标签却叫「访问」）。
 *
 * 这里的三条硬约束：
 *   1) **不存 IP**。IP 只在内存里参与一次 HMAC，落库的是一段不可逆的摘要。
 *   2) **不种追踪 Cookie**。身份从请求头算，客户端只上报「看了哪个路径」。
 *   3) **统计失败绝不影响页面**。写入异常一律吞掉，接口永远 204。
 */

/* ------------------------------------------------------------------ *
 * 路径归一化
 * ------------------------------------------------------------------ */

/**
 * 把任意来源的路径归一成**同一个 key**。写入与读取必须都过这里。
 *
 * 为什么这不是小题大做：本站 slug 是中文，浏览器给的是百分号编码
 * （`/%E5%8D%9A...`），而数据库里存的是解码后的中文（`/博客迁移记录`）。
 * 两边各自为政的话，单篇浏览量会恒为 0 —— 而且不会有任何报错。
 */
export function normalizePath(input: string): string | null {
  if (typeof input !== "string") return null;
  let p = input.trim();
  if (!p) return null;

  // 允许传完整 URL（客户端可能直接给 location.href）
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }

  // 去掉 query 与 hash
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf("#");
  if (h >= 0) p = p.slice(0, h);

  if (!p.startsWith("/")) p = "/" + p;

  // 百分号编码 -> 中文。失败说明是脏输入（残缺的 %xx），按原样处理而不是丢弃
  try {
    p = decodeURIComponent(p);
  } catch {
    /* 保留原样 */
  }

  // 折叠重复斜杠、去掉尾部斜杠（根路径除外）
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (!p.startsWith("/")) p = "/" + p;

  if (p.length > 200) return null;
  // 后台、接口、静态资源一律不统计（也不允许被写进来）
  if (/^\/(admin|api|_next|preview)(\/|$)/.test(p)) return null;

  return p;
}

/** 该路径是否值得记录（固定路由白名单由写入侧宽松放行，这里只挡明显不该记的） */
export function isTrackablePath(path: string): boolean {
  // 资源文件不该出现在报表里；扩展名判断放在最后，避免 /p/1.5 之类误伤
  if (/\.[a-z0-9]{2,5}$/i.test(path)) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 访客标识
 * ------------------------------------------------------------------ */

let _secret: string | null = null;

/**
 * 统计密钥。首次访问时若迁移没跑到（理论上不会），就地补一个。
 * 进程内缓存：这是每个请求都要用的值，不能每次都查库。
 */
function statsSecret(): string {
  if (_secret) return _secret;
  const existing = getRawSetting("stats:secret");
  if (existing) {
    _secret = existing;
    return existing;
  }
  const db = getDb();
  const fresh = hmac("seed", nowIso() + Math.random()).slice(0, 64);
  db.prepare("INSERT INTO settings (key, value) VALUES ('stats:secret', ?) ON CONFLICT(key) DO NOTHING").run(fresh);
  _secret = getRawSetting("stats:secret") ?? fresh;
  return _secret;
}

/**
 * UA 归一化：**抹掉所有版本号**。
 *
 * 这不是洁癖。Chrome 每 4 周升一个大版本，UA 里会带上 `Chrome/120.0.6099.71`。
 * 若把原始 UA 喂进哈希，同一个读者升级完浏览器就变成「新访客」——
 * 时间一长 UV 会明显高于 PV 的合理比例，而没有任何一处报错。
 *
 * 抹掉版本号后，Chrome 120 -> 121 仍然是同一个 `chrome/`。
 * 代价是分不清「同一台机器换了浏览器内核」，但那本来也不是我们要的。
 */
export function uaFamily(ua: string): string {
  return (ua || "")
    .toLowerCase()
    .replace(/\d+(?:\.\d+)*/g, "")   // 去掉 120.0.6099.71 这类版本号
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * 访客标识：HMAC(密钥, IP|UA家族) 的前 16 位。
 *
 * 为什么必须是 HMAC 而不是裸 SHA-256：IPv4 只有 2^32 种取值，
 * UA 家族空间也很小，裸哈希几分钟就能被穷举反查成真实 IP 列表。
 */
export function visitorId(ip: string, ua: string): string {
  return hmac(statsSecret(), ip + "|" + uaFamily(ua)).slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * 来源归因
 * ------------------------------------------------------------------ */

export type RefKind = "direct" | "site" | "search" | "social" | "referral";

/** 搜索引擎域名（含常见分站，按后缀匹配） */
const SEARCH_HOSTS = [
  "google.", "bing.com", "baidu.com", "duckduckgo.com", "yandex.", "sogou.com",
  "so.com", "sm.cn", "ecosia.org", "startpage.com", "search.brave.com",
  "chatgpt.com", "chat.openai.com", "perplexity.ai", "gemini.google.com",
];
/** 社交 / 社区 */
const SOCIAL_HOSTS = [
  "x.com", "twitter.com", "t.co", "weibo.com", "weibo.cn", "zhihu.com",
  "v2ex.com", "discord.com", "discord.gg", "t.me", "telegram.me",
  "reddit.com", "hacker news", "news.ycombinator.com", "douban.com",
  "juejin.cn", "csdn.net", "bilibili.com", "youtube.com", "threads.net",
  "mastodon.", "bsky.app", "facebook.com", "instagram.com",
];

/** 去掉端口、`www.`、末尾点，统一小写 —— 让 google.com 与 www.google.com 归一类 */
export function normalizeHost(host: string): string {
  return (host || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "")
    .slice(0, 120);
}

export function classifyReferrer(refHost: string, selfHost: string): RefKind {
  const h = normalizeHost(refHost);
  if (!h) return "direct";
  const self = normalizeHost(selfHost);
  if (self && (h === self || h.endsWith("." + self))) return "site";
  if (SEARCH_HOSTS.some((s) => h === s.replace(/\.$/, "") || h.includes(s))) return "search";
  if (SOCIAL_HOSTS.some((s) => h.includes(s))) return "social";
  return "referral";
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

export type HitInput = {
  path: string;
  ip: string;
  ua: string;
  referrer?: string;
};

/**
 * 记录一次浏览。
 *
 * `is_entry` 用一条 INSERT ... SELECT 原子判定，不做「先查后写」：
 * 两个并发请求之间若插了一次查询，同一次访问会被算成两次。
 */
export function recordHit(input: HitInput): { ok: boolean; reason?: string } {
  const path = normalizePath(input.path);
  if (!path) return { ok: false, reason: "path" };
  if (!isTrackablePath(path)) return { ok: false, reason: "asset" };

  const db = getDb();
  const visitor = visitorId(input.ip, input.ua);
  const now = nowIso();
  const cutoff = new Date(Date.now() - 30 * 60000).toISOString();

  // 解析路径 -> post_id（服务端解析，不信客户端传的 id）
  const post = resolvePostId(path);

  // 来源：只保留 host，绝不存完整 URL
  let refHost = "";
  if (input.referrer) {
    try {
      refHost = normalizeHost(new URL(input.referrer).hostname);
    } catch {
      refHost = "";
    }
  }
  const selfHost = normalizeHost(process.env.SITE_URL || "blog.yghsite.cn");
  const refKind = classifyReferrer(refHost, selfHost);

  db.prepare(
    "INSERT INTO hits (path, post_id, visitor, is_entry, ref_host, ref_kind, day, created_at) " +
    "SELECT ?, ?, ?, CASE WHEN EXISTS (" +
    "  SELECT 1 FROM hits WHERE visitor = ? AND created_at > ?" +
    ") THEN 0 ELSE 1 END, ?, ?, ?, ?"
  ).run(
    path,
    post ?? null,
    visitor,
    visitor,
    cutoff,
    refKind === "site" ? "" : refHost,   // 站内来源不存 host，避免把自家域名堆进报表
    refKind,
    dateKeyIn(now, DISPLAY_TZ),
    now
  );

  return { ok: true };
}

/** 路径 -> posts.id；文章优先按 slug 精确匹配，`/p/<id>` 直接取 id */
export function resolvePostId(path: string): number | null {
  const db = getDb();
  const byId = /^\/p\/(\d+)$/.exec(path);
  if (byId) {
    // 必须要求 published：`/p/<id>` 是自增编号、可枚举，
    // 草稿与回收站的内容外部根本打不开 —— 给它们记浏览量既没意义，
    // 也会在文章发布后凭空多出一段「上线前的浏览」。
    const row = db.prepare(
      "SELECT id FROM posts WHERE id = ? AND status = 'published' AND deleted_at IS NULL"
    ).get(Number(byId[1])) as { id: number } | undefined;
    return row ? row.id : null;
  }
  const slug = path.slice(1);
  if (!slug) return null;
  const row = db.prepare(
    "SELECT id FROM posts WHERE slug = ? AND status = 'published' AND deleted_at IS NULL " +
    "ORDER BY (type = 'post') DESC LIMIT 1"
  ).get(slug) as { id: number } | undefined;
  if (row) return row.id;
  const alias = db.prepare(
    "SELECT p.id AS id FROM post_aliases a JOIN posts p ON p.id = a.post_id " +
    "WHERE a.slug = ? AND p.status = 'published' AND p.deleted_at IS NULL LIMIT 1"
  ).get(slug) as { id: number } | undefined;
  return alias ? alias.id : null;
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

export type Range = "today" | "7d" | "30d" | "all";

export const RANGE_LABEL: Record<Range, string> = {
  today: "今天",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
  all: "全部",
};

export function parseRange(v: unknown): Range {
  return v === "today" || v === "7d" || v === "30d" || v === "all" ? v : "7d";
}

/** 起始日（含）。null = 不限 */
function rangeStart(range: Range): string | null {
  const now = new Date();
  const days = range === "today" ? 0 : range === "7d" ? 6 : range === "30d" ? 29 : -1;
  if (days < 0) return null;
  const from = new Date(now.getTime() - days * 86400000);
  return dateKeyIn(from.toISOString(), DISPLAY_TZ);
}

function whereFor(range: Range): { sql: string; args: unknown[] } {
  const start = rangeStart(range);
  if (!start) return { sql: "", args: [] };
  return { sql: " WHERE day >= ?", args: [start] };
}

export type Summary = {
  pv: number;        // 访问总量（含历史基线）
  pvLocal: number;   // 本系统上线后记录的 PV
  uv: number;        // 访客总量（去重）
  visits: number;    // 访问次数（会话数）
};

function baselineTotal(): number {
  const raw = getRawSetting("stats:baseline:total");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function getSummary(range: Range): Summary {
  const db = getDb();
  const w = whereFor(range);
  const row = db.prepare(
    "SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv, " +
    "COALESCE(SUM(is_entry), 0) AS visits FROM hits" + w.sql
  ).get(...w.args) as { pv: number; uv: number; visits: number };

  return {
    // 基线只加在「访问总量」这一个维度上：它是唯一有历史数据的指标。
    // UV / 访问次数 / 来源都没有历史可补，硬加会凭空造出一个不存在的访客。
    pv: row.pv + baselineTotal(),
    pvLocal: row.pv,
    uv: row.uv,
    visits: row.visits,
  };
}

export type DayPoint = { day: string; pv: number; uv: number };

/** 最近 N 天（含今天）的每日 PV/UV，缺失日期补 0 —— 图表不能有空洞 */
export function getDailySeries(days = 14): DayPoint[] {
  const db = getDb();
  const start = dateKeyIn(new Date(Date.now() - (days - 1) * 86400000).toISOString(), DISPLAY_TZ);
  const rows = db.prepare(
    "SELECT day, COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv FROM hits " +
    "WHERE day >= ? GROUP BY day"
  ).all(start) as { day: string; pv: number; uv: number }[];

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKeyIn(new Date(Date.now() - i * 86400000).toISOString(), DISPLAY_TZ);
    const hit = byDay.get(key);
    out.push({ day: key, pv: hit?.pv ?? 0, uv: hit?.uv ?? 0 });
  }
  return out;
}

export type TopPage = { path: string; postId: number | null; title: string | null; views: number };

/** 页面 Top：文章优先显示标题，其他路径显示路径本身 */
export function getTopPages(limit = 10, range: Range = "7d"): TopPage[] {
  const db = getDb();
  const w = whereFor(range);
  const rows = db.prepare(
    "SELECT COALESCE('/p/' || post_id, path) AS key, MAX(post_id) AS post_id, COUNT(*) AS c " +
    "FROM hits" + w.sql + " GROUP BY key ORDER BY c DESC LIMIT ?"
  ).all(...w.args, limit) as { key: string; post_id: number | null; c: number }[];

  const titleStmt = db.prepare("SELECT title FROM posts WHERE id = ?");
  return rows.map((r) => ({
    path: r.key,
    postId: r.post_id,
    title: r.post_id ? ((titleStmt.get(r.post_id) as { title: string } | undefined)?.title ?? null) : null,
    views: r.c,
  }));
}

export type SourceRow = { kind: RefKind; host: string; hits: number };

/** 来源 Top：**只看会话入口**（is_entry=1），否则一次进来的访问会把后续每个 PV 都算成同一来源 */
export function getTopSources(limit = 8, range: Range = "7d"): SourceRow[] {
  const db = getDb();
  const w = whereFor(range);
  const clause = (w.sql ? w.sql + " AND" : " WHERE") + " is_entry = 1";
  const rows = db.prepare(
    "SELECT ref_kind AS kind, ref_host AS host, COUNT(*) AS hits FROM hits" + clause +
    " GROUP BY ref_kind, ref_host ORDER BY hits DESC LIMIT ?"
  ).all(...w.args, limit) as SourceRow[];
  return rows;
}

/* ---------------- 单篇 / 全站浏览量（前台读这两个） ---------------- */

/**
 * 单篇浏览量 = 本系统记录的 + 上线前的历史基线。
 *
 * postId 优先：slug 会改（有 post_aliases 兜着），id 不会。
 * 传 path 是为了页面类内容（/about 这种没有稳定 id 语义的场景）也能统计。
 */
export function getPageViews(path: string, postId?: number | null): number | null {
  const db = getDb();
  let local = 0;

  if (postId) {
    local = (db.prepare("SELECT COUNT(*) AS c FROM hits WHERE post_id = ?").get(postId) as { c: number }).c;
  } else {
    const p = normalizePath(path);
    if (!p) return null;
    local = (db.prepare("SELECT COUNT(*) AS c FROM hits WHERE path = ?").get(p) as { c: number }).c;
  }

  const base = baselineFor(postId, path);
  const total = local + base;
  // 一条都没有时返回 null，让页面不渲染「0 次浏览」——「没有数据」和「真的没人看」不是一回事
  if (total === 0) {
    // 除非历史上明确记过 0，否则 null
    return null;
  }
  return total;
}

/**
 * 历史基线（上线前 Umami 的累计 PV）。
 *
 * 注意键统一用**字符串拼接**生成（迁移里就是这么写的）：
 * 若改用 SQL 的 `'prefix' || ?` 拼数字，SQLite 可能把 1 渲染成 "1.0"，
 * 键就对不上了 —— 那种错误不会报错，只会让基线静默变成 0。
 */
function baselineFor(postId: number | null | undefined, path: string): number {
  if (postId) {
    const raw = getRawSetting("stats:baseline:post:" + postId);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  const p = normalizePath(path);
  if (!p) return 0;
  const raw = getRawSetting("stats:baseline:path:" + p);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * 首页/列表页批量取浏览量：**按 post_id 返回**，一次查询取全量。
 *
 * 为什么 key 改成 id 而不是路径：路径有编码问题（中文 slug 的两种形态），
 * id 没有。列表页本来就拿着 Post 对象，取 id 是一行代码的事。
 */
export function getViewsMap(): Map<number, number> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT post_id, COUNT(*) AS c FROM hits WHERE post_id IS NOT NULL GROUP BY post_id"
  ).all() as { post_id: number; c: number }[];

  const map = new Map<number, number>();
  for (const r of rows) map.set(r.post_id, r.c);

  // 叠加历史基线
  const baselines = db.prepare(
    "SELECT key, value FROM settings WHERE key LIKE 'stats:baseline:post:%'"
  ).all() as { key: string; value: string }[];
  for (const b of baselines) {
    const id = Number(b.key.slice("stats:baseline:post:".length));
    const n = Number(b.value);
    if (!Number.isFinite(id) || !Number.isFinite(n)) continue;
    map.set(id, (map.get(id) ?? 0) + Math.trunc(n));
  }
  return map;
}

/** 测试用：清空进程内缓存的密钥（切换 DATA_DIR 时必须调） */
export function resetStatsCache(): void {
  _secret = null;
}

export { hashToken };
