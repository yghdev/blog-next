import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { StoragePanel } from "@/components/admin/StoragePanel";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { PageHeader } from "@/components/admin/ui";
import { storageStatus } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const metadata = { title: "设置 · 图片存储" };

/**
 * 图片存储从独立的 /admin/storage 收进设置区（阶段 02-5）。
 *
 * 为什么搬而不是留一份：原来 /admin/storage 与「设置」并列在资源组，
 * 但它本质是"配置七牛 AK/SK"，和站点设置同一类事务（改配置→保存→生效）。
 * 两个入口做同一件事，最终一定出现"这边改了那边没同步"的认知。
 * 旧 URL 保留 308 永久跳转，不产生 404（见 app/admin/storage/page.tsx）。
 */
export default async function StorageSettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const st = storageStatus();

  return (
    <AdminShell active="settings" username={user.username}>
      <PageHeader
        title="图片存储"
        sub={st.configured
          ? "当前使用七牛云对象存储，图片经 CDN 直连访问。"
          : "尚未配置对象存储，上传的图片会写入本机磁盘（受限于服务器出口带宽）。"}
      />
      <SettingsTabs active="storage" />
      <StoragePanel />
    </AdminShell>
  );
}
