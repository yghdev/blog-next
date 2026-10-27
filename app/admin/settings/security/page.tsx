import { redirect } from "next/navigation";
import { currentUser, remainingRecoveryCodes } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { listSessions } from "@/lib/session";
import { readToken } from "@/lib/guards";
import { SecurityPanel } from "@/components/admin/SecurityPanel";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { PageHeader } from "@/components/admin/ui";
import { formatIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "设置 · 账号安全" };

/**
 * 账号安全从 /admin/settings 拆出来（阶段 02-5）。
 *
 * 拆的理由是**保存语义不同**：站点文案是"一堆字段 + 一个保存键"，
 * 而这里的每个动作（开/关 2FA、重生成恢复码、撤销设备、改密）
 * 都是即时生效、需要验证码、部分还要确认弹窗的独立事务。
 * 把它们和普通表单放在同一页，最容易被误认为"点保存设置能一起改"。
 */
export default async function SecuritySettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const token = (await readToken()) ?? "";
  const sessions = listSessions(user.id, token).map((s) => ({
    ...s,
    createdAtLabel: formatIn(s.createdAt, "datetime"),
    lastSeenLabel: s.lastSeenAt ? formatIn(s.lastSeenAt, "datetime") : "—",
  }));

  return (
    <AdminShell active="settings" username={user.username}>
      <PageHeader
        title="账号安全"
        sub={"两步验证、已登录设备与密码。这里的每个动作都即时生效 —— 没有\u201c保存\u201d这一步。"}
      />
      <SettingsTabs active="security" />
      <SecurityPanel
        username={user.username}
        totpEnabled={!!user.totp_enabled}
        recoveryRemaining={remainingRecoveryCodes(user.id)}
        sessions={sessions}
      />
    </AdminShell>
  );
}
