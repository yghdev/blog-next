import Link from "next/link";
import { PageHeader, Empty } from "./ui";
import { ContentList } from "./ContentList";
import { loadContentList, type ContentType } from "@/lib/admin-content";
import { dateKeyIn } from "@/lib/time";

/**
 * 内容列表页的共享外壳（文章 / 说说 / 页面 / 回收站）。
 *
 * 四个页面只在「取哪些类型」和「文案」上不同，骨架必须一模一样：
 * PageHeader → 状态分段 + 搜索 → 列表 → 分页。任何一处单独改，
 * 用户就会在切换栏目时遇到两套不一致的交互。
 *
 * 工具栏里**没有类型下拉**：类型已经是路由了。留着它等于让用户
 * 在「文章的页面」里筛出页面 —— 那是两个互相矛盾的导航维度。
 */
export type ContentViewProps = {
  type?: ContentType;
  basePath: string;
  title: string;
  eyebrow: string;
  sub: string;
  trash?: boolean;
  searchParams: { page?: string; status?: string; q?: string };
  variant?: "title" | "body";
  showType?: boolean;
  /** 敏感操作是否需要两步验证（删除类动作） */
  stepUpRequired?: boolean;
  emptyTitle: string;
  emptyHint: string;
  emptyAction?: { href: string; label: string };
  newAction?: { href: string; label: string };
};

export function ContentView({
  type, basePath, title, eyebrow, sub, trash = false,
  searchParams, variant = "title", showType = false, stepUpRequired = false,
  emptyTitle, emptyHint, emptyAction, newAction,
}: ContentViewProps) {
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const status = searchParams.status ?? "";
  const q = (searchParams.q ?? "").trim();

  const data = loadContentList({ type, status, q, page, trash });

  const link = (next: { status?: string; page?: number }) => {
    const u = new URLSearchParams();
    const s = next.status !== undefined ? next.status : status;
    if (s) u.set("status", s);
    if (q) u.set("q", q);
    if (trash) u.set("trash", "1");
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const qs = u.toString();
    return basePath + (qs ? "?" + qs : "");
  };

  const filtered = !!(q || status);

  return (
    <>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        count={
          <>
            {data.total} 条
            {q ? <span className="fx-filter-note">· 搜索「{q}」</span> : null}
          </>
        }
        sub={sub}
        actions={newAction ? <Link href={newAction.href} className="btn btn-sm">{newAction.label}</Link> : null}
      />

      <div className="content-toolbar">
        {!trash ? (
          <nav className="seg-tabs" aria-label="按发布状态筛选">
            {[
              { key: "", label: "全部", count: data.counts.all },
              { key: "published", label: "已发布", count: data.counts.published },
              { key: "draft", label: "草稿", count: data.counts.draft },
            ].map((t) => {
              const active = status === t.key;
              return (
                <Link
                  key={t.key || "all"}
                  href={link({ status: t.key, page: 1 })}
                  className={active ? "is-active" : undefined}
                  aria-current={active ? "true" : undefined}
                >
                  {t.label}<span className="seg-count">{t.count}</span>
                </Link>
              );
            })}
          </nav>
        ) : <span className="content-toolbar-fill" />}

        <form className="content-tools" action={basePath} method="get">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {trash ? <input type="hidden" name="trash" value="1" /> : null}
          <label className="content-search">
            <span className="sr-only">{variant === "body" ? "搜索说说正文" : "搜索标题或路径"}</span>
            <input
              className="input"
              type="search"
              name="q"
              defaultValue={q}
              placeholder={variant === "body" ? "搜索说说正文" : "搜索标题或路径"}
            />
          </label>
          <button className="btn btn-sm" type="submit">筛选</button>
          {filtered ? <Link className="content-clear" href={basePath}>清除</Link> : null}
        </form>
      </div>

      {data.rows.length === 0 ? (
        <Empty
          title={filtered ? "没有匹配的内容" : emptyTitle}
          hint={filtered ? (variant === "body" ? "试试清除搜索词或状态筛选。" : "试试清除搜索词或状态筛选。") : emptyHint}
          actions={filtered
            ? <Link className="btn btn-sm" href={basePath}>回到全部</Link>
            : emptyAction
              ? <Link className="btn btn-primary btn-sm" href={emptyAction.href}>{emptyAction.label}</Link>
              : undefined}
        />
      ) : (
        <ContentList
          variant={variant}
          showType={showType}
          trash={trash}
          stepUpRequired={stepUpRequired}
          items={data.rows.map((r) => ({
            id: r.id,
            type: r.type,
            label: r.label,
            excerpt: r.excerpt,
            chars: r.chars,
            status: r.status,
            dateLabel: r.status === "published" && r.publishedAt ? dateKeyIn(r.publishedAt) : "未发布",
            revision: r.revision,
            hasDraft: r.hasDraft,
            hasImage: r.hasImage,
          }))}
        />
      )}

      {data.pages > 1 ? (
        <div className="pager list-pager">
          {page > 1 ? <Link className="btn btn-sm" href={link({ page: page - 1 })}>上一页</Link> : null}
          <span className="pager-current" aria-current="page">{page} / {data.pages}</span>
          {page < data.pages ? <Link className="btn btn-sm" href={link({ page: page + 1 })}>下一页</Link> : null}
        </div>
      ) : null}
    </>
  );
}
