/**
 * 编辑器 ↔ 草稿协议 的薄适配层（方案 §10 阶段 03.1）。
 *
 * 为什么需要这一层：阶段 03.1 引入草稿/发布两套语义后，编辑器不该自己
 * 拼 URL、自己判断 409 是哪一种冲突、自己决定重试策略 —— 那些规则一旦
 * 在 UI 里复制，就会出现"编辑器认为能存、接口认为冲突"的分歧。
 *
 * 这里**只做协议适配，不碰 UI**：状态机与自动保存（03.2）以后再叠加，
 * 这一层已经把它需要的东西准备好了（identity 演进、错误分类、幂等 id）。
 *
 * 注意：本文件必须保持**客户端可用**（不 import next/server、不 import lib/db）。
 * 类型与纯函数只能来自 lib/snapshot 这类零依赖模块。
 */
import type { Snapshot } from "@/lib/snapshot";

export type DraftIdentity = {
  postId: number;
  clientDraftId: string;
  baseRevision: number;
  draftRevision: number;
  snapshotHash: string;
};

/** 协议错误的分类结果：调用方据此决定"重读 / 让用户确认 / 直接报错" */
export type DraftErrorKind =
  | "conflict"        // 版本冲突：需要重新读取或显式 rebase
  | "forbidden"       // 身份/归属不符
  | "gone"            // 文章已删除
  | "notFound"
  | "invalid"         // 请求本身不合法（缺字段、hash 不符）
  | "server";         // 5xx

export type DraftError = {
  kind: DraftErrorKind;
  code: string;
  message: string;
  status: number;
  /** 冲突时服务端回传的当前版本，前端可直接用来渲染差异，不必再发一次 GET */
  server?: {
    currentPostRevision?: number;
    currentDraftRevision?: number;
    serverSnapshotHash?: string;
    serverSnapshot?: string;
  };
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: DraftError };

function classify(status: number, code: string, body: Record<string, unknown>): DraftErrorKind {
  if (status === 410) return "gone";
  if (status === 404) return "notFound";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 400) return "invalid";
  if (status >= 500) return "server";
  return code.includes("CONFLICT") ? "conflict" : "server";
}

async function call<T>(url: string, init: RequestInit): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // 网络错误：调用方应进入 unknown 状态（可能已提交，也可能没到服务端）
    return {
      ok: false,
      error: { kind: "server", code: "NETWORK", message: (e as Error).message, status: 0 },
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 空响应体（例如 204）不是错误 */
  }

  if (res.ok) return { ok: true, value: body as T };

  const code = String(body.code ?? "UNKNOWN");
  return {
    ok: false,
    error: {
      kind: classify(res.status, code, body),
      code,
      message: String(body.error ?? "请求失败"),
      status: res.status,
      server: {
        currentPostRevision: body.currentPostRevision as number | undefined,
        currentDraftRevision: body.currentDraftRevision as number | undefined,
        serverSnapshotHash: body.serverSnapshotHash as string | undefined,
        serverSnapshot: body.serverSnapshot as string | undefined,
      },
    },
  };
}

/* ------------------------------ 读取 ------------------------------ */

export type LoadResult = {
  postId: number;
  postRevision: number;
  deleted: boolean;
  draft: { identity: DraftIdentity; snapshot: Snapshot; updatedAt: string } | null;
};

/**
 * 打开文章：有草稿返回草稿，无草稿返回 null（编辑器随后加载 posts 当前内容）。
 * 这个接口**不会**因为"没有草稿"而失败 —— 那是正常状态，不是错误。
 */
export function loadDraft(postId: number): Promise<Result<LoadResult>> {
  return call<LoadResult>("/api/admin/posts/" + postId + "/draft", { method: "GET" });
}

/* ------------------------------ 保存 ------------------------------ */

export type SaveResult = { identity: DraftIdentity; unchanged: boolean };

/**
 * 保存完整快照到服务端草稿。
 *
 * 首次保存（新文章）：走 PUT /api/admin/drafts/:clientDraftId，由服务端建壳并绑定 postId。
 * 之后：走 PUT /api/admin/posts/:postId/draft。
 *
 * expectedDraftRevision 无草稿时必须为 0 —— 这是"我确认现在没有草稿"的显式声明，
 * 不是"跳过检查"。
 */
