import Link from "next/link";
import { SiteShell } from "./SiteShell";
import type { Metadata } from "next";
import { Animations } from "./Animations";
import { formatDate, toIso } from "./PostCard";
import {
  decodeSlug, prevNextPost, parseJsonArray, readingTime, makeExcerpt, postHref,
} from "@/lib/posts";
import { getPageViewsCached } from "@/lib/cached";
import { getSettings } from "@/lib/settings";
import { renderMarkdown } from "@/lib/markdown";
import { CommentSection } from "./CommentSection";
import { Lightbox } from "./Lightbox";
import { ArticleToc } from "./ArticleToc";
import { categoryColor } from "@/lib/category-color";
import {
  articleJsonLd, docPath, ogImageFor, siteAlternates, type SiteIdentity,
} from "@/lib/seo";
import { toUtcIso } from "@/lib/time";
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
/**
 * 文章 / 页面的 `<head>` 元信息（P0-5，2026-11-07）。
 *
 * 这一版补上了此前完全缺失的四件事：canonical、og:url/og:image、
 * 文章发布时间与时区、RSS autodiscovery（最后一项靠 siteAlternates 带出来，
 * 否则页面自己的 alternates 会把 layout 的整块替换掉）。
 *
 * `site` 由路由层用 getSettings() 传入：设置里改了站名/作者，
 * 分享卡与 JSON-LD 必须跟着变，不能在组件里再硬编一份。
 */
export function articleMetadata(doc: Post, site: SiteIdentity): Metadata {
  const desc = doc.excerpt || makeExcerpt(doc.content);
  const canonical = docPath(doc);
  const published = toUtcIso(doc.published_at || doc.created_at);
  const modified = toUtcIso(doc.updated_at) || published;
  const tags = [...parseJsonArray(doc.tags), ...parseJsonArray(doc.categories)];
  const isPost = doc.type === "post";
  const image = ogImageFor(doc.cover);

  return {
    title: doc.title,
    description: desc,
    alternates: siteAlternates(canonical),
    openGraph: {
      // 页面（/about 这类）不是文章，别报 article —— 结构化数据会被校验器挑出来
      type: isPost ? "article" : "website",
      title: doc.title,
      description: desc,
      url: canonical,
      siteName: site.siteTitle,
      locale: "zh_CN",
      images: [image],
      ...(isPost && published
        ? { publishedTime: published, modifiedTime: modified || published, authors: [site.author] }
        : {}),
      ...(tags.length > 0 ? { tags } : {}),
    },
    twitter: {
      // 现在**总有**图（没有封面就回落到默认分享卡），所以固定用大卡
      card: "summary_large_image",
      title: doc.title,
      description: desc,
      images: [image.url],
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
  const settings = getSettings();

  return (
    <>
      {/* 结构化数据（P0-5）：文章 / 页面各一种类型，内容全部来自 doc + settings */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: articleJsonLd(doc, settings) }}
      />
      <Animations />
      <Lightbox />
      <SiteShell variant="three-col" toc={toc} tocOnly className="content--article">
        {/* 移动/平板目录（P0-3）：≥1392 由右栏承担，这里在 CSS 里隐藏 */}
        <ArticleToc toc={toc} />
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
            <img src={doc.cover} alt={doc.title} className="article-cover" />
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
      </SiteShell>
    </>
  );
}
