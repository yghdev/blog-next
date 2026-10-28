import { NextRequest } from "next/server";
import { requireAdmin, requireStepUp, stepUpCodeFrom } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson, parsePostId, requireRevision } from "@/lib/admin-route";
import { patchPostMetadata, readPost, softDeletePost, type MetadataPatch } from "@/lib/post-writes";
import { str, strList, unwrap } from "@/lib/validate";
import { TAGS } from "@/lib/posts";
import { invalidate } from "@/lib/purge";

export const dynamic = "force-dynamic";

/**
 * GET 单篇：编辑器与调试用。
 * 带上 revision 和草稿摘要，前端才能判断"我拿到的是不是最新版本"。
 */
export const GET = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  await requireAdmin(req);
  const id = parsePostId((await params).id);
  const conn = db();
  const row = conn.prepare("SELECT * FROM posts WHERE id = ?").get(id);
  if (!row) return noStoreJson({ error: "文章不存在", code: "POST_NOT_FOUND", status: 404 }, { status: 404 });
  // 带上 snapshot_json：编辑器要用它判断"服务端草稿是否比 posts 新"，
  // 冲突对比也要正文。只给 hash 的话前端还得再发一次 GET 才能拿到内容。
  const draft = conn.prepare(
    "SELECT client_draft_id, base_revision, draft_revision, snapshot_hash, snapshot_json, updated_at " +
    "FROM post_drafts WHERE post_id = ?"
  ).get(id);
  return noStoreJson({ post: row, draft: draft ?? null });
});

/**
 * PATCH 元数据（方案 §4.1 / §5.1）。
 *
 * 这一步替换了阶段 00 pin 的三条已知缺陷：
 *   1. 全字段覆盖 -> 只改传入字段，未传的保持原值
 *   2. cover:null 清不掉（COALESCE）-> 三态语义，显式 null 即清除
 *   3. slug 别名与 posts 更新不在同一事务 -> 统一写核心内同一事务
 *
 * 另外新增：必须带 expectedRevision，用 WHERE id=? AND revision=? 原子更新。
 * 没有通用 skipRevisionCheck 开关。
 */
export const PATCH = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const id = parsePostId((await params).id);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStoreJson({ error: "参数错误", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const patch: MetadataPatch = {};

  // 只把**请求里真实出现**的字段放进补丁 —— 这是"三态"的关键。
  // 用 `in` 判断而不是 `!== undefined`：POST 过来的 JSON 里
  // {"cover": null} 必须与"没有 cover 键"区分开。
  if ("title" in body) patch.title = unwrap(str(body.title, { field: "标题", max: 200 }));
  if ("slug" in body) patch.slug = unwrap(str(body.slug, { field: "URL 路径", max: 100 }));
  if ("categories" in body) patch.categories = unwrap(strList(body.categories, { field: "分类" }));
  if ("tags" in body) patch.tags = unwrap(strList(body.tags, { field: "标签" }));
  if ("cover" in body) {
    if (body.cover === null) patch.cover = null;            // 清除
    else if (typeof body.cover === "string") patch.cover = body.cover; // 设置
    else return noStoreJson({ error: "cover 必须是字符串或 null", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });
  }
  if ("comments_enabled" in body) {
    if (body.comments_enabled !== 0 && body.comments_enabled !== 1) {
      return noStoreJson({ error: "comments_enabled 必须是 0 或 1", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });
    }
    patch.comments_enabled = body.comments_enabled;
  }

  const result = patchPostMetadata({
    db: db(),
    postId: id,
    actor: actorOf(ctx),
    patch,
    expectedRevision: requireRevision(body.expectedRevision, "expectedRevision"),
  });

  invalidate([TAGS.posts, TAGS.post(id)]);
  return noStoreJson({ ok: true, revision: result.revision, slug: result.slug, status: result.status });
});

/**
 * 删除 = 软删除进回收站。要求 step-up（破坏性操作）。
 *
 * 保留草稿（方案 §7.1）：恢复后还能继续编辑未发布内容，
 * 但此后保存会因基线变化触发冲突，需要显式确认。
 *
 * expectedRevision 是**必填**的：方案 §5.1 明确"无通用 skipRevisionCheck"。
 * 曾经想把它默认成"当前版本"，但那等于给删除留了一个隐式跳过并发检查的后门 ——
 * 列表页刷新后可能删掉别人刚改过的文章而毫无提示。前端传 list 里拿到的版本即可。
 */
export const DELETE = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const id = parsePostId((await params).id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  await requireStepUp(ctx, stepUpCodeFrom(req, body));

  const result = softDeletePost({
    db: db(),
    postId: id,
    actor: actorOf(ctx),
    expectedRevision: requireRevision(body.expectedRevision, "expectedRevision"),
  });

  invalidate([TAGS.posts, TAGS.post(id)]);
  return noStoreJson({ ok: true, movedToTrash: true, revision: result.revision });
});
