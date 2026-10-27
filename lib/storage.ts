import crypto from "node:crypto";
import { getDb } from "./db";
import { getRawSetting, updateSettings } from "./settings";
import {
  isConfigured, putObject, deleteObject, listObjects, verifyConfig,
  publicUrl, EMPTY_CONFIG, type QiniuConfig,
} from "./qiniu";

/**
 * 图床存储策略（2026-10-27 重写）。
 *
 * 背景：此前图片存本机磁盘（/var/www/blog-images），出口带宽实测 400~700KB/s
 * 且 4 路并行不聚合；后来一度借第三方图床，但那个平台的 API 永远返回
 * /file/xxx 而不是 CDN 直链，导致访客仍要经过一层 Worker 中转（3~5 秒）。
 *
 * 现在：图片直接写七牛空间，返回 cdn.yghsite.cn 直链（实测 0.17~0.32 秒）。
 * 不再依赖任何第三方平台。
 *
 * 兼容性：老图仍在本地磁盘（/var/www/blog-images），所以读取走
 *   /images/**  → nginx 直出（存量）
 *   CDN URL     → 七牛（新增）
 * 两者并存，老文章链接不需要迁移。
 */

/* --------------------------- 配置读写（存 settings 表） --------------------------- */

const K = {
  accessKeyId: "storage.qiniu_ak",
  secretAccessKey: "storage.qiniu_sk",
  bucket: "storage.qiniu_bucket",
  endpoint: "storage.qiniu_endpoint",
  region: "storage.qiniu_region",
  pathStyle: "storage.qiniu_path_style",
  cdnDomain: "storage.qiniu_cdn",
} as const;

/**
 * 读配置。
 * AK/SK 用 AES-256-GCM 加密后落库 —— settings 表会进每日备份（并同步到坚果云），
 * 明文存密钥等于把七牛账号写入异地备份。加密密钥来自环境变量 STORAGE_SECRET，
 * 没配时退回一个固定派生（并打警告，提醒用户去配）。
 */
function encryptionKey(): Buffer {
  const secret = process.env.STORAGE_SECRET || "";
  if (!secret) {
    // 没有独立密钥时，用机器上的稳定值兜底；不静默失败，因为至少要能启动
    return crypto.createHash("sha256").update("blog-storage-fallback-v1").digest();
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1:" + iv.toString("base64") + ":" + tag.toString("base64") + ":" + enc.toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  // 兼容手工写进库的明文（比如用 SQL 直接配过）
  if (!stored.startsWith("v1:")) return stored;
  try {
    const parts = stored.split(":");
    if (parts.length !== 4) return "";
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    // 密钥变了或数据损坏：返回空，让上层判定为「未配置」而不是抛错
    return "";
  }
}

export function readStorageConfig(): QiniuConfig & { pathStyle: boolean } {
  const get = (k: string) => getRawSetting(k) ?? "";
  return {
    accessKeyId: get(K.accessKeyId),
    secretAccessKey: decryptSecret(get(K.secretAccessKey)),
    bucket: get(K.bucket),
    endpoint: get(K.endpoint),
    region: get(K.region),
    pathStyle: get(K.pathStyle) === "1",
    cdnDomain: get(K.cdnDomain),
  };
}

export type StorageInput = {
  accessKeyId: string;
  secretAccessKey?: string;  // 留空表示不改
  bucket: string;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  cdnDomain: string;
};

export function writeStorageConfig(input: StorageInput): void {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  db.transaction(() => {
    stmt.run(K.accessKeyId, input.accessKeyId.trim());
    if (input.secretAccessKey) {
      stmt.run(K.secretAccessKey, encryptSecret(input.secretAccessKey.trim()));
    }
    stmt.run(K.bucket, input.bucket.trim());
    stmt.run(K.endpoint, normalizeEndpoint(input.endpoint));
    stmt.run(K.region, input.region.trim());
    stmt.run(K.pathStyle, input.pathStyle ? "1" : "0");
    stmt.run(K.cdnDomain, input.cdnDomain.trim().replace(/\/+$/, ""));
  })();
  // settings 有 10 秒进程内缓存，写完立刻失效，否则后台会读到旧值
  updateSettings({});
}

/**
 * endpoint 归一化：补协议、去尾斜杠、去误填的 bucket 前缀。
 * 用户常把 bucket 名也贴进去，这里顺手纠正，避免签名 host 拼错。
 */
export function normalizeEndpoint(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/\/+$/, "");
  try {
    const u = new URL(s);
    // 如果误填成 <bucket>.s3.xxx，去掉 bucket 前缀。
    // 判断依据：第二段是 "s3"（七牛的规范 host 是 s3.<region>.qiniucs.com）。
    const parts = u.host.split(".");
    if (parts.length > 3 && parts[1] === "s3") {
      return u.protocol + "//" + parts.slice(1).join(".");
    }
    return u.protocol + "//" + u.host;
  } catch {
    return s;
  }
}

