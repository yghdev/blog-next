/**
 * 在线 posts 写入的**唯一**入口（方案 §5.1）。
 *
 * 路由层不得直接拼接 posts 的写 SQL —— 所有对"线上内容"的修改必须经过这里，
 * 因为只有这里同时保证三件事：
 *   1. 版本校验（WHERE id=? AND revision=? 原子更新，没有 skipRevisionCheck）
 *   2. 显式发布才碰 posts（草稿保存只写 post_drafts）
 *   3. 发布时 posts / post_revisions / post_drafts / 审计在**同一个事务**里
 *
 * 事务边界原则（方案 §5.3）：数据提交、发布历史和强制审计原子完成；
 * 缓存失效在事务外，可重试、不回滚已提交数据。
 */
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { snapshotIdentity, type Snapshot } from "./snapshot";
import { logAuditStrict, type AuditAction } from "./audit";
import { makeExcerpt } from "./posts";
import { nowIso } from "./time";

/* ------------------------------ 错误类型 ------------------------------ */

/**
 * 业务错误码。与 HttpError 分离：lib 层不依赖 next/server，
 * 这样才能被运维脚本（rebuild/prune）和 Node 测试直接调用。
 */
export type WriteErrorCode =
  | "POST_NOT_FOUND"
  | "ARTICLE_GONE"
  | "BASE_REVISION_CONFLICT"
  | "DRAFT_REVISION_CONFLICT"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_EXISTS"
  | "DRAFT_FORBIDDEN"
  | "IDEMPOTENCY_CONFLICT"
  | "SLUG_CONFLICT"
  | "SNAPSHOT_INVALID"
  | "PUBLISH_REQUIRES_DRAFT"
  | "INCONSISTENT_STATE"
  | "CLIENT_HASH_MISMATCH"
  | "REVISION_REQUIRED";

