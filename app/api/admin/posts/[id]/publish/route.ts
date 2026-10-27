import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson, parsePostId, requireRevision, requireString } from "@/lib/admin-route";
import { publishDraft, findPublishResult, readDraft, readPost, WriteError } from "@/lib/post-writes";
import { slug as vSlug, unwrap } from "@/lib/validate";
import { slugify, uniqueSlug, TAGS } from "@/lib/posts";
import { invalidate } from "@/lib/purge";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/posts/:id/publish —— 发布当前服务端草稿（方案 §5.3）。
 *
 * 关键：正文来源是**服务端当前草稿**，不接受客户端在发布请求里另传一套内容。
 * 否则"我看到的预览"和"实际发出去的"可能不是同一份，而这正是
 * 草稿协议要消除的那类不一致。
 *
 * 事务提交后：缓存失效在事务外（失败可重试，不回滚已提交数据）。
 */
export const POST = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const postId = parsePostId((await params).id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const publishRequestId = requireString(body.publishRequestId, "publishRequestId", 100);
  const expectedPostRevision = requireRevision(body.expectedPostRevision, "expectedPostRevision");
  const expectedDraftRevision = requireRevision(body.expectedDraftRevision, "expectedDraftRevision");

  const conn = db();

  /**
   * 幂等核对必须在"有没有草稿"之前。
   *
   * 因为第一次发布成功后草稿就被删了 —— 如果先检查草稿，
   * 同一个 publishRequestId 的重试会得到 PUBLISH_REQUIRES_DRAFT，
   * 客户端会把"其实已经成功了"误判为失败，然后可能换个 requestId 再发一次。
   */
  const already = findPublishResult(conn, postId, publishRequestId);
  if (already) {
    const p = readPost(conn, postId);
    if (!p) throw new WriteError("POST_NOT_FOUND", "文章不存在", 404);
    // 事务提交后缓存失效可以且应该再执行一次（幂等、可重试）
    invalidate([TAGS.posts, TAGS.post(postId)]);
    return noStoreJson({
      ok: true,
      postId,
      revision: already.revision,
      slug: p.slug,
      snapshotHash: already.snapshotHash,
      replayed: true,
    });
  }

  const draft = readDraft(conn, postId);
  const post = readPost(conn, postId);
  if (!post) throw new WriteError("POST_NOT_FOUND", "文章不存在", 404);
  if (!draft) throw new WriteError("PUBLISH_REQUIRES_DRAFT", "当前没有可发布的草稿", 409);

  // 正式 slug：优先取请求里确认过的，否则用草稿快照里的拟定 slug；
  // 都要经过合法性校验与唯一性检查（发布才要求标题/slug 合法，草稿阶段不要求）
  const snapshot = JSON.parse(draft.snapshot_json) as { slug: string; title: string; type: string };
  const wanted = typeof body.slug === "string" && body.slug ? body.slug : snapshot.slug;
  const normalized = unwrap(vSlug(wanted, { field: "URL 路径" })) || slugify(snapshot.title || "untitled");

  // 标题：页面/文章发布时必须有标题（说说不强制，沿用既有业务规则）
  if (snapshot.type !== "shuoshuo" && !String(snapshot.title ?? "").trim()) {
    throw new WriteError("SNAPSHOT_INVALID", "发布前请先填写标题", 400);
  }

  const finalSlug = uniqueSlug(normalized, (s) => {
    if (s === post.slug) return false; // 自己的当前 slug 不算冲突
    return !!conn.prepare("SELECT 1 FROM posts WHERE type = ? AND slug = ?").get(post.type, s);
  });

  const result = publishDraft({
    db: conn,
    postId,
    actor: actorOf(ctx),
    publishRequestId,
    expectedPostRevision,
    expectedDraftRevision,
    finalSlug,
  });

  // 事务外：缓存失效失败不影响已提交的发布结果
  invalidate([TAGS.posts, TAGS.post(postId)]);

  return noStoreJson(result);
});
