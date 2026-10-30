/**
 * 媒体文件的服务端操作（删除 / 迁移到 CDN）。
 *
 * 抽出来的理由：单条删除与批量删除必须**完全同一套判定** —— 引用检查、
 * 七牛与磁盘两条路径、先删对象再删记录的顺序，任何一处漂移都会出现
 * 「库里没了但空间里还在」或「对象删了但记录还在」的脏状态。
 *
 * 迁移的取舍（重要，别当实现细节）：
 *   - 只处理本机磁盘上的老图；七牛图原样跳过。
 *   - 上传到七牛后改写**线上文章正文 / 封面**和**未发布草稿快照**里的路径，
 *     否则原文里的 /images/... 仍在，迁完就变成裂图。
 *   - 历史版本（post_revisions）**不改**：它是不可变档案。因此磁盘上的
 *     原文件也**保留**，恢复旧版本时旧路径仍然打得开 —— 迁移可回退。
 *   - 每次改写都是一次受控运维写入：revision 恰好 +1、updated_at 刷新、
 *     与媒体路径更新在同一事务里，失败整体回滚。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { MediaRow } from "./db";
import { safeJoin } from "./upload";
import { deleteFromStorage, keyFromUrl, readStorageConfig, uploadToStorage } from "./storage";
import { isConfigured } from "./qiniu";
import { logAuditStrict } from "./audit";
import { snapshotIdentity, type Snapshot } from "./snapshot";
import { nowIso } from "./time";

export const MEDIA_UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "public/images");

export type MediaActor = { userId: number; userName: string; ip?: string; userAgent?: string };

export function countMediaRefs(db: Database.Database, mediaPath: string): number {
  return (db.prepare(
    "SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL AND content LIKE ?"
  ).get("%" + mediaPath + "%") as { c: number }).c;
}

/**
 * 删除存储对象。七牛对象走 API，本机文件走 unlink。
 * 文件已不在磁盘时视为成功（记录必须能清掉）。
 */
