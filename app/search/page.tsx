import { Sidebar } from "@/components/Sidebar";
import { Animations } from "@/components/Animations";
import { PostCard } from "@/components/PostCard";
import { searchPosts } from "@/lib/search";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "搜索" };

/**
 * 搜索结果页。
 *
 * 两处修正：
 *  1) 结果卡片此前是手写的 <Link className="post-card"><p>{excerpt}</p></Link>，
 *     没有 .excerpt 类，导致摘要占满行宽、行高错乱，和首页卡片不是一套排版。
 *     现在统一复用 PostCard。
 *  2) 没结果时只有一句「没有找到相关文章」，没有出口。补上可执行建议。
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const { hits, mode } = q ? searchPosts(q, { limit: 30 }) : { hits: [], mode: "like" as const };

  return (
    <>
      <Animations />
      <div className="site-shell">
        <Sidebar active="/search" />
        <main className="content">
          <h1 className="page-title">搜索</h1>
          <form method="get" className="content-search" role="search">
            <div className="search-box search-box--dashed">
              <svg className="search-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                name="q"
                defaultValue={q}
                enterKeyHint="search"
                placeholder="输入关键词（2 字以上即可）"
                aria-label="搜索关键词"
              />
            </div>
          </form>

          {q ? (
            <p style={{ fontSize: ".82rem", color: "var(--text-p4)", margin: "0 0 16px" }}>
              {hits.length > 0
                ? "找到 " + hits.length + " 篇 · " + (mode === "fts" ? "全文索引" : "关键词匹配")
                : "没有匹配结果 · " + (mode === "fts" ? "全文索引" : "关键词匹配")}
            </p>
          ) : null}

          {q && hits.length === 0 ? (
            <div className="empty-block">
              <div className="empty-title">没有找到「{q}」</div>
              <div className="empty-hint">
                两字以上的词能走全文索引，单个字只能逐条匹配，容易搜不到。
                也可以换个更短的关键词，或者直接从归档里翻。
              </div>
              <div className="empty-actions">
                <Link className="btn btn-sm" href="/archives">看归档</Link>
                <Link className="btn btn-sm btn-ghost" href="/">回首页</Link>
              </div>
            </div>
          ) : (
            <div className="post-list">
              {hits.map((h) => (
                <PostCard
                  key={h.id}
                  href={"/p/" + h.id}
                  title={h.title}
                  excerpt={h.excerpt}
                  date={h.date}
                />
              ))}
            </div>
          )}

          {!q ? (
            <div className="empty-block">
              <div className="empty-title">想找点什么？</div>
              <div className="empty-hint">输入标题或正文里的关键词，回车即可。两字以上会走全文索引，更快更准。</div>
            </div>
          ) : null}
        </main>
      </div>
    </>
  );
}
