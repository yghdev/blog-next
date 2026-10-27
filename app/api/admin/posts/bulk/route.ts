import { NextRequest } from "next/server";
import { requireAdmin, requireStepUp, stepUpCodeFrom } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson } from "@/lib/admin-route";
import { readDraft, readPost, restoreDeletedPost, softDeletePost, WriteError } from "@/lib/post-writes";
import { snapshotIdentity } from "@/lib/snapshot";
import { TAGS } from "@/lib/posts";
import { nowIso } from "@/lib/time";
import { logAuditStrict } from "@/lib/audit";
import { invalidate } from "@/lib/purge";
import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * 批量操作（方案 §7.1）。
 *
 * 与旧实现的三点不同，每一点都是为"部分成功"服务的：
 *
 *  1. **逐项传 {id, expectedRevision}**，不再是一次 UPDATE ... WHERE id IN (...)。
 *     批量 IN 更新无法表达"第 3 条冲突、其余都成功"，只能全成全败。
 *  2. **逐项独立事务**，允许部分成功，逐项返回 published/updated、skipped、
 *     conflicts、notFound。
 *  3. 每成功项 revision 恰好 +1；跳过/冲突/不存在的项完全不变。
 *     缓存只针对成功项失效。
 *
 * publish 对**有当前草稿**的条目跳过（HAS_UNPUBLISHED_DRAFT）：
 * 不隐式选择快照 —— 用户手上的未发布修改不能被批量发布悄悄拿去发，
 * 也不能被悄悄丢弃。
 */

type Item = { id: number; expectedRevision: number };

type ItemResult = {
  id: number;
  ok: boolean;
  outcome: "published" | "unpublished" | "deleted" | "restored" | "skipped" | "conflict" | "notFound";
  code?: string;
  revision?: number;
  message?: string;
};

function parseItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  const out: Item[] = [];
  for (const v of raw) {
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const id = Number(o.id);
      const rev = Number(o.expectedRevision);
      if (Number.isInteger(id) && id > 0) out.push({ id, expectedRevision: Number.isFinite(rev) ? rev : -1 });
    }
  }
  return out;
}

function toItemResult(id: number, e: unknown): ItemResult {
  if (e instanceof WriteError) {
    const outcome: ItemResult["outcome"] =
      e.code === "POST_NOT_FOUND" || e.code === "ARTICLE_GONE" ? "notFound" : "conflict";
    return { id, ok: false, outcome, code: e.code, message: e.message };
  }
  return { id, ok: false, outcome: "conflict", code: "UNKNOWN", message: (e as Error).message };
}

