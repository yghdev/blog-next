import { NextRequest } from "next/server";
import { requireAdmin, requireStepUp, stepUpCodeFrom } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson, parsePostId, requireRevision } from "@/lib/admin-route";
import { restoreDeletedPost } from "@/lib/post-writes";
import { logAudit } from "@/lib/audit";
import { TAGS } from "@/lib/posts";
import { invalidate } from "@/lib/purge";

export const dynamic = "force-dynamic";

/**
 * 从回收站恢复。必须带 expectedRevision（并发校验，方案 §5.1）。
 *
 * 恢复后 posts.revision +1，因此**此前基于旧基线的草稿再保存会触发
 * 基线冲突**（方案 §7.1 明确要求这个行为）：用户必须显式确认
 * "我的草稿是基于恢复前的内容写的"，而不是让系统猜测怎么合并。
 */
export const POST = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const id = parsePostId((await params).id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const result = restoreDeletedPost({
    db: db(),
    postId: id,
    actor: actorOf(ctx),
    expectedRevision: requireRevision(body.expectedRevision, "expectedRevision"),
  });

  invalidate([TAGS.posts, TAGS.post(id)]);
  return noStoreJson({ ok: true, revision: result.revision });
});

/** 预览彻底删除的影响面（purge 确认框用，方案 §3.5） */
export const GET = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  await requireAdmin(req);
  const id = parsePostId((await params).id);
  const conn = db();
  const row = conn.prepare("SELECT id, deleted_at FROM posts WHERE id = ?").get(id) as
    | { id: number; deleted_at: string | null }
    | undefined;
  if (!row) return noStoreJson({ error: "文章不存在", code: "POST_NOT_FOUND", status: 404 }, { status: 404 });

  const comments = (conn.prepare("SELECT COUNT(*) c FROM comments WHERE post_id = ?").get(id) as { c: number }).c;
  const versions = (conn.prepare("SELECT COUNT(*) c FROM post_revisions WHERE post_id = ?").get(id) as { c: number }).c;
  const drafts = (conn.prepare("SELECT COUNT(*) c FROM post_drafts WHERE post_id = ?").get(id) as { c: number }).c;

  return noStoreJson({ id, inTrash: !!row.deleted_at, comments, versions, drafts });
});

/**
 * 彻底删除（不可恢复）：要求 step-up。
 *
 * 返回删除的影响面（评论 / 历史版本 / 草稿），供确认框展示 ——
 * 方案 §3.5 要求 purge 前用户能看到"我要删掉多少东西"。
 */
export const DELETE = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const id = parsePostId((await params).id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  await requireStepUp(ctx, stepUpCodeFrom(req, body));

  const conn = db();
  const row = conn.prepare("SELECT id, deleted_at FROM posts WHERE id = ?").get(id) as
    | { id: number; deleted_at: string | null }
    | undefined;
  if (!row) return noStoreJson({ error: "文章不存在", code: "POST_NOT_FOUND", status: 404 }, { status: 404 });
  if (!row.deleted_at) {
    return noStoreJson({ error: "请先移入回收站，再彻底删除", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });
  }

  const comments = (conn.prepare("SELECT COUNT(*) c FROM comments WHERE post_id = ?").get(id) as { c: number }).c;
  const versions = (conn.prepare("SELECT COUNT(*) c FROM post_revisions WHERE post_id = ?").get(id) as { c: number }).c;
  const drafts = (conn.prepare("SELECT COUNT(*) c FROM post_drafts WHERE post_id = ?").get(id) as { c: number }).c;

  const purge = conn.transaction(() => {
    // 外键 ON DELETE CASCADE 本会带走草稿与历史，但显式删一遍更清楚，
    // 也不依赖 PRAGMA foreign_keys 一定开着（脚本环境未必设置）
    conn.prepare("DELETE FROM post_drafts WHERE post_id = ?").run(id);
    conn.prepare("DELETE FROM post_revisions WHERE post_id = ?").run(id);
    conn.prepare("DELETE FROM posts WHERE id = ?").run(id);
  });
  purge();

  // 这里用吞异常的 logAudit：文章已删，审计失败也回滚不了什么；
  // 它属于诊断用途，不是"必须与业务原子"的强制审计（那是发布/恢复历史）
  logAudit({
    action: "post.purge", userId: ctx.user.id, userName: ctx.user.username,
    targetType: "post", targetId: id,
    meta: { cascadeComments: comments, purgedVersions: versions, purgedDrafts: drafts },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });
  invalidate([TAGS.posts, TAGS.post(id)]);
  return noStoreJson({ ok: true, purgedComments: comments, purgedVersions: versions, purgedDrafts: drafts });
});
