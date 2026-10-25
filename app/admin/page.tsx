import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { CommentActions } from "@/components/admin/CommentActions";
import { PostList } from "@/components/admin/PostList";
import { PageHeader, Kpi, Badge } from "@/components/admin/ui";
import { formatIn } from "@/lib/time";
import { dateKeyIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "后台" };

const PAGE_SIZE = 20;

/**
 * 内容总览（B 端设计系统 · 列表页骨架 05）。
 *
 * 结构固定为四段，不再让每个页面自己发挥：
 *   PageHeader  → 一句话说清「这是哪、多少条、能干什么」
 *   KpiRow      → 关键计数（可点，直接进对应筛选）
 *   FilterBar   → 查询 + 类型 + 状态，一行内完成
 *   DataSection → 列表 + 分页 + 空状态入口
 */
export default async function AdminPage({ searchParams }: {
  searchParams: Promise<{ page?: string; q?: string; type?: string; status?: string; trash?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const q = (sp.q ?? "").trim();
  const type = sp.type ?? "";
  const status = sp.status ?? "";
  const trash = sp.trash === "1";

  const db = getDb();
  const stats = (() => {
    const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    return {
      total: c("SELECT COUNT(*) c FROM posts WHERE type='post' AND deleted_at IS NULL"),
      drafts: c("SELECT COUNT(*) c FROM posts WHERE status='draft' AND deleted_at IS NULL"),
      shuoshuo: c("SELECT COUNT(*) c FROM posts WHERE type='shuoshuo' AND deleted_at IS NULL"),
      trash: c("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NOT NULL"),
      pending: c("SELECT COUNT(*) c FROM comments WHERE status='pending'"),
    };
  })();

  const where: string[] = [trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  const args: unknown[] = [];
  if (["post", "page", "shuoshuo"].includes(type)) { where.push("type = ?"); args.push(type); }
  if (["draft", "published"].includes(status)) { where.push("status = ?"); args.push(status); }
  if (q) { where.push("(title LIKE ? OR slug LIKE ?)"); args.push("%" + q + "%", "%" + q + "%"); }
  const whereSql = "WHERE " + where.join(" AND ");

  const total = (db.prepare("SELECT COUNT(*) c FROM posts " + whereSql).get(...args) as { c: number }).c;
  const rows = db.prepare(
    "SELECT id, type, title, slug, status, published_at, updated_at FROM posts " + whereSql +
    " ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ? OFFSET ?"
  ).all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE) as {
    id: number; type: string; title: string; slug: string; status: string;
    published_at: string | null; updated_at: string;
  }[];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const pending = db.prepare(
    "SELECT c.*, p.title as post_title FROM comments c JOIN posts p ON c.post_id = p.id " +
    "WHERE c.status = 'pending' ORDER BY c.created_at DESC LIMIT 20"
  ).all() as { id: number; author: string; content: string; created_at: string; post_title: string }[];

  const qs = (extra: Record<string, string>) => {
    const u = new URLSearchParams({ page: String(page), q, type, status });
    if (trash) u.set("trash", "1");
    for (const [k, v] of Object.entries(extra)) { if (v) u.set(k, v); else u.delete(k); }
    return "/admin?" + u.toString();
  };

  const filtered = !!(q || type || status);

  return (
    <AdminShell active="posts" username={user.username}>
      <PageHeader
        title={trash ? "回收站" : "内容"}
        sub={trash
          ? "已删除但还没彻底清除的内容。恢复后立即回到前台。"
          : "文章、页面与说说。草稿只有登录后台可见。"}
        actions={!trash ? <Link href="/admin/new" className="btn btn-primary btn-sm">新建文章</Link> : null}
      />

      <div className="kpi-row">
        <Kpi label="文章" value={stats.total} href="/admin?type=post" />
        <Kpi label="草稿" value={stats.drafts} href="/admin?status=draft" alert={stats.drafts > 0} />
        <Kpi label="说说" value={stats.shuoshuo} href="/admin?type=shuoshuo" />
        <Kpi label="待审评论" value={stats.pending} href="/admin/comments?status=pending" alert={stats.pending > 0} />
        <Kpi label="回收站" value={stats.trash} href="/admin?trash=1" />
      </div>

      <form method="get" action="/admin" className="filter-bar">
        {trash ? <input type="hidden" name="trash" value="1" /> : null}
        <input
          className="input"
          name="q"
          defaultValue={q}
          placeholder="搜索标题或 URL"
          aria-label="搜索标题或 URL"
          style={{ maxWidth: 260, flex: "1 1 200px" }}
        />
        <select className="input" name="type" defaultValue={type} aria-label="类型" style={{ maxWidth: 130 }}>
          <option value="">全部类型</option>
          <option value="post">文章</option>
          <option value="page">页面</option>
          <option value="shuoshuo">说说</option>
        </select>
        <select className="input" name="status" defaultValue={status} aria-label="状态" style={{ maxWidth: 130 }}>
          <option value="">全部状态</option>
          <option value="published">已发布</option>
          <option value="draft">草稿</option>
        </select>
        <button className="btn btn-sm" type="submit">筛选</button>
        {filtered ? <Link className="btn btn-sm btn-ghost" href={trash ? "/admin?trash=1" : "/admin"}>清除</Link> : null}
        <span style={{ flex: 1 }} />
        <Link className="btn btn-sm" href={trash ? "/admin" : "/admin?trash=1"}>
          {trash ? "回到内容" : "回收站" + (stats.trash > 0 ? " " + stats.trash : "")}
        </Link>
      </form>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <h2 style={{ fontFamily: "var(--font-serif)", fontSize: "1.05rem", color: "var(--text-p0)", margin: 0 }}>
          {trash ? "已删除" : "列表"}
        </h2>
        <Badge>{total} 条</Badge>
      </div>

      <PostList
        items={rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          status: r.status,
          dateLabel: r.status === "published" && r.published_at ? dateKeyIn(r.published_at) : "未发布",
        }))}
        trash={trash}
        stepUpRequired={!!user.totp_enabled}
      />

      {pages > 1 ? (
        <div className="pager" style={{ marginTop: 16 }}>
          {page > 1 ? <Link className="btn btn-sm" href={qs({ page: String(page - 1) })}>上一页</Link> : null}
          <span className="btn btn-sm" style={{ pointerEvents: "none", opacity: .6 }} aria-current="page">
            {page} / {pages}
          </span>
          {page < pages ? <Link className="btn btn-sm" href={qs({ page: String(page + 1) })}>下一页</Link> : null}
        </div>
      ) : null}

      {pending.length > 0 ? (
        <section style={{ marginTop: 36 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: "1.05rem", color: "var(--text-p0)", margin: 0 }}>
              待审核评论
            </h2>
            <Badge tone="warn" dot>{pending.length} 条</Badge>
            <span style={{ flex: 1 }} />
            <Link className="btn btn-sm" href="/admin/comments?status=pending">全部待审</Link>
          </div>
          <div className="data-panel">
            {pending.map((c) => (
              <div key={c.id} style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: ".8rem", color: "var(--text-p3)", marginBottom: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--text-p0)" }}>{c.author}</strong>
                  <span>· {c.post_title}</span>
                  <span>· {formatIn(c.created_at, "datetime")}</span>
                </div>
                <div style={{ fontSize: ".88rem", color: "var(--text-p2)", marginBottom: 10, lineHeight: 1.7 }}>{c.content}</div>
                <CommentActions id={c.id} />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </AdminShell>
  );
}
