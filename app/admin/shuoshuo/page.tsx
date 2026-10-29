import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { ContentView } from "@/components/admin/ContentView";

export const dynamic = "force-dynamic";
export const metadata = { title: "说说" };

/**
 * 说说列表（/admin/shuoshuo）。
 *
 * 说说没有标题，正文就是它的身份。所以这里用 variant="body"：
 * 正文当一号信息、最多三行，状态与时间压在下面一行。
 * 用文章那套行结构只会得到一排「(无标题)」，那是把系统缺陷摆给用户看。
 */
export default async function ShuoshuoAdminPage({ searchParams }: {
  searchParams: Promise<{ page?: string; status?: string; q?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const sp = await searchParams;

  return (
    <AdminShell active="shuoshuo" username={user.username}>
      <ContentView
        type="shuoshuo"
        basePath="/admin/shuoshuo"
        eyebrow="内容 · 说说"
        title="说说"
        sub="短句与碎片想法，没有标题。列表直接显示正文，点开就能改。"
        searchParams={sp}
        variant="body"
        emptyTitle="还没有说说"
        emptyHint="说说适合一两句话、一张图。它不需要标题，写完直接发。"
        emptyAction={{ href: "/admin/new?type=shuoshuo", label: "写一条说说" }}
        newAction={{ href: "/admin/new?type=shuoshuo", label: "写一条" }}
      />
    </AdminShell>
  );
}
