import { getDb } from "./db";

/**
 * 按路径查媒体尺寸（F9，2026-11-07）。
 *
 * 用途只有一个：给文章封面的 `<img>` 补 `width`/`height`，让浏览器在图片
 * 下载完成前就按正确比例预留空间 —— 否则封面加载完会把正文整体往下推，
 * 就是 CLS（累积布局偏移）。
 *
 * 为什么查库而不是在 URL 里带尺寸：封面可能是本机 `/images/...`，也可能是
 * 七牛 CDN 直链，URL 形态不统一；而 `media` 表在上传时已经记录了宽高
 * （migration 0007），是唯一可靠来源。
 *
 * 查不到就返回 null，调用方**不要**编一个默认比例 —— 猜错的比例比不预留
 * 更糟（图片会被拉伸或裁切）。
 */
export function mediaSizeByPath(mediaPath: string): { width: number; height: number } | null {
  if (!mediaPath) return null;
  const row = getDb()
    .prepare("SELECT width, height FROM media WHERE path = ?")
    .get(mediaPath) as { width: number | null; height: number | null } | undefined;
  if (!row || !row.width || !row.height) return null;
  return { width: row.width, height: row.height };
}
