import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { Editor } from "@/components/admin/Editor";
import { parseJsonArray } from "@/lib/posts";
import { customExcerptOf } from "@/lib/post-writes";
import { getPostFacets } from "@/lib/post-facets";

export const dynamic = "force-dynamic";

/**
 * 文章编辑页。
 *
 * 这一层只做三件事：鉴权、读这一篇的当前行、把候选项一并取好交给编辑器。
 * 页面标题区不再由 PageHeader 渲染 —— 改版后编辑页是「写作工作台」，
 * 有自己的操作条（返回 / 标题 / 保存状态 / 模式 / 预览 / 发布），
 * 再叠一个大标题只会让正文被推低两屏。
 */
export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) notFound();

  const row = getDb().prepare("SELECT * FROM posts WHERE id = ?").get(numId) as
    | { id: number; type: string; title: string; slug: string; content: string; excerpt: string;
        status: string; categories: string; tags: string; cover: string | null;
        published_at: string | null; comments_enabled: number; revision: number }
    | undefined;
  if (!row) notFound();

  const facets = getPostFacets();

  return (
    <AdminShell active="posts" username={user.username}>
      <Editor
        mode="edit"
        facets={facets}
        initial={{
          id: row.id, type: row.type, title: row.title, slug: row.slug,
          content: row.content,
          // 自动截取的摘要不算"用户填过"：留空，让摘要框显示自动提取提示
          excerpt: customExcerptOf(row) ?? "",
          status: row.status, cover: row.cover,
          categories: parseJsonArray(row.categories), tags: parseJsonArray(row.tags),
          published_at: row.published_at ?? null,
          comments_enabled: row.comments_enabled ?? 1,
          // 草稿基线的起点：编辑器保存时用它做 expectedPostRevision
          revision: row.revision ?? 1,
        }}
      />
    </AdminShell>
  );
}
