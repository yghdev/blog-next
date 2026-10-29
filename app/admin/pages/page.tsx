import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { ContentView } from "@/components/admin/ContentView";

export const dynamic = "force-dynamic";
export const metadata = { title: "页面" };

/**
 * 页面列表（/admin/pages）。
 *
 * 页面是「不按时间排序的独立内容」（关于、归档说明、友链等），
 * 与文章共用同一张表但语义不同，所以单独一栏。
 */
export default async function PagesAdminPage({ searchParams }: {
  searchParams: Promise<{ page?: string; status?: string; q?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const sp = await searchParams;

  return (
    <AdminShell active="pages" username={user.username}>
      <ContentView
        type="page"
        basePath="/admin/pages"
        eyebrow="内容 · 页面"
        title="页面"
        sub="不按时间归档的独立内容，比如关于页、归档说明、友链。"
        searchParams={sp}
        emptyTitle="还没有页面"
        emptyHint="页面适合「关于」「联系」这类长期不动的独立内容。"
        emptyAction={{ href: "/admin/new?type=page", label: "新建页面" }}
        newAction={{ href: "/admin/new?type=page", label: "新建页面" }}
      />
    </AdminShell>
  );
}
