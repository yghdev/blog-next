import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { PostList } from "@/components/admin/PostList";
import { PageHeader } from "@/components/admin/ui";
import { Empty } from "@/components/admin/ui";
import { dateKeyIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "内容" };

const PAGE_SIZE = 20;

export default async function AdminPage({ searchParams }: {
  searchParams: Promise<{ page?: string; type?: string; status?: string; trash?: string; q?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const type = sp.type ?? "";
  const status = sp.status ?? "";
  const q = (sp.q ?? "").trim();
  const trash = sp.trash === "1";

  const db = getDb();
  const typeCond = ["post", "page", "shuoshuo"].includes(type) ? " AND type = ?" : "";
  const typeArgs = typeCond ? [type] : [];
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
  const counts = {
    all: count("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL" + typeCond, ...typeArgs),
    published: count("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL AND status='published'" + typeCond, ...typeArgs),
    draft: count("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL AND status='draft'" + typeCond, ...typeArgs),
  };

  /**
   * 列表要带出草稿快照里的标题（方案 §4.2）。
   *
   * 为什么不能只显示 posts.title：新文章建的是**壳**，posts.title 是空串，
   * 用户在快照里写的标题还没发布。若列表只读 posts.title，后台会显示一排
   * "(无标题)" —— 用户看不到自己刚写的东西，会以为草稿丢了。
   *
   * 同时把搜索也扩到草稿标题：否则"搜草稿标题搜不到"同样像丢数据。
   */
  const draftTitle = "json_extract(d.snapshot_json, '$.title')";
  const from = "FROM posts LEFT JOIN post_drafts d ON d.post_id = posts.id";
  const where: string[] = [trash ? "posts.deleted_at IS NOT NULL" : "posts.deleted_at IS NULL"];
  const args: unknown[] = [];
  if (typeCond) { where.push("posts.type = ?"); args.push(type); }
  if (["draft", "published"].includes(status)) { where.push("posts.status = ?"); args.push(status); }
  if (q) {
    where.push("(posts.title LIKE ? OR posts.slug LIKE ? OR " + draftTitle + " LIKE ?)");
    const like = "%" + q + "%"; args.push(like, like, like);
  }
  const whereSql = "WHERE " + where.join(" AND ");
  const total = (db.prepare("SELECT COUNT(*) c " + from + " " + whereSql).get(...args) as { c: number }).c;
  const rows = db.prepare(
    "SELECT posts.id, posts.type, posts.title, posts.slug, posts.status, posts.published_at, posts.updated_at, " +
    "posts.revision, " + draftTitle + " AS draft_title " +
    from + " " + whereSql +
    " ORDER BY COALESCE(posts.published_at, posts.updated_at) DESC LIMIT ? OFFSET ?"
  ).all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE) as {
    id: number; type: string; title: string; slug: string; status: string;
    published_at: string | null; updated_at: string; revision: number;
    draft_title: string | null;
  }[];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const link = (next: { status?: string; type?: string; page?: number }) => {
    const u = new URLSearchParams();
    const t = next.type !== undefined ? next.type : type;
    const s = next.status !== undefined ? next.status : status;
    if (t) u.set("type", t);
    if (s) u.set("status", s);
    if (q) u.set("q", q);
    if (trash) u.set("trash", "1");
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const qs = u.toString();
    return "/admin" + (qs ? "?" + qs : "");
  };

  return (
    <AdminShell active={trash ? "trash" : "posts"} username={user.username}>
      <PageHeader
        title={trash ? "回收站" : "内容"}
        actions={!trash ? <Link href="/admin/new" className="btn btn-primary">写文章</Link> : null}
      />

      <div className="content-toolbar">
        {!trash ? (
          <nav className="seg-tabs" aria-label="按发布状态筛选">
            {[
              { key: "", label: "全部", count: counts.all },
              { key: "published", label: "已发布", count: counts.published },
              { key: "draft", label: "草稿", count: counts.draft },
            ].map((t) => {
              const active = status === t.key;
              return <Link key={t.key || "all"} href={link({ status: t.key, page: 1 })} className={active ? "is-active" : undefined} aria-current={active ? "true" : undefined}>
                {t.label}<span className="seg-count">{t.count}</span>
              </Link>;
            })}
          </nav>
        ) : null}

        <form className="content-tools" action="/admin" method="get">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {trash ? <input type="hidden" name="trash" value="1" /> : null}
          <label className="content-search">
            <span className="sr-only">搜索标题或路径</span>
            <input className="input" type="search" name="q" defaultValue={q} placeholder="搜索标题或路径" />
          </label>
          <label className="content-type-select">
            <span className="sr-only">内容类型</span>
            <select className="input" name="type" defaultValue={type}>
              <option value="">全部类型</option>
              <option value="post">文章</option>
              <option value="page">页面</option>
              <option value="shuoshuo">说说</option>
            </select>
          </label>
          <button className="btn btn-sm" type="submit">筛选</button>
          {(q || type) ? <Link className="content-clear" href={link({ type: "", page: 1 })}>清除</Link> : null}
        </form>
      </div>

      {rows.length === 0 ? (
        <Empty
          title={trash ? "回收站是空的" : q || type ? "没有匹配的内容" : "还没有内容"}
          hint={trash ? "删除的内容会在这里保留一段时间，可以恢复或彻底清除。" : q || type ? "试试清除搜索词或类型筛选。" : "从第一篇文章开始。"}
          actions={trash || q || type
            ? <Link className="btn btn-sm" href="/admin">回到内容列表</Link>
            : <Link className="btn btn-primary btn-sm" href="/admin/new">写文章</Link>}
        />
      ) : (
        <PostList
          items={rows.map((r) => ({
            id: r.id, type: r.type,
            // 有草稿时优先显示草稿标题（壳的 posts.title 通常是空的）
            title: (r.draft_title && r.draft_title.trim()) ? r.draft_title : r.title,
            status: r.status,
            dateLabel: r.status === "published" && r.published_at ? dateKeyIn(r.published_at) : "未发布",
            revision: r.revision ?? 1,
          }))}
          trash={trash}
          stepUpRequired={!!user.totp_enabled}
        />
      )}

      {pages > 1 ? (
        <div className="pager list-pager">
          {page > 1 ? <Link className="btn btn-sm" href={link({ page: page - 1 })}>上一页</Link> : null}
          <span className="pager-current" aria-current="page">{page} / {pages}</span>
          {page < pages ? <Link className="btn btn-sm" href={link({ page: page + 1 })}>下一页</Link> : null}
        </div>
      ) : null}
    </AdminShell>
  );
}
