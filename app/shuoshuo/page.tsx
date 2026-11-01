import { Animations } from "@/components/Animations";
import { SiteShell } from "@/components/SiteShell";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { formatDate } from "@/components/PostCard";
import { listShuoshuoCached } from "@/lib/cached";
import { renderMarkdown } from "@/lib/markdown";

export const dynamic = "force-dynamic";
export const metadata = { title: "说说" };

export default async function ShuoshuoPage() {
  const items = await listShuoshuoCached(100);
  return (
    <>
      <Animations />
      <SiteShell variant="three-col">
        <PageHeader title="说说" />
        <div>
          {items.length === 0 ? (
            <EmptyState
              title="还没有说说"
              hint="说说适合发短句和碎片想法。在后台新建内容时把类型选成「说说」就会出现在这里。"
              actions={<a className="btn btn-sm" href="/admin/new">去写一条</a>}
            />
          ) : items.map((s) => (
            <div key={s.id} className="shuo-item slide-up">
              <div className="shuo-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.content).html }} />
              <div className="shuo-date">{formatDate(s.published_at || s.created_at)}</div>
            </div>
          ))}
        </div>
      </SiteShell>
    </>
  );
}
