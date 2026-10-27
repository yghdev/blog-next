import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { getSettings } from "@/lib/settings";
import { SettingsForm } from "@/components/admin/SettingsForm";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "设置 · 站点" };

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const settings = getSettings();

  return (
    <AdminShell active="settings" username={user.username}>
      <PageHeader
        title="设置"
        sub="站点文案保存后前台立即生效，不用重新部署。账号安全与图片存储拆到了各自分区。"
      />
      <SettingsTabs active="site" />
      <SettingsForm initial={settings} />
    </AdminShell>
  );
}
