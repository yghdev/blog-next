/**
 * 友链的**纯类型与纯函数**（不带任何 Node 依赖）。
 *
 * 为什么要单独拆一个文件（阶段 02-5 的真实构建失败）：
 * LinksManager 是 "use client" 组件，一旦它 import 自 lib/friend-links.ts，
 * 整个模块（其中 import 了 ./db → better-sqlite3 → node:fs）就会被拉进
 * 浏览器 bundle，构建直接报 "Module not found: Can't resolve 'fs'"。
 * 类型与 isSafeUrl 在两侧都要用，所以放在这里，谁也不依赖谁。
 */

export type FriendLinkKind = "friend" | "hub";

export type FriendLink = {
  id: number;
  name: string;
  url: string;
  desc: string;
  kind: FriendLinkKind;
  sort_order: number;
  visible: number;
  created_at: string;
  updated_at: string;
};

/** 前台展示用的最小字段集（可安全序列化传给客户端组件） */
export type FriendLinkView = Pick<FriendLink, "id" | "name" | "url" | "desc" | "kind">;

export const KIND_LABEL: Record<FriendLinkKind, string> = {
  friend: "友链",
  hub: "聚合",
};

/** 只允许 http/https：外链会被直接渲染成 <a href>，放行 javascript: 等于存储型 XSS */
const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

export function isSafeUrl(url: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
