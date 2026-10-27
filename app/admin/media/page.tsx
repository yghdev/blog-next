import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { getDb, type MediaRow } from "@/lib/db";
import { MediaGrid } from "@/components/admin/MediaGrid";
import { PageHeader } from "@/components/admin/ui";
import { storageStatus } from "@/lib/storage";

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
    // 存储来源要显示出来：排查裂图时第一件事就是确认图在哪一侧
    storage: m.path.startsWith("/images/") ? "local" as const : "qiniu" as const,
  }));
  const totalBytes = (db.prepare("SELECT COALESCE(SUM(size),0) s FROM media").get() as { s: number }).s;
  const qiniuCount = (db.prepare("SELECT COUNT(*) c FROM media WHERE path NOT LIKE '/images/%'").get() as { c: number }).c;
  const localCount = total - qiniuCount;
  const st = storageStatus();

  return (
    <AdminShell active="media" username={user.username}>
      <PageHeader
        title="图片"
        sub={"共 " + total + " 张，占用 " + (totalBytes / 1024 / 1024).toFixed(1) + " MB（七牛 " +
          qiniuCount + " 张 / 本机 " + localCount + " 张）。仍被文章引用的图片不能删除。"}
      />
      <MediaGrid
        items={items}
        storageConfigured={st.configured}
        cdnDomain={st.display.cdnDomain}
      />
    </AdminShell>
  );
}