export class WriteError extends Error {
  code: WriteErrorCode;
  status: number;
  detail?: Record<string, unknown>;
  constructor(code: WriteErrorCode, message: string, status = 409, detail?: Record<string, unknown>) {
    super(message);
    this.name = "WriteError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** 各错误码对应的 HTTP 状态（集中一处，避免每个路由各判一遍） */
const STATUS_BY_CODE: Record<WriteErrorCode, number> = {
  POST_NOT_FOUND: 404,
  ARTICLE_GONE: 410,
  BASE_REVISION_CONFLICT: 409,
  DRAFT_REVISION_CONFLICT: 409,
  DRAFT_NOT_FOUND: 409,
  DRAFT_EXISTS: 409,
  DRAFT_FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409,
  SLUG_CONFLICT: 409,
  SNAPSHOT_INVALID: 400,
  PUBLISH_REQUIRES_DRAFT: 409,
  INCONSISTENT_STATE: 409,
  CLIENT_HASH_MISMATCH: 400,
  REVISION_REQUIRED: 400,
};

function fail(code: WriteErrorCode, message: string, detail?: Record<string, unknown>): never {
  throw new WriteError(code, message, STATUS_BY_CODE[code], detail);
}

/* ------------------------------- 类型 ------------------------------- */

export type Actor = {
  userId: number;
  userName: string;
  ip?: string;
  userAgent?: string;
};

export type PostRowLite = {
  id: number;
  type: "post" | "page" | "shuoshuo";
  title: string;
  slug: string;
  content: string;
  /** posts.excerpt：发布时由正文自动截取，或由编辑器写入的自定义摘要 */
  excerpt: string;
  status: "draft" | "published";
  categories: string;
  tags: string;
  cover: string | null;
  published_at: string | null;
  revision: number;
  deleted_at: string | null;
  comments_enabled: number;
};

export type DraftRow = {
  post_id: number;
  client_draft_id: string;
  owner_user_id: number | null;
  base_revision: number;
  draft_revision: number;
  snapshot_json: string;
  snapshot_hash: string;
  created_at: string;
  updated_at: string;
  updated_by: number | null;
};

export type DraftIdentity = {
  postId: number;
  clientDraftId: string;
  baseRevision: number;
  draftRevision: number;
  snapshotHash: string;
};

/* ----------------------------- 读取辅助 ----------------------------- */

export function readPost(db: Database.Database, postId: number): PostRowLite | undefined {
  return db.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as PostRowLite | undefined;
}

/** 读一篇"可用"的文章：不存在 -> 404，软删除 -> 410（方案 §5.3 第 2 步） */
export function requireLivePost(db: Database.Database, postId: number): PostRowLite {
  const post = readPost(db, postId);
  if (!post) fail("POST_NOT_FOUND", "文章不存在");
  if (post.deleted_at) fail("ARTICLE_GONE", "文章已在回收站，无法继续编辑");
  return post;
}

export function readDraft(db: Database.Database, postId: number): DraftRow | undefined {
  return db.prepare("SELECT * FROM post_drafts WHERE post_id = ?").get(postId) as DraftRow | undefined;
}

export function draftIdentityOf(draft: DraftRow): DraftIdentity {
  return {
    postId: draft.post_id,
    clientDraftId: draft.client_draft_id,
    baseRevision: draft.base_revision,
    draftRevision: draft.draft_revision,
    snapshotHash: draft.snapshot_hash,
  };
}

/** 由 posts 行构造当前快照（无草稿时编辑器加载用） */
export function snapshotFromPost(post: PostRowLite): Snapshot {
  const parse = (s: string): string[] => {
    try {
      const v = JSON.parse(s || "[]");
      return Array.isArray(v) ? v.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  };
  return {
    type: post.type,
    title: post.title,
    slug: post.slug,
    content: post.content,
    // 只有"和自动截取结果不同"的 excerpt 才算自定义摘要。
    // 不这么区分，已发布文章重新打开时会把自己那段自动摘要当成用户填的，
    // 发布幂等比较也会因此永远判定"内容有变化"。
    excerpt: customExcerptOf(post),
    cover: post.cover,
    categories: parse(post.categories),
    tags: parse(post.tags),
    comments_enabled: (post.comments_enabled ? 1 : 0) as 0 | 1,
  };
}

/**
 * 取自定义摘要：posts.excerpt 与正文自动截取一致时视为"未自定义"，返回 undefined。
 * 编辑器据此决定摘要框是空的（显示自动提取提示）还是带着用户写过的内容。
 */
export function customExcerptOf(post: Pick<PostRowLite, "content" | "excerpt">): string | undefined {
  const saved = (post.excerpt ?? "").trim();
  if (!saved) return undefined;
  return saved === makeExcerpt(post.content, 160) ? undefined : saved;
}

/* --------------------------- 草稿：保存 --------------------------- */

export type SaveDraftInput = {
  db: Database.Database;
  postId: number;
  actor: Actor;
  clientDraftId: string;
  snapshot: Snapshot;
  /** 客户端核对用的 hash；服务端会重新计算，不一致返回 400（不信任客户端） */
  clientSnapshotHash?: string;
  expectedPostRevision: number;
  /**
   * 无草稿时必须为 0；有草稿时必须 >=1（方案 §6.2）。
   * 首次创建也必须传 expectedPostRevision —— 不得把当前 posts.revision 直接当新基线。
   */
  expectedDraftRevision: number;
};

export type SaveDraftResult = {
  identity: DraftIdentity;
  /** 草稿没变化时不递增版本（幂等） */
  unchanged: boolean;
};

/**
 * 保存完整快照到 post_drafts（方案 §6.2 / §6.3）。
 *
 * 核心不变量：**已存在文章的草稿保存只写 post_drafts，不改 posts 任何字段**。
 * 这就是"自动保存不会把未发布修改暴露到前台"的物理保证。
 */
export function saveDraft(input: SaveDraftInput): SaveDraftResult {
  const { db, postId, actor, clientDraftId, snapshot } = input;

  return db.transaction((): SaveDraftResult => {
    const post = requireLivePost(db, postId);

    // 服务端永远重新计算 hash，客户端 hash 只做核对
    const { snapshotJson, snapshotHash } = snapshotIdentity(snapshot);
    if (input.clientSnapshotHash && input.clientSnapshotHash !== snapshotHash) {
      fail("CLIENT_HASH_MISMATCH", "客户端快照校验值与服务端不一致，请刷新后重试", {
        serverSnapshotHash: snapshotHash,
        clientSnapshotHash: input.clientSnapshotHash,
      });
    }

    const draft = readDraft(db, postId);
    const now = nowIso();

    if (!draft) {
      // 无草稿：必须用 expectedDraftRevision=0 显式声明"我知道现在没有草稿"
      if (input.expectedDraftRevision !== 0) {
        fail("DRAFT_NOT_FOUND", "当前没有服务端草稿，expectedDraftRevision 应为 0", {
          expectedDraftRevision: input.expectedDraftRevision,
        });
      }
      // 首次创建草稿也要校验基线，避免"基于旧版本新建草稿"
      if (input.expectedPostRevision !== post.revision) {
        fail("BASE_REVISION_CONFLICT", "文章已被修改，请重新加载后再保存", {
          expectedPostRevision: input.expectedPostRevision,
          currentPostRevision: post.revision,
        });
      }

      // 同一 clientDraftId 不能绑到别的文章（UUID 不可猜测 ≠ 鉴权，但绑定要一致）
      const bound = db.prepare("SELECT post_id FROM post_drafts WHERE client_draft_id = ?").get(clientDraftId) as
        | { post_id: number }
        | undefined;
      if (bound && bound.post_id !== postId) {
        fail("IDEMPOTENCY_CONFLICT", "该 clientDraftId 已绑定到其他文章");
      }

      db.prepare(
        "INSERT INTO post_drafts " +
        "(post_id, client_draft_id, owner_user_id, base_revision, draft_revision, snapshot_json, snapshot_hash, created_at, updated_at, updated_by) " +
        "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)"
      ).run(postId, clientDraftId, actor.userId, post.revision, snapshotJson, snapshotHash, now, now, actor.userId);

      logAuditStrict(db, {
        action: "post.draft.save",
        userId: actor.userId, userName: actor.userName,
        targetType: "post", targetId: postId,
        meta: { clientDraftId, draftRevision: 1, baseRevision: post.revision, created: true },
        ip: actor.ip, userAgent: actor.userAgent,
      });

      return {
        identity: {
          postId, clientDraftId,
          baseRevision: post.revision,
          draftRevision: 1,
          snapshotHash,
        },
        unchanged: false,
      };
    }

    // 有草稿：clientDraftId、归属、两个版本都必须一致
    if (draft.client_draft_id !== clientDraftId) {
      fail("DRAFT_FORBIDDEN", "该草稿属于另一个编辑会话", {
        expectedClientDraftId: draft.client_draft_id,
      });
    }
    if (draft.owner_user_id !== null && draft.owner_user_id !== actor.userId) {
      fail("DRAFT_FORBIDDEN", "该草稿属于其他用户");
    }
    if (input.expectedDraftRevision !== draft.draft_revision) {
      fail("DRAFT_REVISION_CONFLICT", "草稿已被其他会话修改", {
        expectedDraftRevision: input.expectedDraftRevision,
        currentDraftRevision: draft.draft_revision,
        serverSnapshotHash: draft.snapshot_hash,
        serverSnapshot: draft.snapshot_json,
        currentPostRevision: post.revision,
      });
    }
    // 草稿基线必须仍等于 posts.revision；否则说明线上内容在我们编辑期间变过，
    // 继续保存会把"基于旧基线的草稿"叠到新内容上 —— 必须显式 rebase
    if (draft.base_revision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "文章已在别处发布或修改，需要先确认如何合并", {
        draftBaseRevision: draft.base_revision,
        currentPostRevision: post.revision,
        serverSnapshotHash: draft.snapshot_hash,
        serverSnapshot: draft.snapshot_json,
      });
    }

    // 快照完全相同 -> 幂等返回，不递增版本（重试同一请求不该制造新版本）
    if (draft.snapshot_hash === snapshotHash) {
      return { identity: draftIdentityOf(draft), unchanged: true };
    }

    const nextRev = draft.draft_revision + 1;
    db.prepare(
      "UPDATE post_drafts SET snapshot_json = ?, snapshot_hash = ?, draft_revision = ?, updated_at = ?, updated_by = ? " +
      "WHERE post_id = ? AND draft_revision = ?"
    ).run(snapshotJson, snapshotHash, nextRev, now, actor.userId, postId, draft.draft_revision);

    logAuditStrict(db, {
      action: "post.draft.save",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: { clientDraftId, draftRevision: nextRev, baseRevision: draft.base_revision },
      ip: actor.ip, userAgent: actor.userAgent,
    });

    return {
      identity: {
        postId,
        clientDraftId,
        baseRevision: draft.base_revision,
        draftRevision: nextRev,
        snapshotHash,
      },
      unchanged: false,
    };
  })();
}

/* ------------------------- 草稿：放弃 ------------------------- */

export function discardDraft(input: {
  db: Database.Database;
  postId: number;
  actor: Actor;
  expectedDraftRevision: number;
  expectedPostRevision: number;
}): { ok: true } {
  const { db, postId, actor } = input;
  return db.transaction((): { ok: true } => {
    const post = requireLivePost(db, postId);
    const draft = readDraft(db, postId);
    if (!draft) fail("DRAFT_NOT_FOUND", "当前没有服务端草稿");
    if (input.expectedPostRevision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "文章已被修改，请重新加载", {
        expectedPostRevision: input.expectedPostRevision,
        currentPostRevision: post.revision,
      });
    }
    if (input.expectedDraftRevision !== draft.draft_revision) {
      fail("DRAFT_REVISION_CONFLICT", "草稿已被其他会话修改", {
        expectedDraftRevision: input.expectedDraftRevision,
        currentDraftRevision: draft.draft_revision,
      });
    }
    db.prepare("DELETE FROM post_drafts WHERE post_id = ? AND draft_revision = ?")
      .run(postId, draft.draft_revision);

    logAuditStrict(db, {
      action: "post.draft.discard",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: { clientDraftId: draft.client_draft_id, draftRevision: draft.draft_revision },
      ip: actor.ip, userAgent: actor.userAgent,
    });
    return { ok: true };
  })();
}

/* ------------------------- 草稿：rebase ------------------------- */

/**
 * 用户确认后把草稿基线推到最新 posts.revision（方案 §6.5）。
 * 只更新 base_revision / draft_revision / 快照 / hash，**不做字段级自动合并**。
 */
export function rebaseDraft(input: {
  db: Database.Database;
  postId: number;
  actor: Actor;
  clientDraftId: string;
  snapshot: Snapshot;
  clientSnapshotHash?: string;
  expectedDraftRevision: number;
  expectedPostRevision: number;
}): { identity: DraftIdentity } {
  const { db, postId, actor, snapshot } = input;
  return db.transaction((): { identity: DraftIdentity } => {
    const post = requireLivePost(db, postId);
    if (input.expectedPostRevision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "文章在确认前后又被修改，请重新加载", {
        expectedPostRevision: input.expectedPostRevision,
        currentPostRevision: post.revision,
      });
    }
    const { snapshotJson, snapshotHash } = snapshotIdentity(snapshot);
    if (input.clientSnapshotHash && input.clientSnapshotHash !== snapshotHash) {
      fail("CLIENT_HASH_MISMATCH", "客户端快照校验值与服务端不一致", {
        serverSnapshotHash: snapshotHash,
      });
    }

    const draft = readDraft(db, postId);
    const now = nowIso();

    if (!draft) {
      // 没有草稿时 rebase 等价于"以当前 posts 版本为基线建一个新草稿"
      if (input.expectedDraftRevision !== 0) {
        fail("DRAFT_NOT_FOUND", "当前没有服务端草稿，expectedDraftRevision 应为 0");
      }
      db.prepare(
        "INSERT INTO post_drafts " +
        "(post_id, client_draft_id, owner_user_id, base_revision, draft_revision, snapshot_json, snapshot_hash, created_at, updated_at, updated_by) " +
        "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)"
      ).run(postId, input.clientDraftId, actor.userId, post.revision, snapshotJson, snapshotHash, now, now, actor.userId);
      logAuditStrict(db, {
        action: "post.draft.rebase",
        userId: actor.userId, userName: actor.userName,
        targetType: "post", targetId: postId,
        meta: { clientDraftId: input.clientDraftId, draftRevision: 1, baseRevision: post.revision, created: true },
        ip: actor.ip, userAgent: actor.userAgent,
      });
      return { identity: { postId, clientDraftId: input.clientDraftId, baseRevision: post.revision, draftRevision: 1, snapshotHash } };
    }

    if (draft.client_draft_id !== input.clientDraftId) {
      fail("DRAFT_FORBIDDEN", "该草稿属于另一个编辑会话");
    }
    if (input.expectedDraftRevision !== draft.draft_revision) {
      fail("DRAFT_REVISION_CONFLICT", "草稿已被其他会话修改", {
        expectedDraftRevision: input.expectedDraftRevision,
        currentDraftRevision: draft.draft_revision,
      });
    }

    // 关键：base_revision 设为**当前 posts.revision**，而不是保留旧值
    const nextRev = draft.draft_revision + 1;
    db.prepare(
      "UPDATE post_drafts SET base_revision = ?, snapshot_json = ?, snapshot_hash = ?, draft_revision = ?, updated_at = ?, updated_by = ? " +
      "WHERE post_id = ? AND draft_revision = ?"
    ).run(post.revision, snapshotJson, snapshotHash, nextRev, now, actor.userId, postId, draft.draft_revision);

    logAuditStrict(db, {
      action: "post.draft.rebase",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: { clientDraftId: input.clientDraftId, draftRevision: nextRev, baseRevision: post.revision },
      ip: actor.ip, userAgent: actor.userAgent,
    });

    return { identity: { postId, clientDraftId: input.clientDraftId, baseRevision: post.revision, draftRevision: nextRev, snapshotHash } };
  })();
}

