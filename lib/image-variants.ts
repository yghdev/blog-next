import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * 图片变体（C3，2026-11-08）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * 正文里的截图动辄 1200–2000px 宽，手机只有 375–430px 的物理宽度，
 * 下载一张 1600px 的 PNG 再缩到 375px 显示，浪费的是流量和解码时间。
 * 生成 640/960/1280 三档 WebP 后，浏览器按 `srcset` + `sizes` 自己挑，
 * 手机拿 640 那档，桌面拿 1280 那档。
 *
 * ── 为什么是 WebP 而不是 AVIF ─────────────────────────────────
 * AVIF 压缩率更好，但编码慢 5–10 倍、内存占用也更高。本机 MemoryHigh=300M，
 * 上传接口已经有过一次内存事故（2026-10-28），不值得为几个百分点的体积
 * 把上传路径变成内存炸弹。WebP 在同等观感下已经比 PNG/JPEG 小 25–35%。
 *
 * ── 内存边界（这是本模块最重要的约束）────────────────────────
 *   · `limitInputPixels` 挡住解压炸弹（一张 20000×20000 的 PNG 解出来是 1.6GB）；
 *   · 三档**串行**生成，不并行 —— 并行会让峰值内存翻三倍；
 *   · 只处理本地 `/images/` 路径：七牛直链的变体要另外上传，见 deploy/README；
 *   · GIF 跳过：转成 WebP 会丢掉动画，而"动图不动了"比"图大一点"严重得多。
 */

/** 生成哪几档宽度。改这里要同步改 prose-images.ts 的 sizes 与文档 */
export const VARIANT_WIDTHS = [640, 960, 1280] as const;

/** `{ "640": "/images/2026/11/abc-640.webp", … }` */
export type Variants = Record<string, string>;

/**
 * 路径越界守卫。
 *
 * 这里不用 lib/upload.ts 的 safeJoin：那个模块会连带引入 Next 相关依赖，
 * 而本模块要能被 `scripts/gen-variants.mjs` 用 `--experimental-strip-types`
 * 直接 import（脚本跑在服务器上，没有 Next 运行时）。保持"只依赖 sharp +
 * node 内置模块"是刻意的。
 */
function safeJoin(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error("路径越界：" + rel);
  }
  return abs;
}

/** 单张图最多允许多少像素（约 5000×5000），超过直接拒绝生成变体 */
const MAX_INPUT_PIXELS = 25_000_000;

/**
 * 源文件超过这个大小就不生成变体。
 *
 * 实测（2026-11-08，本机）：一张 2MB 的 PNG 生成三档 WebP 时进程峰值 RSS
 * 约 154MB（Node 基线 57MB + libvips 解码约 100MB）。blog.service 的
 * MemoryHigh 是 300M、常驻约 90MB，单张 2MB 的图还能扛，但 8MB 的大图
 * 会把峰值推到 250MB 以上 —— 逼近软上限，而上传接口已经有过一次内存事故
 * （2026-10-28）。所以 4MB 以上的图只保留原图：它们本来就少见，
 * 而且大图往往是截图，原图直接给也不至于不可用。
 */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** WebP 质量：78 是"肉眼几乎无损"与体积的常用平衡点 */
const WEBP_QUALITY = 78;

/** 原图路径 -> 某一档变体路径：`/images/a/b.jpg` -> `/images/a/b-640.webp` */
export function variantPath(publicPath: string, width: number): string {
  const m = publicPath.match(/^(.*)\.[a-zA-Z0-9]+$/);
  const base = m ? m[1] : publicPath;
  return base + "-" + width + ".webp";
}

/** 这张图值不值得生成变体（GIF 与 CDN 直链跳过） */
export function shouldGenerateVariants(publicPath: string, mime: string): boolean {
  if (!publicPath.startsWith("/images/")) return false;
  if (mime === "image/gif") return false;
  return mime.startsWith("image/");
}

/**
 * 生成三档 WebP 变体，返回 `{ 宽度: 公开路径 }`。
 *
 * 失败**不抛错**：变体是优化项，原图才是事实。任何一档失败都只是少一个
 * srcset 候选，不该让整次上传失败（用户会以为"图传不上去"）。
 */
export async function generateVariants(
  buf: Buffer,
  publicPath: string,
  uploadDir: string,
  originalWidth: number | null,
): Promise<Variants> {
  const out: Variants = {};
  if (buf.length > MAX_SOURCE_BYTES) {
    console.warn("[variants] 源文件 " + Math.round(buf.length / 1024) + "KB 超过上限，跳过变体生成");
    return out;
  }
  for (const width of VARIANT_WIDTHS) {
    // 原图比目标还窄就不放大 —— 放大只会更糊更大
    if (originalWidth && originalWidth <= width) continue;
    const rel = variantPath(publicPath, width).replace(/^\/images\//, "");
    const abs = safeJoin(uploadDir, rel);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
        // EXIF 里的方向要真的应用，否则手机竖拍的图在网页上是躺着的
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toFile(abs);
      out[String(width)] = variantPath(publicPath, width);
    } catch (e) {
      console.error("[variants] " + width + "px 生成失败（保留原图）:", (e as Error).message);
    }
  }
  return out;
}

/** 从数据库的 JSON 列解析变体；脏数据一律当"没有变体"，不抛错 */
export function parseVariants(raw: string | null | undefined): Variants {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Variants = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && /^\d+$/.test(k)) out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 拼 `srcset`。按宽度升序，带 `w` 描述符。
 *
 * 没有变体时返回空串 —— 调用方据此决定"不加 srcset"，而不是加一个
 * 只有原图的单元素 srcset（那等于没优化，还多一段 HTML）。
 */
export function buildSrcset(original: string, variants: Variants): string {
  const parts = Object.entries(variants)
    .map(([w, url]) => ({ w: Number(w), url }))
    .filter((x) => Number.isFinite(x.w) && x.w > 0)
    .sort((a, b) => a.w - b.w)
    .map((x) => x.url + " " + x.w + "w");
  return parts.join(", ");
}
