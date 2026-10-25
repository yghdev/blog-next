import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { Editor } from "@/components/admin/Editor";
import { PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "写文章" };

export default async function NewPostPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  return (
    <AdminShell active="new" username={user.username}>
      <PageHeader
        title="写文章"
        sub="支持 Markdown，可直接粘贴或拖入图片。草稿会自动存在本机，误关页面还能恢复。"
      />
      <Editor mode="new" />
    </AdminShell>
  );
}