/* ------------------------------ 发布 ------------------------------ */

export type PublishInput = {
  db: Database.Database;
  postId: number;
  actor: Actor;
  publishRequestId: string;
  expectedPostRevision: number;
  expectedDraftRevision: number;
  /** 发布后要用的正式 slug（由调用方校验过合法性/唯一性），缺省用快照里的 slug */
  finalSlug: string;
};

export type PublishResult = {
  ok: true;
  postId: number;
  revision: number;
  slug: string;
  snapshotHash: string;
  /** 幂等重试时为 true：没有重复写 posts / 历史 / 审计 */
  replayed: boolean;
};

/** 查已有发布结果（幂等核对用，方案 §5.4） */
export function findPublishResult(
  db: Database.Database,
  postId: number,
  publishRequestId: string
): { revision: number; snapshotHash: string } | undefined {
  const row = db.prepare(
    "SELECT revision, snapshot_hash FROM post_revisions WHERE post_id = ? AND publish_request_id = ?"
  ).get(postId, publishRequestId) as { revision: number; snapshot_hash: string } | undefined;
  return row ? { revision: row.revision, snapshotHash: row.snapshot_hash } : undefined;
}

/**
 * 发布当前服务端草稿（方案 §5.3）。
 *
 * 严格按方案 12 步执行，全部在一个 BEGIN IMMEDIATE 事务内。
 * 内容来源是**服务端当前草稿**，不接受客户端另传一套正文 ——
 * 否则"预览看到的"和"发布出去的"可能不是同一份。
 */