export async function removeMediaObject(row: Pick<MediaRow, "path">): Promise<void> {
  const key = keyFromUrl(row.path);
  if (key) {
    await deleteQiniuObject(key);
    return;
  }
  if (row.path.startsWith("/images/")) {
    const rel = row.path.replace(/^\/images\//, "");
    try {
      await fs.unlink(safeJoin(MEDIA_UPLOAD_DIR, rel));
    } catch {
      // 文件已不在磁盘，仍允许清掉记录
    }
  }
}

/** 单独包一层是为了让错误信息带上「七牛」前缀，调用方好判断该不该中止 */
async function deleteQiniuObject(key: string): Promise<void> {
  try {
    await deleteFromStorage(key);
  } catch (e) {
    throw new Error("七牛删除失败：" + (e as Error).message);
  }
}

/**
 * 删除一条媒体记录（对象 + 行）。调用方必须先做引用检查。
 * 顺序不能反：先删对象再删行，失败时最坏是「记录还在、对象没了」，
 * 页面会把它标成裂图；反过来则是空间里留下看不见的费用。
 */
export async function deleteMedia(db: Database.Database, row: MediaRow): Promise<void> {
  await removeMediaObject(row);
  db.prepare("DELETE FROM media WHERE id = ?").run(row.id);
}

export type MigrateResult = {
  from: string;
  to: string;
  /** 被改写的线上文章数 */
  posts: number;
  /** 被改写的未发布草稿数 */
  drafts: number;
};

type PostTouch = { id: number; revision: number; content: string; cover: string | null };

/**
 * 把一张本机图片迁到七牛，并同步所有引用。
 *
 * 事务边界：media.path、posts、post_drafts 与会话审计一起提交。
 * 上传动作在事务**之前**完成 —— 网络请求不该占着数据库写锁；
 * 若后续事务失败，七牛上会多一个未登记对象（扫描能发现），
 * 但绝不会出现「正文指向一个不存在的对象」。
 */
export async function migrateLocalToCdn(
  db: Database.Database,
  row: MediaRow,
  actor: MediaActor
): Promise<MigrateResult> {
  if (!row.path.startsWith("/images/")) {
    throw new Error("这张图已经在 CDN 上");
  }
  const cfg = readStorageConfig();
  if (!isConfigured(cfg)) {
    throw new Error("七牛存储尚未配置，无法迁移");
  }

  const rel = row.path.replace(/^\/images\//, "");
  const abs = safeJoin(MEDIA_UPLOAD_DIR, rel);
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    throw new Error("本机磁盘上找不到原文件（可能已被手工删除）");
  }

  const ext = path.extname(row.filename) || path.extname(row.path) || "";
  const stored = await uploadToStorage(buf, ext, row.mime);
  if (stored.url === row.path) throw new Error("迁移后的地址与原地址相同，已跳过");

  const duplicate = db.prepare("SELECT id FROM media WHERE path = ?").get(stored.url) as { id: number } | undefined;
  if (duplicate) throw new Error("CDN 上已有同地址记录（id " + duplicate.id + "），已跳过");

  return db.transaction((): MigrateResult => {
    const now = nowIso();

    const posts = db.prepare(
      "SELECT id, revision, content, cover FROM posts " +
      "WHERE deleted_at IS NULL AND (content LIKE ? OR cover = ?)"
    ).all("%" + row.path + "%", row.path) as PostTouch[];

    let postsTouched = 0;
    for (const p of posts) {
      const content = replacePath(p.content, row.path, stored.url);
      const cover = p.cover === row.path ? stored.url : p.cover;
      if (content === p.content && cover === p.cover) continue;
      const info = db.prepare(
        "UPDATE posts SET content = ?, cover = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ?"
      ).run(content, cover, now, p.revision + 1, p.id, p.revision);
      if (info.changes !== 1) throw new Error("文章「" + p.id + "」在迁移过程中被修改，已整体回滚");
      postsTouched++;
    }

    const drafts = db.prepare(
      "SELECT post_id, snapshot_json, draft_revision FROM post_drafts " +
      "WHERE snapshot_json LIKE ? ESCAPE '\\'"
    ).all("%" + escapeLike(row.path) + "%") as {
      post_id: number; snapshot_json: string; draft_revision: number;
    }[];

    let draftsTouched = 0;
    for (const d of drafts) {
      let snap: Snapshot;
      try {
        snap = JSON.parse(d.snapshot_json) as Snapshot;
      } catch {
        continue; // 脏快照不阻断迁移：其余引用照常修
      }
      const content = replacePath(String(snap.content ?? ""), row.path, stored.url);
      const cover = snap.cover === row.path ? stored.url : snap.cover;
      if (content === snap.content && cover === snap.cover) continue;
      const { snapshotJson, snapshotHash } = snapshotIdentity({ ...snap, content, cover });
      db.prepare(
        "UPDATE post_drafts SET snapshot_json = ?, snapshot_hash = ?, draft_revision = ?, updated_at = ? " +
        "WHERE post_id = ? AND draft_revision = ?"
      ).run(snapshotJson, snapshotHash, d.draft_revision + 1, now, d.post_id, d.draft_revision);
      draftsTouched++;
    }

    const info = db.prepare("UPDATE media SET path = ? WHERE id = ? AND path = ?")
      .run(stored.url, row.id, row.path);
    if (info.changes !== 1) throw new Error("媒体记录在迁移过程中被修改，已整体回滚");

    logAuditStrict(db, {
      action: "media.migrate",
      userId: actor.userId, userName: actor.userName,
      targetType: "media", targetId: row.path,
      meta: { to: stored.url, posts: postsTouched, drafts: draftsTouched },
      ip: actor.ip, userAgent: actor.userAgent,
    });

    return { from: row.path, to: stored.url, posts: postsTouched, drafts: draftsTouched };
  })();
}

/** 原样替换路径；不解释正则，路径里出现特殊字符也不会误伤 */
function replacePath(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => "\\" + m);
}
