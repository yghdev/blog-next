import { getDb, ftsAvailable } from "./db";
import { plainText } from "./posts";
import { dateKeyIn } from "./time";
import { highlightTerms, scoreHit, snippetAround } from "./highlight";

export type SearchHit = {
  id: number;
  title: string;
  slug: string;
  excerpt: string;
  date: string;
  categories: string[];
};

export type SearchMode = "fts" | "like";

export type SearchResult = {
  hits: SearchHit[];
  mode: SearchMode;
  /** 命中总数（不是 hits.length：hits 会被 limit 截断） */
  total: number;
  /** 候选被 CANDIDATE_CAP 截断过 -> total 只是下限，界面要写 "N+" */
  capped: boolean;
  /**
   * 单字查询：只在标题里匹配（2026-11-07）。
   *
   * 原因：`的`、`了` 这类单字在正文里几乎每篇都有，全量命中 + 几十处高亮
   * 只会把真正想找的东西淹掉。单字本身信息量太低，限定在标题里既保留了
   * "找标题带某个字"的用途，又不会让结果页变成全站列表。
   * 界面据此显示提示，告诉用户为什么结果变少了。
   */
  titleOnly: boolean;
};

/** trigram 分词的最短查询长度：少于 3 个字符无法匹配（实测结论） */
export const TRIGRAM_MIN = 3;

/**
 * 候选上限（P0-6）。
 *
 * 排序在 JS 里做（标题权重 + 正文词频，见 lib/highlight.ts），所以先把
 * 候选捞上来再挑。300 对本站（几十篇）是"永远用不到"的上限；真要撞到，
 * `capped` 会告诉界面把计数写成 "N+"，而不是谎称"共 N 篇"。
 */
export const CANDIDATE_CAP = 300;

/**
 * 把用户输入变成安全的 FTS5 查询串。
 *
 * 做法：整体包成短语（"..."），并把内部的 " 换成 ""（FTS5 的转义），
 * 这样就无需关心里面的 AND/OR/NOT/NEAR 等语法字符被当成运算符。
 */