export function publishDraft(input: PublishInput): PublishResult {
  const { db, postId, actor, publishRequestId, finalSlug } = input;

  // BEGIN IMMEDIATE：尽早拿写锁，避免两个发布并发时都读到旧 revision
  const run = db.transaction((): PublishResult => {
    // 1. 幂等：先查这个请求是否已经成功过
    const existing = db.prepare(
      "SELECT post_id, revision, snapshot_hash FROM post_revisions WHERE publish_request_id = ?"
    ).get(publishRequestId) as { post_id: number; revision: number; snapshot_hash: string } | undefined;
    if (existing) {
      if (existing.post_id !== postId) {
        fail("IDEMPOTENCY_CONFLICT", "该发布请求标识已被用于其他文章");
      }
      // 同一请求重试：返回原结果，不重复写 posts / 历史 / 审计
      return {
        ok: true, postId, revision: existing.revision,
        slug: (readPost(db, postId)?.slug ?? finalSlug),
        snapshotHash: existing.snapshot_hash,
        replayed: true,
      };
    }

    // 2. 读 posts：不存在 404，软删除 410
    const post = requireLivePost(db, postId);

    // 3. 发布必须有草稿
    const draft = readDraft(db, postId);
    if (!draft) fail("PUBLISH_REQUIRES_DRAFT", "当前没有可发布的草稿");

    // 4. 校验调用方期望的 posts 版本
    if (input.expectedPostRevision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "文章已被修改，请重新加载后再发布", {
        expectedPostRevision: input.expectedPostRevision,
        currentPostRevision: post.revision,
      });
    }
    // 5. 校验草稿基线仍等于 posts.revision
    if (draft.base_revision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "草稿基于旧版本，需要先确认再发布", {
        draftBaseRevision: draft.base_revision,
        currentPostRevision: post.revision,
      });
    }
    // 6. 校验草稿版本
    if (input.expectedDraftRevision !== draft.draft_revision) {
      fail("DRAFT_REVISION_CONFLICT", "草稿已被其他会话修改", {
        expectedDraftRevision: input.expectedDraftRevision,
        currentDraftRevision: draft.draft_revision,
      });
    }

    // 7. 草稿快照必须可发布：正式 slug 已由调用方校验；这里复核冲突
    const snapshot = JSON.parse(draft.snapshot_json) as Snapshot;

    /**
     * 内容与线上完全一致 -> 幂等返回，不新增版本。
     *
     * 场景：用户点了一次「更新」没反应（网络慢），又点一次；或者发布成功后
     * 没刷新页面又点了一次。没有这一条，每点一次 revision 就 +1，
     * 版本历史里会出现一串"内容完全相同"的记录，用户没法用它找回任何东西。
     * 这里**不做任何写入**，只把当前状态如实返回（revision 用现值）。
     *
     * ⚠ 必须限定 status = 'published'：草稿或已下线的文章即使内容与 posts 相同，
     * 「发布」也必须真的把状态改成 published。漏了这条判断，
     * 「转草稿后再点发布」会静默什么都不做，用户看到"已发布"但前台仍是 404。
     */
    const live = snapshotFromPost(post);
    if (
      post.status === "published" &&
      live.type === snapshot.type &&
      live.title === snapshot.title &&
      live.slug === finalSlug &&
      live.content === snapshot.content &&
      (live.excerpt ?? "") === (snapshot.excerpt ?? "") &&
      (live.cover ?? null) === (snapshot.cover ?? null) &&
      live.comments_enabled === snapshot.comments_enabled &&
      JSON.stringify(live.categories) === JSON.stringify(snapshot.categories) &&
      JSON.stringify(live.tags) === JSON.stringify(snapshot.tags)
    ) {
      // 草稿已经没有存在意义（内容和线上一致），顺手清掉，避免它继续挡住批量发布
      db.prepare("DELETE FROM post_drafts WHERE post_id = ?").run(postId);
      return {
        ok: true, postId, revision: post.revision,
        slug: post.slug,
        snapshotHash: draft.snapshot_hash,
        replayed: true,
      };
    }
    const clash = db.prepare("SELECT id FROM posts WHERE type = ? AND slug = ? AND id != ?")
      .get(post.type, finalSlug, postId) as { id: number } | undefined;
    if (clash) fail("SLUG_CONFLICT", "该 URL 路径已被其他文章占用", { slug: finalSlug });
    const aliasClash = db.prepare("SELECT post_id FROM post_aliases WHERE slug = ?").get(finalSlug) as
      | { post_id: number }
      | undefined;
    if (aliasClash && aliasClash.post_id !== postId) {
      fail("SLUG_CONFLICT", "该 URL 路径已被历史别名占用", { slug: finalSlug });
    }

    // 8. slug 变化时把旧 slug 写进别名表（与 posts 更新同一事务）
    if (finalSlug !== post.slug) {
      db.prepare(
        "INSERT INTO post_aliases (slug, post_id) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET post_id = excluded.post_id"
      ).run(post.slug, postId);
    }

    // 9. 更新 posts：revision 恰好 +1，状态转为 published
    const now = nowIso();
    const nextRevision = post.revision + 1;
    const publishedAt = post.published_at ?? now;
    const info = db.prepare(
      "UPDATE posts SET type = ?, title = ?, slug = ?, content = ?, excerpt = ?, status = 'published', " +
      "categories = ?, tags = ?, cover = ?, published_at = ?, updated_at = ?, revision = ?, comments_enabled = ? " +
      "WHERE id = ? AND revision = ?"
    ).run(
      // 摘要：编辑器填了就用它（卡片与 og:description 的来源），留空才自动截取。
      snapshot.type, snapshot.title, finalSlug, snapshot.content,
      (snapshot.excerpt ?? "").trim() || makeExcerpt(snapshot.content, 160),
      JSON.stringify(snapshot.categories), JSON.stringify(snapshot.tags), snapshot.cover,
      publishedAt, now, nextRevision, snapshot.comments_enabled,
      postId, post.revision
    );
    if (info.changes !== 1) {
      // 理论上不可达（事务内已持锁），但保留断言：宁可报错也不要静默漏更新
      fail("BASE_REVISION_CONFLICT", "发布时文章版本已变化，请重试");
    }

    // 10. 写不可变历史，记录 publishRequestId 以便幂等核对
    db.prepare(
      "INSERT INTO post_revisions (post_id, revision, snapshot_json, snapshot_hash, reason, publish_request_id, created_by, created_at) " +
      "VALUES (?, ?, ?, ?, 'publish', ?, ?, ?)"
    ).run(postId, nextRevision, draft.snapshot_json, draft.snapshot_hash, publishRequestId, actor.userId, now);

    // 11. 发布成功后清理当前草稿（草稿的使命已结束，内容已进 posts + 历史）
    db.prepare("DELETE FROM post_drafts WHERE post_id = ?").run(postId);

    // 12. 强制审计：与业务同事务，失败则整体回滚
    logAuditStrict(db, {
      action: "post.publish",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: {
        revision: nextRevision, slug: finalSlug,
        snapshotHash: draft.snapshot_hash,
        publishRequestId,
        slugChanged: finalSlug !== post.slug,
      },
      ip: actor.ip, userAgent: actor.userAgent,
    });

    return { ok: true, postId, revision: nextRevision, slug: finalSlug, snapshotHash: draft.snapshot_hash, replayed: false };
  });

  // immediate: 事务内第一条语句就是读，用 immediate 提前拿写锁更符合意图
  return run.immediate();
}

