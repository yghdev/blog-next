import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader, Card, Kpi, Badge, Empty } from "@/components/admin/ui";
import { StatBar } from "@/components/ui/StatBar";
import { formatIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "概览" };

/**
 * 概览（阶段 02，方案 §9.1）。
 *
 * 只放**可行动的信息**：未发布草稿、最近编辑、待审评论、回收站、
 * 存储异常。不做装饰性访问量大屏 —— 那些数字好看但不改变任何决定，
 * 占着首屏最贵的位置。
 *
 * 每个区块都必须回答"我接下来该做什么"；回答不了就不放，
 * 这也是为什么这里没有"本月发文数趋势"之类的东西。
 */
export default async function OverviewPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const db = getDb();
  const count = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...args) as { c: number }).c;

  const stats = {
    drafts: count("SELECT COUNT(*) c FROM posts WHERE status='draft' AND deleted_at IS NULL"),
    published: count("SELECT COUNT(*) c FROM posts WHERE status='published' AND deleted_at IS NULL"),
    trash: count("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NOT NULL"),
    pending: count("SELECT COUNT(*) c FROM comments WHERE status='pending'"),
    // 媒体表里登记了但磁盘文件已不在的，属于"存储异常"，需要人去看一眼
    media: count("SELECT COUNT(*) c FROM media"),
  };

  const recent = db.prepare(
    "SELECT id, title, slug, status, updated_at FROM posts " +
    "WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 6"
  ).all() as { id: number; title: string; slug: string; status: string; updated_at: string }[];

  const drafts = db.prepare(
    "SELECT id, title, type, updated_at FROM posts " +
    "WHERE status='draft' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5"
  ).all() as { id: number; title: string; type: string; updated_at: string }[];

  const pendingComments = db.prepare(
    "SELECT c.id, c.author, c.content, c.created_at, p.title AS post_title " +
    "FROM comments c JOIN posts p ON c.post_id = p.id " +
    "WHERE c.status='pending' ORDER BY c.created_at DESC LIMIT 4"
  ).all() as { id: number; author: string; content: string; created_at: string; post_title: string }[];

  const nothingToDo = stats.drafts === 0 && stats.pending === 0 && stats.trash === 0;

  return (
    <AdminShell active="overview" username={user.username}>
      <PageHeader
        title="概览"
        sub="这里只放需要你动手的事。没有待办就说明可以安心去写东西。"
        actions={<Link href="/admin/new" className="btn btn-primary btn-sm">写文章</Link>}
      />

      <div className="kpi-row">
        <Kpi label="未发布草稿" value={stats.drafts} href="/admin?status=draft" alert={stats.drafts > 0} />
        <Kpi label="待审评论" value={stats.pending} href="/admin/comments?status=pending" alert={stats.pending > 0} />
        <Kpi label="回收站" value={stats.trash} href="/admin?trash=1" alert={stats.trash > 0} />
        <Kpi label="已发布" value={stats.published} href="/admin?status=published" />
      </div>

      {nothingToDo ? (
        <Card>
          <Empty
            title="没有待处理事项"
            hint="草稿、待审评论和回收站都是空的。可以去写点新东西，或者翻翻下面的最近编辑。"
            actions={<Link href="/admin/new" className="btn btn-primary btn-sm">写一篇</Link>}
          />
        </Card>
      ) : null}

      <div className="overview-grid">
        {/* 未发布草稿：这是最容易被遗忘的一类内容，单独列出来 */}
        {drafts.length ? (
          <Card title="未发布草稿" desc="写完没发的内容。放着不动会一直提醒你。">
            <div className="overview-list">
              {drafts.map((d) => (
                <Link key={d.id} className="overview-item" href={"/admin/edit/" + d.id}>
                  <span className="overview-item-main">{d.title || "(未命名草稿)"}</span>
                  <span className="overview-item-meta">{formatIn(d.updated_at, "date")}</span>
                </Link>
              ))}
            </div>
            <Link className="overview-more" href="/admin?status=draft">查看全部草稿</Link>
          </Card>
        ) : null}

        {/* 待审评论：审核是有时效的，积压等于读者被无视 */}
        {pendingComments.length ? (
          <Card title="待审评论" desc="通过或标记垃圾后读者才能看到自己的留言。">
            <div className="overview-list">
              {pendingComments.map((cm) => (
                <div key={cm.id} className="overview-comment">
                  <div className="overview-comment-head">
                    <strong>{cm.author}</strong>
                    <span className="overview-item-meta">在《{cm.post_title}》</span>
                  </div>
                  <p className="overview-comment-body">{cm.content}</p>
                </div>
              ))}
            </div>
            <Link className="overview-more" href="/admin/comments?status=pending">去审核</Link>
          </Card>
        ) : null}

        <Card title="最近编辑" desc="按最后修改时间排序，不分状态。">
          {recent.length ? (
            <div className="overview-list">
              {recent.map((r) => (
                <Link key={r.id} className="overview-item" href={"/admin/edit/" + r.id}>
                  <span className="overview-item-main">{r.title || "(未命名)"}</span>
                  <Badge tone={r.status === "published" ? "ok" : "warn"} dot>
                    {r.status === "published" ? "已发布" : "草稿"}
                  </Badge>
                  <span className="overview-item-meta">{formatIn(r.updated_at, "date")}</span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="还没有任何内容"
              hint="写下第一篇之后，这里会按修改时间列出最近动过的内容。"
              actions={<Link href="/admin/new" className="btn btn-primary btn-sm">写第一篇</Link>}
            />
          )}
          <Link className="overview-more" href="/admin">全部内容</Link>
        </Card>

        <Card title="内容构成" desc="草稿与已发布的比例，用来判断积压程度。">
          <StatBar
            ariaLabel="内容状态分布"
            segments={[
              { label: "已发布", value: stats.published, tone: "ok" },
              { label: "草稿", value: stats.drafts, tone: "warn" },
              { label: "回收站", value: stats.trash, tone: "danger" },
            ]}
          />
          <div className="overview-foot">
            媒体库共 <strong>{stats.media}</strong> 个文件 ·{" "}
            <Link href="/admin/media">管理媒体</Link>
          </div>
        </Card>
      </div>
    </AdminShell>
  );
}
