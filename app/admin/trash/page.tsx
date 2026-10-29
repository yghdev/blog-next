import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { ContentView } from "@/components/admin/ContentView";

export const dynamic = "force-dynamic";
export const metadata = { title: "回收站" };

/**
 * 回收站（/admin/trash）。
 *
 * 单独成页而不是 `?trash=1` 筛选：回收站的操作集与正常列表完全不同
 * （只有恢复与彻底清除，没有发布/转草稿），把它做成一个筛选值会让
 * 工具栏出现一批当前上下文里无意义的按钮。
 *
 * 类型混杂（文章/说说/页面都在里面），所以显示类型标记；
 * 说说仍按正文型行渲染 —— 它在回收站里也没有标题。
 */
export default async function TrashPage({ searchParams }: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const sp = await searchParams;

  return (
    <AdminShell active="trash" username={user.username}>
      <ContentView
        trash
        basePath="/admin/trash"
        eyebrow="内容 · 回收站"
        title="回收站"
        sub="删除的内容先放这里，可以恢复或彻底清除。彻底清除不可逆。"
        searchParams={sp}
        showType
        emptyTitle="回收站是空的"
        emptyHint="移入回收站的内容会先停在这里，确认不要了再彻底删除。"
        emptyAction={{ href: "/admin", label: "回到文章列表" }}
      />
    </AdminShell>
  );
}
