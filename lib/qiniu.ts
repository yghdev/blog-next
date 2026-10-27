import crypto from "node:crypto";

/**
 * 七牛 Kodo 的 S3 兼容客户端（零依赖）。
 *
 * 为什么自己写而不用 @aws-sdk/client-s3：
 *   · 那个包连同依赖十几 MB，而我们只用 PUT / GET / HEAD / DELETE / List 五个操作；
 *   · 产物已经 348MB，能不涨就不涨；
 *   · SigV4 是公开标准，有官方测试向量可以逐字节验证（见 tests/qiniu.test.ts）。
 *
 * 七牛官方文档确认同时兼容 AWS Signature V2 / V4，这里实现 V4。
 * endpoint 形如 https://s3.cn-south-1.qiniucs.com，region 为 cn-south-1。
 */

export type QiniuConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** 形如 https://s3.cn-south-1.qiniucs.com（不带尾斜杠） */
  endpoint: string;
  /** 七牛 S3 区域，如 cn-south-1 */
  region: string;
  /** 是否用路径式（s3.host/bucket/key）而不是虚拟主机式（bucket.s3.host/key） */
  pathStyle?: boolean;
  /** 对外访问域名，如 https://cdn.yghsite.cn */
  cdnDomain: string;
};

export const EMPTY_CONFIG: QiniuConfig = {
  accessKeyId: "", secretAccessKey: "", bucket: "",
  endpoint: "", region: "", pathStyle: false, cdnDomain: "",
};

/** 配置是否齐全（用于后台显示「未配置」而不是报错） */
export function isConfigured(c: Partial<QiniuConfig> | null | undefined): boolean {
  if (!c) return false;
  return !!(c.accessKeyId && c.secretAccessKey && c.bucket && c.endpoint && c.region && c.cdnDomain);
}

/* ------------------------------ 签名工具 ------------------------------ */

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** 20261027T032049Z / 20261027 */
export function amzDates(now = new Date()): { amz: string; date: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

/**
 * RFC3986 编码。
 * S3 的 canonical URI 要求斜杠不被编码（key 里的 / 表示目录层级），
 * 所以单独暴露一个 allowSlash 开关。
 */
export function uriEncode(str: string, allowSlash = false): string {
  let out = "";
  for (const ch of Buffer.from(str, "utf8")) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === "/" && allowSlash) out += "/";
    else out += "%" + ch.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** canonical query：按编码后的 key 排序，空格编码成 %20 而不是 + */
export function canonicalQueryString(query: Record<string, string | number | undefined>): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    pairs.push([uriEncode(k), uriEncode(String(v))]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => k + "=" + v).join("&");
}

export type SignInput = {
  method: string;
  /** 已编码的路径，形如 /bucket/key 或 /key，必须以 / 开头 */
  canonicalUri: string;
  query?: Record<string, string | number | undefined>;
  /** 参与签名的头（小写 key），必须包含 host 与 x-amz-date、x-amz-content-sha256 */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  amzDate: string;
  dateStamp: string;
};

/**
 * 计算 SigV4 签名并返回完整的 Authorization 头值。
 * 拆成纯函数是为了能用 AWS 官方测试向量逐字节校验。
 */
export function signRequest(input: SignInput): string {
  const service = input.service ?? "s3";
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    lowerHeaders[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  }

  const headerNames = Object.keys(lowerHeaders).sort();
  const canonicalHeaders = headerNames.map((h) => h + ":" + lowerHeaders[h] + "\n").join("");
  const signedHeaders = headerNames.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri,
    canonicalQueryString(input.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = input.dateStamp + "/" + input.region + "/" + service + "/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + input.secretAccessKey, input.dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return (
    "AWS4-HMAC-SHA256 Credential=" + input.accessKeyId + "/" + scope +
    ", SignedHeaders=" + signedHeaders +
    ", Signature=" + signature
  );
}

/* ------------------------------ 请求封装 ------------------------------ */

/** 从 endpoint 拆出 host 与协议，并拼出实际的请求 host */
export function resolveHost(cfg: QiniuConfig): { host: string; protocol: string } {
  const u = new URL(cfg.endpoint.includes("://") ? cfg.endpoint : "https://" + cfg.endpoint);
  const protocol = u.protocol;
  const base = u.host;
  return {
    host: cfg.pathStyle ? base : cfg.bucket + "." + base,
    protocol,
  };
}

/** 构造 canonicalUri 与最终 URL 路径 */
export function buildPath(cfg: QiniuConfig, key?: string): string {
  const safeKey = (key ?? "").split("/").map((s) => uriEncode(s, false)).join("/");
  if (cfg.pathStyle) {
    const base = "/" + uriEncode(cfg.bucket);
    return safeKey ? base + "/" + safeKey : base;
  }
  return safeKey ? "/" + safeKey : "/";
}

export type QiniuResult = { ok: boolean; status: number; body: string; headers: Headers };

