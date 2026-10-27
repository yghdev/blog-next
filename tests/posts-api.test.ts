import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { isolatedDataDir, installTestSession, postPayload, assertIsolatedDataDir } from "./helpers/isolated-db.ts";

const isolated = isolatedDataDir("posts-api-");
process.env.DATA_DIR = isolated.dir;
const dbMod = await import("../lib/db.ts");
const postsRoute = await import("../app/api/admin/posts/route.ts");
const postRoute = await import("../app/api/admin/posts/[id]/route.ts");
const restoreRoute = await import("../app/api/admin/posts/[id]/restore/route.ts");
const bulkRoute = await import("../app/api/admin/posts/bulk/route.ts");
const publicPosts = await import("../lib/posts.ts");

let userId = 0;
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
function request(url: string, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(url, {
    method: init.method ?? "GET",
    ...(init.body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(init.body),
    }),
  });
}
function post(body: unknown) { return request("http://test.local/api/admin/posts", { method: "POST", body }); }
function patch(id: number, body: unknown) { return request("http://test.local/api/admin/posts/" + id, { method: "PATCH", body }); }
function bulk(body: unknown) { return request("http://test.local/api/admin/posts/bulk", { method: "POST", body }); }
function row(id: number): any { return dbMod.getDb().prepare("SELECT * FROM posts WHERE id = ?").get(id); }
async function create(overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await postsRoute.POST(post(postPayload(overrides)));
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  return body.id;
}
before(() => {
  const session = installTestSession(dbMod.getDb());
  userId = session.userId;
});
after(() => {
  (globalThis as any).__blogTestNext.cookies = () => ({ get: () => undefined });
  dbMod.closeDb();
  isolated.cleanup();
});

test("fixture refuses the development database and uses a fresh temporary database", () => {
  assert.throws(() => assertIsolatedDataDir("data"), /isolated temporary/);
  assert.equal(dbMod.dbPath(), isolated.dbPath);
  assert.notEqual(isolated.dbPath, process.cwd() + "\\data\\blog.db");
  assert.equal((dbMod.getDb().prepare("SELECT COUNT(*) c FROM posts").get() as any).c, 0);
  assert.ok(userId > 0);
});

test("admin post API rejects unauthenticated requests without writing", async () => {
  const count = (dbMod.getDb().prepare("SELECT COUNT(*) c FROM posts").get() as any).c;
  (globalThis as any).__blogTestNext.cookies = () => ({ get: () => undefined });
  const res = await postsRoute.POST(post(postPayload()));
  assert.equal(res.status, 401);
  assert.equal((dbMod.getDb().prepare("SELECT COUNT(*) c FROM posts").get() as any).c, count);
  installTestSession(dbMod.getDb());
});

test("POST creates drafts without exposing them through public readers", async () => {
  const id = await create({ slug: "private-draft", title: "Draft only", content: "not public" });
  assert.equal(row(id).status, "draft");
  assert.equal(row(id).published_at, null);
  assert.equal(publicPosts.resolveSlug("private-draft").post, undefined);
  assert.equal(publicPosts.listPosts().some((p) => p.id === id), false);
});

test("publishing preserves Markdown byte-for-byte and sets publication state", async () => {
  const content = ["# Complex", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "```ts", "const x = 1;", "```"].join("\n");
  const id = await create({ slug: "publish-baseline", content });
  const res = await postRoute.PATCH(patch(id, postPayload({ slug: "publish-baseline", content, status: "published" })), params(id));
  assert.equal(res.status, 200, await res.text());
  assert.equal(row(id).content, content);
  assert.equal(row(id).status, "published");
  assert.ok(row(id).published_at);
  assert.equal(publicPosts.getPostBySlug("publish-baseline")?.content, content);
});

test("slug change records an alias and preserves content; slug collision returns 409", async () => {
  await create({ slug: "taken", title: "Taken" });
  const content = "Body\n\nordinary Markdown";
  const id = await create({ slug: "old-slug", content });
  const res = await postRoute.PATCH(patch(id, postPayload({ slug: "new-slug", content, status: "published" })), params(id));
  assert.equal(res.status, 200, await res.text());
  assert.equal(row(id).content, content);
  const alias = publicPosts.resolveSlug("old-slug");
  assert.equal(alias.redirectTo, "new-slug");
  const clash = await postRoute.PATCH(patch(id, postPayload({ slug: "taken", content })), params(id));
  assert.equal(clash.status, 409);
  assert.equal(row(id).slug, "new-slug");
});

test("soft delete hides a post and restore makes it public again", async () => {
  const id = await create({ slug: "trash-baseline", status: "published" });
  const deleted = await postRoute.DELETE(request("http://test.local/api/admin/posts/" + id, { method: "DELETE", body: {} }), params(id));
  assert.equal(deleted.status, 200);
  assert.ok(row(id).deleted_at);
  assert.equal(publicPosts.resolveSlug("trash-baseline").post, undefined);
  const restored = await restoreRoute.POST(request("http://test.local/api/admin/posts/" + id + "/restore", { method: "POST" }), params(id));
  assert.equal(restored.status, 200);
  assert.equal(row(id).deleted_at, null);
  assert.equal(publicPosts.resolveSlug("trash-baseline").post?.id, id);
});

