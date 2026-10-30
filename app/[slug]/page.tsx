import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { postHref } from "@/lib/posts";
import { resolveSlugCached, getPageBySlugCached } from "@/lib/cached";
import { ArticleView, articleMetadata } from "@/components/ArticleView";

export const dynamic = "force-dynamic";

/**
 * 旧地址入口（`/中文slug`），2026-10-30 起降级为**兼容层**。
 *
 * 三种去向：
 *   1) 文章（type=post）       -> 308 到 `/p/<id>`，这是规范地址
 *   2) 页面（type=page）       -> 原地渲染（/about、/friend-links 这类保留语义化路径）
 *   3) 历史别名（post_aliases）-> 308 到目标文章的规范地址
 *
 * 为什么用 permanentRedirect（308）而不是 redirect（307）：
 * 307 是临时的，搜索引擎不会把权重与索引转移到新地址，别名表就白做了。
 * 308 等价于 301 的语义且保留请求方法，是 Server Component 里最接近的写法。
 *
 * ⚠️ 旧地址必须长期有效。已经发出去的 RSS、别人博客里的友链、
 *    搜索引擎的索引都指向它们，删掉就是一批 404。
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolveSlugCached(slug);
  const doc = resolved.post ?? (await getPageBySlugCached(slug));
  if (!doc || resolved.redirectTo) return {};
  return articleMetadata(doc);
}

export default async function LegacySlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const resolved = await resolveSlugCached(slug);

  // 历史别名 -> 目标文章的规范地址
  if (resolved.redirectTo) permanentRedirect(postHref(resolved.redirectTo));

  const doc = resolved.post;
  if (!doc) notFound();

  // 文章一律跳到编号地址：同一篇内容只应该有一个 URL，
  // 否则浏览量、分享链接、搜索引擎收录会分散在多个 key 上。
  if (doc.type === "post") permanentRedirect(postHref(doc));

  // 页面（/about 之类）保留语义化路径，原地渲染
  return <ArticleView doc={doc} />;
}
