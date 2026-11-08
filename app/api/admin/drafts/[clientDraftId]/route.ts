import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson } from "@/lib/admin-route";
import { createDraftShell, readDraft, saveDraft, draftIdentityOf } from "@/lib/post-writes";
import { parseSnapshot } from "@/lib/snapshot";
import { WriteError } from "@/lib/post-writes";

export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/drafts/:clientDraftId —— 新文章首次保存 / 同身份重试（方案 §6.3）。
 *
 * 这个接口的存在意义：新文章在用户输入标题之前就要能保存草稿，
 * 而"发布文章必须有标题"的规则不能用来拒绝草稿（方案 §4.2）。
 * 所以首次保存先建一个壳（status=draft、slug=draft-xxx），再挂草稿。
 *
 * 幂等规则：
 *   - 不存在 -> 事务内创建壳和草稿，返回 postId 与 DraftIdentity
 *   - 已存在且身份、规范化快照一致 -> 幂等返回，无版本递增
 *   - 已存在但快照不同 -> 走正常保存协议，必须提供两个 expected 版本
 *   - 缺版本、版本不符、绑定不符、归属不符 -> 409/403，绝不静默成功
 */
export const PUT = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ clientDraftId: string }> }) => {
  const ctx = await requireAdmin(req);
  const clientDraftId = (await params).clientDraftId;
  if (!clientDraftId || clientDraftId.length > 100) {
    return noStoreJson({ error: "clientDraftId 不合法", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStoreJson({ error: "参数错误", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const parsed = parseSnapshot(body.snapshot);
  if (!parsed.ok) return noStoreJson({ error: parsed.error, code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const conn = db();

  // 已存在这个 clientDraftId 的草稿？重试就返回幂等结果
  const existingDraft = conn.prepare(
    "SELECT post_id, client_draft_id, base_revision, draft_revision, snapshot_hash, snapshot_json, owner_user_id " +
    "FROM post_drafts WHERE client_draft_id = ?"
  ).get(clientDraftId) as
    | { post_id: number; client_draft_id: string; base_revision: number; draft_revision: number; snapshot_hash: string; snapshot_json: string; owner_user_id: number | null }
    | undefined;

  if (existingDraft) {
    // 归属校验：草稿属于别人时不能覆盖（UUID 不可猜测 ≠ 鉴权）
    if (existingDraft.owner_user_id !== null && existingDraft.owner_user_id !== ctx.user.id) {
      throw new WriteError("DRAFT_FORBIDDEN", "该草稿属于其他用户", 403);
    }

    const hadVersions = body.expectedDraftRevision !== undefined || body.expectedPostRevision !== undefined;

    if (!hadVersions) {
      // 没带版本：仅当快照完全一致才允许幂等返回，否则拒绝 ——
      // 否则"不同内容 + 没带版本"会被当成静默覆盖
      const incoming = JSON.stringify(parsed.snapshot);
      const stored = JSON.parse(existingDraft.snapshot_json) as unknown;
      const same = JSON.stringify(stored) === incoming;
      if (!same) {
        throw new WriteError("DRAFT_REVISION_CONFLICT", "该草稿已存在且内容不同，请带上版本信息重试", 409, {
          currentDraftRevision: existingDraft.draft_revision,
          serverSnapshotHash: existingDraft.snapshot_hash,
        });
      }
      return noStoreJson({
        ok: true,
        unchanged: true,
        identity: {
          postId: existingDraft.post_id,
          clientDraftId,
          baseRevision: existingDraft.base_revision,
          draftRevision: existingDraft.draft_revision,
          snapshotHash: existingDraft.snapshot_hash,
        },
      });
    }

    // 带了版本：走正常保存协议
    const result = saveDraft({
      db: conn,
      postId: existingDraft.post_id,
      actor: actorOf(ctx),
      clientDraftId,
      snapshot: parsed.snapshot,
      clientSnapshotHash: typeof body.snapshotHash === "string" ? body.snapshotHash : undefined,
      expectedPostRevision: Number(body.expectedPostRevision),
      expectedDraftRevision: Number(body.expectedDraftRevision),
    });
    return noStoreJson({ ok: true, unchanged: result.unchanged, identity: result.identity });
  }

  // 首次保存：建壳 + 草稿，两者同一事务内完成
  const created = conn.transaction(() => {
    const { postId } = createDraftShell({
      db: conn,
      actor: actorOf(ctx),
      type: parsed.snapshot.type,
    });
    return saveDraft({
      db: conn,
      postId,
      actor: actorOf(ctx),
      clientDraftId,
      snapshot: parsed.snapshot,
      clientSnapshotHash: typeof body.snapshotHash === "string" ? body.snapshotHash : undefined,
      // 刚建的壳 revision 必为 1，且必然没有草稿
      expectedPostRevision: 1,
      expectedDraftRevision: 0,
    });
  })();

  return noStoreJson({ ok: true, created: true, unchanged: false, identity: created.identity });
});

/**
 * GET /api/admin/drafts/:clientDraftId —— 按客户端身份查草稿。
 *
 * 用于"首次保存超时后重试"：客户端拿同一个 clientDraftId 来问
 * "你到底建成没有"，而不是盲改走另一个新建接口（方案 §6.1.1）。
 */
export const GET = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ clientDraftId: string }> }) => {
  await requireAdmin(req);
  const clientDraftId = (await params).clientDraftId;
  const conn = db();

  const row = conn.prepare(
    "SELECT post_id FROM post_drafts WHERE client_draft_id = ?"
  ).get(clientDraftId) as { post_id: number } | undefined;
  if (!row) return noStoreJson({ found: false, clientDraftId });

  const draft = readDraft(conn, row.post_id);
  if (!draft) return noStoreJson({ found: false, clientDraftId });

  return noStoreJson({
    found: true,
    identity: draftIdentityOf(draft),
    snapshot: JSON.parse(draft.snapshot_json),
    updatedAt: draft.updated_at,
  });
});