/* -------------------------- 恢复历史到草稿 -------------------------- */

/**
 * 用历史快照替换当前草稿（方案 §6.4）。
 *
 * 三条不能违反的规则：
 *   - 不改 posts、不新增 post_revisions —— 恢复只影响草稿，
 *     用户还得显式发布才会改变线上内容
 *   - base_revision 设为**当前 posts.revision**，不是历史 revision
 *   - 强制审计与草稿更新同事务
 */
export function restoreVersionToDraft(input: {
  db: Database.Database;
  postId: number;
  actor: Actor;
  revision: number;
  expectedDraftRevision: number;
  expectedPostRevision: number;
  clientDraftId: string;
}): { identity: DraftIdentity } {
  const { db, postId, actor } = input;
  return db.transaction((): { identity: DraftIdentity } => {
    const post = requireLivePost(db, postId);
    if (input.expectedPostRevision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "文章已被修改，请重新加载", {
        expectedPostRevision: input.expectedPostRevision,
        currentPostRevision: post.revision,
      });
    }

    const hist = db.prepare(
      "SELECT snapshot_json, snapshot_hash FROM post_revisions WHERE post_id = ? AND revision = ?"
    ).get(postId, input.revision) as { snapshot_json: string; snapshot_hash: string } | undefined;
    if (!hist) fail("POST_NOT_FOUND", "该历史版本不存在", { revision: input.revision });

    const draft = readDraft(db, postId);
    const now = nowIso();

    if (!draft) {
      if (input.expectedDraftRevision !== 0) {
        fail("DRAFT_NOT_FOUND", "当前没有服务端草稿，expectedDraftRevision 应为 0");
      }
      db.prepare(
        "INSERT INTO post_drafts " +
        "(post_id, client_draft_id, owner_user_id, base_revision, draft_revision, snapshot_json, snapshot_hash, created_at, updated_at, updated_by) " +
        "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)"
      ).run(postId, input.clientDraftId, actor.userId, post.revision, hist.snapshot_json, hist.snapshot_hash, now, now, actor.userId);

      logAuditStrict(db, {
        action: "post.restore_version",
        userId: actor.userId, userName: actor.userName,
        targetType: "post", targetId: postId,
        meta: { fromRevision: input.revision, draftRevision: 1, created: true },
        ip: actor.ip, userAgent: actor.userAgent,
      });

      return {
        identity: {
          postId, clientDraftId: input.clientDraftId,
          baseRevision: post.revision, draftRevision: 1,
          snapshotHash: hist.snapshot_hash,
        },
      };
    }

    if (input.expectedDraftRevision !== draft.draft_revision) {
      fail("DRAFT_REVISION_CONFLICT", "草稿已被其他会话修改", {
        expectedDraftRevision: input.expectedDraftRevision,
        currentDraftRevision: draft.draft_revision,
      });
    }

    const nextRev = draft.draft_revision + 1;
    db.prepare(
      "UPDATE post_drafts SET base_revision = ?, snapshot_json = ?, snapshot_hash = ?, draft_revision = ?, updated_at = ?, updated_by = ? " +
      "WHERE post_id = ? AND draft_revision = ?"
    ).run(post.revision, hist.snapshot_json, hist.snapshot_hash, nextRev, now, actor.userId, postId, draft.draft_revision);

    logAuditStrict(db, {
      action: "post.restore_version",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: { fromRevision: input.revision, draftRevision: nextRev },
      ip: actor.ip, userAgent: actor.userAgent,
    });

    return {
      identity: {
        postId, clientDraftId: draft.client_draft_id,
        baseRevision: post.revision, draftRevision: nextRev,
        snapshotHash: hist.snapshot_hash,
      },
    };
  })();
}

