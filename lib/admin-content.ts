import { getDb } from "./db";
import { makeExcerpt } from "./posts";

/**
 * 后台内容列表的数据层（文章 / 说说 / 页面 / 回收站共用）。
 *
 * 为什么抽出来：三种类型原本挤在一个页面的 `?type=` 筛选里，拆成三条路由后
 * 如果各写一份 SQL，分页、草稿快照、搜索条件迟早会漂移 —— 典型症状是
 * 「说说能搜到草稿、文章搜不到」这种只在某一页出现的怪 bug。
 *
 * 一条硬规则：**说说没有标题**。它的正文就是它的身份，所以列表的展示文案
 * 统一走 labelFor()：有标题用标题；没有标题（说说，或还没起名的草稿）用
 * 正文摘要。任何地方都不再出现「(无标题)」—— 用户看到的应该是自己写的话，
 * 而不是一句系统占位。
 */
export type ContentType = "post" | "page" | "shuoshuo";

export const CONTENT_TYPES: ContentType[] = ["post", "page", "shuoshuo"];

export const TYPE_LABEL: Record<ContentType, string> = {
  post: "文章",
  page: "页面",
  shuoshuo: "说说",
};

export type ContentRow = {
  id: number;
  type: ContentType;
  /** 展示文案：标题优先，缺失时用正文摘要（说说永远走这条） */
  label: string;
  /** 纯文本摘要，说说列表直接显示它 */
  excerpt: string;
  /** 正文字数（去空白），说说列表用来表达「这条有多短」 */
  chars: number;
  /** 正文里是否带图（说说列表给一个「含图」提示，避免只看到文字以为图丢了） */
  hasImage: boolean;
  status: "draft" | "published";
  publishedAt: string | null;
  updatedAt: string;
  revision: number;
  hasDraft: boolean;
};

export type ContentListData = {
  rows: ContentRow[];
  total: number;
  counts: { all: number; published: number; draft: number };
  pages: number;
};

const DRAFT_TITLE = "json_extract(d.snapshot_json, '$.title')";
const DRAFT_CONTENT = "json_extract(d.snapshot_json, '$.content')";

/** LIKE 通配符转义：用户输入 % 或 _ 时不能变成「匹配全库」 */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => "\\" + m);
}

/**
 * 说说正文 → 列表里可读的纯文本。
 *
 * 与 makeExcerpt 的差别是**保留换行**：说说常常是两三行短句，
 * 压成一段会丢掉它的节奏（"快门声比记忆里轻。"单独一行是有意的）。
 * 图片语法整段丢掉，只留「含图」标记 —— 保留 alt 文字会在句尾
 * 多出一个孤零零的词（实测：「…拍了一张。 云」）。
 */
