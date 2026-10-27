import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { actorOf, db, handleWrite, noStoreJson } from "@/lib/admin-route";
import { createDraftShell, saveDraft, publishDraft } from "@/lib/post-writes";
import { parseSnapshot } from "@/lib/snapshot";
import { TAGS, slugify, uniqueSlug } from "@/lib/posts";
import { invalidate } from "@/lib/purge";
import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * 后台列表：分页 + 筛选 + 搜索（C8）。
 * 原实现 SELECT * 全表载入后交给前端过滤。
 */
export const GET = handleWrite(async (req: NextRequest) => {
  await requireAdmin(req);
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  const type = sp.get("type") ?? "";
  const status = sp.get("status") ?? "";
  const trash = sp.get("trash") === "1";
  const rawLimit = Number(sp.get("limit") ?? 30);
  const lim = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 30;
  const rawOffset = Number(sp.get("offset") ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

  const TYPES = ["post", "page", "shuoshuo"];
  const STATUSES = ["draft", "published"];
  const where: string[] = [trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  const args: unknown[] = [];
  if (TYPES.includes(type)) { where.push("type = ?"); args.push(type); }
  if (STATUSES.includes(status)) { where.push("status = ?"); args.push(status); }
  if (q) { where.push("(title LIKE ? OR slug LIKE ?)"); args.push("%" + q + "%", "%" + q + "%"); }
  const whereSql = "WHERE " + where.join(" AND ");

  const conn = db();
  const total = (conn.prepare("SELECT COUNT(*) c FROM posts " + whereSql).get(...args) as { c: number }).c;
  // 带上 revision 与 has_draft：列表页的删除/批量操作需要 revision 做并发校验，
  // has_draft 让批量发布能明确跳过"有未发布草稿"的条目（方案 §7.1）
  const rows = conn.prepare(
    "SELECT id, type, title, slug, status, categories, tags, published_at, updated_at, deleted_at, revision, " +
    "(SELECT COUNT(*) FROM post_drafts d WHERE d.post_id = posts.id) AS has_draft " +
    "FROM posts " + whereSql + " ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ? OFFSET ?"
  ).all(...args, lim, offset);

  return noStoreJson({ rows, total, limit: lim, offset });
});

/**
 * 新建。
 *
 * 阶段 03.1 起"新建"不再直接写一篇内容完整的 posts —— 那会让未发布内容
 * 与已发布内容共用同一份状态。现在统一走：
 *   1. 建壳（status=draft、revision=1、slug=draft-xxx）
 *   2. 若请求带了内容，立刻挂一条草稿
 *
 * 这样新建的文章天然处于"草稿—发布"两态，与自动保存协议同一条数据通路，
 * 不会出现"新建时一套语义、编辑时另一套语义"。
 */
export const POST = handleWrite(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStoreJson({ error: "参数错误", code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  const type = (body.type === "page" || body.type === "shuoshuo" ? body.type : "post") as "post" | "page" | "shuoshuo";
  const conn = db();
  const actor = actorOf(ctx);
  const wantPublished = body.status === "published";

  // 无 clientDraftId：只要壳，编辑器随后的首次保存会挂草稿
  const clientDraftId = typeof body.clientDraftId === "string" && body.clientDraftId
    ? body.clientDraftId
    : "cid-" + randomBytes(12).toString("hex");

  const parsed = parseSnapshot({
    type,
    title: typeof body.title === "string" ? body.title : "",
    slug: typeof body.slug === "string" ? body.slug : "",
    content: typeof body.content === "string" ? body.content : "",
    cover: typeof body.cover === "string" && body.cover ? body.cover : null,
    categories: Array.isArray(body.categories) ? (body.categories as string[]) : [],
    tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
    comments_enabled: typeof body.comments_enabled === "boolean" ? (body.comments_enabled ? 1 : 0) : 1,
  });
  if (!parsed.ok) return noStoreJson({ error: parsed.error, code: "SNAPSHOT_INVALID", status: 400 }, { status: 400 });

  /**
   * 新建 = 建壳 + 挂草稿（+ 需要时立刻发布）。
   *
   * 阶段 03.1 起"新建"不再直接写一篇内容完整的 posts —— 那会让未发布内容
   * 与已发布内容共用同一份状态。这里把 `status: "published"` 也解释成
   * **同一条数据通路**（建壳 -> 存草稿 -> 发布），而不是另写一条 INSERT，
   * 否则就等于存在"第二套语义"（方案 §6.1 明确禁止）。
   */
  const result = conn.transaction(() => {
    const { postId } = createDraftShell({ db: conn, actor, type });
    const saved = saveDraft({
      db: conn,
      postId,
      actor,
      clientDraftId,
      snapshot: parsed.snapshot,
      expectedPostRevision: 1,
      expectedDraftRevision: 0,
    });

    if (!wantPublished) return { postId, identity: saved.identity, published: null as any };

    // 发布路径与手工发布完全一致：正文取刚存下的服务端草稿。
    // 正式 slug 在发布时才认真校验唯一性（草稿阶段用 draft-<hex> 壳值占位）。
    const base = parsed.snapshot.slug
      ? (slugify(parsed.snapshot.slug) || parsed.snapshot.slug)
      : slugify(parsed.snapshot.title || "untitled");
    const finalSlug = uniqueSlug(base, (s) =>
      !!conn.prepare("SELECT 1 FROM posts WHERE type = ? AND slug = ?").get(type, s)
    );

    const published = publishDraft({
      db: conn,
      postId,
      actor,
      publishRequestId: "create-" + randomBytes(12).toString("hex"),
      expectedPostRevision: 1,
      expectedDraftRevision: saved.identity.draftRevision,
      finalSlug,
    });
    return { postId, identity: saved.identity, published };
  })();

  invalidate([TAGS.posts]);
  return noStoreJson({
    ok: true,
    id: result.postId,
    slug: result.published ? result.published.slug : undefined,
    created: true,
    hasDraft: !result.published,
    status: result.published ? "published" : "draft",
    identity: result.published ? undefined : result.identity,
  });
});
