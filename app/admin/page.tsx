import { permanentRedirect, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { ContentView } from "@/components/admin/ContentView";

export const dynamic = "force-dynamic";
export const metadata = { title: "文章" };

/**
 * 文章列表（/admin）。
 *
 * 拆页后的分工：文章、说说、页面各有自己的路由与导航项。
 * 为什么拆：「文章与说说」共用一个列表时，说说（没有标题、一两句话）
 * 只能按文章的行结构渲染，于是列表里出现一排「(无标题)」——
 * 那不是用户的标题，是系统把不同结构的东西塞进了同一个模板。
 *
 * /admin 继续是文章列表，不搬家：它被登录后跳转、前台「进后台」、
 * 各处「回到内容列表」引用，改路由只会让书签失效。
 */
export default async function PostsPage({ searchParams }: {
  searchParams: Promise<{ page?: string; status?: string; q?: string; type?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");
  const sp = await searchParams;

  /**
   * 旧链接兼容：拆页前 /admin?type=shuoshuo 是「说说」的筛选视图，
   * 可能已经被收藏或用在了别处的链接里。直接忽略 type 会让用户看到
   * 一堆文章并以为内容没了，所以按 308 带到新地址，筛选条件一并保留。
   * 未知 / 空 type 仍按文章列表渲染（那是这个路由本来的语义）。
   */
  const legacyType = sp.type;
  if (legacyType === "page" || legacyType === "shuoshuo") {
    const u = new URLSearchParams();
    if (sp.status) u.set("status", sp.status);
    if (sp.q) u.set("q", sp.q);
    if (sp.page && sp.page !== "1") u.set("page", sp.page);
    const qs = u.toString();
    const target = legacyType === "page" ? "/admin/pages" : "/admin/shuoshuo";
    permanentRedirect(target + (qs ? "?" + qs : ""));
  }

  return (
    <AdminShell active="posts" username={user.username}>
      <ContentView
        type="post"
        basePath="/admin"
        eyebrow="内容 · 文章"
        title="文章"
        sub="有标题、成篇发布的内容。草稿只存在草稿区，点发布才出现在前台。"
        searchParams={sp}
        emptyTitle="还没有文章"
        emptyHint="从第一篇开始。写文章常驻在左侧，也可以直接点下面的按钮。"
        emptyAction={{ href: "/admin/new", label: "写第一篇" }}
        newAction={{ href: "/admin/new", label: "新建文章" }}
      />
    </AdminShell>
  );
}
