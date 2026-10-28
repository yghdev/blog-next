import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getDb, type MediaRow } from "@/lib/db";
import { requireAdmin, handle, noStore } from "@/lib/guards";
import { logAudit } from "@/lib/audit";
import { readStorageConfig, countObjects } from "@/lib/storage";
import { isConfigured, listObjects } from "@/lib/qiniu";

export const dynamic = "force-dynamic";

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "public/images");

/** 按扩展名猜 MIME —— 七牛 List 不返回 Content-Type，登记时够用即可 */
function guessMime(key: string): string {
  const ext = key.toLowerCase().slice(key.lastIndexOf("."));
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm",
  };
  return map[ext] ?? "application/octet-stream";
}

/** 媒体库列表 + 存储概览 */
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 60) || 60, 1), 200);
  const offset = Math.max(Number(sp.get("offset") ?? 0) || 0, 0);
  /**
   * 按类型筛选（编辑器「从媒体库插入」用）。
   *   image / video —— 只看某一类
   *   不传         —— 全部（媒体库管理页保持原行为）
   * 用 mime 前缀判断而不是扩展名：媒体库里有历史上按扩展名猜出来的记录，
   * 前缀是最稳的共同点。
   */
  const kind = sp.get("kind") ?? "";
  const kindCond = kind === "image" ? "mime LIKE 'image/%'"
    : kind === "video" ? "mime LIKE 'video/%'"
    : "";

  const db = getDb();
  const conds: string[] = [];
  const args: unknown[] = [];
  if (q) { conds.push("(path LIKE ? OR filename LIKE ?)"); args.push("%" + q + "%", "%" + q + "%"); }
  if (kindCond) conds.push(kindCond);
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const total = (db.prepare("SELECT COUNT(*) c FROM media " + where).get(...args) as { c: number }).c;
  const rows = db.prepare("SELECT * FROM media " + where + " ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(...args, limit, offset) as MediaRow[];

  // 引用计数：文章正文里出现的路径
  const refRow = db.prepare("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL AND content LIKE ?");
  const items = rows.map((m) => ({
    ...m,
    refs: (refRow.get("%" + m.path + "%") as { c: number }).c,
    storage: m.path.startsWith("/images/") ? "local" : "qiniu",
    // 编辑器据此决定插入 <img> 还是 <video>，不必在前端重复判 mime
    kind: m.mime.startsWith("video/") ? "video" as const : "image" as const,
  }));

  const cfg = readStorageConfig();
  const qiniuCount = (db.prepare("SELECT COUNT(*) c FROM media WHERE path NOT LIKE '/images/%'").get() as { c: number }).c;
  const localCount = (db.prepare("SELECT COUNT(*) c FROM media WHERE path LIKE '/images/%'").get() as { c: number }).c;
  const totalBytes = (db.prepare("SELECT COALESCE(SUM(size),0) s FROM media").get() as { s: number }).s;

  return noStore(NextResponse.json({
    rows: items, total, limit, offset,
    overview: {
      qiniuConfigured: isConfigured(cfg),
      cdnDomain: cfg.cdnDomain,
      qiniuCount, localCount, totalBytes,
    },
  }));
});

/**
 * POST 动作：
 *   scan-orphans —— 对比「库里记录」与「实际存储」，找出单向存在的对象
 */
