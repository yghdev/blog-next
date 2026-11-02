import Link from "next/link";
import { SiteShell } from "@/components/SiteShell";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Animations } from "@/components/Animations";
import { listArchivesCached } from "@/lib/cached";
import { dateKeyIn } from "@/lib/time";
import { postHref } from "@/lib/posts";

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
      <SiteShell variant="three-col">
        <PageHeader title="归档" />
        {groups.length === 0 ? (
          <EmptyState
            title="归档还是空的"
            hint="归档按月分组，只统计已发布的文章。草稿不会出现在这里。"
            actions={<a className="btn btn-sm" href="/admin/new">写第一篇</a>}
          />
        ) : null}
        {groups.map((g) => (
          <section key={g.year}>
            <h2 className="archive-year">
              {g.year}
              <span className="archive-year-count">{g.count} 篇</span>
            </h2>
            {g.months.map((m) => (
              <div key={m.ym} className="archive-month-group">
                {/*
                  需求 8.3「月份作为二级分组」：用 h3 而不是 div。
                  视觉完全一致，但读屏用户可以用标题快捷键在「年份 → 月份」
                  之间跳转 —— 归档页正是那种"快速扫一批标题"的页面。
                */}
                <h3 className="archive-month">{m.label}</h3>
                {m.posts.map((p) => (
                  <div key={p.id} className="archive-item slide-up">
                    <span className="date">
                      {dateKeyIn(p.published_at || p.created_at).slice(5).replace("-", "/")}
                    </span>
                    <Link href={postHref(p)}>{p.title}</Link>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))}
      </SiteShell>
    </>
  );
}
