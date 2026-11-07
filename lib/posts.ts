import { getDb, type Post } from "./db";
import { dateKeyIn, monthKeyIn, toUtcIso, yearKeyIn } from "./time";

/** Next.js 传入的 params 是未解码的百分号编码，这里统一解码 */
export function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/**
 * 文章/页面的规范地址（2026-10-30 起）。
 *
 * 为什么不再用 slug 当 URL：
 *   本站 slug 是中文，浏览器里会变成 `/%E5%8D%9A%E5%AE%A2%E8%BF%81...` ——
 *   粘贴分享时又长又难读，且「编码态」与「解码态」两种形态在全站并存，
 *   统计、缓存、比对都要各自处理一遍。
 *
 * 现在文章统一走 `/p/<id>`：
 *   - 纯 ASCII，短，不会因为编码产生第二种形态
 *   - id 是主键，改标题/改 slug 都不会断链，也不需要查别名表
 *   - `comments` 的 pageKey 仍然用旧 slug（`/博客迁移记录`），历史评论不丢
 *
 * 页面（type=page）**保留语义化路径**（/about 这种）：它们的地址本身有含义，
 * 且不像文章那样频繁新增，没有必要编号化。
 */
export function postHref(post: { id: number; type?: string; slug: string }): string {
  if (post.type === "page") return "/" + encodeURIComponent(post.slug);
  return "/p/" + post.id;
}

/** 旧地址（/中文slug）的编码形态。目前只有 RSS 的 guid 需要它 —— 见 app/rss.xml/route.ts */
export function legacySlugPath(post: { slug: string }): string {
  return "/" + encodeURIComponent(post.slug);
}

/** Next 16 的 revalidateTag 需要第二个 profile 参数 */
export const REVALIDATE_PROFILE = "max";

/** 缓存标签：后台保存后按 tag 精准失效（方案 C12） */
export const TAGS = {
  posts: "posts",
  post: (id: number | string) => "post:" + id,
  comments: "comments",
  stats: "site-stats",
} as const;

/** 只取未删除的 */
const ALIVE = "deleted_at IS NULL";

export function listPosts(opts: { limit?: number; offset?: number } = {}): Post[] {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  return db.prepare(
    "SELECT * FROM posts WHERE type = 'post' AND status = 'published' AND " + ALIVE +
    " ORDER BY published_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as Post[];
}

export function countPosts(): number {
  const db = getDb();
  return (db.prepare("SELECT COUNT(*) c FROM posts WHERE type = 'post' AND status = 'published' AND " + ALIVE).get() as { c: number }).c;
}

/**
 * 按 slug 查文章；未命中则查别名（返回 `redirectTo` + 目标文章），由页面 308。
 * 同时要求 status='published' —— 草稿不可被外部访问。
 *
 * `redirectTo` 现在是**目标文章对象**而不是 slug 字符串：
 * 文章规范地址已改成 `/p/<id>`，只拿 slug 无法拼出规范地址
 * （页面类内容仍走 slug，两条规则不同，必须由 postHref 决定）。
 */
export function resolveSlug(rawSlug: string): { post?: Post; redirectTo?: Post } {
  const db = getDb();
  const slug = decodeSlug(rawSlug);
  const post = db.prepare(
    "SELECT * FROM posts WHERE type = 'post' AND slug = ? AND status = 'published' AND " + ALIVE
  ).get(slug) as Post | undefined;
  if (post) return { post };

  // 页面类型也允许（但仍要求 published，修 B3）
  const page = db.prepare(
    "SELECT * FROM posts WHERE type = 'page' AND slug = ? AND status = 'published' AND " + ALIVE
  ).get(slug) as Post | undefined;
  if (page) return { post: page };

  const alias = db.prepare(
    "SELECT p.* FROM post_aliases a JOIN posts p ON p.id = a.post_id " +
    "WHERE a.slug = ? AND p.status = 'published' AND p.deleted_at IS NULL"
  ).get(slug) as Post | undefined;
  if (alias) return { redirectTo: alias };

  return {};
}

export function getPostBySlug(rawSlug: string): Post | undefined {
  const db = getDb();
  const slug = decodeSlug(rawSlug);
  return db.prepare(
    "SELECT * FROM posts WHERE type = 'post' AND slug = ? AND status = 'published' AND " + ALIVE
  ).get(slug) as Post | undefined;
}

/**
 * 按主键取一篇已发布内容（文章或页面）—— `/p/<id>` 的规范地址用这个。
 *
 * 要求 published 且未删除：草稿与回收站的内容不能被外部用编号猜到。
 * （编号是自增的、可枚举的，所以这条过滤不是可选项。）
 */
export function getPostById(rawId: string | number): Post | undefined {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return getDb().prepare(
    "SELECT * FROM posts WHERE id = ? AND status = 'published' AND " + ALIVE
  ).get(id) as Post | undefined;
}

/**
 * B3：原实现没有 status 条件 —— 草稿状态的 page 会直接公开可访问。
 * 管理员预览走显式 includeDrafts。
 */
export function getPageBySlug(rawSlug: string, opts: { includeDrafts?: boolean } = {}): Post | undefined {
  const db = getDb();
  const slug = decodeSlug(rawSlug);
  const statusSql = opts.includeDrafts ? "" : " AND status = 'published'";
  return db.prepare(
    "SELECT * FROM posts WHERE type = 'page' AND slug = ?" + statusSql + " AND " + ALIVE
  ).get(slug) as Post | undefined;
}

export function listShuoshuo(limit = 50): Post[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM posts WHERE type = 'shuoshuo' AND status = 'published' AND " + ALIVE +
    " ORDER BY published_at DESC LIMIT ?"
  ).all(limit) as Post[];
}

