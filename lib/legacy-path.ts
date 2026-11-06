import { getDb, type Post } from "./db";
import { decodeSlug } from "./posts";

/**
 * 旧 WordPress 地址兼容层（`/YYYY/MM/DD/<旧 slug>`）。
 *
 * ## 为什么需要它
 *
 * 博客从 WordPress 迁到 Next.js 后，文章规范地址改成了 `/p/<id>`，
 * 旧地址入口只兼容了单段形态（`/中文slug`，见 `app/[slug]/page.tsx`）。
 * 但 WordPress 时代的 permalink 是日期路径：
 *
 * ```
 * /2026/06/07/imghub
 * /2026/09/07/coc-war-tool：花名册重构与成员更新优化
 * /2026/05/25/35            ← WP 老文章的 slug 是纯数字
 * ```
 *
 * 这些地址仍在被访问：搜索引擎索引、别处的友链、RSS 阅读器里存着的旧条目。
 * 迁移后它们全部 404 —— 对一篇文章来说，等于把已经积累的入口权重丢掉。
 * 2026-11-06 的 nginx 日志里，一天就有 900+ 次 404，其中旧日期路径占相当比例。
 *
 * ## 为什么用「前缀唯一」而不是维护一张完整别名表
 *
 * 迁移时 `wp_posts.post_name` 已经写进 `posts.slug`，但用户在 WordPress 里
 * 改过 slug 的文章（`imghub` → `imghub图床`、`ai` → `ai做了个部落冲突管理网站`）
 * 在旧链接里是**短前缀**。没有 WP 库可查的情况下，前缀匹配能覆盖它们，
 * 且只在**唯一命中**时才跳转 —— 多条候选一律 404，绝不猜。
 *
 * 剩下的少数改得面目全非的旧 slug（`十大排序算法` → `十大经典排序算法`）
 * 靠 `post_aliases` 表补：后台改 slug 时本来就会写这张表，这里复用同一套机制。
 */

export type LegacyShape =
  | { kind: "dated"; year: string; month: string; day: string; slug: string }
  | { kind: "archive" };

export type LegacyTarget =
  | { kind: "post"; post: Post }
  | { kind: "archive" };

const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^(0[1-9]|1[0-2])$/;
const DAY_RE = /^(0[1-9]|[12]\d|3[01])$/;
const PURE_NUMBER_RE = /^\d+$/;

/** 文章前缀匹配至少两个字符：单字符前缀（`a`）会命中太多东西，不能自动跳 */
const MIN_PREFIX = 2;

/**
 * 纯解析：把 catch-all 的 segments 归类成「日期路径」或「归档路径」。
 *
 * 不碰数据库，方便单测。返回 `null` 表示不是旧日期形态 ——
 * 调用方应该继续走 404，而不是给它编一个跳转目标。
 */
export function classifyLegacySegments(rawSegments: string[]): LegacyShape | null {
  const segments = rawSegments.map((s) => decodeSlug(s)).filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const [year, month, day, ...rest] = segments;
  if (!YEAR_RE.test(year)) return null;

  // /2026、/2026/06、/2026/06/07 —— WordPress 的年/月/日归档
  if (segments.length === 1) return { kind: "archive" };
  if (segments.length === 2) return MONTH_RE.test(month) ? { kind: "archive" } : null;
  if (segments.length === 3) {
    // /2026/page/2 —— 年份分页（WP 也生成这种地址），先于日期判断
    if (segments[1] === "page" && PURE_NUMBER_RE.test(segments[2])) return { kind: "archive" };
    if (!MONTH_RE.test(month) || !DAY_RE.test(day)) return null;
    return { kind: "archive" };
  }
  if (!MONTH_RE.test(month) || !DAY_RE.test(day)) return null;

  // /2026/06/07/<slug>；slug 之后可能跟着 /feed、/page/2 之类，一律忽略
  const slug = rest[0];
  if (!slug) return null;
  return { kind: "dated", year, month, day, slug };
}

/** LIKE 前缀匹配前的转义：slug 里出现 % 或 _ 时不能当通配符 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

const BASE = "type = 'post' AND status = 'published' AND deleted_at IS NULL";

/**
 * 按旧 slug 找文章。顺序固定：精确 → 数字（wp_id / id）→ 别名 → 唯一前缀。
 *
 * 精确优先是为了不引入任何"猜"的环节：slug 没改过的旧链接直接命中。
 */
export function findPostByLegacySlug(rawSlug: string): Post | undefined {
  const db = getDb();
  const slug = decodeSlug(rawSlug).trim();
  if (!slug) return undefined;

  const exact = db.prepare("SELECT * FROM posts WHERE " + BASE + " AND slug = ? LIMIT 1").get(slug) as
    | Post
    | undefined;
  if (exact) return exact;

  // WP 把 `post_name` 留成纯数字的文章（本站有 35 / 39 两篇）：先按 wp_id，再按 id
  if (PURE_NUMBER_RE.test(slug)) {
    const n = Number(slug);
    const byWpId = db.prepare("SELECT * FROM posts WHERE " + BASE + " AND wp_id = ? LIMIT 1").get(n) as
      | Post
      | undefined;
    if (byWpId) return byWpId;
    const byId = db.prepare("SELECT * FROM posts WHERE " + BASE + " AND id = ? LIMIT 1").get(n) as
      | Post
      | undefined;
    if (byId) return byId;
  }

  // 人工补的旧 slug（后台改 slug 时写入 post_aliases）
  const alias = db
    .prepare(
      "SELECT p.* FROM post_aliases a JOIN posts p ON p.id = a.post_id " +
        "WHERE a.slug = ? AND p.status = 'published' AND p.deleted_at IS NULL LIMIT 1"
    )
    .get(slug) as Post | undefined;
  if (alias) return alias;

  // 唯一前缀：只接受恰好一条候选。多条说明旧 slug 太短或有歧义，宁可 404 也不乱跳。
  if (slug.length >= MIN_PREFIX) {
    const rows = db
      .prepare(
        "SELECT * FROM posts WHERE " +
          BASE +
          " AND slug LIKE ? ESCAPE '\\' ORDER BY length(slug) ASC, id ASC LIMIT 2"
      )
      .all(escapeLike(slug) + "%") as Post[];
    if (rows.length === 1) return rows[0];
  }

  return undefined;
}

/**
 * 解析整条旧路径，返回跳转目标（或 null 表示 404）。
 *
 * 归档类路径（`/2026`、`/2026/page/2`、`/2026/06/07`）统一跳 `/archives`：
 * 本站的归档页是唯一的分页/时间线入口，跳首页会让用户再找一次。
 */
export function resolveLegacyPath(segments: string[]): LegacyTarget | null {
  const shape = classifyLegacySegments(segments);
  if (!shape) return null;
  if (shape.kind === "archive") return { kind: "archive" };

  const post = findPostByLegacySlug(shape.slug);
  return post ? { kind: "post", post } : null;
}
