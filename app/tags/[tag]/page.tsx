import { Animations } from "@/components/Animations";
import { SiteShell } from "@/components/SiteShell";
import { PageHeader } from "@/components/PageHeader";
import { PostCard } from "@/components/PostCard";
import { getDb } from "@/lib/db";
import { makeExcerpt, parseJsonArray, decodeSlug, postHref } from "@/lib/posts";
import { listPostsCached } from "@/lib/cached";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return { title: "标签：" + decodeSlug(tag) };
}

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag: raw } = await params;
  const tag = decodeSlug(raw);
  // 原先每次请求都全表 LIKE 扫描；改为复用已缓存的全量列表
  const candidates = await listPostsCached(1000, 0);
  const posts = candidates.filter((p) => parseJsonArray(p.tags).includes(tag));

  return (
    <>
      <Animations />
      <SiteShell variant="three-col">
        <PageHeader title={"标签：" + tag} sub={"共 " + posts.length + " 篇文章"} />
        <div className="post-list">
          {posts.map((p) => (
            <PostCard
              key={p.id}
              href={postHref(p)}
              title={p.title}
              excerpt={p.excerpt || makeExcerpt(p.content)}
              date={p.published_at || p.created_at}
              categories={parseJsonArray(p.categories)}
            />
          ))}
        </div>
      </SiteShell>
    </>
  );
}
