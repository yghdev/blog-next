import { getDb } from "./db";
import { parseVariants, type Variants } from "./image-variants";

/**
 * 按路径查媒体元信息（F9 / C3，2026-11-08）。
 *
 * 用途有两个：
 *   1. 给 `<img>` 补 `width`/`height`，让浏览器在图片下载完成前就按正确比例
 *      预留空间 —— 否则图片加载完会把正文整体往下推，就是 CLS；
 *   2. 给 `<img>` 补 `srcset`，让浏览器按视口挑 640/960/1280 里合适的一档。
 *
 * 为什么查库而不是在 URL 里带尺寸：图片可能是本机 `/images/...`，也可能是
 * 七牛 CDN 直链，URL 形态不统一；而 `media` 表在上传时已经记录了宽高与变体，
 * 是唯一可靠来源。
 *
 * 查不到就返回 null，调用方**不要**编一个默认比例 —— 猜错的比例比不预留更糟
 * （图片会被拉伸或裁切）。
 */
export type MediaMeta = {
  width: number | null;
  height: number | null;
  variants: Variants;
};

export function mediaMetaByPath(mediaPath: string): MediaMeta | null {
  if (!mediaPath) return null;
  const row = getDb()
    .prepare("SELECT width, height, variants FROM media WHERE path = ?")
    .get(mediaPath) as { width: number | null; height: number | null; variants: string } | undefined;
  if (!row) return null;
  return {
    width: row.width ?? null,
    height: row.height ?? null,
    variants: parseVariants(row.variants),
  };
}

/**
 * 批量查（一篇文章里的所有图片一次查完）。
 *
 * 为什么批量：正文可能有十几张图，逐张查就是十几次 SQLite 往返；
 * 一次 `IN (...)` 拿全，渲染路径上只多一次查询。
 *
 * 返回数组而不是 Map：`unstable_cache` 会把结果序列化，Map 过一趟就变成 `{}`。
 */
export function mediaMetaByPaths(paths: string[]): [string, MediaMeta][] {
  const uniq = [...new Set(paths.filter(Boolean))];
  if (uniq.length === 0) return [];
  const placeholders = uniq.map(() => "?").join(",");
  const rows = getDb()
    .prepare("SELECT path, width, height, variants FROM media WHERE path IN (" + placeholders + ")")
    .all(...uniq) as { path: string; width: number | null; height: number | null; variants: string }[];
  return rows.map((r) => [
    r.path,
    { width: r.width ?? null, height: r.height ?? null, variants: parseVariants(r.variants) },
  ]);
}
