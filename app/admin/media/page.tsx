import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { getDb, type MediaRow } from "@/lib/db";
import { MediaGrid } from "@/components/admin/MediaGrid";
import { PageHeader } from "@/components/admin/ui";
import { storageStatus } from "@/lib/storage";
import { mediaOrderSql, normalizeMediaSort } from "@/lib/media-sort";
import { formatIn } from "@/lib/time";
import { formatBytes } from "@/lib/image-plan";

export const dynamic = "force-dynamic";
export const metadata = { title: "图片" };

/**
 * 媒体库（阶段 02-4 / 02-6 批量与排序）。
 *
 * 改动的核心是一条：**原来这里是 LIMIT 120 的固定快照**，第 121 张图开始
 * 既看不见也删不掉，而 API 早已支持 q / limit / offset。现在筛选、搜索、
 * 排序、分页全部都落到 URL 上 —— 可以把"未引用"那一屏存成书签，也可以回退。
 *
 * 筛选口径：
 *   storage=qiniu  -> path 不以 /images/ 开头（CDN 直链）
 *   storage=local  -> path 以 /images/ 开头（本机磁盘）
 *   storage=unused -> 没有任何未删除文章正文包含该路径
 *
 * "未引用"用 NOT EXISTS + LIKE 而不是先取全量再过滤：
 * 引用关系是 content LIKE '%path%'，这个子查询本身也是 LIKE，
 * 成本与逐条 count 相同，但少一次全表搬运。
 *
 * 排序只接受 lib/media-sort.ts 白名单里的四个键，SQL 片段从那里取，
 * 不把 URL 参数拼进 ORDER BY（曾经有人用 ?sort= 直接拼接，等于开了注入口）。
 */
const PAGE_SIZE = 48;

export default async function MediaPage({ searchParams }: {
  searchParams: Promise<{ storage?: string; q?: string; page?: string; sort?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const filter = ["qiniu", "local", "unused"].includes(sp.storage ?? "") ? sp.storage! : "";
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const sort = normalizeMediaSort(sp.sort);

  const db = getDb();
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;

  const where: string[] = [];
  const args: unknown[] = [];
  if (filter === "qiniu") where.push("m.path NOT LIKE '/images/%'");
  else if (filter === "local") where.push("m.path LIKE '/images/%'");
  else if (filter === "unused") {
    where.push("NOT EXISTS (SELECT 1 FROM posts p WHERE p.deleted_at IS NULL AND p.content LIKE '%' || m.path || '%')");
  }
  if (q) { where.push("(m.path LIKE ? OR m.filename LIKE ?)"); args.push("%" + q + "%", "%" + q + "%"); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const total = count("SELECT COUNT(*) c FROM media m " + whereSql, ...args);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 页码越界时退回最后一页，避免改筛选后停在空白页
  const current = Math.min(page, pages);

  const rows = db.prepare(
    "SELECT m.* FROM media m " + whereSql + " ORDER BY " + mediaOrderSql(sort) + " LIMIT ? OFFSET ?"
  ).all(...args, PAGE_SIZE, (current - 1) * PAGE_SIZE) as MediaRow[];

  const refStmt = db.prepare("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL AND content LIKE ?");
  const items = rows.map((m) => ({
    ...m,
    refs: (refStmt.get("%" + m.path + "%") as { c: number }).c,
    // 存储来源要显示出来：排查裂图时第一件事就是确认图在哪一侧
    storage: m.path.startsWith("/images/") ? "local" as const : "qiniu" as const,
    uploadedAt: m.created_at ? formatIn(m.created_at, "date") : "",
  }));

  const all = count("SELECT COUNT(*) c FROM media m");
  const totalBytes = (db.prepare("SELECT COALESCE(SUM(size),0) s FROM media").get() as { s: number }).s;
  const qiniuCount = count("SELECT COUNT(*) c FROM media WHERE path NOT LIKE '/images/%'");
  const localCount = all - qiniuCount;
  const st = storageStatus();

  return (
    <AdminShell active="media" username={user.username}>
      <PageHeader
        title="图片"
        sub={"共 " + all + " 张，占用 " + formatBytes(totalBytes) + "（七牛 " +
          qiniuCount + " 张 / 本机 " + localCount + " 张）。仍被文章引用的图片不能删除。"}
      />
      <MediaGrid
        items={items}
        total={total}
        page={current}
        pages={pages}
        filter={filter}
        q={q}
        sort={sort}
        storageConfigured={st.configured}
        cdnDomain={st.display.cdnDomain}
      />
    </AdminShell>
  );
}
