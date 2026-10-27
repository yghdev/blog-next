/**
 * 草稿/发布路由的公用辅助。
 *
 * 存在的理由：03.1 新增了 8 个接口，它们都要做同样四件事 ——
 * 取 id、取 actor、把 WriteError 翻译成带 code 的 HTTP 响应、收集缓存失效标签。
 * 复制 8 遍必然会漂移（某个接口忘记带 code，前端就没法区分冲突类型）。
 */
import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { getDb } from "@/lib/db";
import { badRequest, errorResponse, HttpError, type AdminContext } from "@/lib/guards";
import { WriteError, type Actor } from "@/lib/post-writes";

export function parsePostId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest("文章 id 不合法");
  return n;
}

/** 路由上下文 -> 写核心需要的 actor */
export function actorOf(ctx: AdminContext): Actor {
  return { userId: ctx.user.id, userName: ctx.user.username, ip: ctx.ip, userAgent: ctx.userAgent };
}

export function db(): Database {
  return getDb();
}

/**
 * WriteError -> HTTP 响应。
 *
 * 响应体里带 `code`，因为前端必须能区分"基线冲突（要 rebase）"和
 * "草稿版本冲突（要重读）" —— 两者都给 409，处理方式完全不同。
 * 冲突类响应同时回传服务端当前版本，避免前端再发一次 GET。
 */
export function writeErrorResponse(e: unknown): NextResponse {
  if (e instanceof WriteError) {
    const body: Record<string, unknown> = { error: e.message, code: e.code, status: e.status };
    if (e.detail) Object.assign(body, e.detail);
    return NextResponse.json(body, { status: e.status });
  }
  if (e instanceof HttpError) return errorResponse(e);
  return errorResponse(e);
}

/** 包一层，省掉每个路由的 try/catch */
export function handleWrite<A extends unknown[]>(fn: (...args: A) => Promise<NextResponse>) {
  return async (...args: A): Promise<NextResponse> => {
    try {
      return await fn(...args);
    } catch (e) {
      return writeErrorResponse(e);
    }
  };
}

export function noStoreJson(body: unknown, init?: { status?: number }): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  return res;
}

/**
 * 必填数字版本号：缺了就是 400，不能默认成"跳过校验"。
 *
 * 特别注意空值的处理：`Number(undefined)` 是 NaN、`Number("")` 是 **0**。
 * 如果把空字符串当 0 接受，那么"漏传 expectedRevision" 会被解释成
 * "expectedRevision = 0"，对 revision>=1 的文章必然冲突（看似安全），
 * 但对 expectedDraftRevision 来说 0 是**合法且有意义**的值（表示"我知道没有草稿"）。
 * 两者混在一起会让"忘传参数"伪装成"显式声明无草稿"，所以这里一律先拒绝空值。
 */
export function requireRevision(raw: unknown, field: string): number {
  if (raw === undefined || raw === null || raw === "") {
    throw new WriteError("REVISION_REQUIRED", field + " 是必填项", 400);
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new WriteError("REVISION_REQUIRED", field + " 必须是非负整数", 400);
  }
  return n;
}

export function requireString(raw: unknown, field: string, max = 200): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new WriteError("SNAPSHOT_INVALID", field + " 不能为空", 400);
  }
  if (raw.length > max) throw new WriteError("SNAPSHOT_INVALID", field + " 过长", 400);
  return raw;
}
