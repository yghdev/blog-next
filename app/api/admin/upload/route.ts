import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/lib/db";
import { requireAdmin, handle, badRequest, HttpError } from "@/lib/guards";
import { logAudit } from "@/lib/audit";
import {
  detectImage, detectVideo, looksLikeMarkup, buildRelativePath, safeJoin, imageSize, sha256,
  MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, DAILY_UPLOAD_LIMIT, DAILY_VIDEO_LIMIT,
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

  if (file.size === 0) throw badRequest("文件是空的");

  /**
   * 先看体积，再判定类型 —— 顺序是有讲究的。
   *
   * 图片与视频上限差 5 倍（8MB / 40MB），所以不能只写一个总上限：那会让
   * 40MB 的图片包也进到 magic bytes 解析里（白读一遍 40MB），或者反过来
   * 把 20MB 的视频当成超限拒掉。先按"最大可能"粗筛（超过 40MB 一律拒，
   * 连读都不读），再在拿到真实类型后用各自的精确上限复核。
   */
  const hardCap = Math.max(MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES);
  if (file.size > hardCap) {
    throw badRequest("文件过大：视频最大 " + Math.round(MAX_VIDEO_BYTES / 1024 / 1024) +
      "MB，图片最大 " + Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) + "MB");
  }

  const buf = Buffer.from(await file.arrayBuffer());

  /**
   * ① 只信 magic bytes：类型与扩展名都由服务端决定（A1 的根因修复）。
   *
   * 先试视频再试图片：两者签名没有交集（ftyp / EBML vs PNG  / FFD8），
   * 顺序不影响正确性，只是视频文件通常更大、命中概率更低，放前面少解析一次。
   */
  const video = detectVideo(buf);
  const image = video ? null : detectImage(buf);
  if (!video && !image) {
    throw badRequest(
      looksLikeMarkup(buf)
        ? "不支持该格式：SVG/HTML 等可携带脚本的文件一律拒绝"
        : "只支持 PNG / JPEG / GIF / WEBP / AVIF 图片，或 MP4 / WebM 视频"
    );
  }

  const isVideo = Boolean(video);
  const detected = (video ?? image)!;

  // ② 精确上限复核（拿到真实类型之后）
  if (isVideo && file.size > MAX_VIDEO_BYTES) {
    throw badRequest("视频不能超过 " + Math.round(MAX_VIDEO_BYTES / 1024 / 1024) + "MB");
  }
  if (!isVideo && file.size > MAX_UPLOAD_BYTES) {
    throw badRequest("图片不能超过 " + Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) + "MB");
  }

  const db = getDb();

  // ③ 按天配额：防止把后台当免费图床。
  //    图片按「张」计（100 张/天）；视频单个体积是图的 5 倍，按「个」单独限 10 个/天，
  //    否则 100 × 40MB = 4GB 一天就能把空间写满。
  const todayCount = (db
    .prepare("SELECT COUNT(*) c FROM media WHERE created_at >= ? AND mime LIKE 'image/%'")
    .get(startOfToday()) as { c: number }).c;
  if (!isVideo && todayCount >= DAILY_UPLOAD_LIMIT) {
    throw new HttpError(429, "今日图片上传已达上限（" + DAILY_UPLOAD_LIMIT + " 张）");
  }
  if (isVideo) {
    const todayVideos = (db
      .prepare("SELECT COUNT(*) c FROM media WHERE created_at >= ? AND mime LIKE 'video/%'")
      .get(startOfToday()) as { c: number }).c;
    if (todayVideos >= DAILY_VIDEO_LIMIT) {
      throw new HttpError(429, "今日视频上传已达上限（" + DAILY_VIDEO_LIMIT + " 个）");
    }
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
      // kind 必须一起返回：复用一个已有视频时，前端要靠它决定插入 <video> 还是 ![]()
      return NextResponse.json({
        ok: true, url: dup.path, deduped: true,
        mime: dup.mime, kind: dup.mime.startsWith("video/") ? "video" : "image",
      });
    }
    db.prepare("DELETE FROM media WHERE path = ?").run(dup.path);
  }

  // 视频不解析宽高：MP4 的 tkhd 解析要为每种容器单独写，而媒体库里
  // 视频留空宽高只影响缩略图比例（前端会退回 16:9），不值得为它引入解析器
  const size = isVideo ? null : imageSize(buf, detected.mime);
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
      mime: detected.mime, size: buf.length, kind: isVideo ? "video" : "image",
      declaredName: file.name.slice(0, 80), declaredType: file.type,
      storage: storageKey ? "qiniu" : "local",
    },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });

  return NextResponse.json({
    ok: true, url: publicPath, mime: detected.mime, kind: isVideo ? "video" : "image",
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
