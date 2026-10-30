import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolatedDataDir } from "./helpers/isolated-db.ts";

/**
 * 媒体批量操作的数据层（阶段 02-6）。
 *
 * 这里盯的都是「界面上看不出来、但会静默弄坏数据」的点：
 *   1. 排序键来自 URL，必须走白名单，未知值退回默认 —— 不能拼进 SQL。
 *   2. 迁移必须**同时**改写 posts、post_drafts 与 media.path；
 *      漏掉任何一处，正文就指向一个已经不存在的本机路径（裂图）。
 *   3. 历史版本不可变：迁移不能改 post_revisions，因此本机原文件要保留。
 *   4. 每条被改写的文章 revision 恰好 +1（并发检查依赖它）。
 *   5. 已在 CDN 上的图再迁移必须失败，而不是覆盖成第二条记录。
 */

const isolated = isolatedDataDir("media-ops-");
const uploadRoot = path.join(isolated.dir, "uploads");
fs.mkdirSync(path.join(uploadRoot, "2026", "10"), { recursive: true });
process.env.UPLOAD_DIR = uploadRoot;

const dbMod = await import("../lib/db.ts");
const storage = await import("../lib/storage.ts");
const ops = await import("../lib/media-ops.ts");
const sortMod = await import("../lib/media-sort.ts");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const actor = { userId: 1, userName: "ops-test", ip: "127.0.0.1", userAgent: "node-test" };
const realFetch = globalThis.fetch;

function useCdnConfig(domain = "https://cdn.test.local") {
  storage.writeStorageConfig({
    accessKeyId: "AK_TEST", secretAccessKey: "SK_TEST", bucket: "bucket-test",
    endpoint: "https://s3.cn-south-1.qiniucs.com", region: "cn-south-1",
    pathStyle: false, cdnDomain: domain,
  });
}

/** 只拦七牛 S3 的 PUT/DELETE；其余请求保持原样（本测试不发别的请求） */
function stubQiniu(writes: { key: string }[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("qiniucs.com")) {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        const key = new URL(url).pathname.replace(/^\/bucket-test\//, "");
        writes.push({ key });
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 204 });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

before(() => { useCdnConfig(); });
after(() => { globalThis.fetch = realFetch; isolated.cleanup(); });

function freshDb() {
  dbMod.closeDb();
  const db = dbMod.getDb();
  // 审计表对 actor_user_id 有外键（ON DELETE SET NULL），测试里的 actor 必须真实存在
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, totp_enabled, role, created_at) " +
    "VALUES (1, 'ops-test', 'x', 0, 'admin', ?)"
  ).run(new Date().toISOString());
  return db;
}

function insertPost(db: ReturnType<typeof dbMod.getDb>, input: {
  slug: string; content: string; cover?: string | null; status?: "draft" | "published";
}) {
  const now = new Date().toISOString();
  const info = db.prepare(
    "INSERT INTO posts (type, title, slug, content, cover, status, created_at, updated_at, revision) " +
    "VALUES ('post', ?, ?, ?, ?, ?, ?, ?, 1)"
  ).run(input.slug, input.slug, input.content, input.cover ?? null, input.status ?? "published", now, now);
  return Number(info.lastInsertRowid);
}

test("排序白名单：合法键命中，非法值退回默认（不把 URL 拼进 SQL）", () => {
  assert.equal(sortMod.normalizeMediaSort("largest"), "largest");
  assert.equal(sortMod.normalizeMediaSort("smallest"), "smallest");
  assert.equal(sortMod.normalizeMediaSort("oldest"), "oldest");
  assert.equal(sortMod.normalizeMediaSort("newest"), "newest");

  // 注入尝试必须落到默认值，且返回的订单片段是固定常量
  for (const evil of ["size; DROP TABLE media--", "created_at DESC, (SELECT 1)", "", undefined, null]) {
    assert.equal(sortMod.normalizeMediaSort(evil as string | undefined), "newest", "非法排序值应退回默认：" + String(evil));
  }
  assert.equal(sortMod.mediaOrderSql("newest"), "m.created_at DESC, m.id DESC");
  assert.ok(!sortMod.mediaOrderSql("largest").includes(";"), "ORDER BY 片段不得含分号");
});

