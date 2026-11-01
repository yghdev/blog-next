import { Animations } from "@/components/Animations";
import { SiteShell } from "@/components/SiteShell";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { SearchBox } from "@/components/SearchBox";
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
      <SiteShell variant="wide">
        <PageHeader title="搜索" />
        {/*
          复用 SearchBox，而不是手写第二份表单（B-6）。
          手写那份用了 `content-search` 类名，被 820px 的
          `.content-search { display:none }` 命中 —— 移动端搜索页
          一个输入框都没有。换类名 + 复用组件后两个问题一起消失。
        */}
        <div className="search-page-form">
          <SearchBox initial={q} variant="dashed" />
        </div>

        {q ? (
          <p className="search-meta">
            {hits.length > 0
              ? "找到 " + hits.length + " 篇 · " + (mode === "fts" ? "全文索引" : "关键词匹配")
              : "没有匹配结果 · " + (mode === "fts" ? "全文索引" : "关键词匹配")}
          </p>
        ) : null}

        {q && hits.length === 0 ? (
          <EmptyState
            title={"没有找到「" + q + "」"}
            hint="两字以上的词能走全文索引，单个字只能逐条匹配，容易搜不到。也可以换个更短的关键词，或者直接从归档里翻。"
            actions={
              <>
                <Link className="btn btn-sm" href="/archives">看归档</Link>
                <Link className="btn btn-sm btn-ghost" href="/">回首页</Link>
              </>
            }
          />
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
          <EmptyState
            title="想找点什么？"
            hint="输入标题或正文里的关键词，回车即可。两字以上会走全文索引，更快更准。"
          />
        ) : null}
      </SiteShell>
    </>
  );
}
