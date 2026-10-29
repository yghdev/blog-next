import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader, Empty, EmptyLine, Figure, SectionHead, State } from "@/components/admin/ui";
import { formatIn } from "@/lib/time";
import { labelFor, type ContentType } from "@/lib/admin-content";

export const dynamic = "force-dynamic";
export const metadata = { title: "概览" };

const asType = (t: string): ContentType =>
  t === "shuoshuo" ? "shuoshuo" : t === "page" ? "page" : "post";

/**
 * 概览 = 创作者工作台，不是数据仪表盘。
 *
 * 三种数据流：
 *   1. 继续写作（主视觉）—— 最近的草稿，没有草稿就退回最近编辑
 *   2. 待处理事项 —— 待审评论、回收站，只有真的 > 0 才出现，不占常驻位置
 *   3. 两个列表 —— 未发布草稿 / 最近编辑
 *
 * 所有数字都来自真实查询。没有任何示例数据、没有任何为了填满版面而画的图表 ——
 * 空库时页面给空状态与出口，而不是显示几个 0 的彩色卡片。
 */
export default async function OverviewPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const db = getDb();
  /**
   * 标题取草稿快照优先。
   *
   * 新文章建的是壳，posts.title 为空串，用户写的标题在 post_drafts.snapshot_json 里。
   * 若只读 posts.title，用户看到自己刚写的草稿显示成「(未命名)」——
   * 那会让人以为内容没存上。这里用 COALESCE 把草稿标题顶上来。
   */
  const titleExpr = "COALESCE(NULLIF(json_extract(d.snapshot_json,'$.title'),''), NULLIF(posts.title,''))";
  /**
   * 说说没有标题 —— 它在这里也必须显示正文，否则概览会出现「(未命名)」。
   * 取草稿正文优先（草稿才是「我刚写的那句」），长度够喂 labelFor 即可。
   */
  const bodyExpr = "COALESCE(NULLIF(json_extract(d.snapshot_json,'$.content'),''), NULLIF(posts.content,''))";
  const joinDraft = "FROM posts LEFT JOIN post_drafts d ON d.post_id = posts.id";

  const recent = db.prepare(
    "SELECT posts.id, posts.type, " + titleExpr + " AS title, " + bodyExpr + " AS body, " +
    "posts.status, posts.updated_at " + joinDraft +
    " WHERE posts.deleted_at IS NULL ORDER BY posts.updated_at DESC LIMIT 6"
  ).all() as { id: number; type: string; title: string; body: string; status: string; updated_at: string }[];

  const drafts = db.prepare(
    "SELECT posts.id, posts.type, " + titleExpr + " AS title, " + bodyExpr + " AS body, posts.updated_at " + joinDraft +
    " WHERE posts.status='draft' AND posts.deleted_at IS NULL ORDER BY posts.updated_at DESC LIMIT 8"
  ).all() as { id: number; type: string; title: string; body: string; updated_at: string }[];

  /** 概览与列表页共用同一套文案规则：说说取正文，文章取标题 */
  const shown = (r: { type: string; title: string; body: string }) => labelFor(asType(r.type), r.title, r.body);

  const pending = (db.prepare("SELECT COUNT(*) c FROM comments WHERE status='pending'").get() as { c: number }).c;
  const trash = (db.prepare("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NOT NULL").get() as { c: number }).c;
  /**
   * 分类型的计数。
   *
   * 拆页前这里只有「已发布 / 草稿」两个总数，且都链到 /admin —— 那是唯一
   * 的列表，数字一定对得上。拆成三条列表后继续显示总数就会骗人：
   * 「已发布 2」点进去只看到 1 篇文章（另一条是说说）。
   * 所以改成按类型分别计数，每一格都指向**它自己那条列表**，点开数量吻合。
   */
  const countBy = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const typeCounts = {
    post: countBy("SELECT COUNT(*) c FROM posts WHERE type='post' AND deleted_at IS NULL"),
    shuoshuo: countBy("SELECT COUNT(*) c FROM posts WHERE type='shuoshuo' AND deleted_at IS NULL"),
    page: countBy("SELECT COUNT(*) c FROM posts WHERE type='page' AND deleted_at IS NULL"),
  };

  const primary = drafts[0] ?? recent[0];
  const primaryIsDraft = drafts.length > 0;

  return (
    <AdminShell active="overview" username={user.username}>
      <PageHeader
        eyebrow="工作台"
        title="继续写"
        sub="草稿只存在草稿区，点发布才会出现在前台。"
      />

      {/* ── 主视觉：继续上次的工作 ── */}
      {primary ? (
        <section className="continue-card">
          <div className="continue-copy">
            <span className="section-eyebrow">{primaryIsDraft ? "接着上次的草稿" : "回到最近编辑"}</span>
            <h2>{shown(primary)}</h2>
            <p>最后编辑 {formatIn(primary.updated_at, "datetime")}</p>
          </div>
          <Link className="btn btn-primary" href={"/admin/edit/" + primary.id}>继续编辑</Link>
        </section>
      ) : (
        <section className="continue-card">
          <div className="continue-copy">
            <span className="section-eyebrow">从这里开始</span>
            <h2>写下下一篇。</h2>
            <p>还没有任何内容。第一篇不需要准备好，先写开头一句就行。</p>
          </div>
          <Link className="btn btn-primary" href="/admin/new">开始写作</Link>
        </section>
      )}

      {/* ── 待处理：只有真的有事才出现，避免常驻的位置长期是 0 ── */}
      {(pending > 0 || trash > 0) ? (
        <div className="task-links" aria-label="待处理事项">
          {pending > 0 ? (
            <Link href="/admin/comments?status=pending">
              <strong>{pending}</strong> 条评论待审核<span>去处理</span>
            </Link>
          ) : null}
          {trash > 0 ? (
            <Link href="/admin/trash">
              <strong>{trash}</strong> 条内容在回收站<span>查看</span>
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* ── 统计：一行数字，不做彩色卡片 ── */}
      <div className="fx-figure-row" role="group" aria-label="内容概况">
        <Figure label="文章" value={typeCounts.post} href="/admin" />
        <Figure label="说说" value={typeCounts.shuoshuo} href="/admin/shuoshuo" />
        <Figure label="页面" value={typeCounts.page} href="/admin/pages" />
        <Figure label="待审评论" value={pending} href="/admin/comments?status=pending" alert={pending > 0} />
        <Figure label="回收站" value={trash} href="/admin/trash" />
      </div>

      {/* ── 下方两栏：草稿优先，最近编辑其次 ── */}
      <div className="overview-grid" style={{ marginTop: 40 }}>
        <section className="work-section">
          <SectionHead
            title="未发布草稿"
            action={drafts.length ? <Link href="/admin?status=draft">全部草稿</Link> : undefined}
          />
          {drafts.length ? (
            <div className="work-list">
              {drafts.map((d) => (
                <Link key={d.id} className="work-item" href={"/admin/edit/" + d.id}>
                  <span className="work-item-title">{shown(d)}</span>
                  <span className="work-item-date">{formatIn(d.updated_at, "date")}</span>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyLine>没有未完成的草稿。<Link href="/admin/new">开一篇新的</Link></EmptyLine>
          )}
        </section>

        <section className="work-section">
          <SectionHead title="最近编辑" action={<Link href="/admin">全部内容</Link>} />
          {recent.length ? (
            <div className="work-list">
              {recent.map((r) => (
                <Link key={r.id} className="work-item" href={"/admin/edit/" + r.id}>
                  <span className="work-item-title">{shown(r)}</span>
                  <State status={r.status === "published" ? "published" : "draft"} />
                  <span className="work-item-date">{formatIn(r.updated_at, "date")}</span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="还没有内容"
              hint="写下的第一篇会出现在这里。"
              actions={<Link className="btn btn-sm" href="/admin/new">写第一篇</Link>}
            />
          )}
        </section>
      </div>
    </AdminShell>
  );
}
