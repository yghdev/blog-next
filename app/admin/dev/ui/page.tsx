import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader, Badge } from "@/components/admin/ui";
import { UiKit } from "./kit";

export const dynamic = "force-dynamic";
export const metadata = { title: "UI 对照页", robots: { index: false, follow: false } };

/**
 * 组件对照页（阶段 01-A，方案 §9.3）。
 *
 * 门禁：
 *   - 未登录 -> 沿用后台统一登录重定向（由 proxy + 这里双保险）
 *   - 已登录但生产未启用 -> 404。用 404 而不是"隐藏路由"，因为 404 表达的是
 *     "功能未开放"，不承担"隐藏路由存在"的安全目标；proxy 也不为此加特殊分支。
 *   - 不进导航、不被索引（metadata.robots + 后台统一 X-Robots-Tag）
 *
 * 只复用**真实组件**，这里没有任何 fixture 专用样式。fixture 只提供数据与布局，
 * 这样对照页看到的密度、圆角、语义色和真实页面完全一致 —— 否则它就是一张
 * 好看的假图，验收时会被真实页面的差异打回。
 */
const ENABLED = process.env.NODE_ENV !== "production" || process.env.ADMIN_UI_KIT === "1";

export default async function UiKitPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  // 生产默认 404：功能未开放，而不是"藏起来"
  if (!ENABLED) notFound();

  return (
    <AdminShell active="dev-ui" username={user.username}>
      <PageHeader
        title="UI 对照页"
        sub="基础组件在真实后台壳里的样子。改组件先在这里看双主题与窄屏，再去动页面。"
        actions={<Badge tone="info" dot>仅开发可见</Badge>}
      />
      <UiKit />
    </AdminShell>
  );
}
