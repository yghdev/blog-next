/**
 * 分类 / 标签的候选项（编辑器自动补全用）。
 *
 * 为什么不在前端硬编码「学习 / AI / 部署 / 工具」：
 * 那是示意图里的示例数据，写进业务后会让编辑器给出站内根本不存在的分类。
 * 候选必须来自真实内容 —— 这里直接扫 posts 里已有的 JSON 数组，
 * 按出现次数排序（常用的先出现），脏数据走 parseJsonArray 降级为 []。
 *
 * 只读、不写库；后台页面本来就是 force-dynamic，多这一条查询的代价可忽略。
 */
import { getDb } from "./db";
import { parseJsonArray } from "./posts";

export type Facet = { name: string; count: number };

export type PostFacets = {
  categories: Facet[];
  tags: Facet[];
};

const LIMIT = 60;

function tally(rows: { value: string }[]): Facet[] {
  const counter = new Map<string, number>();
  for (const row of rows) {
    for (const raw of parseJsonArray(row.value)) {
      const name = raw.trim();
      if (!name) continue;
      counter.set(name, (counter.get(name) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, LIMIT)
    .map(([name, count]) => ({ name, count }));
}

export function getPostFacets(): PostFacets {
  const rows = getDb()
    .prepare("SELECT categories AS value, tags FROM posts WHERE deleted_at IS NULL")
    .all() as { value: string; tags: string }[];
  return {
    categories: tally(rows.map((r) => ({ value: r.value }))),
    tags: tally(rows.map((r) => ({ value: r.tags }))),
  };
}
