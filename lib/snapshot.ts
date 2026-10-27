/**
 * 快照规范化与哈希（方案 §4.1）。
 *
 * 硬性约束（方案 §3.4 明确要求，别改）：
 *   - `canonicalize()` 与 `hashSnapshot()` 必须是**同步纯函数**：
 *     不依赖 await、浏览器、请求上下文或 next/*，这样才能被
 *     迁移（lib/migrations.ts）、接口（app/api/...）和运维脚本共同加载。
 *   - categories/tags **保留顺序**，不为了哈希而排序 —— 顺序是用户输入的一部分。
 *   - title/content 不在哈希阶段暗中 trim。若产品要清理标题，先由校验层生成
 *     最终保存值，再进快照。否则"存进去的"和"算哈希的"不是同一份东西。
 *   - 哈希输入必须**等于**数据库实际保存的 snapshot_json。
 *     所以这里的设计是：canonicalize 出字符串，对**这同一个字符串**求 hash。
 *   - 服务端永远重新 canonicalize 并计算 hash；客户端 hash 仅用于核对，
 *     不一致返回 400，绝不信任。
 */

import { createHash } from "node:crypto";

export type SnapshotType = "post" | "page" | "shuoshuo";

export type Snapshot = {
  type: SnapshotType;
  title: string;
  slug: string;
  content: string;
  cover: string | null;
  categories: string[];
  tags: string[];
  comments_enabled: 0 | 1;
};

/** 字段顺序固定，不依赖对象字面量的插入顺序（那是实现细节，不是契约） */
const FIELD_ORDER: (keyof Snapshot)[] = [
  "type",
  "title",
  "slug",
  "content",
  "cover",
  "categories",
  "tags",
  "comments_enabled",
];

/**
 * 生成规范化 JSON 字符串。
 *
 * 唯一允许的"规范化"是**字段顺序固定**与**值类型归一**；
 * 不 trim、不排序数组、不丢字段、不省略 null —— 任何"顺手清理"都会让
 * 哈希口径与真实保存内容产生偏差，而那种偏差在 10 次自动保存之后才会暴露。
 */
export function canonicalize(snapshot: Snapshot): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) ordered[key] = snapshot[key];
  return JSON.stringify(ordered);
}

/** SHA-256（十六进制）。输入必须是 canonicalize 的**返回值本身**。 */
export function hashSnapshot(canonicalJson: string): string {
  // node:crypto 是内置模块，顶层静态导入在 ESM 与 CJS 下都可用，
  // 且 createHash 是同步的 —— 迁移脚本、接口、测试都能直接调用。
  // 不用 Web Crypto（crypto.subtle）因为它只有异步 API，会破坏"同步纯函数"约束。
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

/** canonicalize + hash 一步到位（调用方几乎总是两个都要） */
export function snapshotIdentity(snapshot: Snapshot): { snapshotJson: string; snapshotHash: string } {
  const snapshotJson = canonicalize(snapshot);
  return { snapshotJson, snapshotHash: hashSnapshot(snapshotJson) };
}

export type ParseResult = { ok: true; snapshot: Snapshot } | { ok: false; error: string };

const TYPES: SnapshotType[] = ["post", "page", "shuoshuo"];

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/**
 * 校验并归一客户端提交的完整快照。
 *
 * 方案 §4.1：草稿 PUT 使用完整快照，**必填字段缺失返回 400** ——
 * 避免"缺省"被不同接口解释成不同含义。
 *
 * 注意这里刻意**不做 trim**（校验层是否 trim 由调用方明确决定并传入已清理的值），
 * 只做类型与范围检查。
 */
export function parseSnapshot(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "快照必须是对象" };
  const o = raw as Record<string, unknown>;

  const type = o.type;
  if (typeof type !== "string" || !TYPES.includes(type as SnapshotType)) {
    return { ok: false, error: "快照 type 必须是 post / page / shuoshuo 之一" };
  }
  for (const field of ["title", "slug", "content"] as const) {
    if (typeof o[field] !== "string") return { ok: false, error: "快照缺少字段 " + field + "（必须是字符串）" };
  }
  // cover：必须显式出现，允许 null。缺省不等于 null —— 那会让"清除封面"无法表达。
  if (!("cover" in o)) return { ok: false, error: "快照缺少字段 cover（可为 null）" };
  if (o.cover !== null && typeof o.cover !== "string") return { ok: false, error: "快照 cover 必须是字符串或 null" };

  const categories = asStringArray(o.categories);
  if (!categories) return { ok: false, error: "快照 categories 必须是字符串数组" };
  const tags = asStringArray(o.tags);
  if (!tags) return { ok: false, error: "快照 tags 必须是字符串数组" };

  if (o.comments_enabled !== 0 && o.comments_enabled !== 1) {
    return { ok: false, error: "快照 comments_enabled 必须是 0 或 1" };
  }

  return {
    ok: true,
    snapshot: {
      type: type as SnapshotType,
      title: o.title as string,
      slug: o.slug as string,
      content: o.content as string,
      cover: o.cover as string | null,
      categories,
      tags,
      comments_enabled: o.comments_enabled as 0 | 1,
    },
  };
}

/** 安全解析库里的 JSON 数组（脏数据不抛错，降级为 []）——迁移与接口共用 */
export function safeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x));
  } catch {
    return [];
  }
}