test("bulk publish and unpublish affect only selected rows", async () => {
  const a = await create({ slug: "bulk-a" });
  const b = await create({ slug: "bulk-b" });
  const res = await bulkRoute.POST(bulk({ ids: [a], action: "publish" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, affected: 1 });
  assert.equal(row(a).status, "published");
  assert.equal(row(b).status, "draft");
  const undone = await bulkRoute.POST(bulk({ ids: [a], action: "unpublish" }));
  assert.equal(undone.status, 200);
  assert.equal(row(a).status, "draft");
});

/**
 * KNOWN-DEFECT pins（阶段 00 交付物）。
 *
 * 规则（对应方案 §10 阶段 00 与 §11 验收）：
 *   - 当前缺陷**只记录、不固化**：断言的是"今天确实坏成这样"，不是"以后也该这样"。
 *   - 用 `{ todo: "..." }` 而不是普通 test：node:test 会照常执行函数体，
 *     但失败不把套件判红。等 03 修好之后，这些 pin 会转向通过 —— 到那时应当
 *     连同 todo 标记一起改写成正向契约测试，而不是留着继续跑。
 *   - 每条 pin 的样例必须**真的能触发该缺陷**。这里踩过坑：最初的 trim pin 用了
 *     "Body\n\nordinary Markdown"（首尾没有空白），今天就是通过的，等于什么都没记。
 */
test("KNOWN-DEFECT: current string validation trims significant content whitespace", { todo: "03 preserves canonical Markdown byte-for-byte while keeping field-specific validation" }, async () => {
  // 样例必须带首尾空白：现在的 str() 默认 trim，正是它把正文改写掉
  const content = "\n\n# 标题\n\n正文段落\n\n\n";
  const id = await create({ slug: "trim-defect", content });
  const res = await postRoute.PATCH(patch(id, postPayload({ slug: "trim-defect", content, status: "published" })), params(id));
  /**
   * pin 的是**今天的坏行为**：首尾空白被 trim 掉。
   *
   * 方向很重要 —— 这里断言"内容被改写"，而不是"内容原样保留"。
   * 断言"应该原样保留"会让这条 pin 今天就是红的，等于在用 todo 掩盖一个失败；
   * 而断言"确实被改写"能让它今天为绿、issue 明确，并且在 03 修好之后**转为失败**，
   * 强迫施工者把整条 pin 改写成正向契约（那时应当删除这个 todo 标记）。
   */
  assert.equal(res.status, 200);
  assert.notEqual(row(id).content, content, "当前实现应把首尾空白 trim 掉");
  assert.equal(row(id).content, content.trim(), "当前实现保存的是 trim 之后的正文");
});


test("KNOWN-DEFECT: cover:null currently retains the previous cover", { todo: "03 replaces COALESCE with explicit null semantics" }, async () => {
  const id = await create({ cover: "/images/cover.png" });
  const res = await postRoute.PATCH(patch(id, postPayload({ slug: row(id).slug, cover: null })), params(id));
  assert.equal(res.status, 200);
  assert.equal(row(id).cover, "/images/cover.png");
});


test("KNOWN-DEFECT: PATCH is a full-field overwrite, so a title-only patch silently wipes categories/tags", { todo: "03 splits metadata PATCH (tri-state) from full snapshot writes" }, async () => {
  // 方案 §1.1/§1.2 点名的三个当前缺陷之一：PATCH 是全字段覆盖。
  // 危害不是"字段被清空"本身，而是**返回 200**，调用方以为只是改了标题。
  const id = await create({ slug: "fullfield-defect", categories: ["技术"], tags: ["sqlite", "next"] });
  const before = dbMod.getDb().prepare("SELECT categories, tags FROM posts WHERE id = ?").get(id) as any;
  assert.deepEqual(JSON.parse(before.categories), ["技术"], "前置：分类已写入");
  assert.deepEqual(JSON.parse(before.tags), ["sqlite", "next"], "前置：标签已写入");

  // 只带 title —— 典型"改个标题"的调用
  const res = await postRoute.PATCH(patch(id, { title: "只改标题" }), params(id));
  assert.equal(res.status, 200, "当前实现仍然是 200，不会提示字段被覆盖");

  const after = dbMod.getDb().prepare("SELECT title, categories, tags FROM posts WHERE id = ?").get(id) as any;
  assert.equal(after.title, "只改标题");
  assert.deepEqual(JSON.parse(after.categories), [], "当前实现把未提供的 categories 覆盖成 []");
  assert.deepEqual(JSON.parse(after.tags), [], "当前实现把未提供的 tags 覆盖成 []");
});

test("KNOWN-DEFECT: slug alias write is not transactional with the posts update", { todo: "03 wraps alias + posts update in one transaction" }, async () => {
  // 方案 §1.1 点名的第三个缺陷：别名写入与 posts 更新不在同一事务。
  // 取证方式：用触发器让随后的 UPDATE posts 失败，观察 alias 是否残留。
  // 这是当前实现最真实的事故形态 —— 请求返回 500，但别名已经写进去了，
  // 用户重试时会因为"该路径已被历史别名占用"而得到 409。
  const db = dbMod.getDb();
  const id = await create({ slug: "alias-tx-old", content: "alias tx body" });

  db.exec("CREATE TRIGGER IF NOT EXISTS probe_alias_boom BEFORE UPDATE ON posts BEGIN SELECT RAISE(ABORT, 'probe boom'); END;");
  let status = 0;
  try {
    const res = await postRoute.PATCH(patch(id, postPayload({ slug: "alias-tx-new" })), params(id));
    status = res.status;
  } finally {
    db.exec("DROP TRIGGER IF EXISTS probe_alias_boom");
  }

  assert.equal(status, 500, "UPDATE 失败应表现为服务端错误");
  assert.equal((db.prepare("SELECT slug FROM posts WHERE id = ?").get(id) as any).slug, "alias-tx-old", "文章本身的 slug 未变");
  const alias = db.prepare("SELECT post_id FROM post_aliases WHERE slug = ?").get("alias-tx-old") as any;
  assert.ok(alias, "当前实现：posts 更新失败后，旧 slug 别名仍然残留（未回滚）");
});
