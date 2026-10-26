/**
 * 上传前预处理决策（纯函数，不碰 DOM —— 这样能在 Node 里直测）。
 *
 * 为什么需要这一层：
 *   1) iPhone 默认拍 HEIC，而服务端只认 PNG/JPEG/GIF/WEBP/AVIF 的 magic bytes，
 *      于是 HEIC 一律被拒 —— 这是"后台传不了图"最主要的原因。
 *   2) 手机原图动辄 4~12MB，撞上 10MB 上限；就算没撞上，直出也慢。
 *
 * 策略：能在浏览器里转的就在浏览器里转，服务端继续只信 magic bytes（安全边界不动）。
 * 客户端转码还顺带剥掉 EXIF/GPS：canvas 重编码不保留任何元数据。
 */

/** HEIC/HEIF 的扩展名（Chrome 有时给的 type 是空串，只能靠扩展名兜底） */
export const HEIC_EXTENSIONS = [".heic", ".heif", ".hif"] as const;

/** 部分浏览器/系统会给出这些 MIME */
export const HEIC_MIMES = [
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
] as const;

/** 长边上限：2560 对 2x/3x 屏的文章正文仍然清晰，再大只是浪费带宽 */
export const MAX_DIMENSION = 2560;

/** 超过这个体积就重编码（不设太小，避免把本来就小的图白白损失画质） */
export const COMPRESS_THRESHOLD_BYTES = 1.2 * 1024 * 1024;

/**
 * 客户端假设的上传上限。
 *
 * 为什么不在客户端直接 import lib/upload.ts 的 MAX_UPLOAD_BYTES：
 * 那个模块为了 safeJoin 引入了 node:path、为了 sha256 引入了 node:crypto。
 * 编辑器是 "use client"，把这套东西拉进浏览器包既没必要也很脆
 * （一旦那边加了模块级副作用，客户端就会在运行期炸）。
 *
 * 所以这里放一份副本，并由 tests/image-plan.test.ts 断言两者相等 ——
 * 有任何一方被改动而忘了同步，CI 立刻红。
 */
export const MAX_UPLOAD_BYTES_ASSUMED = 8 * 1024 * 1024;

/** HEIC 转 JPEG 的质量（爱疯原图转出来通常仍有 1MB 以内） */
export const HEIC_QUALITY = 0.82;

/** 其余大图重编码质量 */
export const REENCODE_QUALITY = 0.86;

/** 是否 HEIC/HEIF：MIME 优先，缺失时退回扩展名 */
export function isHeic(name: string, mime: string): boolean {
  const m = (mime || "").toLowerCase().trim();
  if ((HEIC_MIMES as readonly string[]).includes(m)) return true;
  const n = (name || "").toLowerCase();
  return HEIC_EXTENSIONS.some((ext) => n.endsWith(ext));
}

/** 按长边等比缩放；不需要缩时原样返回（并取整到像素） */
export function fitDimensions(
  width: number,
  height: number,
  max = MAX_DIMENSION
): { width: number; height: number; scaled: boolean } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0, scaled: false };
  }
  const longest = Math.max(width, height);
  if (longest <= max) {
    return { width: Math.round(width), height: Math.round(height), scaled: false };
  }
  const ratio = max / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

export type UploadPlan = {
  /** heic=必须转码；compress=只是体积大，可能需要重编码；as-is=原样上传 */
  kind: "heic" | "compress" | "as-is";
  maxDimension: number;
  quality: number;
};

/**
 * 决定这张图该怎么处理。
 * 注意：是否需要真正重编码，要等 decode 拿到宽高后才能定（见 shouldReencode）。
 */
export function planUpload(file: { name: string; type: string; size: number }): UploadPlan {
  if (isHeic(file.name, file.type)) {
    return { kind: "heic", maxDimension: MAX_DIMENSION, quality: HEIC_QUALITY };
  }
  if (file.size > COMPRESS_THRESHOLD_BYTES) {
    return { kind: "compress", maxDimension: MAX_DIMENSION, quality: REENCODE_QUALITY };
  }
  return { kind: "as-is", maxDimension: MAX_DIMENSION, quality: REENCODE_QUALITY };
}

/**
 * 拿到真实宽高（以及 HEIC 转码后的实际体积）后，判断要不要再走一次 canvas。
 *
 *   - 尺寸超限 -> 必须缩，与体积无关
 *   - HEIC 已由 heic2any 产出 JPEG：只在仍然偏大时才二次重编码。
 *     否则会变成"JPEG 再压一遍 JPEG"，白掉一次画质（这是这一版特意规避的）
 *   - 体积大但尺寸正常 -> 重编码，多数情况能压掉一半以上
 *   - 其余原样上传，避免无谓的画质损失
 */
export function shouldReencode(
  plan: UploadPlan,
  dims: { width: number; height: number },
  currentBytes?: number
): { reencode: boolean; target: { width: number; height: number } } {
  const fitted = fitDimensions(dims.width, dims.height, plan.maxDimension);
  if (fitted.scaled) return { reencode: true, target: fitted };
  if (plan.kind === "heic") {
    const bytes = typeof currentBytes === "number" ? currentBytes : 0;
    return { reencode: bytes > COMPRESS_THRESHOLD_BYTES, target: fitted };
  }
  if (plan.kind === "compress") return { reencode: true, target: fitted };
  return { reencode: false, target: fitted };
}

/**
 * 输出格式：PNG 保持 PNG（截图里的文字和透明通道都靠它），其余统一转 JPEG。
 * HEIC 一律转 JPEG —— 它本来就没有 PNG 的用途。
 */
export function outputMimeFor(sourceMime: string, isHeicSource = false): "image/png" | "image/jpeg" {
  if (isHeicSource) return "image/jpeg";
  const m = (sourceMime || "").toLowerCase().trim();
  if (m === "image/png") return "image/png";
  return "image/jpeg";
}

/** 体积可读化，用于给用户的提示 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/**
 * 服务端拒绝时说人话。
 * 传进来的 serverError 是 API 的中文报错，这里只补充"该怎么办"。
 */
export function explainUploadFailure(
  filename: string,
  status: number,
  serverError: string
): string {
  const name = filename || "该文件";
  if (status === 413) return name + " 太大，超出了服务器允许的体积上限";
  if (status === 429) return serverError || "今日上传已达上限，明天再试";
  if (status === 401) return "登录已过期，请重新登录后台";
  if (/SVG|HTML|脚本/.test(serverError)) {
    return name + " 不是位图：SVG/HTML 这类可携带脚本的文件一直被拒绝";
  }
  if (/只支持/.test(serverError)) {
    return name + " 的格式无法识别（" + serverError + "）。HEIC 请在编辑器里直接选图，浏览器会自动转成 JPEG";
  }
  return serverError || name + " 上传失败";
}
