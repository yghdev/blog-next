import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader, Empty, StatCard, SectionHead, State } from "@/components/admin/ui";
import { QuickCapture } from "@/components/admin/QuickCapture";
import { formatIn } from "@/lib/time";
import { labelFor, TYPE_LABEL, type ContentType } from "@/lib/admin-content";
import {
  IconArchive, IconChat, IconComment, IconFolder, IconPen,
} from "@/components/admin/editor-icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "概览" };

const asType = (t: string): ContentType =>
  t === "shuoshuo" ? "shuoshuo" : t === "page" ? "page" : "post";

type Row = {
  id: number;
  type: string;
  title: string;
  body: string;
  status: string;
  updated_at: string;
  slug: string;
  has_draft: number;
};

/**
 * 概览 = 创作者工作台，不是数据仪表盘。
 *
 * 版面按「有没有草稿」分成两种状态，而不是永远摆一张注定为空的大卡片：
 *
 *   有草稿                              没有草稿
 *   ┌ 接着上次的草稿（主视觉）┐          ┌ 随手记一句（速记框）┐
 *   ├ 五张统计入口卡 ────────┤          ├ 五张统计入口卡 ────┤
 *   ├ 其他草稿 ┬ 最近编辑 ───┤          └ 最近编辑（整行）──┘
 *
 * 没有草稿时不再显示「回到最近编辑」——那句话只说明"你没有草稿"，
 * 却占掉首屏最贵的一块位置。这块位置改放速记框：立即可用，存下来
 * 就是一条说说草稿，走的是和编辑器完全相同的写入通路。
 * 下方两栏同时并成一栏，最近编辑拿到整行宽度，不再被空栏挤压。
 *
 * 所有数字都来自真实查询。没有示例数据、没有为了填满版面而画的图表。
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
  /** slug 用来判断能否预览；has_draft 让「已发布但有未发布改动」可被标记 */
  const cols = "posts.id, posts.type, posts.slug, posts.status, posts.updated_at, " +
    "(SELECT COUNT(*) FROM post_drafts dd WHERE dd.post_id = posts.id) AS has_draft, ";
  const recent = db.prepare(
    "SELECT " + cols + titleExpr + " AS title, " + bodyExpr + " AS body " + joinDraft +
    " WHERE posts.deleted_at IS NULL ORDER BY posts.updated_at DESC LIMIT 6"
  ).all() as Row[];

  const drafts = db.prepare(
    "SELECT " + cols + titleExpr + " AS title, " + bodyExpr + " AS body " + joinDraft +
    " WHERE posts.status='draft' AND posts.deleted_at IS NULL ORDER BY posts.updated_at DESC LIMIT 8"
  ).all() as Row[];

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

  const [topDraft, ...otherDrafts] = drafts;

  /** 能预览的条件：已发布、有公开地址、且不是还没换 slug 的壳 */
  const previewHref = (r: Row): string | null => {
    if (r.status !== "published") return null;
    if (r.type !== "post" && r.type !== "page") return null;
    if (!r.slug || r.slug.startsWith("draft-")) return null;
    return r.type === "page" ? "/" + encodeURIComponent(r.slug) : "/p/" + r.id;
  };

  return (
    <AdminShell active="overview" username={user.username}>
      <PageHeader
        eyebrow="工作台"
        title="概览"
        sub="草稿只存在草稿区，点发布才会出现在前台。"
      />

      {/* ── 首屏主位：有草稿就继续写，没有草稿就把这块位置交给速记 ── */}
      {topDraft ? (
        <section className="continue-card">
          <div className="continue-copy">
            <span className="section-eyebrow">
              接着上次的草稿 · {TYPE_LABEL[asType(topDraft.type)]}
            </span>
            <h2>{shown(topDraft)}</h2>
            <p>
              最后编辑 {formatIn(topDraft.updated_at, "datetime")}
              {drafts.length > 1 ? <> · 还有 {drafts.length - 1} 份草稿</> : null}
            </p>
          </div>
          <div className="continue-actions">
            <Link className="btn btn-primary" href={"/admin/edit/" + topDraft.id}>继续编辑</Link>
            <Link className="btn btn-ghost" href="/admin?status=draft">全部草稿</Link>
          </div>
        </section>
      ) : (
        <section className="quick-capture-card" aria-label="速记">
          <div className="quick-capture-intro">
            <span className="section-eyebrow">还没有未完成的草稿</span>
            <h2>随手记一句。</h2>
            <p>灵感不必等到有标题。存下来就是一条说说草稿，之后再决定发不发。</p>
          </div>
          <QuickCapture />
        </section>
      )}

      {/* ── 统计：五个入口，每张卡整块可点，直接去对应的管理列表 ── */}
      <div className="stat-grid" role="group" aria-label="内容概况">
        <StatCard label="文章" value={typeCounts.post} href="/admin" icon={<IconPen size={16} />} hint="进入文章列表" />
        <StatCard label="说说" value={typeCounts.shuoshuo} href="/admin/shuoshuo" icon={<IconChat size={16} />} hint="进入说说列表" />
        <StatCard label="页面" value={typeCounts.page} href="/admin/pages" icon={<IconFolder size={16} />} hint="进入页面列表" />
        <StatCard
          label="待审评论" value={pending} href="/admin/comments?status=pending"
          icon={<IconComment size={16} />} alert={pending > 0} hint="进入待审评论"
        />
        <StatCard label="回收站" value={trash} href="/admin/trash" icon={<IconArchive size={16} />} hint="进入回收站" />
      </div>

      {/* ── 下方两栏：有草稿时左栏列其余草稿；没有草稿时整行给最近编辑 ── */}
      <div className={"overview-grid" + (otherDrafts.length ? "" : " is-single")}>
        {otherDrafts.length ? (
          <section className="work-section">
            <SectionHead
              title="其他草稿"
              action={<Link href="/admin?status=draft">全部草稿</Link>}
            />
            <div className="work-list">
              {otherDrafts.map((d) => (
                <div className="work-row" key={d.id}>
                  <Link className="work-row-main" href={"/admin/edit/" + d.id}>
                    <span className="work-item-title">{shown(d)}</span>
                    <span className="work-item-date">{formatIn(d.updated_at, "date")}</span>
                  </Link>
                  <span className="work-row-actions">
                    <Link className="work-action" href={"/admin/edit/" + d.id}>继续编辑</Link>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="work-section">
          <SectionHead title="最近编辑" action={<Link href="/admin">全部内容</Link>} />
          {recent.length ? (
            <div className="work-list">
              {recent.map((r) => {
                const preview = previewHref(r);
                return (
                  <div className="work-row" key={r.id}>
                    <Link className="work-row-main" href={"/admin/edit/" + r.id}>
                      <span className="work-type">{TYPE_LABEL[asType(r.type)]}</span>
                      <span className="work-item-title">{shown(r)}</span>
                      {r.has_draft > 0 && r.status === "published" ? (
                        <span className="work-draft-mark" title="有未发布的改动">有改动</span>
                      ) : null}
                      <State status={r.status === "published" ? "published" : "draft"} />
                      <span className="work-item-date">{formatIn(r.updated_at, "date")}</span>
                    </Link>
                    <span className="work-row-actions">
                      {preview ? (
                        <a
                          className="work-action"
                          href={preview}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={"预览：" + shown(r)}
                        >
                          预览
                        </a>
                      ) : null}
                      <Link
                        className="work-action is-primary"
                        href={"/admin/edit/" + r.id}
                        aria-label={"编辑：" + shown(r)}
                      >
                        编辑
                      </Link>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty
              title="还没有内容"
              hint="写下的第一篇会出现在这里。也可以先从上面的速记框写一句。"
              actions={<Link className="btn btn-sm" href="/admin/new">写第一篇</Link>}
            />
          )}
        </section>
      </div>
    </AdminShell>
  );
}