export function toFtsQuery(raw: string): string {
  const q = raw.trim().replace(/\s+/g, " ");
  if (!q) return "";
  return '"' + q.replace(/"/g, '""') + '"';
}

type Row = {
  id: number;
  title: string;
  slug: string;
  content: string;
  categories: string;
  published_at: string | null;
  created_at: string;
};

const COLUMNS = "p.id, p.title, p.slug, p.content, p.categories, p.published_at, p.created_at";
const ALIVE = "p.type = 'post' AND p.status = 'published' AND p.deleted_at IS NULL";

/**
 * LIKE 候选（1~2 个字、或 FTS 不可用/无结果时）。
 *
 * 多个词之间是 **AND**：搜「deepseek 视频」的人要的是两者都有的文章。
 * 这里只负责"缩小范围"，是否真的命中、排第几由 highlight.ts 的边界规则
 * 与打分决定（`AI` 的候选里会出现 email，但随后会被边界过滤掉）。
 */
function likeCandidates(terms: string[], cap: number): Row[] {
  if (terms.length === 0) return [];
  const db = getDb();
  const conds: string[] = [];
  const params: string[] = [];
  for (const t of terms) {
    // 去掉 LIKE 的通配符：用户输入的 % 不应该变成"任意内容"
    const like = "%" + t.replace(/[%_\\]/g, "") + "%";
    conds.push("(p.title LIKE ? OR p.content LIKE ?)");
    params.push(like, like);
  }
  const sql =
    "SELECT " + COLUMNS + " FROM posts p WHERE " + ALIVE + " AND " + conds.join(" AND ") +
    " ORDER BY COALESCE(p.published_at, p.created_at) DESC LIMIT ?";
  return db.prepare(sql).all(...params, cap) as Row[];
}

function ftsCandidates(raw: string, cap: number): Row[] {
  const db = getDb();
  return db.prepare(
    "SELECT " + COLUMNS + " FROM posts_fts f JOIN posts p ON p.id = f.rowid " +
    "WHERE posts_fts MATCH ? AND " + ALIVE +
    " ORDER BY bm25(posts_fts) LIMIT ?"
  ).all(toFtsQuery(raw), cap) as Row[];
}

function safeCats(s: string): string[] {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 搜索（C10 起，P0-6 重写了排序与摘要）。
 *
 * 混合策略不变：FTS5(trigram) 负责 >=3 字符的查询，不足 3 字符或 FTS 不可用
 * 时退回 LIKE。变化的是一致性：
 *
 *   1. **命中判定只有一处**（lib/highlight.ts 的 buildMatcher）——
 *      排序、摘要、界面高亮用的是同一套规则，不会再出现"结果列表里有这条，
 *      但摘要里找不到关键词"的错位；
 *   2. **排序按相关性**（标题命中 ×10 + 正文词频），并列才按时间；
 *      2 字查询此前完全按时间倒序，"我们"这种词会把最近的文章全顶上来；
 *   3. **摘要从命中位置截**，而不是永远取正文开头 90 字；
 *   4. **返回 total**，界面不再把"前 30 条"说成"共 30 篇"。
 *
 * 返回值仍只含摘要，不回传整篇正文（原实现单篇最大 13,871 B）。
 */
export function searchPosts(raw: string, opts: { limit?: number } = {}): SearchResult {
  const q = raw.trim().replace(/\s+/g, " ");
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  if (!q) return { hits: [], mode: "like", total: 0, capped: false, titleOnly: false };

  const terms = highlightTerms(q);
  // 单字查询只在标题里匹配（见 SearchResult.titleOnly 的说明）
  const titleOnly = [...q].length === 1;
  const useFts = ftsAvailable() && [...q].length >= TRIGRAM_MIN;

  let mode: SearchMode = useFts ? "fts" : "like";
  let rows: Row[] = [];
  if (useFts) {
    try {
      rows = ftsCandidates(q, CANDIDATE_CAP);
    } catch (e) {
      console.warn("[search] FTS failed, falling back to LIKE:", (e as Error).message);
      rows = [];
    }
    // FTS 无结果时仍走一次 LIKE：trigram 对含标点/空格的短语可能过严
    if (rows.length === 0) {
      rows = likeCandidates(terms, CANDIDATE_CAP);
      mode = "like";
    }
  } else {
    rows = likeCandidates(terms, CANDIDATE_CAP);
  }

  const capped = rows.length >= CANDIDATE_CAP;
  const scored = rows
    .map((r) => {
      const body = plainText(r.content);
      // 单字查询把正文置空：scoreHit 只剩标题权重，正文命中一律不计分，
      // 于是"每篇都含这个字"的文章不会挤进结果。
      return { row: r, body, score: scoreHit(r.title, titleOnly ? "" : body, terms) };
    })
    // 边界规则在这里落地：`AI` 的候选里有 email，但 score 为 0 时被丢掉
    .filter((x) => x.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.row.published_at || a.row.created_at;
    const bt = b.row.published_at || b.row.created_at;
    return at < bt ? 1 : at > bt ? -1 : 0;
  });

  return {
    hits: scored.slice(0, limit).map(({ row, body }) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      excerpt: snippetAround(body, terms, 90),
      date: dateKeyIn(row.published_at || row.created_at),
      categories: safeCats(row.categories),
    })),
    mode,
    total: scored.length,
    capped,
    titleOnly,
  };
}

/** 重建索引（媒体/迁移后可用；后台"维护"里可触发） */
export function rebuildSearchIndex(): void {
  const db = getDb();
  if (!ftsAvailable()) return;
  db.prepare("INSERT INTO posts_fts (posts_fts) VALUES ('rebuild')").run();
}

export function searchIndexRows(): number {
  if (!ftsAvailable()) return 0;
  return (getDb().prepare("SELECT COUNT(*) c FROM posts_fts").get() as { c: number }).c;
}