/* ------------------------ 元数据 PATCH（三态） ------------------------ */

export type MetadataPatch = {
  title?: string;
  slug?: string;
  categories?: string[];
  tags?: string[];
  /** 三态：字段缺省不改；cover:null 清除；cover:string 设置 */
  cover?: string | null;
  comments_enabled?: 0 | 1;
};

/**
 * 元数据补丁（方案 §4.1 / §5.1）。
 *
 * 与旧 PATCH 的区别：
 *   - 只改**传入的**字段，未传的保持原值（旧实现是全字段覆盖，
 *     改个标题会把 categories/tags 静默清空）
 *   - cover 支持显式 null 清除（旧实现用 COALESCE，永远清不掉）
 *   - 必须带 expectedRevision，用 WHERE id=? AND revision=? 原子更新
 *   - 整个更新在一个事务里，slug 别名与 posts 同进同退
 */
export function patchPostMetadata(input: {
  db: Database.Database;
  postId: number;
  actor: Actor;
  patch: MetadataPatch;
  expectedRevision: number;
}): { ok: true; revision: number; slug: string; status: "draft" | "published" } {
  const { db, postId, actor, patch } = input;

  return db.transaction((): { ok: true; revision: number; slug: string; status: "draft" | "published" } => {
    const post = requireLivePost(db, postId);
    if (input.expectedRevision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "文章已被修改，请重新加载", {
        expectedRevision: input.expectedRevision,
        currentRevision: post.revision,
      });
    }

    const sets: string[] = [];
    const args: unknown[] = [];

    if (patch.title !== undefined) { sets.push("title = ?"); args.push(patch.title); }
    if (patch.categories !== undefined) { sets.push("categories = ?"); args.push(JSON.stringify(patch.categories)); }
    if (patch.tags !== undefined) { sets.push("tags = ?"); args.push(JSON.stringify(patch.tags)); }
    if (patch.comments_enabled !== undefined) { sets.push("comments_enabled = ?"); args.push(patch.comments_enabled); }

    // cover 的三态：只有 key 存在时才动；值为 null 表示清除
    if ("cover" in patch) { sets.push("cover = ?"); args.push(patch.cover ?? null); }

    let finalSlug = post.slug;
    if (patch.slug !== undefined && patch.slug !== post.slug) {
      const clash = db.prepare("SELECT id FROM posts WHERE type = ? AND slug = ? AND id != ?")
        .get(post.type, patch.slug, postId) as { id: number } | undefined;
      if (clash) fail("SLUG_CONFLICT", "该 URL 路径已被其他文章占用", { slug: patch.slug });
      const aliasClash = db.prepare("SELECT post_id FROM post_aliases WHERE slug = ?").get(patch.slug) as
        | { post_id: number }
        | undefined;
      if (aliasClash && aliasClash.post_id !== postId) {
        fail("SLUG_CONFLICT", "该 URL 路径已被历史别名占用", { slug: patch.slug });
      }
      // 别名写入与 posts 更新在同事务内 —— 修掉阶段 00 pin 的"别名单写残留"
      db.prepare(
        "INSERT INTO post_aliases (slug, post_id) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET post_id = excluded.post_id"
      ).run(post.slug, postId);
      sets.push("slug = ?");
      args.push(patch.slug);
      finalSlug = patch.slug;
    }

    if (!sets.length) {
      // 没有任何字段要改：不递增版本（避免"空补丁"制造无意义版本）
      return { ok: true, revision: post.revision, slug: post.slug, status: post.status };
    }

    const nextRevision = post.revision + 1;
    sets.push("updated_at = ?", "revision = ?");
    args.push(nowIso(), nextRevision);
    args.push(postId, post.revision);

    const info = db.prepare(
      "UPDATE posts SET " + sets.join(", ") + " WHERE id = ? AND revision = ?"
    ).run(...args);
    if (info.changes !== 1) {
      fail("BASE_REVISION_CONFLICT", "更新时版本已变化，请重试");
    }

    logAuditStrict(db, {
      action: "post.update",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: { revision: nextRevision, fields: Object.keys(patch), slugChanged: finalSlug !== post.slug },
      ip: actor.ip, userAgent: actor.userAgent,
    });

    return { ok: true, revision: nextRevision, slug: finalSlug, status: post.status };
  })();
}