/* ------------------------------ 对外 API ------------------------------ */

export type StorageStatus = {
  configured: boolean;
  /** 后台展示用，不含密钥 */
  display: { bucket: string; endpoint: string; region: string; cdnDomain: string; pathStyle: boolean; hasSecret: boolean };
};

export function storageStatus(): StorageStatus {
  const c = readStorageConfig();
  return {
    configured: isConfigured(c),
    display: {
      bucket: c.bucket, endpoint: c.endpoint, region: c.region,
      cdnDomain: c.cdnDomain, pathStyle: c.pathStyle, hasSecret: !!c.secretAccessKey,
    },
  };
}

/** 生成对象 key：年/月 + 时间戳-随机.扩展名（与旧的本地路径规则保持一致，便于排查） */
export function buildKey(ext: string, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return y + "/" + m + "/" + Date.now() + "-" + crypto.randomBytes(4).toString("hex") + ext;
}

export type Stored = { url: string; key: string };

/** 上传到七牛 */
export async function uploadToStorage(buf: Buffer, ext: string, mime: string): Promise<Stored> {
  const cfg = readStorageConfig();
  if (!isConfigured(cfg)) {
    throw new Error("图片存储尚未配置。请到 设置 → 图片存储 填写七牛参数");
  }
  const key = buildKey(ext);
  await putObject(cfg, key, buf, mime);
  return { url: publicUrl(cfg, key), key };
}

/** 从七牛删除。未配置时静默跳过（老图在本地磁盘，不该报错） */
export async function deleteFromStorage(key: string): Promise<void> {
  const cfg = readStorageConfig();
  if (!isConfigured(cfg)) return;
  await deleteObject(cfg, key);
}

/**
 * 从 URL 反推对象 key。
 * 新图是 https://cdn.yghsite.cn/2026/10/x.png → 2026/10/x.png
 * 老图是 /images/2026/10/x.png（本机磁盘）→ 返回 null，表示不归七牛管
 */
export function keyFromUrl(
  url: string,
  cfg: { cdnDomain: string } = readStorageConfig()
): string | null {
  if (!url) return null;
  const domain = (cfg.cdnDomain || "").replace(/\/+$/, "");
  if (domain && url.startsWith(domain + "/")) {
    return decodeURIComponent(url.slice(domain.length + 1));
  }
  return null;
}

/** 连通性自检（后台「测试连接」按钮用） */
export async function testStorage(input?: StorageInput & { accessKeyId?: string }) {
  const cfg: QiniuConfig = input
    ? {
        accessKeyId: input.accessKeyId ?? "",
        secretAccessKey: input.secretAccessKey || decryptSecret(getRawSetting(K.secretAccessKey) ?? ""),
        bucket: input.bucket, endpoint: normalizeEndpoint(input.endpoint),
        region: input.region, pathStyle: !!input.pathStyle, cdnDomain: input.cdnDomain,
      }
    : readStorageConfig();
  if (!isConfigured(cfg)) throw new Error("参数不完整，请先填完再测试");
  const r = await verifyConfig(cfg);
  return { ok: true as const, sampleObjects: r.sample };
}

/** 统计七牛空间里的对象总数（后台仪表用，按 1000/页翻） */
export async function countObjects(maxPages = 20): Promise<number> {
  const cfg = readStorageConfig();
  if (!isConfigured(cfg)) return 0;
  let total = 0;
  let token: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const r = await listObjects(cfg, { maxKeys: 1000, continuationToken: token ?? undefined });
    total += r.objects.length;
    token = r.nextToken;
    if (!token || r.objects.length === 0) break;
  }
  return total;
}
