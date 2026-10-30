import { NextRequest, NextResponse } from "next/server";
import { getDb, type MediaRow } from "@/lib/db";
import { requireAdmin, handle, noStore, badRequest, notFound, conflict } from "@/lib/guards";
import { logAudit } from "@/lib/audit";
import { countMediaRefs, deleteMedia } from "@/lib/media-ops";

export const dynamic = "force-dynamic";

/** 删除图片：仍被文章引用时拒绝（防止误删正在用的图） */
export const DELETE = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("图片 id 不合法");

  const db = getDb();
  const row = db.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined;
  if (!row) throw notFound("图片不存在");

  // 引用检查与批量删除共用同一实现：两处口径漂移会直接变成「单删被拦、批量删得掉」
  const refs = countMediaRefs(db, row.path);
  if (refs > 0) throw conflict("这张图仍被 " + refs + " 篇文章引用，请先移除引用");

  // 先删对象再删记录 —— 反过来一旦删对象失败，就会留下一条指向已删记录的孤儿对象。
  await deleteMedia(db, row);

  logAudit({
    action: "media.delete", userId: ctx.user.id, userName: ctx.user.username,
    targetType: "media", targetId: row.path, ip: ctx.ip, userAgent: ctx.userAgent,
    meta: { storage: row.path.startsWith("/images/") ? "local" : "qiniu" },
  });
  return noStore(NextResponse.json({ ok: true }));
});