/* --------------------- 状态类写操作（删除/恢复） --------------------- */

export function softDeletePost(input: {
  db: Database.Database;
  postId: number;
  actor: Actor;
  expectedRevision: number;
}): { ok: true; revision: number } {
  const { db, postId, actor } = input;
  return db.transaction((): { ok: true; revision: number } => {
    const post = readPost(db, postId);
    if (!post) fail("POST_NOT_FOUND", "文章不存在");
    if (post.deleted_at) fail("POST_NOT_FOUND", "文章已在回收站");
    if (input.expectedRevision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "文章已被修改，请重新加载", {
        expectedRevision: input.expectedRevision,
        currentRevision: post.revision,
      });
    }
    const now = nowIso();
    const nextRevision = post.revision + 1;
    // 软删除保留草稿（方案 §7.1）：用户恢复后还能继续编辑未发布内容
    db.prepare("UPDATE posts SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ?")
      .run(now, now, nextRevision, postId, post.revision);

    logAuditStrict(db, {
      action: "post.delete",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: { revision: nextRevision },
      ip: actor.ip, userAgent: actor.userAgent,
    });
    return { ok: true, revision: nextRevision };
  })();
}

export function restoreDeletedPost(input: {
  db: Database.Database;
  postId: number;
  actor: Actor;
  expectedRevision: number;
}): { ok: true; revision: number } {
  const { db, postId, actor } = input;
  return db.transaction((): { ok: true; revision: number } => {
    const post = readPost(db, postId);
    if (!post) fail("POST_NOT_FOUND", "文章不存在");
    if (!post.deleted_at) fail("POST_NOT_FOUND", "文章不在回收站");
    if (input.expectedRevision !== post.revision) {
      fail("BASE_REVISION_CONFLICT", "文章已被修改，请重新加载", {
        expectedRevision: input.expectedRevision,
        currentRevision: post.revision,
      });
    }
    const now = nowIso();
    const nextRevision = post.revision + 1;
    db.prepare("UPDATE posts SET deleted_at = NULL, updated_at = ?, revision = ? WHERE id = ? AND revision = ?")
      .run(now, nextRevision, postId, post.revision);

    logAuditStrict(db, {
      action: "post.restore",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: { revision: nextRevision },
      ip: actor.ip, userAgent: actor.userAgent,
    });
    return { ok: true, revision: nextRevision };
  })();
}

