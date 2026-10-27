import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson, parsePostId, requireRevision } from "@/lib/admin-route";
import { rebaseDraft } from "@/lib/post-writes";
import { parseSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/posts/:id/draft/rebase —— 用户确认后替换快照并更新基线（方案 §6.5）。
 *
 * 这里刻意**不做字段级自动合并**：三方差异由界面呈现，用户决定最终内容，
 * 服务端只负责把"用户确认过的完整快照"落盘并把基线推到最新版本。
 * 自动合并 Markdown 正文的风险远大于收益（改一个错字可能悄悄吃掉一段代码块）。
 */
export const POST = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const postId = parsePostId((await params).id);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStoreJson({ error: "参数错误", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const parsed = parseSnapshot(body.snapshot);
  if (!parsed.ok) return noStoreJson({ error: parsed.error, code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const result = rebaseDraft({
    db: db(),
    postId,
    actor: actorOf(ctx),
    clientDraftId: String(body.clientDraftId ?? ""),
    snapshot: parsed.snapshot,
    clientSnapshotHash: typeof body.snapshotHash === "string" ? body.snapshotHash : undefined,
    expectedDraftRevision: requireRevision(body.expectedDraftRevision, "expectedDraftRevision"),
    expectedPostRevision: requireRevision(body.expectedPostRevision, "expectedPostRevision"),
  });

  return noStoreJson({ ok: true, identity: result.identity });
});
