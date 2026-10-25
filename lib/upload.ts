import path from "node:path";
import crypto from "node:crypto";

/**
 * 上传安全（方案 A1）—— 这是全案里优先级最高的一段。
 *
 * 原实现的两处致命问题：
 *   1) 用 ALLOWED.has(file.type) 校验类型，而 file.type 完全由客户端决定；
 *   2) 落盘扩展名取自 file.name。
 * 于是「PNG 的字节 + 名叫 evil.html」这类组合能通过校验并写入 nginx 直出的
 * 静态目录，形成**同域存储型 XSS**，进而带着管理员 Cookie 发同源请求拿下后台。
 *
 * 现在的做法：
 *   - 只信 magic bytes（文件头），类型与扩展名都由服务端判定
 *   - 明确拒绝 SVG（可携带 script，是这条链路的经典载体）
 *   - 文件名完全由服务端生成（时间戳 + 随机），与客户端无关
 */

export type Detected = { mime: string; ext: string };

const SIGS: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  {
    mime: "image/png", ext: ".png",
    test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  { mime: "image/jpeg", ext: ".jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/gif", ext: ".gif",
    test: (b) => b.length > 6 && b.subarray(0, 6).toString("latin1") === "GIF87a"
      || b.length > 6 && b.subarray(0, 6).toString("latin1") === "GIF89a",
  },
  {
    mime: "image/webp", ext: ".webp",
    test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF"
      && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  {
    mime: "image/avif", ext: ".avif",
    test: (b) => b.length > 12 && b.subarray(4, 8).toString("latin1") === "ftyp"
      && (b.subarray(8, 12).toString("latin1") === "avif" || b.subarray(8, 12).toString("latin1") === "avis"),
  },
];

/**
 * 识别真实图片类型。识别不出即拒绝 —— 这是白名单而非黑名单，
 * 所以「HTML 伪装成 image/png」「SVG 带 script」「PHP 改名」全部落在拒绝侧。
 */
export function detectImage(buf: Buffer): Detected | null {
  for (const s of SIGS) {
    try {
      if (s.test(buf)) return { mime: s.mime, ext: s.ext };
    } catch {
      // 极短文件导致的越界，直接视为不识别
    }
  }
  return null;
}

/** 明显的非图片前缀（用于给出更准确的报错信息） */
export function looksLikeMarkup(buf: Buffer): boolean {
  const head = buf.subarray(0, 64).toString("utf8").trim().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<script");
}

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 与 nginx client_max_body_size 12m 留出余量
export const DAILY_UPLOAD_LIMIT = 100;           // 按天配额，防被拿来当图床

/** 服务端决定落盘相对路径（年/月 + 随机名），与客户端文件名无关 */
export function buildRelativePath(ext: string, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const name = Date.now() + "-" + crypto.randomBytes(4).toString("hex") + ext;
  return y + "/" + m + "/" + name;
}

/** 读取 PNG / JPEG / GIF / WEBP 的像素尺寸（无依赖，够画占位符用） */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (mime === "image/webp" && buf.length > 30) {
      const fmt = buf.subarray(12, 16).toString("latin1");
      if (fmt === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fmt === "VP8X") return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
  } catch {
    // 尺寸解析失败不影响上传，只是拿不到宽高
  }
  return null;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * 把相对路径拼到根目录下，并挡住路径穿越。
 *
 * 单靠 path.resolve 对比前缀在 POSIX 上有个缺口：反斜杠不是分隔符，
 * "..\\..\\windows\\system32\\x.dll" 会被当成一个合法的**文件名**，
 * resolve 之后仍在 base 之内，于是检查通过。这条路径在 Windows 上就是穿越。
 * 落盘相对路径由服务端 buildRelativePath 生成，永远不会含反斜杠，
 * 所以这里直接拒绝：既挡住 Windows 风格的穿越串，也不会误伤正常调用。
 *
 * （这条是 CI 在 Linux 上暴露的：原来只有 Windows 会走进抛错分支，
 *   同一份代码在 Linux runner 上测试直接失败。）
 */
export function safeJoin(root: string, rel: string): string {
  if (rel.includes("\0")) throw new Error("path traversal blocked");
  if (path.sep === "/" && rel.includes("\\")) throw new Error("path traversal blocked");
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (!abs.startsWith(base + path.sep) && abs !== base) throw new Error("path traversal blocked");
  return abs;
}
