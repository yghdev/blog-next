import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { PostList } from "@/components/admin/PostList";
import { PageHeader, Kpi, Badge } from "@/components/admin/ui";
import { Empty } from "@/components/admin/ui";
import { dateKeyIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "内容" };

const PAGE_SIZE = 20;

/**
 * 内容列表（阶段 02-2：迁移到统一的分段筛选 + 列表骨架）。
 *
 * 本轮改掉的：
 *  1) 状态筛选原是两个 <select>，必须点两下才能选、点「筛选」再提交一次。
 *     改成 .seg-tabs 分段链接（与评论页同一套控件）：
 *     一次点击直达、URL 可分享、aria-current 标明当前项。
 *     方案 §9.3 明确：**筛选链接用 aria-current，不把 aria-selected 挂到
 *     普通链接上** —— 这里不是 tablist，没有对应面板。
 *  2) 底部原有一整块「待审核评论」，与 /admin/comments 重复。
 *     后台不该有两个地方做同一件事，否则迟早出现"在这处理了那边没刷新"。
 *     改为一行入口直达评论页的待审筛选。
 *  3) 行内样式收进类名（.content-toolbar / .list-head / .list-pager）。
 *
 * 保留不动：PostList 的保存/删除/批量协议与确认弹窗语义 —— 阶段 02 只动
 * 展示结构，保存协议不属于本阶段范围。
 */
export default async function AdminPage({ searchParams }: {
  searchParams: Promise<{ page?: string; type?: string; status?: string; trash?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const type = sp.type ?? "";
  const status = sp.status ?? "";
  const trash = sp.trash === "1";

  const db = getDb();
  const counts = (() => {
    const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    // 计数与当前 type 筛选联动：否则"草稿 7"点进去可能只看到 2 条，很困惑
    const typeCond = ["post", "page", "shuoshuo"].includes(type) ? " AND type = '" + type + "'" : "";
    return {
      all: c("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL" + typeCond),
      published: c("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL AND status='published'" + typeCond),
      draft: c("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL AND status='draft'" + typeCond),
      trash: c("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NOT NULL"),
      pending: c("SELECT COUNT(*) c FROM comments WHERE status='pending'"),
    };
  })();

  const where: string[] = [trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  const args: unknown[] = [];
  if (["post", "page", "shuoshuo"].includes(type)) { where.push("type = ?"); args.push(type); }
  if (["draft", "published"].includes(status)) { where.push("status = ?"); args.push(status); }
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

  /** 构造筛选链接：type 与 status 互相保留，避免点一个丢一个 */
  const link = (next: { status?: string; type?: string; page?: number }) => {
    const u = new URLSearchParams();
    const t = next.type !== undefined ? next.type : type;
    const s = next.status !== undefined ? next.status : status;
    if (t) u.set("type", t);
    if (s) u.set("status", s);
    if (trash) u.set("trash", "1");
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const q = u.toString();
    return "/admin" + (q ? "?" + q : "");
  };

  const statusTabs = [
    { key: "", label: "全部", count: counts.all },
    { key: "published", label: "已发布", count: counts.published },
    { key: "draft", label: "草稿", count: counts.draft },
  ];

  return (
    <AdminShell active={trash ? "trash" : "posts"} username={user.username}>
      <PageHeader
        title={trash ? "回收站" : "内容"}
        sub={trash
          ? "已删除但还没彻底清除的内容。恢复后立即回到前台。"
          : "文章、页面与说说。草稿只有登录后台可见，发布后前台立即生效。"}
        actions={!trash ? <Link href="/admin/new" className="btn btn-primary btn-sm">写文章</Link> : null}
      />

      {!trash ? (
        <div className="kpi-row">
          <Kpi label="全部" value={counts.all} href={link({ status: "" })} />
          <Kpi label="已发布" value={counts.published} href={link({ status: "published" })} />
          <Kpi label="草稿" value={counts.draft} href={link({ status: "draft" })} alert={counts.draft > 0} />
          <Kpi label="回收站" value={counts.trash} href="/admin?trash=1" alert={counts.trash > 0} />
        </div>
      ) : null}

      <div className="content-toolbar">
        {/* 状态用分段链接：一次点击直达，且可分享/可收藏 */}
        {!trash ? (
          <nav className="seg-tabs" aria-label="按发布状态筛选">
            {statusTabs.map((t) => {
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
        ) : null}

        {/* 类型筛选是"过滤维度"而不是"切换面板"，所以用 aria-pressed 按钮组 */}
        <div className="type-filter" role="group" aria-label="按内容类型筛选">
          {[
            { k: "", label: "全部类型" },
            { k: "post", label: "文章" },
            { k: "page", label: "页面" },
            { k: "shuoshuo", label: "说说" },
          ].map((t) => {
            const active = type === t.k;
            return (
              <Link
                key={t.k || "all"}
                href={link({ type: t.k, page: 1 })}
                className="type-filter-item"
                aria-pressed={active}
              >
                {t.label}
              </Link>
            );
          })}
        </div>

        <span className="content-toolbar-fill" />

        {!trash ? (
          <Link className="btn btn-sm" href="/admin?trash=1">
            回收站{counts.trash > 0 ? " " + counts.trash : ""}
          </Link>
        ) : (
          <Link className="btn btn-sm" href="/admin">回到内容</Link>
        )}
      </div>

      <div className="list-head">
        <h2>{trash ? "已删除" : "列表"}</h2>
        <Badge>{total} 条</Badge>
        {counts.pending > 0 ? (
          <>
            <span className="content-toolbar-fill" />
            <Link className="btn btn-sm" href="/admin/comments?status=pending">
              待审评论 {counts.pending}
            </Link>
          </>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Empty
          title={trash ? "回收站是空的" : "没有匹配的内容"}
          hint={trash
            ? "删除的内容会先放进回收站，可以在这里恢复，或者彻底清除。"
            : "换个筛选条件，或者直接写一篇新的。"}
          actions={trash
            ? <Link className="btn btn-sm" href="/admin">回到内容列表</Link>
            : <Link className="btn btn-primary btn-sm" href="/admin/new">写一篇</Link>}
        />
      ) : (
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