export type ArchiveGroup = { year: string; count: number; months: { ym: string; label: string; posts: Post[] }[] };

/**
 * B4：原实现按年分组（slice(0,4)）却把变量叫 ym，月度维度整体丢失。
 * 现在返回 年 -> 月 两级，且分组键按展示时区计算（不再依赖裸字符串截断）。
 */
export function listArchives(): ArchiveGroup[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM posts WHERE type = 'post' AND status = 'published' AND " + ALIVE +
    " ORDER BY published_at DESC"
  ).all() as Post[];

  const years = new Map<string, Map<string, Post[]>>();
  for (const r of rows) {
    const ts = r.published_at || r.created_at;
    const y = yearKeyIn(ts);
    const ym = monthKeyIn(ts);
    // 日期解析不出来时 yearKeyIn/monthKeyIn 返回 ""，继续分组会造出
    // year="" 的空年份 + label="0 月" 这种假分组。跳过而不是猜日期：
    // 脏数据该被看见（下面 warn），但不该被伪装成一个月份。
    if (!y || !ym) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[archives] skipped post with unparsable date:", r.id, JSON.stringify(ts));
      }
      continue;
    }
    if (!years.has(y)) years.set(y, new Map());
    const months = years.get(y)!;
    if (!months.has(ym)) months.set(ym, []);
    months.get(ym)!.push(r);
  }

  return [...years.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, months]) => {
      const list = [...months.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([ym, posts]) => ({ ym, label: Number(ym.slice(5, 7)) + " 月", posts }));
      return { year, count: list.reduce((n, m) => n + m.posts.length, 0), months: list };
    });
}

export function prevNextPost(publishedAt: string | null): { prev?: Post; next?: Post } {
  const db = getDb();
  const at = toUtcIso(publishedAt);
  if (!at) return {};
  // 列表按时间倒序（最新在前）：
  //   上一篇 = 更晚的一条；下一篇 = 更早的一条
  const prev = db.prepare(
    "SELECT * FROM posts WHERE type = 'post' AND status = 'published' AND " + ALIVE +
    " AND published_at > ? ORDER BY published_at ASC LIMIT 1"
  ).get(at) as Post | undefined;
  const next = db.prepare(
    "SELECT * FROM posts WHERE type = 'post' AND status = 'published' AND " + ALIVE +
    " AND published_at < ? ORDER BY published_at DESC LIMIT 1"
  ).get(at) as Post | undefined;
  return { prev, next };
}

export function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/**
 * 相关文章（F11，2026-11-07）。
 *
 * 规则：同分类 +2 分、同标签 +1 分，取分数最高的 N 篇；并列按发布时间倒序。
 *
 * 为什么不用"正文相似度"（TF-IDF / 向量）：本站只有几十篇，词频相似度算出来
 * 噪声比信号大 —— 中文短文本里"的/是/我"这类高频字会把不相干的文章拉到一起。
 * 分类和标签是作者亲手打的，语义最准，而且零额外依赖。
 *
 * 没有分类也没有标签时返回空数组：宁可不显示这一块，也不要拿"最新文章"
 * 冒充"相关文章"（那是在骗点击）。
 */
