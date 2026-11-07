import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader, Badge, Empty } from "@/components/admin/ui";
import { ARTALK_ADMIN_URL } from "@/lib/site-stats";
import { formatIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "评论（历史）" };

const PAGE = 50;

const STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  approved: { text: "已通过", tone: "ok" },
  pending: { text: "待审核", tone: "warn" },
  spam: { text: "垃圾", tone: "danger" },
};

/**
 * 评论历史（2026-11-07 起**只读**，P0-7）。
 *
 * ## 为什么拿掉了「通过 / 垃圾 / 删除」
 *
 * 前台评论区从 2026-10 起接的是 Artalk（独立容器 + 独立 SQLite），
 * 本地 `comments` 表**早就不再收到新评论**。但旧页面还在提供审核按钮：
 * 点下去只改本地表，读者看到的评论区毫无变化 —— 等于给运营者一个
 * "我审过了"的错觉（概览页的「待审评论」也数本地表，永远是 0）。
 *
 * 现在职责划清：
 *   · 审核 / 删除 / 封禁 → Artalk 面板（ARTALK_ADMIN_URL）；
 *   · 这一页 → **只读历史**，查看旧版本写入本地表的数据。
 *     保留它是因为这里能看到 Artalk 不展示的 `ip` / `ua`，
 *     真出事（刷评论、冒名）时是唯一能取证的原始记录。
 *
 * 状态筛选 / 分页 / 分段计数都保留：只读不等于什么都看不到。
 * 空的 `comments` 表不代表出错，所以空态文案要把这一点说清楚，并给出出口。
 */
export default async function CommentsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const status = sp.status ?? "";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

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
    "SELECT c.*, p.title as post_title FROM comments c JOIN posts p ON c.post_id = p.id " +
    where + " ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, c.created_at DESC " +
    "LIMIT ? OFFSET ?"
  ).all(...args, PAGE, (page - 1) * PAGE) as {
    id: number; author: string; email: string; url: string; content: string; status: string;
    created_at: string; ip: string; parent_id: number | null; post_id: number; post_title: string;
  }[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const pages = Math.max(1, Math.ceil(total / PAGE));

  /** 统一构造筛选与分页链接，避免 status 为空时拼出 "?status=&page=2" */
  const link = (next: { status?: string; page?: number }) => {
    const u = new URLSearchParams();
    const s = next.status !== undefined ? next.status : status;
    if (s) u.set("status", s);
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const q = u.toString();
    return "/admin/comments" + (q ? "?" + q : "");
  };

  const tabs = [
    { key: "", label: "全部", count: counts.all },
    { key: "pending", label: "待审核", count: counts.pending },
    { key: "approved", label: "已通过", count: counts.approved },
    { key: "spam", label: "垃圾", count: counts.spam },
  ];

  const artalkLink = (
    <a className="btn btn-sm" href={ARTALK_ADMIN_URL} target="_blank" rel="noopener noreferrer">
      去 Artalk 审核
    </a>
  );

  return (
    <AdminShell active="comments" username={user.username}>
      <PageHeader
        title="评论"
        count={total}
        sub="只读历史。评论现在由 Artalk 管理，本地表已停止写入；审核、删除、封禁都在 Artalk 后台做。"
        actions={artalkLink}
      />

      <div className="notice notice-info">
        <strong>本页只读。</strong>
        这里展示的是<strong>旧版本</strong>写入博客自有 <code>comments</code> 表的历史评论（<code>ip</code> / <code>ua</code> 只有这里有，
        取证时用得上）。2026-11 起前台评论区接的是 Artalk，审核与删除都在
        <a href={ARTALK_ADMIN_URL} target="_blank" rel="noopener noreferrer">Artalk 后台</a>
        做 —— 本页不再提供任何写操作。
      </div>

      <nav className="seg-tabs" aria-label="评论状态筛选">
        {tabs.map((t) => {
          const active = status === t.key;
          return (
            <Link
              key={t.key || "all"}
              href={link({ status: t.key, page: 1 })}
              className={active ? "is-active" : undefined}
              aria-current={active ? "true" : undefined}
            >
              {t.label}
              <span className="seg-count">{t.count}</span>
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <Empty
          title={status ? "这个状态下没有历史评论" : "还没有历史评论"}
          hint={status
            ? "换个状态看看，或者切回「全部」。新评论不会出现在这里 —— 它们进的是 Artalk。"
            : "本地 comments 表只在旧版本里写入过数据；空的表是正常状态。真实评论在 Artalk 后台。"}
          actions={
            status
              ? <Link className="btn btn-sm" href="/admin/comments">看全部</Link>
              : artalkLink
          }
        />
      ) : (
        <div className="data-panel">
          {rows.map((c) => {
            const parent = c.parent_id ? byId.get(c.parent_id) : null;
            const st = STATUS_LABEL[c.status] ?? { text: c.status, tone: "neutral" as const };
            return (
              <div key={c.id} className="comment-item">
                <div className="comment-item-head">
                  <strong className="comment-author-name">{c.author}</strong>
                  <Badge tone={st.tone} dot>{st.text}</Badge>
                  <Link className="comment-item-post" href={"/p/" + c.post_id}>
                    {c.post_title}
                  </Link>
                  <span className="comment-item-meta">{formatIn(c.created_at, "datetime")}</span>
                  <span className="comment-item-meta">{c.ip}</span>
                  {parent ? <span className="comment-item-reply">回复 {parent.author}</span> : null}
                </div>

                {parent ? (
                  <blockquote className="comment-item-quote">{parent.content.slice(0, 100)}</blockquote>
                ) : null}

                <div className="comment-item-body">{c.content}</div>
              </div>
            );
          })}
        </div>
      )}

      {pages > 1 ? (
        <div className="pager list-pager">
          {page > 1 ? <Link className="btn btn-sm" href={link({ page: page - 1 })}>上一页</Link> : null}
          <span className="btn btn-sm pager-current" aria-current="page">{page} / {pages}</span>
          {page < pages ? <Link className="btn btn-sm" href={link({ page: page + 1 })}>下一页</Link> : null}
        </div>
      ) : null}
    </AdminShell>
  );
}