export const POST = handleWrite(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStoreJson({ error: "参数错误", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  // 兼容旧调用形态（ids: number[]）：此时没有版本信息，逐项按冲突处理并说明原因。
  // 不静默"取当前版本代填" —— 那等于绕过并发检查（方案 §5.1 禁止）。
  const items: Item[] = Array.isArray(body.items)
    ? parseItems(body.items)
    : Array.isArray(body.ids)
      ? (body.ids as unknown[]).map((v) => ({ id: Number(v), expectedRevision: -1 }))
      : [];

  if (!items.length) return noStoreJson({ error: "请先选择文章", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });
  if (items.length > 200) return noStoreJson({ error: "一次最多操作 200 篇", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const action = String(body.action ?? "");
  const conn = db();
  const actor = actorOf(ctx);
  const results: ItemResult[] = [];

  if (action === "delete") {
    await requireStepUp(ctx, stepUpCodeFrom(req, body as Record<string, unknown>));
  }

  for (const item of items) {
    // 版本缺失是协议错误，不是"跳过"：明确告诉调用方必须传
    if (item.expectedRevision < 0) {
      results.push({
        id: item.id, ok: false, outcome: "conflict",
        code: "REVISION_REQUIRED", message: "批量操作必须逐项传 expectedRevision",
      });
      continue;
    }

    try {
      if (action === "delete") {
        const r = softDeletePost({ db: conn, postId: item.id, actor, expectedRevision: item.expectedRevision });
        results.push({ id: item.id, ok: true, outcome: "deleted", revision: r.revision });
      } else if (action === "restore") {
        const r = restoreDeletedPost({ db: conn, postId: item.id, actor, expectedRevision: item.expectedRevision });
        results.push({ id: item.id, ok: true, outcome: "restored", revision: r.revision });
      } else if (action === "publish") {
        results.push(publishOne(conn, item, actor));
      } else if (action === "unpublish") {
        results.push(unpublishOne(conn, item, actor));
      } else {
        return noStoreJson({ error: "未知的批量操作", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });
      }
    } catch (e) {
      results.push(toItemResult(item.id, e));
    }
  }

  // 只针对成功项失效缓存
  const okIds = results.filter((r) => r.ok).map((r) => r.id);
  if (okIds.length) invalidate([TAGS.posts, ...okIds.map((id) => TAGS.post(id))]);

  const summary = {
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    conflicts: results.filter((r) => r.outcome === "conflict").length,
    notFound: results.filter((r) => r.outcome === "notFound").length,
  };

  logAuditStrict(conn, {
    action: "post.bulk",
    userId: actor.userId, userName: actor.userName,
    meta: { action, ...summary },
    ip: actor.ip, userAgent: actor.userAgent,
  });

  return noStoreJson({ ok: true, action, summary, results });
});

/** 单条发布（批量语义）：有草稿则跳过，已发布也跳过 */
function publishOne(conn: ReturnType<typeof db>, item: Item, actor: ReturnType<typeof actorOf>): ItemResult {
  return conn.transaction((): ItemResult => {
    const post = readPost(conn, item.id);
    if (!post) return { id: item.id, ok: false, outcome: "notFound", code: "POST_NOT_FOUND" };
    if (post.deleted_at) return { id: item.id, ok: false, outcome: "notFound", code: "ARTICLE_GONE" };
    if (item.expectedRevision !== post.revision) {
      return {
        id: item.id, ok: false, outcome: "conflict", code: "BASE_REVISION_CONFLICT",
        message: "文章已被修改", revision: post.revision,
      };
    }
    // 有当前草稿 -> 跳过，绝不隐式选择快照
    if (readDraft(conn, item.id)) {
      return {
        id: item.id, ok: false, outcome: "skipped", code: "HAS_UNPUBLISHED_DRAFT",
        message: "存在未发布的草稿，请单独发布或先处理草稿",
      };
    }
    if (post.status === "published") {
      return { id: item.id, ok: false, outcome: "skipped", code: "ALREADY_PUBLISHED" };
    }

    const nextRevision = post.revision + 1;
    const now = nowIso();
    const info = conn.prepare(
      "UPDATE posts SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?, revision = ? " +
      "WHERE id = ? AND revision = ?"
    ).run(now, now, nextRevision, item.id, post.revision);
    if (info.changes !== 1) {
      return { id: item.id, ok: false, outcome: "conflict", code: "BASE_REVISION_CONFLICT" };
    }

    // 批量发布也要写不可变历史：否则会出现"有发布、无历史"的洞
    const { snapshotJson, snapshotHash } = snapshotIdentity({
      type: post.type, title: post.title, slug: post.slug, content: post.content,
      cover: post.cover,
      categories: safeArray(post.categories),
      tags: safeArray(post.tags),
      comments_enabled: (post.comments_enabled ? 1 : 0) as 0 | 1,
    });
    conn.prepare(
      "INSERT INTO post_revisions (post_id, revision, snapshot_json, snapshot_hash, reason, publish_request_id, created_by, created_at) " +
      "VALUES (?, ?, ?, ?, 'publish', ?, ?, ?)"
    ).run(item.id, nextRevision, snapshotJson, snapshotHash, "bulk-" + randomBytes(8).toString("hex"), actor.userId, now);

    logAuditStrict(conn, {
      action: "post.publish",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: item.id,
      meta: { revision: nextRevision, origin: "bulk" },
      ip: actor.ip, userAgent: actor.userAgent,
    });

    return { id: item.id, ok: true, outcome: "published", revision: nextRevision };
  })();
}

/** 单条取消发布：保留草稿，revision+1 */
function unpublishOne(conn: ReturnType<typeof db>, item: Item, actor: ReturnType<typeof actorOf>): ItemResult {
  return conn.transaction((): ItemResult => {
    const post = readPost(conn, item.id);
    if (!post) return { id: item.id, ok: false, outcome: "notFound", code: "POST_NOT_FOUND" };
    if (post.deleted_at) return { id: item.id, ok: false, outcome: "notFound", code: "ARTICLE_GONE" };
    if (item.expectedRevision !== post.revision) {
      return { id: item.id, ok: false, outcome: "conflict", code: "BASE_REVISION_CONFLICT", revision: post.revision };
    }
    if (post.status === "draft") {
      return { id: item.id, ok: false, outcome: "skipped", code: "ALREADY_DRAFT" };
    }
    const nextRevision = post.revision + 1;
    const now = nowIso();
    // 取消发布**保留草稿**（方案 §7.1）；此后再次保存会因基线冲突要求显式确认
    conn.prepare("UPDATE posts SET status = 'draft', updated_at = ?, revision = ? WHERE id = ? AND revision = ?")
      .run(now, nextRevision, item.id, post.revision);

    logAuditStrict(conn, {
      action: "post.unpublish",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: item.id,
      meta: { revision: nextRevision, origin: "bulk" },
      ip: actor.ip, userAgent: actor.userAgent,
    });
    return { id: item.id, ok: true, outcome: "unpublished", revision: nextRevision };
  })();
}

/** 安全解析库里的 JSON 数组（脏数据降级为 []，不让批量操作整体 500） */
function safeArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}
