import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson, parsePostId, requireRevision } from "@/lib/admin-route";
import { discardDraft, draftIdentityOf, readDraft, readPost, saveDraft } from "@/lib/post-writes";
import { parseSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/posts/:id/draft —— 编辑器打开文章时调用（方案 §6.1）。
 *
 * 语义刻意做成"无论有没有草稿都返回 200"：
 *   - 有草稿：返回草稿身份与快照，编辑器加载草稿
 *   - 无草稿：draft 为 null，同时返回当前 post revision 与 posts 快照，
 *     编辑器加载线上内容（旧文章首次编辑就是这条路）
 *
 * 如果把"无草稿"做成 404，前端就得把 404 当正常分支处理 ——
 * 而 404 同时也是"文章不存在"的信号，两种情况混在一起没法区分。
 */
export const GET = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  await requireAdmin(req);
  const postId = parsePostId((await params).id);
  const conn = db();

  const post = readPost(conn, postId);
  if (!post) return noStoreJson({ error: "文章不存在", code: "POST_NOT_FOUND", status: 404 }, { status: 404 });

  const draft = readDraft(conn, postId);
  return noStoreJson({
    postId,
    postRevision: post.revision,
    deleted: !!post.deleted_at,
    draft: draft
      ? {
          identity: draftIdentityOf(draft),
          snapshot: JSON.parse(draft.snapshot_json),
          updatedAt: draft.updated_at,
        }
      : null,
  });
});

/**
 * PUT /api/admin/posts/:id/draft —— 保存完整快照（方案 §6.2）。
 *
 * 必须带 expectedPostRevision 与 expectedDraftRevision：
 * 无草稿时后者为 0，这是一份显式声明"我知道现在没有草稿"，
 * 避免并发下两个会话都以为自己是第一个。
 */
export const PUT = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const postId = parsePostId((await params).id);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStoreJson({ error: "参数错误", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const parsed = parseSnapshot(body.snapshot);
  if (!parsed.ok) return noStoreJson({ error: parsed.error, code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const result = saveDraft({
    db: db(),
    postId,
    actor: actorOf(ctx),
    clientDraftId: String(body.clientDraftId ?? ""),
    snapshot: parsed.snapshot,
    clientSnapshotHash: typeof body.snapshotHash === "string" ? body.snapshotHash : undefined,
    expectedPostRevision: requireRevision(body.expectedPostRevision, "expectedPostRevision"),
    expectedDraftRevision: requireRevision(body.expectedDraftRevision, "expectedDraftRevision"),
  });

  return noStoreJson({ ok: true, unchanged: result.unchanged, identity: result.identity });
});

/**
 * DELETE /api/admin/posts/:id/draft —— 放弃服务端草稿（方案 §6.5）。
 *
 * 注意与"放弃本地未同步内容"的区别：那个只清 localStorage，不调接口。
 * 这里删的是服务端草稿，用户会回到 posts 当前版本。
 */
export const DELETE = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const postId = parsePostId((await params).id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  discardDraft({
    db: db(),
    postId,
    actor: actorOf(ctx),
    expectedDraftRevision: requireRevision(body.expectedDraftRevision, "expectedDraftRevision"),
    expectedPostRevision: requireRevision(body.expectedPostRevision, "expectedPostRevision"),
  });

  return noStoreJson({ ok: true, discarded: true });
});