/** 把七牛的 XML 错误转成人能读懂的中文 */
export function explainError(status: number, body: string): string {
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? "";
  const msg = body.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? "";
  const map: Record<string, string> = {
    AccessDenied: "七牛拒绝了请求：AccessKey/SecretKey 无权限，或空间不是这个账号的",
    InvalidAccessKeyId: "AccessKeyId 不存在，请检查是否复制完整",
    SignatureDoesNotMatch: "签名校验失败：SecretKey 不对，或 region / endpoint 填错了",
    NoSuchBucket: "空间不存在：请核对存储空间名称与存储区域",
    NoSuchKey: "对象不存在",
    MalformedXML: "请求格式错误",
    InvalidBucketName: "空间名不合法",
    RequestTimeTooSkewed: "本机时间与七牛相差过大（超过 15 分钟）",
    EntityTooLarge: "文件超过七牛单次上传上限",
  };
  const base = map[code] || ("七牛返回 " + status + (msg ? "：" + msg : ""));
  return code ? base + "（" + code + "）" : base;
}

async function request(
  cfg: QiniuConfig,
  method: string,
  key?: string,
  opts: {
    query?: Record<string, string | number | undefined>;
    body?: Buffer | string;
    contentType?: string;
    extraHeaders?: Record<string, string>;
  } = {}
): Promise<QiniuResult> {
  const { host, protocol } = resolveHost(cfg);
  const canonicalUri = buildPath(cfg, key);
  const payload = opts.body === undefined ? Buffer.alloc(0) : Buffer.from(opts.body as any);
  const payloadHash = sha256Hex(payload);
  const { amz, date } = amzDates();

  const headers: Record<string, string> = {
    host,
    "x-amz-date": amz,
    "x-amz-content-sha256": payloadHash,
    ...(opts.contentType ? { "content-type": opts.contentType } : {}),
    ...(opts.extraHeaders ?? {}),
  };

  const authorization = signRequest({
    method,
    canonicalUri,
    query: opts.query,
    headers,
    payloadHash,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    amzDate: amz,
    dateStamp: date,
  });

  const qs = canonicalQueryString(opts.query ?? {});
  const url = protocol + "//" + host + canonicalUri + (qs ? "?" + qs : "");

  // host 由 fetch 自己按 URL 设置，不能手工传（否则会被覆盖或冲突）
  const sendHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "host") continue;
    sendHeaders[k] = v;
  }
  sendHeaders.authorization = authorization;

  const res = await fetch(url, {
    method,
    headers: sendHeaders,
    body: method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : payload,
  });

  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: text, headers: res.headers };
}

/* ------------------------------ 对外操作 ------------------------------ */

/** 上传一个对象；成功返回可公开访问的 URL */
export async function putObject(
  cfg: QiniuConfig,
  key: string,
  body: Buffer,
  contentType: string
): Promise<{ url: string }> {
  const r = await request(cfg, "PUT", key, { body, contentType });
  if (!r.ok) throw new Error(explainError(r.status, r.body));
  return { url: publicUrl(cfg, key) };
}

/** 删除一个对象。404 视为已删除，不报错（幂等） */
export async function deleteObject(cfg: QiniuConfig, key: string): Promise<void> {
  const r = await request(cfg, "DELETE", key);
  if (r.ok || r.status === 404) return;
  throw new Error(explainError(r.status, r.body));
}

export type ObjectMeta = { key: string; size: number; lastModified: string; etag: string };

/** 列出对象（S3 ListObjectsV2） */
export async function listObjects(
  cfg: QiniuConfig,
  opts: { prefix?: string; maxKeys?: number; continuationToken?: string } = {}
): Promise<{ objects: ObjectMeta[]; nextToken: string | null }> {
  const r = await request(cfg, "GET", undefined, {
    query: {
      "list-type": 2,
      prefix: opts.prefix,
      "max-keys": opts.maxKeys ?? 100,
      "continuation-token": opts.continuationToken,
    },
  });
  if (!r.ok) throw new Error(explainError(r.status, r.body));
  return parseListXml(r.body);
}

/** 解析 ListObjectsV2 的 XML（不引 XML 库，字段固定且结构简单） */
export function parseListXml(xml: string): { objects: ObjectMeta[]; nextToken: string | null } {
  const objects: ObjectMeta[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? "";
    const size = Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
    const lastModified = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? "";
    const etag = (block.match(/<ETag>([^<]+)<\/ETag>/)?.[1] ?? "").replace(/&quot;/g, "").replace(/"/g, "");
    if (key) objects.push({ key: decodeXmlEntities(key), size, lastModified, etag });
  }
  const nextToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? null;
  return { objects, nextToken: nextToken ? decodeXmlEntities(nextToken) : null };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 拼出对外访问地址 */
export function publicUrl(cfg: QiniuConfig, key: string): string {
  const domain = (cfg.cdnDomain || "").replace(/\/+$/, "");
  return domain + "/" + key.split("/").map((s) => uriEncode(s, false)).join("/");
}

/** 连通性自检：列一个对象就能同时验证凭证、区域、endpoint、空间名 */
export async function verifyConfig(cfg: QiniuConfig): Promise<{ ok: true; sample: number }> {
  const r = await request(cfg, "GET", undefined, { query: { "list-type": 2, "max-keys": 1 } });
  if (!r.ok) throw new Error(explainError(r.status, r.body));
  const { objects } = parseListXml(r.body);
  return { ok: true, sample: objects.length };
}
