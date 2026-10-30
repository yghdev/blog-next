import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { listFriendLinks } from "@/lib/friend-links";
import { LinksManager } from "@/components/admin/LinksManager";
import { PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "外链" };

export default async function LinksPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const links = listFriendLinks();

  return (
    <AdminShell active="links" username={user.username}>
      <PageHeader
        title="外链"
        sub="这里新增的条目会同时出现在友链页（/friend-links）、桌面右栏和手机抽屉，保存即生效，不用重新部署。排序值小的靠前。"
      />
      <LinksManager initial={links} />
    </AdminShell>
  );
}
