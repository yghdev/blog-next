import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson, parsePostId, requireRevision } from "@/lib/admin-route";
import { restoreVersionToDraft } from "@/lib/post-writes";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/posts/:id/restore-version —— 用历史快照替换当前草稿（方案 §6.4）。
 *
 * 语义边界必须清楚：恢复**只改草稿**，不改线上内容，也不新增历史。
 * 用户恢复后还要显式发布，线上才会变 —— 这样"手滑恢复了旧版本"不会
 * 直接把一个旧版本推到读者面前。
 */
export const POST = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const postId = parsePostId((await params).id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const revision = requireRevision(body.revision, "revision");

  const result = restoreVersionToDraft({
    db: db(),
    postId,
    actor: actorOf(ctx),
    revision,
    expectedDraftRevision: requireRevision(body.expectedDraftRevision, "expectedDraftRevision"),
    expectedPostRevision: requireRevision(body.expectedPostRevision, "expectedPostRevision"),
    clientDraftId: String(body.clientDraftId ?? ""),
  });

  return noStoreJson({ ok: true, identity: result.identity });
});

/**
 * GET /api/admin/posts/:id/restore-version —— 历史版本列表（编辑器"版本历史"用）。
 *
 * 注意按 created_at/id 排序，**不把 revision 当连续发布序号**：
 * revision 是行版本，中间可能跳号（元数据补丁也会递增它）。
 */
export const GET = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  await requireAdmin(req);
  const postId = parsePostId((await params).id);

  const rows = db().prepare(
    "SELECT id, revision, reason, created_at, snapshot_hash, created_by FROM post_revisions " +
    "WHERE post_id = ? ORDER BY id DESC LIMIT 100"
  ).all(postId) as {
    id: number; revision: number; reason: string; created_at: string;
    snapshot_hash: string; created_by: number | null;
  }[];

  return noStoreJson({
    postId,
    versions: rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      reason: r.reason,
      createdAt: r.created_at,
      snapshotHash: r.snapshot_hash,
      // 给界面的简短标签：历史列表里要能一眼看出"这是发布还是基线"
      label: r.reason === "baseline" ? "初始基线" : "发布",
    })),
  });
});
