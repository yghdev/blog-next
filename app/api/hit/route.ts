import { NextRequest, NextResponse } from "next/server";
import { recordHit, normalizePath } from "@/lib/visitor-stats";
import { clientIp } from "@/lib/request-ip";
import { consume } from "@/lib/rate-limit";
import { hashToken } from "@/lib/crypto";
import { COOKIE_NAME } from "@/lib/session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 前端埋点接口（2026-10-30）。
 *
 * ## 为什么这个接口必须自己写限流与来源校验
 *
 * 它的路径是 `/api/hit`，不在 `/api/admin/*` 下 —— `proxy.ts` 的粗粒度门禁
 * 拦不到它（那是故意的：访客本来就没有登录态）。所以这里的每一层
 * 都得自己负责，不能指望后台那层兜底。
 *
 * ## 为什么永远返回 204
 *
 * 统计失败绝不能让页面感知。任何异常（限流、非法路径、UA 黑名单、
 * 甚至数据库忙）都在这里被吞掉并返回 204 —— 前端拿到非 2xx 会记一条
 * 控制台错误，而访客不该为我们的统计逻辑看到任何红字。
 */

/** 爬虫 UA 黑名单：命中就完全不写库（不是先写再过滤） */
const BOT_UA = /bot|spider|crawl|slurp|headless|phantomjs|puppeteer|playwright|selenium|gptbot|claudebot|chatgpt|anthropic|ccbot|perplexity|bytespider|petalbot|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp|axios\/|node-fetch|libwww|scrapy|httpclient|postman|insomnia/i;

/** 只接受同源上报：挡住跨站刷量与大部分脚本 */
function sameOrigin(req: NextRequest): boolean {
  // 现代浏览器都会带 Sec-Fetch-Site；缺失时退回 Origin/Host 比对
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

/**
 * 管理员排除（需求 4）。
 *
 * **只查一条主键，不 join users、不写任何东西。**
 * 不要用 `currentUser()` —— 它会顺带 `UPDATE sessions SET last_seen_at`，
 * 等于「统计一次浏览」产生一次写库，在低流量站点上完全是浪费。
 *
 * 已实测 `sessions.token_hash` 是主键，命中走 `sqlite_autoindex_sessions_1`。
 */
function isAdmin(req: NextRequest): boolean {
  const token = req.cookies.get(COOKIE_NAME)?.value ?? "";
  // 与 proxy.ts 同一套格式校验：格式不对直接当未登录，连库都不用查
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  try {
    const row = getDb().prepare(
      "SELECT 1 AS hit FROM sessions WHERE token_hash = ? AND expires_at > ?"
    ).get(hashToken(token), new Date().toISOString()) as { hit: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

function noContent(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // 1. 来源校验
    if (!sameOrigin(req)) return noContent();

    // 2. 管理员排除（在限流之前：自己的浏览不该消耗配额）
    if (isAdmin(req)) return noContent();

    const ip = clientIp(req);
    const ua = req.headers.get("user-agent") ?? "";

    // 3. 爬虫过滤
    if (!ua || BOT_UA.test(ua)) return noContent();

    // 4. 限流：同一 IP 10 分钟 120 次。
    //    正常读者一分钟翻不了 12 页；这个值只是防脚本刷，不会误伤。
    if (!consume("hit:ip:" + ip, 120, 600).ok) return noContent();

    const body = (await req.json().catch(() => null)) as
      | { path?: unknown; referrer?: unknown }
      | null;
    if (!body || typeof body.path !== "string") return noContent();

    // 5. 归一化 + 写入
    const path = normalizePath(body.path);
    if (!path) return noContent();

    const referrer = typeof body.referrer === "string" ? body.referrer : "";
    recordHit({ path, ip, ua, referrer });

    return noContent();
  } catch (e) {
    // 统计挂了也不能影响访客：只记日志，不回错误
    console.warn("[hit] 记录失败（已忽略）:", (e as Error).message);
    return noContent();
  }
}

/** 浏览器可能用 sendBeacon 发 text/plain，这里也接受；GET 一律 405 */
export async function GET(): Promise<NextResponse> {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
