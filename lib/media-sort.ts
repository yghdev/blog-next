/**
 * 媒体库排序：白名单 + SQL 片段（服务端与客户端共用）。
 *
 * 为什么单独一层：
 *   排序键来自 URL（?sort=largest），**绝不能**拼进 SQL。这里用一张
 *   固定表把「用户可见的排序名」映射到唯一的 ORDER BY 片段，页面只允许
 *   从表里取值，未知值一律退回默认排序。
 *
 * 四个维度对应两类真实动作：
 *   · 时间：清理陈旧文件（oldest）
 *   · 体积：定位大文件（largest / smallest）
 * 默认仍是最新上传，保持既有行为不变。
 */
export const MEDIA_SORTS = [
  { key: "newest", label: "最新上传", order: "m.created_at DESC, m.id DESC" },
  { key: "oldest", label: "最早上传", order: "m.created_at ASC, m.id ASC" },
  { key: "largest", label: "文件最大", order: "m.size DESC, m.id DESC" },
  { key: "smallest", label: "文件最小", order: "m.size ASC, m.id ASC" },
] as const;

export type MediaSort = (typeof MEDIA_SORTS)[number]["key"];

export const DEFAULT_MEDIA_SORT: MediaSort = "newest";

export function normalizeMediaSort(raw: string | undefined | null): MediaSort {
  return MEDIA_SORTS.some((s) => s.key === raw) ? (raw as MediaSort) : DEFAULT_MEDIA_SORT;
}

/** 只返回白名单里的 ORDER BY；调用方只应把它拼在 SELECT 末尾。 */
export function mediaOrderSql(sort: MediaSort): string {
  return MEDIA_SORTS.find((s) => s.key === sort)?.order ?? MEDIA_SORTS[0].order;
}

export function mediaSortLabel(sort: MediaSort): string {
  return MEDIA_SORTS.find((s) => s.key === sort)?.label ?? MEDIA_SORTS[0].label;
}
