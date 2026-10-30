import { Sidebar } from "@/components/Sidebar";
import { PostCard } from "@/components/PostCard";
import { Animations } from "@/components/Animations";
import { SearchBox } from "@/components/SearchBox";
import { RightBar } from "@/components/RightBar";
import { parseJsonArray, makeExcerpt, readingTime, postHref } from "@/lib/posts";
import { listPostsCached, countPostsCached, getViewsMapCached } from "@/lib/cached";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export default async function HomePage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page || "1", 10) || 1);
  const posts = await listPostsCached(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const viewsMap = new Map(await getViewsMapCached());
  const total = await countPostsCached();

  return (
    <>
      <Animations />
      <div className="site-shell">
        <Sidebar active="/" />
        <main className="content">
          {/* PC 端：文章列表顶部搜索框（手机端隐藏，用顶部栏搜索） */}
          <div className="content-search">
            <SearchBox variant="dashed" />
          </div>
          <div className="post-list">
            {posts.length === 0 ? (
              <div className="empty-block">
                <div className="empty-title">这里还没有文章</div>
                <div className="empty-hint">
                  如果后台已经有内容，检查一下是不是都还停留在草稿状态；草稿不会出现在前台。
                </div>
                <div className="empty-actions">
                  <a className="btn btn-sm" href="/archives">看归档</a>
                  <a className="btn btn-sm btn-ghost" href="/admin">进后台</a>
                </div>
              </div>
            ) : (
              posts.map((p) => (
                <PostCard
                  key={p.id}
                  href={postHref(p)}
                  title={p.title}
                  excerpt={p.excerpt || makeExcerpt(p.content)}
                  date={p.published_at || p.created_at}
                  categories={parseJsonArray(p.categories)}
                  readingTime={readingTime(p.content)}
                  views={viewsMap.get(p.id)}
                />
              ))
            )}
          </div>
          {total > PAGE_SIZE ? (
            <div className="pager">
              {page > 1 ? <a className="btn btn-sm" href={`/?page=${page - 1}`}>上一页</a> : null}
              <span className="btn btn-sm" style={{ pointerEvents: "none", opacity: .6 }}>
                {page} / {Math.ceil(total / PAGE_SIZE)}
              </span>
              {page * PAGE_SIZE < total ? <a className="btn btn-sm" href={`/?page=${page + 1}`}>下一页</a> : null}
            </div>
          ) : null}
        </main>
        <div className="toc-col"><RightBar /></div>
      </div>
    </>
  );
}
