import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader, Badge, Empty } from "@/components/admin/ui";
import { formatIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "概览" };

export default async function OverviewPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const db = getDb();
  const recent = db.prepare(
    "SELECT id, title, status, updated_at FROM posts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5"
  ).all() as { id: number; title: string; status: string; updated_at: string }[];
  const drafts = db.prepare(
    "SELECT id, title, updated_at FROM posts WHERE status='draft' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 4"
  ).all() as { id: number; title: string; updated_at: string }[];
  const pending = (db.prepare("SELECT COUNT(*) c FROM comments WHERE status='pending'").get() as { c: number }).c;
  const trash = (db.prepare("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NOT NULL").get() as { c: number }).c;
  const primary = drafts[0] ?? recent[0];

  return (
    <AdminShell active="overview" username={user.username}>
      <PageHeader title="继续工作" actions={<Link href="/admin/new" className="btn btn-primary">写文章</Link>} />

      {primary ? (
        <section className="continue-card">
          <div className="continue-copy">
            <span className="section-eyebrow">{drafts.length ? "接着上次的草稿" : "回到最近编辑"}</span>
            <h2>{primary.title || "(未命名草稿)"}</h2>
            <p>最后编辑于 {formatIn(primary.updated_at, "datetime")}</p>
          </div>
          <Link className="btn btn-primary" href={"/admin/edit/" + primary.id}>继续编辑</Link>
        </section>
      ) : (
        <section className="continue-card">
          <div className="continue-copy">
            <span className="section-eyebrow">从这里开始</span>
            <h2>写下下一篇。</h2>
            <p>草稿会先保存，只有显式发布才会出现在前台。</p>
          </div>
          <Link className="btn btn-primary" href="/admin/new">写文章</Link>
        </section>
      )}

      {(pending > 0 || trash > 0) ? (
        <div className="task-links" aria-label="待处理事项">
          {pending > 0 ? <Link href="/admin/comments?status=pending"><strong>{pending}</strong> 条评论待审核<span>去处理</span></Link> : null}
          {trash > 0 ? <Link href="/admin?trash=1"><strong>{trash}</strong> 条内容在回收站<span>查看</span></Link> : null}
        </div>
      ) : null}

      <div className="overview-grid">
        <section className="work-section">
          <div className="section-heading">
            <h2>未发布草稿</h2>
            {drafts.length ? <Link href="/admin?status=draft">全部草稿</Link> : null}
          </div>
          {drafts.length ? (
            <div className="work-list">
              {drafts.map((d) => (
                <Link key={d.id} className="work-item" href={"/admin/edit/" + d.id}>
                  <span className="work-item-title">{d.title || "(未命名草稿)"}</span>
                  <span className="work-item-date">{formatIn(d.updated_at, "date")}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="work-empty">没有未完成的草稿。</p>
          )}
        </section>

        <section className="work-section">
          <div className="section-heading"><h2>最近编辑</h2><Link href="/admin">全部内容</Link></div>
          {recent.length ? (
            <div className="work-list">
              {recent.map((r) => (
                <Link key={r.id} className="work-item" href={"/admin/edit/" + r.id}>
                  <span className="work-item-title">{r.title || "(未命名)"}</span>
                  <Badge tone={r.status === "published" ? "ok" : "warn"} dot>{r.status === "published" ? "已发布" : "草稿"}</Badge>
                  <span className="work-item-date">{formatIn(r.updated_at, "date")}</span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty title="还没有内容" actions={<Link className="btn btn-sm" href="/admin/new">写第一篇</Link>} />
          )}
        </section>
      </div>
    </AdminShell>
  );
}
