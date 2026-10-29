import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { Editor } from "@/components/admin/Editor";
import { PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

const TYPES = ["post", "page", "shuoshuo"] as const;
type NewType = (typeof TYPES)[number];

const COPY: Record<NewType, { title: string; sub: string }> = {
  post: {
    title: "写文章",
    sub: "支持 Markdown，可直接粘贴或拖入图片。草稿会自动存在本机，误关页面还能恢复。",
  },
  page: {
    title: "新建页面",
    sub: "页面不按时间归档，适合「关于」「联系」这类长期不动的独立内容。",
  },
  shuoshuo: {
    title: "写说说",
    sub: "一两句话、一张图都可以，不需要标题。写完直接发。",
  },
};

/**
 * 新建内容。
 *
 * ?type=shuoshuo / ?type=page 让三个列表页的「新建」按钮各自直达对应类型，
 * 而不是先建一篇默认文章再让用户去顶栏改类型 —— 那一步几乎总会被忘掉，
 * 结果是在文章列表里出现一条本该是说说/页面的内容。
 */
export default async function NewPostPage({ searchParams }: {
  searchParams: Promise<{ type?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const type: NewType = TYPES.includes(sp.type as NewType) ? (sp.type as NewType) : "post";
  const copy = COPY[type];

  return (
    <AdminShell active="new" username={user.username}>
      <PageHeader title={copy.title} sub={copy.sub} />
      <Editor mode="new" initialType={type} />
    </AdminShell>
  );
}
