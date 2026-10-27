import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { StoragePanel } from "@/components/admin/StoragePanel";
import { PageHeader } from "@/components/admin/ui";
import { storageStatus } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const metadata = { title: "图片存储" };

export default async function StoragePage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const st = storageStatus();

  return (
    <AdminShell active="storage" username={user.username}>
      <PageHeader
        title="图片存储"
        sub={st.configured
          ? "当前使用七牛云对象存储，图片经 CDN 直连访问。"
          : "尚未配置对象存储，上传的图片会写入本机磁盘（受限于服务器出口带宽）。"}
      />
      <StoragePanel />
    </AdminShell>
  );
}