export function saveDraft(input: {
  postId?: number;
  clientDraftId: string;
  snapshot: Snapshot;
  snapshotHash: string;
  expectedPostRevision: number;
  expectedDraftRevision: number;
}): Promise<Result<SaveResult & { postId: number }>> {
  const payload = {
    clientDraftId: input.clientDraftId,
    snapshot: input.snapshot,
    snapshotHash: input.snapshotHash,
    expectedPostRevision: input.expectedPostRevision,
    expectedDraftRevision: input.expectedDraftRevision,
  };

  const url = input.postId
    ? "/api/admin/posts/" + input.postId + "/draft"
    : "/api/admin/drafts/" + encodeURIComponent(input.clientDraftId);

  return call<SaveResult>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true as const, value: { ...r.value, postId: r.value.identity.postId } };
  });
}

/* ------------------------------ 发布 ------------------------------ */

export type PublishOptions = {
  postId: number;
  publishRequestId: string;
  expectedPostRevision: number;
  expectedDraftRevision: number;
  slug?: string;
};

export type PublishResult = {
  ok: true;
  postId: number;
  revision: number;
  slug: string;
  snapshotHash: string;
  replayed: boolean;
};

/**
 * 发布当前服务端草稿。
 *
 * publishRequestId 由调用方生成并**在重试时保持不变** —— 这是幂等的唯一依据。
 * 响应丢失后可以：
 *   a) 用同一个 requestId 重发（服务端识别为同一请求，返回原结果）
 *   b) 调 publishResult() 查结果
 * 两者都不需要知道"上次到底成没成"。
 */
export function publishDraft(opts: PublishOptions): Promise<Result<PublishResult>> {
  return call<PublishResult>("/api/admin/posts/" + opts.postId + "/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publishRequestId: opts.publishRequestId,
      expectedPostRevision: opts.expectedPostRevision,
      expectedDraftRevision: opts.expectedDraftRevision,
      slug: opts.slug,
    }),
  });
}

/** 发布结果核对（响应丢失时用） */
export function publishResult(postId: number, requestId: string): Promise<Result<{ found: boolean; revision?: number; slug?: string }>> {
  return call("/api/admin/posts/" + postId + "/publish-result?requestId=" + encodeURIComponent(requestId), {
    method: "GET",
  });
}

/* ------------------------------ 其它 ------------------------------ */

/** 放弃服务端草稿（带版本校验）。成功后编辑器回到 posts 当前版本。 */
export function discardDraft(input: {
  postId: number;
  expectedDraftRevision: number;
  expectedPostRevision: number;
}): Promise<Result<{ ok: true }>> {
  return call("/api/admin/posts/" + input.postId + "/draft", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedDraftRevision: input.expectedDraftRevision,
      expectedPostRevision: input.expectedPostRevision,
    }),
  });
}

/** 用户确认后 rebase：把草稿基线推到最新 posts.revision（不做字段级合并） */
export function rebaseDraft(input: {
  postId: number;
  clientDraftId: string;
  snapshot: Snapshot;
  snapshotHash: string;
  expectedDraftRevision: number;
  expectedPostRevision: number;
}): Promise<Result<{ identity: DraftIdentity }>> {
  return call("/api/admin/posts/" + input.postId + "/draft/rebase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientDraftId: input.clientDraftId,
      snapshot: input.snapshot,
      snapshotHash: input.snapshotHash,
      expectedDraftRevision: input.expectedDraftRevision,
      expectedPostRevision: input.expectedPostRevision,
    }),
  });
}

/** 用历史版本替换草稿（不改线上内容） */
export function restoreVersion(input: {
  postId: number;
  revision: number;
  expectedDraftRevision: number;
  expectedPostRevision: number;
  clientDraftId: string;
}): Promise<Result<{ identity: DraftIdentity }>> {
  return call("/api/admin/posts/" + input.postId + "/restore-version", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision: input.revision,
      expectedDraftRevision: input.expectedDraftRevision,
      expectedPostRevision: input.expectedPostRevision,
      clientDraftId: input.clientDraftId,
    }),
  });
}

/** 生成幂等标识（浏览器环境用 crypto.randomUUID，退化时用时间+随机） */
export function newRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 某些环境 randomUUID 需要 secure context */
  }
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 生成本地草稿身份（每个标签页独立，刷新不重新生成，见方案 §8.3） */
export function newClientDraftId(): string {
  return "cid-" + newRequestId();
}