/* -------------------------- 新文章壳创建 -------------------------- */

/**
 * 新文章首次服务端保存时创建壳记录（方案 §4.2）。
 *
 * 壳的特征：status=draft、published_at=NULL、revision=1、content/excerpt 为空。
 * 壳 slug 用 `draft-<去连字符 UUID>` 这种服务端生成的保留值，
 * **不占用用户的正式 slug** —— 因为首次保存时用户可能还没想好 slug，
 * 而正式 slug 的唯一性应该等到发布时才认真校验。
 */
export function createDraftShell(input: {
  db: Database.Database;
  actor: Actor;
  type: "post" | "page" | "shuoshuo";
}): { postId: number } {
  const { db, actor } = input;
  return db.transaction((): { postId: number } => {
    const now = nowIso();
    // 生成一个绝对不会与用户 slug 冲突的保留值
    const shellSlug = "draft-" + cryptoRandomId();
    const takeover = db.prepare("SELECT 1 FROM posts WHERE type = ? AND slug = ?").get(input.type, shellSlug);
    if (takeover) fail("SLUG_CONFLICT", "生成壳 slug 失败，请重试");

    const info = db.prepare(
      "INSERT INTO posts (type, title, slug, content, excerpt, status, categories, tags, cover, published_at, created_at, updated_at, comments_enabled, revision) " +
      "VALUES (?, '', ?, '', '', 'draft', '[]', '[]', NULL, NULL, ?, ?, 1, 1)"
    ).run(input.type, shellSlug, now, now);

    const postId = Number(info.lastInsertRowid);

    logAuditStrict(db, {
      action: "post.create",
      userId: actor.userId, userName: actor.userName,
      targetType: "post", targetId: postId,
      meta: { type: input.type, shell: true, slug: shellSlug },
      ip: actor.ip, userAgent: actor.userAgent,
    });

    return { postId };
  })();
}

/** 无连字符的随机 id，用于壳 slug（16 字节加密随机数，不可猜测且比 UUID 字符串短） */
function cryptoRandomId(): string {
  // 必须用加密随机源而不是 Math.random：壳 slug 虽不承载鉴权，
  // 但可预测的 slug 会让"遍历草稿壳"变成可行的探测手段。
  return randomBytes(16).toString("hex");
}