export function relatedPosts(post: Post, limit = 3): Post[] {
  const db = getDb();
  const cats = new Set(parseJsonArray(post.categories));
  const tags = new Set(parseJsonArray(post.tags));
  if (cats.size === 0 && tags.size === 0) return [];

  // 先按时间捞一批候选（几十篇的站，60 条足够覆盖全部已发布文章）
  const rows = db.prepare(
    "SELECT * FROM posts WHERE type = 'post' AND status = 'published' AND " + ALIVE +
    " AND id != ? ORDER BY published_at DESC LIMIT 60"
  ).all(post.id) as Post[];

  const scored = rows
    .map((r) => {
      let score = 0;
      for (const c of parseJsonArray(r.categories)) if (cats.has(c)) score += 2;
      for (const t of parseJsonArray(r.tags)) if (tags.has(t)) score += 1;
      return { r, score };
    })
    .filter((x) => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.r);
}

export function readingTime(md: string): number {
  const chars = md.replace(/\s/g, "").length;
  return Math.max(1, Math.round(chars / 400));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

/** 冲突时自动加序号：foo -> foo-2 -> foo-3 */
export function uniqueSlug(base: string, taken: (s: string) => boolean): string {
  let candidate = base;
  let n = 2;
  while (taken(candidate)) {
    candidate = base + "-" + n;
    n++;
    if (n > 999) return base + "-" + Date.now();
  }
  return candidate;
}

/**
 * 生成摘要。关键：链接/图片只保留可读文字，绝不能把 URL 混进摘要。
 */
/**
 * 把 Markdown 正文变成"可读的一行纯文本"（去代码块、链接语法、标题井号、表格线…）。
 *
 * 单独抽出来的原因（P0-6，2026-11-07）：搜索摘要需要在**命中位置附近**截取，
 * 而不再只是取开头 120 字（见 lib/highlight.ts 的 snippetAround）。两处清洗
 * 规则必须一致 —— 摘要里残留 `**` 或 `](http…` 这种碎片，是"看着像 bug"的
 * 那一类瑕疵。makeExcerpt 现在复用它，行为不变。
 */
export function plainText(md: string): string {
  let t = md;
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/^\s*\|.*\|\s*$/gm, " ");
  t = t.replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, " ");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // 列表/有序列表的符号在行首才删：`- ` 是项目符号，而 `2026-11-07`、`coc-tool`
  // 里的连字符是正文。旧的 `[*_~`>\-]` 见字符就删，把日期摘成了 `20261107`，
  // 也让搜索词 `CACHE_DB_ONLY` 永远匹配不到（下划线被吃掉了）—— 见 P0-6。
  t = t.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "");
  t = t.replace(/^\s*>\s?/gm, "");
  // 只删真正无信息量的修饰符；`_` 保留（下划线在标识符里是内容，不是格式）
  t = t.replace(/[*~`]/g, "");
  t = t.replace(/\(?\s*https?:\/\/[^\s)]+\s*\)?/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

export function makeExcerpt(md: string, len = 120): string {
  const t = plainText(md);
  return t.length > len ? t.slice(0, len) + "…" : t;
}

/** 标签云：按出现次数映射字号（0.72 ~ 1.0 rem）；排除已删除 */
export type TagItem = { name: string; count: number; size: number };

export function getTagCloud(limit = 18): TagItem[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT tags FROM posts WHERE type = 'post' AND status = 'published' AND " + ALIVE
  ).all() as { tags: string }[];

  const counter = new Map<string, number>();
  for (const r of rows) {
    for (const t of parseJsonArray(r.tags)) {
      const name = t.trim();
      if (!name) continue;
      counter.set(name, (counter.get(name) || 0) + 1);
    }
  }

  const list = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = list[0]?.[1] || 1;
  return list.map(([name, count]) => ({ name, count, size: 0.72 + (count / max) * 0.28 }));
}

/** 日期展示统一走 formatIn（见 lib/time.ts），这里保留一个便捷包装 */
export { formatIn } from "./time";