test("引用计数：只统计未删除文章", () => {
  const db = freshDb();
  const used = insertPost(db, { slug: "ref-a", content: "![x](/images/2026/10/used.png)" });
  insertPost(db, { slug: "ref-b", content: "另一篇也用了 ![x](/images/2026/10/used.png)" });
  const trashed = insertPost(db, { slug: "ref-c", content: "![x](/images/2026/10/used.png)" });
  db.prepare("UPDATE posts SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), trashed);

  assert.equal(ops.countMediaRefs(db, "/images/2026/10/used.png"), 2, "回收站里的文章不应算作引用");
  assert.equal(ops.countMediaRefs(db, "/images/2026/10/unused.png"), 0);
  assert.ok(used > 0);
  db.close();
});

test("删除：本机文件与 media 行一起移除，文件已丢失也不阻塞删记录", async () => {
  const db = freshDb();
  const rel = "2026/10/del-me.png";
  fs.writeFileSync(path.join(uploadRoot, rel), PNG);
  const info = db.prepare(
    "INSERT INTO media (path, filename, mime, size, width, height) VALUES (?, 'del-me.png', 'image/png', ?, 1, 1)"
  ).run("/images/" + rel, PNG.length);
  const row = db.prepare("SELECT * FROM media WHERE id = ?").get(Number(info.lastInsertRowid)) as any;

  await ops.deleteMedia(db, row);
  assert.equal(fs.existsSync(path.join(uploadRoot, rel)), false, "磁盘文件应被删除");
  assert.equal(db.prepare("SELECT id FROM media WHERE id = ?").get(row.id), undefined, "media 行应被删除");

  // 文件本来就不在：仍要能清掉记录（否则会留下永远删不掉的假记录）
  const info2 = db.prepare(
    "INSERT INTO media (path, filename, mime, size) VALUES ('/images/2026/10/ghost.png', 'ghost.png', 'image/png', 1)"
  ).run();
  const ghost = db.prepare("SELECT * FROM media WHERE id = ?").get(Number(info2.lastInsertRowid)) as any;
  await ops.deleteMedia(db, ghost);
  assert.equal(db.prepare("SELECT id FROM media WHERE id = ?").get(ghost.id), undefined);
  db.close();
});

test("迁移：正文 / 封面 / 草稿 / media.path 同步改写，revision +1，历史不动", async () => {
  const db = freshDb();
  useCdnConfig();
  const writes: { key: string }[] = [];
  stubQiniu(writes);

  const rel = "2026/10/migrate-me.png";
  fs.writeFileSync(path.join(uploadRoot, rel), PNG);
  const oldPath = "/images/" + rel;

  const postId = insertPost(db, {
    slug: "migrate-a",
    content: "# T\n\n![x](" + oldPath + ")\n\n尾部文字",
    cover: oldPath,
  });
  const otherId = insertPost(db, { slug: "migrate-b", content: "没用这张图" });

  // 服务端草稿也引用了这条路径
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO post_drafts (post_id, client_draft_id, owner_user_id, base_revision, draft_revision, snapshot_json, snapshot_hash, created_at, updated_at) " +
    "VALUES (?, 'cid-migrate', NULL, 1, 3, ?, 'hash-placeholder', ?, ?)"
  ).run(otherId, JSON.stringify({
    type: "post", title: "草稿", slug: "migrate-b", content: "草稿里也用了 ![](" + oldPath + ")",
    cover: null, categories: [], tags: [], comments_enabled: 1,
  }), now, now);

  // 历史版本（不可变）：迁移不得改写它
  db.prepare(
    "INSERT INTO post_revisions (post_id, revision, snapshot_json, snapshot_hash, reason, created_at) " +
    "VALUES (?, 1, ?, 'h', 'baseline', ?)"
  ).run(postId, JSON.stringify({ content: "历史里是 " + oldPath }), now);

  const mediaInfo = db.prepare(
    "INSERT INTO media (path, filename, mime, size, width, height) VALUES (?, 'migrate-me.png', 'image/png', ?, 1, 1)"
  ).run(oldPath, PNG.length);
  const row = db.prepare("SELECT * FROM media WHERE id = ?").get(Number(mediaInfo.lastInsertRowid)) as any;

  const result = await ops.migrateLocalToCdn(db, row, actor);
  assert.equal(result.posts, 1, "应只改写真正引用到它的那篇文章");
  assert.equal(result.drafts, 1, "草稿快照也应改写");
  assert.ok(result.to.startsWith("https://cdn.test.local/"), "新地址应是 CDN 直链：" + result.to);
  assert.equal(writes.length, 1, "应向七牛写入一个对象");

  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as any;
  assert.ok(!post.content.includes(oldPath), "正文里的旧路径必须被替换");
  assert.ok(post.content.includes(result.to), "正文应指向 CDN 直链");
  assert.ok(post.content.includes("尾部文字"), "替换不能吞掉其余正文");
  assert.equal(post.cover, result.to, "封面也要迁移");
  assert.equal(post.revision, 2, "被改写的文章 revision 恰好 +1");

  const untouched = db.prepare("SELECT * FROM posts WHERE id = ?").get(otherId) as any;
  assert.equal(untouched.revision, 1, "没引用这张图的文章不得被碰");

  const draft = db.prepare("SELECT * FROM post_drafts WHERE post_id = ?").get(otherId) as any;
  assert.ok(draft.snapshot_json.includes(result.to), "草稿快照应指向新地址");
  assert.equal(draft.draft_revision, 4, "草稿 revision 应 +1（让编辑器重新加载）");

  const revision = db.prepare("SELECT snapshot_json FROM post_revisions WHERE post_id = ? AND revision = 1").get(postId) as any;
  assert.ok(revision.snapshot_json.includes(oldPath), "历史版本是不可变档案，不能被迁移改写");

  const mediaRow = db.prepare("SELECT * FROM media WHERE id = ?").get(row.id) as any;
  assert.equal(mediaRow.path, result.to, "media 记录的 path 必须指向新地址");

  assert.ok(fs.existsSync(path.join(uploadRoot, rel)), "本机原文件要保留：历史版本仍需要它，迁移因此可回退");

  const audit = db.prepare("SELECT action FROM audit_log WHERE action = 'media.migrate'").get() as any;
  assert.ok(audit, "迁移必须留审计");
  db.close();
});

test("迁移：已在 CDN 的图直接拒绝，不产生第二条记录", async () => {
  const db = freshDb();
  useCdnConfig();
  const info = db.prepare(
    "INSERT INTO media (path, filename, mime, size) VALUES ('https://cdn.test.local/2026/10/already.png', 'already.png', 'image/png', 10)"
  ).run();
  const row = db.prepare("SELECT * FROM media WHERE id = ?").get(Number(info.lastInsertRowid)) as any;
  await assert.rejects(() => ops.migrateLocalToCdn(db, row, actor), /已经在 CDN 上/);
  db.close();
});

test("迁移：本机文件缺失时给出可行动的报错，而不是 500 空话", async () => {
  const db = freshDb();
  useCdnConfig();
  const info = db.prepare(
    "INSERT INTO media (path, filename, mime, size) VALUES ('/images/2026/10/missing.png', 'missing.png', 'image/png', 10)"
  ).run();
  const row = db.prepare("SELECT * FROM media WHERE id = ?").get(Number(info.lastInsertRowid)) as any;
  await assert.rejects(() => ops.migrateLocalToCdn(db, row, actor), /找不到原文件/);
  db.close();
});
