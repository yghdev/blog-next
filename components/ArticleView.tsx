import Link from "next/link";
import type { Metadata } from "next";
import { Sidebar } from "./Sidebar";
import { Animations } from "./Animations";
import { formatDate, toIso } from "./PostCard";
import {
  decodeSlug, prevNextPost, parseJsonArray, readingTime, makeExcerpt, postHref,
} from "@/lib/posts";
import { getPageViewsCached, getSettingsCached } from "@/lib/cached";
import { renderMarkdown } from "@/lib/markdown";
import { CommentSection } from "./CommentSection";
import { Lightbox } from "./Lightbox";
import { categoryColor } from "@/lib/category-color";
import { RightBar } from "./RightBar";
import type { Post } from "@/lib/db";

/**
 * 文章 / 页面的正文视图（2026-10-30 抽出）。
 *
 * 为什么单独成组件：URL 体系改成了「文章 `/p/<id>`、页面仍走语义化路径」，
 * 两条路由都要渲染同一份文章，各抄一遍必然会漂移（其中一处改了标题样式、
 * 另一处忘了，是最典型的长尾 bug）。
 *
 * 这里只负责「拿到 doc 之后怎么画」，取数在调用方完成 —— 路由层要做的
 * 解析（按 id 查 / 按 slug 查 / 旧地址跳转）各不相同，不适合塞进来。
 */
export function articleMetadata(doc: Post): Metadata {
  const desc = doc.excerpt || makeExcerpt(doc.content);
  return {
    title: doc.title,
    description: desc,
    openGraph: {
      type: "article",
      title: doc.title,
      description: desc,
      images: doc.cover ? [doc.cover] : undefined,
    },
    twitter: {
      card: doc.cover ? "summary_large_image" : "summary",
      title: doc.title,
      description: desc,
      images: doc.cover ? [doc.cover] : undefined,
    },
  };
}

/**
 * 评论区与浏览量的稳定键。
 *
 * ⚠️ 评论的 pageKey **必须继续用旧的中文 slug**（`/博客迁移记录`），
 * 不能跟着 URL 一起改成 `/p/12`：Artalk 是按 pageKey 存评论的，
 * 一改，全站历史评论会立刻「消失」（其实是挂在新键下没人用了）。
 * 这是本次改 URL 唯一不能动的东西。
 */
export function legacyPageKey(doc: { slug: string }): string {
  return "/" + decodeSlug(doc.slug);
}

export async function ArticleView({ doc }: { doc: Post }) {
  const { html, toc } = renderMarkdown(doc.content);
  const cats = parseJsonArray(doc.categories);
  const nav = doc.type === "post" ? prevNextPost(doc.published_at || doc.created_at) : {};
  const pageViews = await getPageViewsCached(legacyPageKey(doc), doc.id);
  const settings = await getSettingsCached();

  return (
    <>
      <Animations />
      <Lightbox />
      <div className="site-shell">
        <Sidebar active={doc.type === "post" ? "/" : ""} />
        <main className="content">
          <article>
            <header className="article-header">
              {cats.length > 0 ? (
                <div className="article-eyebrow">
                  {cats.map((c) => {
                    const col = categoryColor(c);
                    return (
                      <span key={c} className="cat-pill" style={{ color: col.fg, background: col.bg }}>
                        {c}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <h1 className="article-title">{doc.title}</h1>
              <div className="article-meta-bar">
                <time dateTime={toIso(doc.published_at || doc.created_at)}>
                  {formatDate(doc.published_at || doc.created_at)}
                </time>
                <span className="dot">·</span>
                <span>{readingTime(doc.content)} 分钟</span>
                {pageViews !== null ? (
                  <>
                    <span className="dot">·</span>
                    <span>{pageViews} 次浏览</span>
                  </>
                ) : null}
              </div>
            </header>

            {doc.cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={doc.cover} alt={doc.title}
                   style={{ width: "100%", borderRadius: 12, marginBottom: 20, border: "1px solid var(--border)" }} />
            ) : null}

            <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
          </article>

          {nav.prev || nav.next ? (
            <nav className="article-nav" aria-label="上下篇">
              {nav.prev ? (
                <Link href={postHref(nav.prev)} className="article-nav-item prev">
                  <span className="article-nav-label">
                    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden>
                      <path d="M14 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    上一篇
                  </span>
                  <span className="article-nav-title">{nav.prev.title}</span>
                </Link>
              ) : <span />}
              {nav.next ? (
                <Link href={postHref(nav.next)} className="article-nav-item next">
                  <span className="article-nav-label">
                    下一篇
                    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden>
                      <path d="M10 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="article-nav-title">{nav.next.title}</span>
                </Link>
              ) : null}
            </nav>
          ) : null}

          {/* 评论：按「单页开关 + 全站开关」双重判断。
              文章页与页面都能评论；pageKey 见上方 legacyPageKey 的说明。 */}
          {settings.commentEnabled && doc.comments_enabled !== 0 ? (
            <CommentSection postId={doc.id} pageKey={legacyPageKey(doc)} />
          ) : null}
        </main>
        <div className="toc-col"><RightBar toc={toc} /></div>
      </div>
    </>
  );
}
