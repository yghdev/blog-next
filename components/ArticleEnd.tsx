import Link from "next/link";
import { PostCard } from "./PostCard";
import { makeExcerpt, parseJsonArray, postHref, readingTime } from "@/lib/posts";
import type { Post } from "@/lib/db";

/**
 * 文章末尾的「读完去哪」（F11，2026-11-07）。
 *
 * 此前文章页在正文之后只有上下篇导航，读者读完就走到尽头 —— 没有作者信息、
 * 没有继续读的入口、也没有订阅方式。这一块补三件事：
 *   1. 作者卡：这是谁写的、本站是干什么的；
 *   2. 相关文章：同分类/同标签的 3 篇（规则见 lib/posts.ts 的 relatedPosts）；
 *   3. 订阅入口：RSS + 关于页。
 *
 * 只对 `type === "post"` 渲染：页面（/about 这类）不是"文章"，给它挂
 * 作者卡和相关文章既没有语义也没有内容。
 */
export function ArticleEnd({
  author, bio, related,
}: {
  author: string;
  bio: string;
  related: Post[];
}) {
  return (
    <>
      <aside className="author-card" aria-label="关于作者">
        {/* 头像与侧栏品牌区同源（public/avatar.jpg），不另起一份资源 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/avatar.jpg"
          alt=""
          className="author-photo"
          width={56}
          height={56}
          loading="lazy"
          decoding="async"
        />
        <div className="author-body">
          <p className="author-name">{author}</p>
          <p className="author-bio">{bio}</p>
          <div className="author-links">
            <Link href="/about">关于本站</Link>
            <a href="/rss.xml">RSS 订阅</a>
          </div>
        </div>
      </aside>

      {related.length > 0 ? (
        <section className="related" aria-labelledby="related-title">
          <h2 className="related-title" id="related-title">相关文章</h2>
          <div className="post-list">
            {related.map((p) => (
              <PostCard
                key={p.id}
                href={postHref(p)}
                title={p.title}
                excerpt={p.excerpt || makeExcerpt(p.content)}
                date={p.published_at || p.created_at}
                categories={parseJsonArray(p.categories)}
                readingTime={readingTime(p.content)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
