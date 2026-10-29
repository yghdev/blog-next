import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, STEP_UP_SECONDS, isFreshAuth, markFreshAuth, sessionUser, type SessionUser } from "./session";
import { verifyTotp, consumeRecoveryCode } from "./auth";
import { logAudit } from "./audit";
import { clientIp } from "./request-ip";

/** 带 HTTP 语义的错误，route 层统一转成响应 */
export class HttpError extends Error {
  status: number;
  /**
   * 机器可读的错误码。
   *
   * 为什么补这个字段：428 有两种完全不同的成因 ——
   *   a) 需要输入两步验证码（用户有 TOTP，给个输入框就行）
   *   b) 未启用 TOTP 且登录已超过 10 分钟（给输入框也没用，只能重新登录）
   * 前端此前只看状态码，于是对 (b) 也弹"请输入验证码"，用户怎么输都过不去 ——
   * 线上 49 次连续 428 就是这么来的。只靠中文 message 分支太脆，所以带 code。
   */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "HttpError";
  }
}

export const unauthorized = () => new HttpError(401, "未登录或登录已过期");
export const forbidden = (m = "没有权限") => new HttpError(403, m);
export const notFound = (m = "资源不存在") => new HttpError(404, m);
export const conflict = (m = "操作冲突") => new HttpError(409, m);
export const badRequest = (m: string) => new HttpError(400, m);
/** 428：需要二次验证（step-up） */
export const needsStepUp = (m = "此操作需要再次验证两步验证码", code = "STEP_UP_REQUIRED") =>
  new HttpError(428, m, code);

export type AdminContext = {
  user: SessionUser;
  token: string;
  ip: string;
  userAgent: string;
};

export async function readToken(): Promise<string | null> {
  return (await cookies()).get(COOKIE_NAME)?.value ?? null;
}

/**
 * 权威鉴权（方案 A6）。
 *
 * proxy.ts 只做粗粒度拦截（省一次开库），真正判定在这里。
 * 这样即使 proxy 因某种原因没生效，安全性也不降级 —— 两层互补而非互相依赖。
 */
export async function requireAdmin(req?: { headers: { get(n: string): string | null } }): Promise<AdminContext> {
  const token = await readToken();
  if (!token) throw unauthorized();
  const user = sessionUser(token);
  if (!user) throw unauthorized();
  return {
    user,
    token,
    ip: req ? clientIp(req) : "unknown",
    userAgent: req?.headers.get("user-agent") ?? "",
  };
}

/**
 * 敏感操作二次验证（方案 A5）。
 *
 * 规则：
 *   1) 若会话在 10 分钟内刚通过验证 -> 放行
 *   2) 否则要求本次请求携带有效 TOTP 码
 *   3) 未启用 TOTP 时，只能靠 (1) 的窗口；否则提示去开启
 *
 * 目的：即使 Cookie 被窃（上传 XSS 等路径），也无法直接关闭 2FA 或改密码。
 */
export async function requireStepUp(ctx: AdminContext, code?: string | null): Promise<void> {
  if (isFreshAuth(ctx.token, STEP_UP_SECONDS)) return;

  if (!ctx.user.totp_enabled || !ctx.user.totp_secret) {
    /**
     * 未启用 TOTP：只能靠"10 分钟内登录过"。
     *
     * 这里必须用**另一个 code**（STEP_UP_RELOGIN），前端据此显示"重新登录"，
     * 而不是给一个永远不可能正确的验证码输入框。线上批量删除连续 428
     * 就是这一支被当成"请输入验证码"处理的结果。
     */
    throw needsStepUp(
      "这次操作需要重新登录：未启用两步验证时，敏感操作只允许在登录后 10 分钟内进行",
      "STEP_UP_RELOGIN"
    );
  }

  const input = (code ?? "").trim();
  if (!input) throw needsStepUp();

  if (verifyTotp(ctx.user.totp_secret, input)) {
    markFreshAuth(ctx.token);
    return;
  }
  // 恢复码也可用于 step-up（验证器丢失时的最后退路）
  if (consumeRecoveryCode(ctx.user.id, input)) {
    markFreshAuth(ctx.token);
    logAudit({ action: "login.ok", userId: ctx.user.id, userName: ctx.user.username, meta: { via: "recovery-code" }, ip: ctx.ip, userAgent: ctx.userAgent });
    return;
  }
  throw needsStepUp("验证码不正确", "STEP_UP_BAD_CODE");
}

/** 从请求体里取可能的验证码（约定字段名 totp，兼容 header） */
export function stepUpCodeFrom(req: { headers: { get(n: string): string | null } }, body?: Record<string, unknown>): string | null {
  const fromHeader = req.headers.get("x-admin-step-up");
  if (fromHeader) return fromHeader;
  const v = body?.totp ?? body?.code;
  return typeof v === "string" ? v : null;
}

/** 统一错误 -> 响应；未预期异常不外泄内部细节 */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return NextResponse.json(
      { error: e.message, status: e.status, ...(e.code ? { code: e.code } : {}) },
      { status: e.status }
    );
  }
  if (e && typeof e === "object" && "status" in e && "message" in e) {
    const anyE = e as { status: number; message: string; code?: string };
    return NextResponse.json(
      { error: anyE.message, status: anyE.status, ...(anyE.code ? { code: anyE.code } : {}) },
      { status: anyE.status }
    );
  }
  // 只记日志，不回传堆栈/SQL 细节（原实现会把 SQLite 原文抛给客户端）
  console.error("[api] unhandled error:", e);
  return NextResponse.json({ error: "服务器内部错误", status: 500 }, { status: 500 });
}

/** 包一层，省掉每个 route 里的 try/catch 样板 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<NextResponse>) {
  return async (...args: A): Promise<NextResponse> => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  return res;
}
