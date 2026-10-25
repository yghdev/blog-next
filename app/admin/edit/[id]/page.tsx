import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AdminShell } from "@/components/admin/AdminShell";
import { Editor } from "@/components/admin/Editor";
import { PageHeader } from "@/components/admin/ui";
import { parseJsonArray } from "@/lib/posts";

export const dynamic = "force-dynamic";

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) notFound();

  const row = getDb().prepare("SELECT * FROM posts WHERE id = ?").get(numId) as
    | { id: number; type: string; title: string; slug: string; content: string; status: string;
        categories: string; tags: string; cover: string | null; published_at: string | null; comments_enabled: number }
    | undefined;
  if (!row) notFound();

  return (
    <AdminShell active="posts" username={user.username}>
      <PageHeader title="编辑" sub="改完之后点「更新」才会写库。URL 路径改动会自动为旧地址保留跳转。" />
      <Editor
        mode="edit"
        initial={{
          id: row.id, type: row.type, title: row.title, slug: row.slug,
          content: row.content, status: row.status, cover: row.cover,
          categories: parseJsonArray(row.categories), tags: parseJsonArray(row.tags),
          published_at: row.published_at ?? null,
          comments_enabled: row.comments_enabled ?? 1,
        }}
      />
    </AdminShell>
  );
}
