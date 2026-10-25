import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { CommentActions } from "@/components/admin/CommentActions";
import { PageHeader, Badge, Empty } from "@/components/admin/ui";
import { formatIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "评论" };

const STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  approved: { text: "已通过", tone: "ok" },
  pending: { text: "待审核", tone: "warn" },
  spam: { text: "垃圾", tone: "danger" },
};

export default async function CommentsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const status = sp.status ?? "";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const PAGE = 50;

  const db = getDb();
  const where = status ? "WHERE c.status = ?" : "";
  const args = status ? [status] : [];
  const total = (db.prepare("SELECT COUNT(*) c FROM comments c " + where).get(...args) as { c: number }).c;

  const counts = (() => {
    const c = (s: string) => (db.prepare(s).get() as { c: number }).c;
    return {
      all: c("SELECT COUNT(*) c FROM comments"),
      pending: c("SELECT COUNT(*) c FROM comments WHERE status='pending'"),
      approved: c("SELECT COUNT(*) c FROM comments WHERE status='approved'"),
      spam: c("SELECT COUNT(*) c FROM comments WHERE status='spam'"),
    };
  })();

  const rows = db.prepare(
    "SELECT c.*, p.title as post_title, p.slug as post_slug FROM comments c JOIN posts p ON c.post_id = p.id " +
    where + " ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, c.created_at DESC " +
    "LIMIT ? OFFSET ?"
  ).all(...args, PAGE, (page - 1) * PAGE) as {
    id: number; author: string; email: string; url: string; content: string; status: string;
    created_at: string; ip: string; parent_id: number | null; post_title: string; post_slug: string;
  }[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const pages = Math.max(1, Math.ceil(total / PAGE));

  // 分段控件：三项平铺（≤4 项不用下拉，B 端参考 06）
  const tab = (k: string, label: string, count: number) => (
    <a
      key={k || "all"}
      href={k ? "/admin/comments?status=" + k : "/admin/comments"}
      className={status === k ? "is-active" : undefined}
      aria-current={status === k ? "page" : undefined}
    >
      {label}
      <span className="seg-count">{count}</span>
    </a>
  );

  return (
    <AdminShell active="comments" username={user.username}>
      <PageHeader
        title="评论"
        sub="游客评论默认进待审队列，通过之后才会出现在文章页。垃圾评论只会隐藏，删除才是真的移除。"
      />

      <nav className="seg-tabs" aria-label="评论状态筛选">
        {tab("", "全部", counts.all)}
        {tab("pending", "待审核", counts.pending)}
        {tab("approved", "已通过", counts.approved)}
        {tab("spam", "垃圾", counts.spam)}
      </nav>

      {rows.length === 0 ? (
        <Empty
          title={status ? "这个状态下没有评论" : "还没有评论"}
          hint={status
            ? "换个状态看看，或者切回「全部」。"
            : "文章页底部的评论区接通的是 Artalk，评论会先落到待审队列。"}
          actions={status ? <Link className="btn btn-sm" href="/admin/comments">看全部评论</Link> : undefined}
        />
      ) : (
        <div className="data-panel">
          {rows.map((c) => {
            const parent = c.parent_id ? byId.get(c.parent_id) : null;
            const st = STATUS_LABEL[c.status] ?? { text: c.status, tone: "neutral" as const };
            return (
              <div key={c.id} style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: ".8rem", color: "var(--text-p3)", marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <strong style={{ color: "var(--text-p0)" }}>{c.author}</strong>
                  <Badge tone={st.tone} dot>{st.text}</Badge>
                  <span>· {c.post_title}</span>
                  <span>· {formatIn(c.created_at, "datetime")}</span>
                  <span style={{ color: "var(--text-p4)" }}>· {c.ip}</span>
                  {parent ? <span style={{ color: "var(--link)" }}>· 回复 {parent.author}</span> : null}
                </div>
                {parent ? (
                  <div style={{
                    fontSize: ".78rem", color: "var(--text-p4)", borderLeft: "1px solid var(--border-strong)",
                    paddingLeft: 10, marginBottom: 8, lineHeight: 1.7,
                  }}>{parent.content.slice(0, 100)}</div>
                ) : null}
                <div style={{ fontSize: ".88rem", color: "var(--text-p2)", marginBottom: 10, whiteSpace: "pre-wrap", lineHeight: 1.75 }}>
                  {c.content}
                </div>
                <CommentActions id={c.id} currentStatus={c.status} />
              </div>
            );
          })}
        </div>
      )}

      {pages > 1 ? (
        <div className="pager" style={{ marginTop: 16 }}>
          {page > 1 ? <Link className="btn btn-sm" href={"/admin/comments?status=" + status + "&page=" + (page - 1)}>上一页</Link> : null}
          <span className="btn btn-sm" style={{ pointerEvents: "none", opacity: .6 }}>{page} / {pages}</span>
          {page < pages ? <Link className="btn btn-sm" href={"/admin/comments?status=" + status + "&page=" + (page + 1)}>下一页</Link> : null}
        </div>
      ) : null}
    </AdminShell>
  );
}
