import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { Animations } from "@/components/Animations";
import { RightBar } from "@/components/RightBar";
import { listArchivesCached } from "@/lib/cached";
import { dateKeyIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "归档" };

/**
 * B4：原实现按年分组（published_at.slice(0,4)）却把变量命名为 ym，
 * 月度维度整体丢失。现在按 年 -> 月 两级展示，且日期按展示时区计算。
 */
export default async function ArchivesPage() {
  const groups = await listArchivesCached();
  return (
    <>
      <Animations />
      <div className="site-shell">
        <Sidebar active="/archives" />
        <main className="content">
          <h1 className="page-title">归档</h1>
          {groups.length === 0 ? (
            <div className="empty-block">
              <div className="empty-title">归档还是空的</div>
              <div className="empty-hint">归档按月分组，只统计已发布的文章。草稿不会出现在这里。</div>
              <div className="empty-actions">
                <a className="btn btn-sm" href="/admin/new">写第一篇</a>
              </div>
            </div>
          ) : null}
          {groups.map((g) => (
            <section key={g.year}>
              <h2 className="archive-year">
                {g.year}
                <span style={{ fontSize: ".72rem", color: "var(--text-p4)", marginLeft: 8, fontWeight: 400 }}>
                  {g.count} 篇
                </span>
              </h2>
              {g.months.map((m) => (
                <div key={m.ym} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: ".78rem", color: "var(--text-p4)", margin: "6px 0 4px" }}>{m.label}</div>
                  {m.posts.map((p) => (
                    <div key={p.id} className="archive-item slide-up">
                      <span className="date">
                        {dateKeyIn(p.published_at || p.created_at).slice(5).replace("-", "/")}
                      </span>
                      <Link href={"/" + encodeURIComponent(p.slug)}>{p.title}</Link>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </main>
        <div className="toc-col"><RightBar /></div>
      </div>
    </>
  );
}
