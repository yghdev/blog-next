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

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 见 deploy/nginx-blog.conf：nginx 统一 20m（图片/视频共用一条）
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

/* ══════════════════════════════════════════════════════════════════════
   视频上传（2026-10-28 补）
   ──────────────────────────────────────────────────────────────────────
   与图片**完全同一套安全模型**：只认 magic bytes，扩展名与 MIME 都由服务端
   决定，客户端给的 file.type / file.name 一个都不采信。

   为什么单独一套大小上限：
     图片 8MB 是为了让 nginx(12m) 有足够余量；视频天然更大。这里视频放到
     40MB，同时 nginx 需要同步上调 client_max_body_size（见 deploy/nginx-blog.conf）。
     两个数必须一起改，否则会在 nginx 层被 413 挡掉，而应用层完全看不到。

   为什么不做"任意格式"：
     只允许 MP4 / WebM 两个浏览器原生能播的容器。允许 .mov / .avi 只会产生
     "传上去了但没人能播"的文件，那比拒绝更糟 —— 用户以为成功了。
   ══════════════════════════════════════════════════════════════════════ */

export type DetectedVideo = { mime: string; ext: string };

const VIDEO_SIGS: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  {
    // ISO BMFF：offset 4 起是 "ftyp"，brand 决定是 mp4 家族（mp42/isom/avc1/M4V 等）
    mime: "video/mp4", ext: ".mp4",
    test: (b) => {
      if (b.length < 12) return false;
      if (b.subarray(4, 8).toString("latin1") !== "ftyp") return false;
      const brand = b.subarray(8, 12).toString("latin1");
      // qt 是 QuickTime(.mov)：浏览器支持度差，明确排除，别让它伪装成 mp4
      if (brand === "qt  ") return false;
      return /^(isom|iso2|iso4|iso5|iso6|mp41|mp42|avc1|M4V|M4A|dash|mmp4|MSNV|NDAS|f4v)/.test(brand);
    },
  },
  {
    // EBML：1A 45 DF A3，再往后 4 字节含 "webm" 或 "matroska"
    mime: "video/webm", ext: ".webm",
    test: (b) => {
      if (b.length < 32) return false;
      if (!(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) return false;
      // DocType 在 EBML header 里，通常前 64 字节内就能看到
      return b.subarray(0, 64).toString("latin1").includes("webm");
    },
  },
];

/**
 * 识别真实视频类型。识别不出返回 null（白名单策略，未知一律拒绝）。
 * MP4 与 WebM 覆盖了浏览器 <video> 能播的绝大多数情况。
 */
export function detectVideo(buf: Buffer): DetectedVideo | null {
  for (const s of VIDEO_SIGS) {
    try {
      if (s.test(buf)) return { mime: s.mime, ext: s.ext };
    } catch {
      // 极短文件的越界，视为不识别
    }
  }
  return null;
}

/**
 * 视频上传上限 16MB。
 *
 * **这个值由实测内存决定，不是由"想要多大"决定。**
 *
 * 2026-10-28 线上事故：最初设成 40MB，结果一次 40MB 上传把整个 Node 进程
 * 顶进 cgroup 节流（wchan=mem_cgroup_handle_over_high，D 状态，swap 抖动），
 * **同进程的所有请求一起超时** —— 前台首页也挂了。
 *
 * 实测（scripts 里跑的一次性探针，METHOD 见下）：
 *    文件 10MB → RSS +56MB（5.6x）
 *    文件 16MB → RSS +104MB（6.5x）
 *    文件 20MB → RSS +129MB（6.5x）
 *    文件 25MB → RSS +159MB（6.4x）
 * 放大来自 Next 在把请求交给 route handler **之前**就解析完整个 multipart
 * body（连被本模块拒绝的请求也照样花掉这份内存）。
 *
 * 本机约束：MemoryHigh=300M，生产基线峰值约 120MB。
 *   → 16MB 上传峰值约 224MB，留 76MB 余量，安全。
 *   → 40MB 上传要约 380MB，**必然触顶**，这就是事故的直接原因。
 *
 * 所以上限取 16MB。更大的视频走平台外链（B 站/YouTube，编辑器支持），
 * 那本来也是更合适的选择：这台机器出口带宽 400~700KB/s，40MB 的片段
 * 访客要等 60~100 秒，传上去也没人看得完。
 *
 * ⚠ 想调大必须先确认机器能承受（基线 + 6.5 × 上限 < MemoryHigh），
 * 并**同步改四处**：本常量、lib/image-plan.ts 的 _ASSUMED 副本、
 * next.config.ts 的 proxyClientMaxBodySize、deploy/nginx-blog.conf 的
 * client_max_body_size。漏改任一处都会在那一层被截断或节流。
 */
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024;

/** 统一的体积上限判定，供上传接口按类型选择 */
export function limitFor(mime: string): number {
  return mime.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES;
}

/** 视频按天配额。比图片严得多：单个体积是图的 5 倍，放宽会直接写满空间 */
export const DAILY_VIDEO_LIMIT = 10;
