import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, handle, noStore, badRequest } from "@/lib/guards";
import { logAudit } from "@/lib/audit";
import {
  storageStatus, readStorageConfig, writeStorageConfig, testStorage,
  normalizeEndpoint, type StorageInput,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

/** 读当前配置（永不返回 SK 明文） */
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const st = storageStatus();
  return noStore(NextResponse.json({ configured: st.configured, ...st.display }));
});

/**
 * 保存配置。
 * SK 留空 = 不修改（前端也不回填 SK，避免明文往返）。
 */
export const PUT = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = (await req.json().catch(() => null)) as Partial<StorageInput> | null;
  if (!body) throw badRequest("请求体不是合法 JSON");

  const bucket = String(body.bucket ?? "").trim();
  const endpoint = normalizeEndpoint(String(body.endpoint ?? ""));
  const region = String(body.region ?? "").trim();
  const cdnDomain = String(body.cdnDomain ?? "").trim().replace(/\/+$/, "");
  const accessKeyId = String(body.accessKeyId ?? "").trim();
  const secretAccessKey = body.secretAccessKey ? String(body.secretAccessKey).trim() : undefined;

  if (!bucket) throw badRequest("存储空间名称不能为空");
  if (!endpoint) throw badRequest("Endpoint 不能为空");
  if (!region) throw badRequest("存储区域不能为空");
  if (!cdnDomain) throw badRequest("CDN 域名不能为空");
  if (!/^https?:\/\//.test(cdnDomain)) throw badRequest("CDN 域名要以 http:// 或 https:// 开头");
  if (!accessKeyId) throw badRequest("AccessKey 不能为空");

  // 首次配置必须给 SK；之后留空表示沿用旧值
  const existing = readStorageConfig();
  if (!secretAccessKey && !existing.secretAccessKey) {
    throw badRequest("首次配置必须填写 SecretKey");
  }

  writeStorageConfig({
    accessKeyId, secretAccessKey, bucket, endpoint,
    region, pathStyle: !!body.pathStyle, cdnDomain,
  });

  logAudit({
    action: "storage.update",
    userId: ctx.user.id, userName: ctx.user.username,
    targetType: "settings", targetId: "storage",
    meta: { bucket, endpoint, region, cdnDomain, pathStyle: !!body.pathStyle, rotatedSecret: !!secretAccessKey },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });

  return noStore(NextResponse.json({ ok: true }));
});

/** 测试连接：用「即将保存的」参数试列对象，避免存了坏配置才发现 */
export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = (await req.json().catch(() => ({}))) as Partial<StorageInput>;

  try {
    const r = await testStorage({
      accessKeyId: String(body.accessKeyId ?? "").trim() || readStorageConfig().accessKeyId,
      secretAccessKey: body.secretAccessKey ? String(body.secretAccessKey).trim() : undefined,
      bucket: String(body.bucket ?? "").trim(),
      endpoint: normalizeEndpoint(String(body.endpoint ?? "")),
      region: String(body.region ?? "").trim(),
      pathStyle: !!body.pathStyle,
      cdnDomain: String(body.cdnDomain ?? "").trim(),
    });
    logAudit({
      action: "storage.test", userId: ctx.user.id, userName: ctx.user.username,
      targetType: "settings", targetId: "storage",
      meta: { ok: true, bucket: body.bucket ?? "" },
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return noStore(NextResponse.json({ ok: true, sampleObjects: r.sampleObjects }));
  } catch (e) {
    const msg = (e as Error).message || "测试失败";
    logAudit({
      action: "storage.test", userId: ctx.user.id, userName: ctx.user.username,
      targetType: "settings", targetId: "storage",
      meta: { ok: false, error: msg.slice(0, 200) },
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    // 测试失败是业务结果而不是服务器错误，用 400 让前端好判断
    return noStore(NextResponse.json({ ok: false, error: msg }, { status: 400 }));
  }
});
