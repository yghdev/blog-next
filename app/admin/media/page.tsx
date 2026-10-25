import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { getDb, type MediaRow } from "@/lib/db";
import { MediaGrid } from "@/components/admin/MediaGrid";
import { PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "图片" };

export default async function MediaPage() {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const db = getDb();
  const rows = db.prepare("SELECT * FROM media ORDER BY created_at DESC LIMIT 120").all() as MediaRow[];
  const total = (db.prepare("SELECT COUNT(*) c FROM media").get() as { c: number }).c;
  const refStmt = db.prepare("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL AND content LIKE ?");
  const items = rows.map((m) => ({
    ...m,
    refs: (refStmt.get("%" + m.path + "%") as { c: number }).c,
  }));
  const totalBytes = (db.prepare("SELECT COALESCE(SUM(size),0) s FROM media").get() as { s: number }).s;

  return (
    <AdminShell active="media" username={user.username}>
      <PageHeader
        title="图片"
        sub={"共 " + total + " 张，占用 " + (totalBytes / 1024 / 1024).toFixed(1) +
          " MB。仍被文章引用的图片不能删除，避免把线上正文里的图删成裂图。"}
      />
      <MediaGrid items={items} />
    </AdminShell>
  );
}
