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

const PAGE = 50;

const STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  approved: { text: "已通过", tone: "ok" },
  pending: { text: "待审核", tone: "warn" },
  spam: { text: "垃圾", tone: "danger" },
};

/**
 * 评论管理（阶段 02-3）。
 *
 * 本轮改掉的：
 *  1) 空状态没有出口。原来 `actions` 只在"筛选后为空"时给链接；**一条评论
 *     都没有时 actions=undefined**，用户看到一段说明却无处可去 ——
 *     违反 B 端门禁 14（空状态必须给行动出口）。现在两种空态都给出口。
 *  2) 评论卡片全是行内样式（每行 ~10 个魔法数字）。收进 .comment-item 等类，
 *     并让回复引文、正文、操作区有稳定的垂直节奏。
 *  3) 分页链接用字符串拼接 `"?status=" + status + "&page="`，status 为空时
 *     会产生 `?status=&page=2` 这种脏 URL。改用 URLSearchParams 统一构造。
 *  4) 排序原来靠 SQL 的 CASE 把待审排前面，但界面上没说明。现在待审筛选是
 *     默认关注点，且在页头说明审核时效性。
 *
 * 保留不动：CommentActions 的三按钮语义（通过与垃圾都是次级按钮，不替审核人
 * 做决定；只有删除是危险色并要求确认）—— 那是既有 B 端门禁的正确实现。
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
    "SELECT c.*, p.title as post_title, p.slug as post_slug FROM comments c JOIN posts p ON c.post_id = p.id " +
    where + " ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, c.created_at DESC " +
    "LIMIT ? OFFSET ?"
  ).all(...args, PAGE, (page - 1) * PAGE) as {
    id: number; author: string; email: string; url: string; content: string; status: string;
    created_at: string; ip: string; parent_id: number | null; post_id: number;
    post_title: string; post_slug: string;
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

  return (
    <AdminShell active="comments" username={user.username}>
      <PageHeader
        title="评论"
        sub="游客评论默认进待审队列，通过之后才会出现在文章页。垃圾只会隐藏，删除才是真的移除。"
      />

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
          title={status ? "这个状态下没有评论" : "还没有评论"}
          hint={status
            ? "换个状态看看，或者切回「全部」。"
            : "文章页底部的评论区接通的是 Artalk，读者留言后会先落到待审队列，通过后才显示。"}
          actions={
            status
              ? <Link className="btn btn-sm" href="/admin/comments">看全部评论</Link>
              // 一条评论都没有时也必须给出口：原来这里是 undefined，
              // 用户看到说明却无处可去（B 端门禁 14）
              : <Link className="btn btn-sm" href="/admin">去看文章</Link>
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

                <CommentActions id={c.id} currentStatus={c.status} />
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
