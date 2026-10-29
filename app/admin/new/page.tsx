import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { Editor } from "@/components/admin/Editor";
import { getPostFacets } from "@/lib/post-facets";

export const dynamic = "force-dynamic";

const TYPES = ["post", "page", "shuoshuo"] as const;
type NewType = (typeof TYPES)[number];

/**
 * 新建内容。
 *
 * ?type=shuoshuo / ?type=page 让三个列表页的「新建」按钮各自直达对应类型，
 * 而不是先建一篇默认文章再让用户去顶栏改类型 —— 那一步几乎总会被忘掉，
 * 结果是在文章列表里出现一条本该是说说/页面的内容。
 *
 * 页面本身不再包 PageHeader：编辑页的操作条已经承担了「返回 / 标题 / 发布」
 * 这一层，再放一个衬线大标题会把输入框推到第二屏。
 */
export default async function NewPostPage({ searchParams }: {
  searchParams: Promise<{ type?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const type: NewType = TYPES.includes(sp.type as NewType) ? (sp.type as NewType) : "post";

  return (
    <AdminShell active="new" username={user.username}>
      <Editor mode="new" initialType={type} facets={getPostFacets()} />
    </AdminShell>
  );
}