export function shuoshuoText(md: string): string {
  let t = md;
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/[*_~`>]/g, "");
  // 压缩 3 行以上的空行，保留段落间距
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** 去空白后的字数，与编辑器顶栏的口径一致（编辑器：content.replace(/\s/g,"").length） */
export function contentChars(s: string): number {
  return s.replace(/\s/g, "").length;
}

/**
 * 展示文案。
 *
 * 说说：正文摘要（不带标题）。
 * 文章 / 页面：标题；标题为空（新建的壳）时退回摘要，最后才是「空草稿」。
 */
export function labelFor(type: ContentType, title: string, content: string): string {
  const t = (title ?? "").trim();
  if (t) return t;
  const flat = type === "shuoshuo"
    ? shuoshuoText(content ?? "").replace(/\s+/g, " ")
    : makeExcerpt(content ?? "", 80);
  if (flat) return flat;
  return type === "shuoshuo" ? "（空说说）" : "（空草稿）";
}

export function loadContentList(opts: {
  /** 不传 = 全部类型（只有回收站用） */
  type?: ContentType;
  status?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  trash?: boolean;
}): ContentListData {
  const db = getDb();
  const pageSize = opts.pageSize ?? 20;
  const page = Math.max(1, opts.page ?? 1);
  const q = (opts.q ?? "").trim();
  const trash = !!opts.trash;

  const from = "FROM posts LEFT JOIN post_drafts d ON d.post_id = posts.id";
  const where: string[] = [trash ? "posts.deleted_at IS NOT NULL" : "posts.deleted_at IS NULL"];
  const args: unknown[] = [];

  if (opts.type) { where.push("posts.type = ?"); args.push(opts.type); }

  const status = opts.status ?? "";
  if (!trash && ["draft", "published"].includes(status)) {
    where.push("posts.status = ?");
    args.push(status);
  }

  if (q) {
    const like = "%" + escapeLike(q) + "%";
    /**
     * 说说的搜索必须落在正文上 —— 它没有标题，只搜 posts.title 永远搜不到。
     * 文章/页面额外搜 slug 与草稿快照里的标题（壳的 posts.title 常为空）。
     */
    if (opts.type === "shuoshuo") {
      where.push("(posts.content LIKE ? ESCAPE '\\' OR " + DRAFT_CONTENT + " LIKE ? ESCAPE '\\')");
      args.push(like, like);
    } else {
      where.push("(posts.title LIKE ? ESCAPE '\\' OR posts.slug LIKE ? ESCAPE '\\' OR " +
        DRAFT_TITLE + " LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
  }

  const whereSql = "WHERE " + where.join(" AND ");
  const total = (db.prepare("SELECT COUNT(*) c " + from + " " + whereSql).get(...args) as { c: number }).c;

  // 状态计数始终基于「类型 + 未删除」，不叠加当前搜索词：
  // 它表达的是「这一栏有多少」，不是「搜索结果有多少」。
  const countWhere = trash ? "WHERE posts.deleted_at IS NOT NULL" : "WHERE posts.deleted_at IS NULL";
  const countType = opts.type ? " AND posts.type = ?" : "";
  const countArgs = opts.type ? [opts.type] : [];
  const countOf = (extra: string) =>
    (db.prepare("SELECT COUNT(*) c FROM posts " + countWhere + countType + extra).get(...countArgs) as { c: number }).c;
  const counts = trash
    ? { all: countOf(""), published: 0, draft: 0 }
    : { all: countOf(""), published: countOf(" AND posts.status='published'"), draft: countOf(" AND posts.status='draft'") };

  const rows = db.prepare(
    "SELECT posts.id, posts.type, posts.title, posts.content, posts.status, posts.published_at, " +
    "posts.updated_at, posts.revision, " + DRAFT_TITLE + " AS draft_title, " +
    DRAFT_CONTENT + " AS draft_content, (d.post_id IS NOT NULL) AS has_draft " +
    from + " " + whereSql +
    " ORDER BY COALESCE(posts.published_at, posts.updated_at) DESC LIMIT ? OFFSET ?"
  ).all(...args, pageSize, (page - 1) * pageSize) as {
    id: number; type: ContentType; title: string; content: string; status: "draft" | "published";
    published_at: string | null; updated_at: string; revision: number;
    draft_title: string | null; draft_content: string | null; has_draft: number;
  }[];

  return {
    total,
    counts,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((r) => {
      // 有草稿时用草稿里的内容：用户找的是「我刚写的那句」，不是线上旧版本
      const draftContent = (r.draft_content ?? "").trim();
      const content = draftContent || r.content || "";
      const title = (r.draft_title ?? "").trim() || r.title || "";
      return {
        id: r.id,
        type: r.type,
        label: labelFor(r.type, title, content),
        excerpt: r.type === "shuoshuo" ? shuoshuoText(content) : makeExcerpt(content, 220),
        chars: contentChars(content),
        // makeExcerpt 会把图片语法降级成 alt 文字，所以必须看原文判断
        hasImage: /!\[[^\]]*\]\(|<img\b/i.test(content),
        status: r.status,
        publishedAt: r.published_at,
        updatedAt: r.updated_at,
        revision: r.revision ?? 1,
        hasDraft: !!r.has_draft,
      };
    }),
  };
}