export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  const db = getDb();

  if (action === "import-qiniu") {
    /**
     * 把七牛空间里「库中没有」的对象登记进 media 表。
     *
     * 场景：这些对象是历史上用别的客户端（第三方图床、PicGo 等）传的，
     * 从来没经过博客的 media 表，于是媒体库里看不见、也没法删。
     * 只登记、不动对象本身；判断"已在库里"用 CDN 域名 + key 拼出的完整 URL。
     */
    const cfg = readStorageConfig();
    if (!isConfigured(cfg)) {
      return noStore(NextResponse.json({ error: "七牛尚未配置" }, { status: 400 }));
    }
    const domain = cfg.cdnDomain.replace(/\/+$/, "");
    const known = new Set((db.prepare("SELECT path FROM media").all() as { path: string }[]).map((r) => r.path));
    const inserted: string[] = [];
    const ins = db.prepare(
      "INSERT OR IGNORE INTO media (path, filename, mime, size, width, height, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    let token: string | null = null;
    let scanned = 0;
    for (let page = 0; page < 20; page++) {
      const r = await listObjects(cfg, { maxKeys: 1000, continuationToken: token ?? undefined });
      for (const o of r.objects) {
        scanned++;
        const url = domain + "/" + o.key;
        if (known.has(url)) continue;
        const mime = guessMime(o.key);
        ins.run(url, o.key.split("/").pop() ?? o.key, mime, o.size, null, null, null);
        inserted.push(url);
        known.add(url);
      }
      token = r.nextToken;
      if (!token || r.objects.length === 0) break;
    }

    logAudit({
      action: "media.orphans", userId: ctx.user.id, userName: ctx.user.username,
      meta: { action: "import-qiniu", scanned, inserted: inserted.length },
      ip: ctx.ip, userAgent: ctx.userAgent,
    });

    return noStore(NextResponse.json({
      ok: true, scanned, inserted: inserted.length,
      sample: inserted.slice(0, 20),
    }));
  }

  if (action !== "scan-orphans") {
    return noStore(NextResponse.json({ error: "未知操作" }, { status: 400 }));
  }

  const rows = db.prepare("SELECT path FROM media").all() as { path: string }[];
  const knownLocal = new Set<string>();
  const knownQiniu = new Set<string>();
  for (const r of rows) {
    if (r.path.startsWith("/images/")) knownLocal.add(r.path);
    else knownQiniu.add(r.path);
  }

  // 磁盘侧
  const onDisk: string[] = [];
  async function walk(dir: string, rel = "") {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const nextRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), nextRel);
      else onDisk.push("/images/" + nextRel);
    }
  }
  await walk(UPLOAD_DIR);

  // 七牛侧（分页拉全量，最多 20 页 = 2 万对象）
  const cfg = readStorageConfig();
  const qiniuKeys: string[] = [];
  if (isConfigured(cfg)) {
    let token: string | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await listObjects(cfg, { maxKeys: 1000, continuationToken: token ?? undefined });
      for (const o of r.objects) qiniuKeys.push(cfg.cdnDomain.replace(/\/+$/, "") + "/" + o.key);
      token = r.nextToken;
      if (!token || r.objects.length === 0) break;
    }
  }

  const diskOrphans = onDisk.filter((p) => !knownLocal.has(p));
  const qiniuOrphans = qiniuKeys.filter((p) => !knownQiniu.has(p));
  const missingInStorage = [
    ...(isConfigured(cfg) ? [...knownQiniu].filter((p) => !qiniuKeys.includes(p)) : []),
    ...[...knownLocal].filter((p) => !onDisk.includes(p)),
  ];

  logAudit({
    action: "media.orphans", userId: ctx.user.id, userName: ctx.user.username,
    meta: {
      onDisk: onDisk.length, inDb: rows.length, qiniu: qiniuKeys.length,
      diskOrphans: diskOrphans.length, qiniuOrphans: qiniuOrphans.length,
      missing: missingInStorage.length,
    },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });

  return noStore(NextResponse.json({
    ok: true,
    onDisk: onDisk.length,
    qiniu: qiniuKeys.length,
    inDb: rows.length,
    // 存储里有、库里没有（可以清理，但先只报告不删）
    orphans: [...diskOrphans, ...qiniuOrphans].slice(0, 200),
    orphanCount: diskOrphans.length + qiniuOrphans.length,
    // 库里有、存储里没有（这些是"裂图"，需要处理）
    missing: missingInStorage.slice(0, 200),
    missingCount: missingInStorage.length,
  }));
});
