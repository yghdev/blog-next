import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { getPostByIdCached } from "@/lib/cached";
import { ArticleView, articleMetadata } from "@/components/ArticleView";

export const dynamic = "force-dynamic";

/**
 * 文章的规范地址：`/p/<id>`（2026-10-30 起）。
 *
 * 为什么从「中文 slug」改成「编号」：
 *   中文 slug 在浏览器里是 `/%E5%8D%9A%E5%AE%A2%E8%BF%81%E7%A7%BB%E8%AE%B0%E5%BD%95`
 *   这种长串，粘贴分享时几乎不可读；更麻烦的是它有两种形态（编码态/解码态），
 *   统计、缓存、链接生成各处理一遍就容易出错 —— 上线前实测过：
 *   页面用解码后的中文查浏览量、浏览器上报的是编码态，两者永不相等。
 *
 * id 是主键：改标题、改 slug、搬库都不会断链，也不需要查别名表。
 * 旧地址仍然可用，见 app/[slug]/page.tsx（308 永久跳转）。
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await getPostByIdCached(id);
  if (!doc) return {};
  return articleMetadata(doc);
}

export default async function PostByIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await getPostByIdCached(id);
  if (!doc) notFound();
  return <ArticleView doc={doc} />;
}
