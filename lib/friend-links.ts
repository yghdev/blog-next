import { getDb } from "./db";
import { isSafeUrl, KIND_LABEL, type FriendLink, type FriendLinkKind, type FriendLinkView } from "./friend-links-shared";

/**
 * 友链 / 聚合外链（2026-10-23）。
 *
 * 背景：settings.friend_links 早就存在，但**全库 0 处渲染** —— 后台能填一段自由文本，
 * 前台却没任何地方展示。改成独立表后：一行一条外链，可在后台逐条增删改、拖排序、开关显隐。
 *
 * 分类（kind）：
 *   friend —— 友链（个人博客互链）
 *   hub    —— 聚合站（如「开往」这类友链接力/聚合导航）
 * 两者在侧栏分区展示，互不混淆。
 *
 * 2026-10-27（阶段 02-5）：类型与 isSafeUrl/KIND_LABEL 搬到了
 * ./friend-links-shared —— 本文件 import 了 ./db（better-sqlite3 → node:fs），
 * 客户端组件不能引它。这里保留 re-export，避免改动既有调用方。
 */
export type { FriendLink, FriendLinkKind, FriendLinkView };
export { isSafeUrl, KIND_LABEL };

/**
 * 全量列表（后台用，含隐藏项）。
 * 排序：sort_order 升序 → id 升序，保证同 sort_order 时顺序稳定不抖动。
 */
export function listFriendLinks(): FriendLink[] {
  return getDb()
    .prepare("SELECT * FROM friend_links ORDER BY sort_order ASC, id ASC")
    .all() as FriendLink[];
}

/**
 * 前台展示用（只取 visible=1）。
 * 读库前先把不安全的历史脏数据过滤掉 —— 避免一条脏 URL 让整块侧栏失效。
 */
export function listVisibleFriendLinks(): FriendLink[] {
  return listFriendLinks().filter((l) => l.visible === 1 && isSafeUrl(l.url));
}

export function getFriendLink(id: number): FriendLink | undefined {
  return getDb().prepare("SELECT * FROM friend_links WHERE id = ?").get(id) as FriendLink | undefined;
}

export type FriendLinkInput = {
  name: string;
  url: string;
  desc?: string;
  kind?: FriendLinkKind;
  sort_order?: number;
  visible?: boolean;
};

export function createFriendLink(input: FriendLinkInput): number {
  const info = getDb()
    .prepare(
      "INSERT INTO friend_links (name, url, desc, kind, sort_order, visible) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.name,
      input.url,
      input.desc ?? "",
      input.kind ?? "friend",
      input.sort_order ?? 100,
      input.visible === false ? 0 : 1
    );
  return Number(info.lastInsertRowid);
}

export function updateFriendLink(id: number, input: FriendLinkInput): void {
  getDb()
    .prepare(
      "UPDATE friend_links SET name = ?, url = ?, desc = ?, kind = ?, sort_order = ?, visible = ?," +
        " updated_at = datetime('now') WHERE id = ?"
    )
    .run(
      input.name,
      input.url,
      input.desc ?? "",
      input.kind ?? "friend",
      input.sort_order ?? 100,
      input.visible === false ? 0 : 1,
      id
    );
}

export function deleteFriendLink(id: number): void {
  getDb().prepare("DELETE FROM friend_links WHERE id = ?").run(id);
}

export const FRIEND_LINK_DEFAULTS: FriendLinkInput[] = [
  { name: "开往", url: "https://www.travellings.cn/go.html", desc: "友链接力 · 随机去往一个陌生博客", kind: "hub", sort_order: 10 },
];
