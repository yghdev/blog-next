import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/lib/db";
import { requireAdmin, handle, badRequest, HttpError } from "@/lib/guards";
import { logAudit } from "@/lib/audit";
import {
  detectImage, looksLikeMarkup, buildRelativePath, safeJoin, imageSize, sha256,
  MAX_UPLOAD_BYTES, DAILY_UPLOAD_LIMIT,
} from "@/lib/upload";
import { uploadToStorage, readStorageConfig } from "@/lib/storage";
import { isConfigured } from "@/lib/qiniu";

export const dynamic = "force-dynamic";

/** 本地兜底目录：七牛未配置时仍然可用（老部署方式，不该因为没配存储就传不了图） */
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "public/images");

function startOfToday(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw badRequest("没有收到文件");

  if (file.size > MAX_UPLOAD_BYTES) {
    throw badRequest("图片不能超过 " + Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) + "MB");
  }
  if (file.size === 0) throw badRequest("文件是空的");

  const buf = Buffer.from(await file.arrayBuffer());

  // ① 只信 magic bytes：类型与扩展名都由服务端决定（A1 的根因修复）
  const detected = detectImage(buf);
  if (!detected) {
    throw badRequest(
      looksLikeMarkup(buf)
        ? "不支持该格式：SVG/HTML 等可携带脚本的文件一律拒绝"
        : "只支持 PNG / JPEG / GIF / WEBP / AVIF 图片"
    );
  }

  const db = getDb();

  // ② 按天配额：防止把后台当免费图床
  const todayCount = (db
    .prepare("SELECT COUNT(*) c FROM media WHERE created_at >= ?")
    .get(startOfToday()) as { c: number }).c;
  if (todayCount >= DAILY_UPLOAD_LIMIT) {
    throw new HttpError(429, "今日上传已达上限（" + DAILY_UPLOAD_LIMIT + " 张）");
  }

  // ③ 内容去重：同图重复上传直接复用，不占额外空间与流量。
  //    七牛模式下必须额外确认对象仍存在 —— media 表有记录但空间里被删掉时
  //    （手工删、或换过 bucket），只信表格会返回一个 404 的 URL。
  const digest = sha256(buf);
  const dup = db.prepare("SELECT path, filename, mime FROM media WHERE sha256 = ?").get(digest) as
    | { path: string; filename: string; mime: string } | undefined;
  if (dup) {
    const stillThere = await urlAlive(dup.path);
    if (stillThere) {
      return NextResponse.json({ ok: true, url: dup.path, deduped: true });
    }
    db.prepare("DELETE FROM media WHERE path = ?").run(dup.path);
  }

  const size = imageSize(buf, detected.mime);
  const cfg = readStorageConfig();
  const useQiniu = isConfigured(cfg);

  let publicPath: string;
  let storageKey: string | null = null;

  if (useQiniu) {
    // ④-a 主路径：直接写七牛，返回 CDN 直链
    try {
      const stored = await uploadToStorage(buf, detected.ext, detected.mime);
      publicPath = stored.url;
      storageKey = stored.key;
    } catch (e) {
      // 存储不可用时不要把上传打死：退回本地磁盘，并让调用方知道
      console.error("[upload] 七牛上传失败，退回本地磁盘:", (e as Error).message);
      publicPath = await writeLocal(buf, detected.ext);
      storageKey = null;
    }
  } else {
    // ④-b 兜底路径：本地磁盘 + nginx 直出
    publicPath = await writeLocal(buf, detected.ext);
  }

  db.prepare(
    "INSERT INTO media (path, filename, mime, size, width, height, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(publicPath, path.basename(publicPath), detected.mime, buf.length, size?.width ?? null, size?.height ?? null, digest);

  logAudit({
    action: "upload.create",
    userId: ctx.user.id, userName: ctx.user.username,
    targetType: "media", targetId: publicPath,
    meta: {
      mime: detected.mime, size: buf.length,
      declaredName: file.name.slice(0, 80), declaredType: file.type,
      storage: storageKey ? "qiniu" : "local",
    },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });

  return NextResponse.json({
    ok: true, url: publicPath, mime: detected.mime,
    width: size?.width, height: size?.height,
    storage: storageKey ? "qiniu" : "local",
  });
});

/** 写本地磁盘（兜底路径）。文件名由服务端生成，与客户端无关 */
async function writeLocal(buf: Buffer, ext: string): Promise<string> {
  const rel = buildRelativePath(ext);
  const abs = safeJoin(UPLOAD_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf, { mode: 0o644 });
  return "/images/" + rel;
}

/** 探活：本地路径查磁盘，CDN 路径发 HEAD */
async function urlAlive(publicPath: string): Promise<boolean> {
  if (publicPath.startsWith("/images/")) {
    const rel = publicPath.replace(/^\/images\//, "");
    return fs.access(safeJoin(UPLOAD_DIR, rel)).then(() => true).catch(() => false);
  }
  if (/^https?:\/\//.test(publicPath)) {
    try {
      const r = await fetch(publicPath, { method: "HEAD" });
      return r.ok;
    } catch {
      return false;
    }
  }
  return false;
}
