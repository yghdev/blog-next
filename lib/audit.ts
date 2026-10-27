import { getDb, type AuditRow } from "./db";
import { nowIso } from "./time";

export type AuditAction =
  | "login.ok" | "login.fail"
  | "logout"
  | "post.create" | "post.update" | "post.delete" | "post.restore" | "post.purge"
  | "post.publish" | "post.unpublish" | "post.bulk"
  | "comment.approve" | "comment.spam" | "comment.delete" | "comment.bulk" | "comment.reply"
  | "upload.create" | "media.delete" | "media.orphans"
  | "settings.update"
  | "storage.update" | "storage.test"
  | "links.create" | "links.update" | "links.delete"
  | "totp.start" | "totp.enable" | "totp.disable"
  | "recovery.regenerate"
  | "password.change"
  | "session.revoke" | "session.revoke_all";

export type AuditInput = {
  action: AuditAction;
  userId?: number | null;
  userName?: string;
  targetType?: "post" | "comment" | "media" | "setting" | "settings" | "user" | "session" | "friend_link";
  targetId?: string | number;
  meta?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
};

/**
 * 写一条审计记录（方案 C1）。
 * 设计要点：
 *   - 永不抛出：审计失败不能连累业务操作
 *   - 记录 IP 与 UA，便于回溯「谁在哪儿干的」
 *   - meta 只放摘要，不放正文（避免日志膨胀 + 二次泄露）
 */
export function logAudit(input: AuditInput): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO audit_log (actor_user_id, actor_name, action, target_type, target_id, meta_json, ip, user_agent, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      input.userId ?? null,
      (input.userName ?? "").slice(0, 60),
      input.action,
      input.targetType ?? null,
      input.targetId === undefined ? null : String(input.targetId),
      JSON.stringify(input.meta ?? {}).slice(0, 4000),
      (input.ip ?? "").slice(0, 64),
      (input.userAgent ?? "").slice(0, 300),
      nowIso()
    );
  } catch (e) {
    console.error("[audit] failed to write entry", (e as Error).message);
  }
}

export type AuditQuery = {
  action?: string;
  targetType?: string;
  targetId?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export function listAudit(query: AuditQuery = {}): { rows: AuditRow[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.action) { where.push("action = ?"); args.push(query.action); }
  if (query.targetType) { where.push("target_type = ?"); args.push(query.targetType); }
  if (query.targetId) { where.push("target_id = ?"); args.push(query.targetId); }
  if (query.q) { where.push("(actor_name LIKE ? OR action LIKE ? OR meta_json LIKE ?)"); const like = "%" + query.q + "%"; args.push(like, like, like); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const total = (db.prepare("SELECT COUNT(*) c FROM audit_log " + whereSql).get(...args) as { c: number }).c;
  const rows = db.prepare(
    "SELECT * FROM audit_log " + whereSql + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ).all(...args, limit, offset) as AuditRow[];
  return { rows, total };
}

/** 保留策略：默认 180 天（由备份脚本或 cron 触发） */
export function pruneAudit(days = 180): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  return db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff).changes;
}
