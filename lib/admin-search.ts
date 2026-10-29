/**
 * 后台搜索（阶段 04）。
 *
 * 与前台搜索（lib/search.ts）**刻意分开**，因为两者的规则根本不同：
 *
 *   | 维度     | 前台搜索                     | 后台搜索                       |
 *   | -------- | ---------------------------- | ------------------------------ |
 *   | 范围     | 仅已发布 post                | 草稿/页面/说说全都要            |
 *   | 回收站   | 排除                         | **排除**（要删的先去回收站）    |
 *   | 返回     | 摘要（给读者看）             | 不返正文（只给定位用的元信息）  |
 *   | 排序     | 相关度/时间                  | 更新时间倒序（找"我刚才改的"）  |
 *
 * 最要紧的一条是**不返回整篇正文**：命令面板只需要"标题 + 类型 + 状态"来定位，
 * 回传正文既浪费带宽，也会让"搜一下"变成"把整库内容拉到浏览器里"。
 * 唯一的例外是说说：它没有标题，若不给一小段正文，结果只能显示「未命名」，
 * 用户搜到了也认不出是哪一条 —— 所以说说只带出 60 字以内的摘要当展示文案，
 * 文章与页面仍然一个字都不带。
 *
 * 草稿标题特殊：新文章是壳，posts.title 为空，真实标题在 post_drafts 快照里
 * （方案 §4.2）。所以搜索必须同时匹配草稿快照的标题，否则"搜我刚写的草稿"
 * 会搜不到 —— 那正是这个功能最常见的用法。
 */
import type Database from "better-sqlite3";
import { makeExcerpt } from "./posts";

export type AdminSearchType = "post" | "page" | "shuoshuo";

export type AdminSearchHit = {
  id: number;
  type: AdminSearchType;
  /** 展示用标题：有草稿时用草稿标题（壳的 posts.title 常为空） */
  title: string;
  slug: string;
  status: "draft" | "published";
  /** 是否有未发布的草稿 —— 命令面板要标出来，否则用户会以为线上就是这个内容 */
  hasDraft: boolean;
  updatedAt: string;
  /** 命中的是哪一段（标题/路径/草稿标题），用于解释"为什么它出现在结果里" */
  matchedIn: "title" | "slug" | "draft" | "body";
};

const TYPE_LABEL: Record<AdminSearchType, string> = {
  post: "文章",
  page: "页面",
  shuoshuo: "说说",
};

export function adminTypeLabel(t: AdminSearchType): string {
  return TYPE_LABEL[t];
}

/**
 * 执行后台搜索。
 *
 * 用 LIKE 而不是 FTS：后台数据量级是几十到几百篇，LIKE 完全够用；
 * 而 posts_fts 只索引已发布文章（见 0009 迁移），拿它搜草稿会直接搜不到 ——
 * 那是"功能看起来能用、实际漏数据"的典型形态。
 */
export function adminSearch(
  db: Database.Database,
  raw: string,
  opts: { limit?: number; type?: AdminSearchType | "" } = {}
): AdminSearchHit[] {
  const q = raw.trim();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  if (!q) return [];

  // LIKE 转义：% _ \ 都必须处理，否则用户输入 "%" 会匹配全库
  const escaped = q.replace(/[\\%_]/g, (m) => "\\" + m);
  const like = "%" + escaped + "%";

  const args: unknown[] = [like, like, like, like];
  let typeSql = "";
  if (opts.type) {
    typeSql = " AND posts.type = ?";
    args.push(opts.type);
  }

  const rows = db.prepare(
    "SELECT posts.id, posts.type, posts.slug, posts.status, posts.updated_at, posts.title, " +
    "  json_extract(d.snapshot_json, '$.title') AS draft_title, " +
    "  COALESCE(NULLIF(json_extract(d.snapshot_json, '$.content'), ''), posts.content) AS body, " +
    "  (d.post_id IS NOT NULL) AS has_draft " +
    "FROM posts LEFT JOIN post_drafts d ON d.post_id = posts.id " +
    "WHERE posts.deleted_at IS NULL " +           // 回收站一律排除
    "  AND (posts.title LIKE ? ESCAPE '\\' " +
    "       OR posts.slug LIKE ? ESCAPE '\\' " +
    "       OR json_extract(d.snapshot_json, '$.title') LIKE ? ESCAPE '\\' " +
    "       OR (posts.type = 'shuoshuo' AND posts.content LIKE ? ESCAPE '\\')) " +
    typeSql +
    " ORDER BY posts.updated_at DESC LIMIT ?"
  ).all(...args, limit) as {
    id: number; type: AdminSearchType; slug: string; status: "draft" | "published";
    updated_at: string; title: string; draft_title: string | null; body: string; has_draft: number;
  }[];

  return rows.map((r) => {
    const draftTitle = (r.draft_title ?? "").trim();
    const postsTitle = (r.title ?? "").trim();
    /**
     * 说说没有标题：用正文摘要当展示文案。
     * 否则命令面板里会出现一条叫「(未命名)」的结果 —— 用户搜到了却认不出
     * 那是自己写的哪一句。文章仍走「草稿标题 > 正式标题」。
     */
    const shown = draftTitle || postsTitle ||
      (r.type === "shuoshuo" ? makeExcerpt(r.body ?? "", 60) : "");

    // 解释命中原因：草稿标题命中与 posts 标题命中要能区分开，
    // 否则用户会疑惑"标题明明是 A，为什么搜 B 出来了"
    const inDraft = !!(draftTitle && draftTitle.toLowerCase().includes(q.toLowerCase()));
    const inTitle = !!(postsTitle && postsTitle.toLowerCase().includes(q.toLowerCase()));
    // 说说的命中在正文上；不解释的话用户会以为标题里藏着这个词
    const matchedIn: AdminSearchHit["matchedIn"] =
      r.type === "shuoshuo" && !inTitle && !inDraft ? "body" : inDraft ? "draft" : inTitle ? "title" : "slug";

    return {
      id: r.id,
      type: r.type,
      title: shown || "(未命名)",
      slug: r.slug,
      status: r.status,
      hasDraft: !!r.has_draft,
      updatedAt: r.updated_at,
      matchedIn,
    };
  });
}
