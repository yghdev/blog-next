import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedDataDir } from "./helpers/isolated-db.ts";

/**
 * 后台搜索测试（阶段 04）。
 *
 * 重点验三件容易做错的事：
 *   1. 必须能搜到**草稿标题**（新文章是壳，posts.title 为空，真实标题在草稿快照里）
 *   2. 必须**排除回收站**（要删的内容不该在"找东西"时冒出来）
 *   3. 必须**不返回正文**（命令面板只需要定位信息）
 */

const isolated = isolatedDataDir("admin-search-");
process.env.DATA_DIR = isolated.dir;
const dbMod = await import("../lib/db.ts");
const searchMod = await import("../lib/admin-search.ts");

function insert(opts: {
  type?: string; title?: string; slug: string; content?: string;
  status?: string; deletedAt?: string | null;
}): number {
  const db = dbMod.getDb();
  const info = db.prepare(
    "INSERT INTO posts (type, title, slug, content, excerpt, status, categories, tags, deleted_at, revision) " +
    "VALUES (?, ?, ?, ?, '', ?, '[]', '[]', ?, 1)"
  ).run(
    opts.type ?? "post",
    opts.title ?? "",
    opts.slug,
    opts.content ?? "正文内容",
    opts.status ?? "draft",
    opts.deletedAt ?? null
  );
  return Number(info.lastInsertRowid);
}

function insertDraft(postId: number, title: string, content = "草稿正文"): void {
  const db = dbMod.getDb();
  const snap = JSON.stringify({
    type: "post", title, slug: "x", content,
    cover: null, categories: [], tags: [], comments_enabled: 1,
  });
  db.prepare(
    "INSERT INTO post_drafts (post_id, client_draft_id, owner_user_id, base_revision, draft_revision, snapshot_json, snapshot_hash, created_at, updated_at, updated_by) " +
    "VALUES (?, ?, NULL, 1, 1, ?, 'h', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)"
  ).run(postId, "cid-" + postId, snap);
}

function search(q: string, opts: { type?: "post" | "page" | "shuoshuo" | "" } = {}) {
  return searchMod.adminSearch(dbMod.getDb(), q, { limit: 20, type: opts.type ?? "" });
}

test("搜索能匹配 posts 标题", () => {
  insert({ title: "Next 部署笔记", slug: "next-deploy", status: "published" });
  const hits = search("部署");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "Next 部署笔记");
  assert.equal(hits[0].matchedIn, "title");
});

test("搜索能匹配草稿标题（新文章是壳，标题只在快照里）", () => {
  // 壳：title 为空
  const id = insert({ title: "", slug: "draft-shell-abc", status: "draft" });
  insertDraft(id, "我刚刚写的标题");

  const hits = search("刚刚写的");
  assert.equal(hits.length, 1, "必须能搜到草稿标题，否则'找刚写的内容'这个主要用法就废了");
  assert.equal(hits[0].title, "我刚刚写的标题", "展示草稿标题而不是壳的空标题");
  assert.equal(hits[0].hasDraft, true);
  assert.equal(hits[0].matchedIn, "draft", "要能说明是草稿标题命中的");
});

test("搜索能匹配 slug", () => {
  insert({ title: "无关标题", slug: "unique-slug-xyz", status: "published" });
  const hits = search("unique-slug");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matchedIn, "slug");
});

test("回收站内容一律不出现", () => {
  insert({ title: "已删除的文章", slug: "deleted-one", deletedAt: "2026-01-01T00:00:00Z" });
  const hits = search("已删除");
  assert.equal(hits.length, 0, "回收站内容不得出现在搜索结果里");
});

test("覆盖文章/页面/说说三种类型", () => {
  insert({ type: "post", title: "三类测试-文章", slug: "t-post", status: "published" });
  insert({ type: "page", title: "三类测试-页面", slug: "t-page", status: "published" });
  insert({ type: "shuoshuo", title: "三类测试-说说", slug: "t-shuo", status: "published" });

  const hits = search("三类测试");
  assert.equal(hits.length, 3);
  const types = hits.map((h) => h.type).sort();
  assert.deepEqual(types, ["page", "post", "shuoshuo"]);
});

test("按类型过滤只返回该类型", () => {
  const hits = search("三类测试", { type: "page" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, "page");
});

test("不返回正文（命令面板只需要定位信息）", () => {
  insert({ title: "正文泄露检查", slug: "no-body-leak", content: "这段正文不应该出现在结果里", status: "published" });
  const hits = search("正文泄露");
  assert.equal(hits.length, 1);
  const serialized = JSON.stringify(hits[0]);
  assert.doesNotMatch(serialized, /这段正文不应该出现在结果里/, "结果里不得含正文");
});

test("LIKE 通配符被转义：搜 % 不会匹配全库", () => {
  insert({ title: "文章A", slug: "a1", status: "published" });
  insert({ title: "文章B", slug: "a2", status: "published" });
  const hits = search("%");
  assert.equal(hits.length, 0, "裸 % 必须被转义成字面量，否则等于全表扫描");
});

test("空查询返回空数组而不是报错", () => {
  assert.deepEqual(search(""), []);
  assert.deepEqual(search("   "), []);
});

test("结果按 updated_at 倒序（找'我刚改的'）", () => {
  const db = dbMod.getDb();
  const id1 = insert({ title: "排序测试一", slug: "order-1", status: "published" });
  const id2 = insert({ title: "排序测试二", slug: "order-2", status: "published" });
  db.prepare("UPDATE posts SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(id1);
  db.prepare("UPDATE posts SET updated_at = '2026-06-01T00:00:00Z' WHERE id = ?").run(id2);

  const hits = search("排序测试");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].slug, "order-2", "最近更新的应排在最前");
});

test("limit 有上限，防止一次拉太多", () => {
  for (let i = 0; i < 60; i++) {
    insert({ title: "批量标题 " + i, slug: "bulk-" + i, status: "published" });
  }
  const hits = searchMod.adminSearch(dbMod.getDb(), "批量标题", { limit: 999 });
  assert.ok(hits.length <= 50, "limit 应被钳制在 50 以内，实际 " + hits.length);
});

test("未命名内容有可读的兜底标题", () => {
  insert({ title: "", slug: "untitled-check", status: "draft" });
  const hits = search("untitled-check");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "(未命名)", "空标题应显示兜底文案而不是空白");
});
