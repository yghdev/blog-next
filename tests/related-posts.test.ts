import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 相关文章（F11，2026-11-07）的集成测试：真实 SQLite。
 *
 * 必须独立成文件：lib/db.ts 的 getDb() 是进程级单例，与其它测试同文件会
 * 沿用已被前序用例初始化的库。这里在任何 lib 动态导入之前先把 DATA_DIR
 * 指向临时目录（与 search-integration.test.ts 同一套做法）。
 */
const TMP_ROOT = path.join(process.cwd(), ".tmp-tests");
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, "related-"));
process.env.DATA_DIR = TMP;

const dbMod = await import("../lib/db.ts");
const postsMod = await import("../lib/posts.ts");
const timeMod = await import("../lib/time.ts");

function insertPost(opts: {
  slug: string; title: string; categories?: string[]; tags?: string[]; at?: string;
}) {
  const db = dbMod.getDb();
  const at = opts.at ?? timeMod.nowIso();
  db.prepare(
    "INSERT INTO posts (type, slug, title, content, categories, tags, status, published_at, created_at, updated_at) " +
    "VALUES ('post', ?, ?, ?, ?, ?, 'published', ?, ?, ?)"
  ).run(
    opts.slug, opts.title, "正文 " + opts.title,
    JSON.stringify(opts.categories ?? []), JSON.stringify(opts.tags ?? []),
    at, at, at
  );
}

test("相关文章：同分类 +2、同标签 +1，按分数排序", () => {
  insertPost({ slug: "r-self", title: "自己", categories: ["AI"], tags: ["deepseek"] });
  insertPost({ slug: "r-both", title: "同分类同标签", categories: ["AI"], tags: ["deepseek"] });
  insertPost({ slug: "r-cat", title: "只同分类", categories: ["AI"], tags: ["其它"] });
  insertPost({ slug: "r-tag", title: "只同标签", categories: ["生活"], tags: ["deepseek"] });
  insertPost({ slug: "r-none", title: "都不同", categories: ["生活"], tags: ["随笔"] });

  const self = postsMod.getPostBySlug("r-self")!;
  const related = postsMod.relatedPosts(self, 3);
  const slugs = related.map((p) => p.slug);

  assert.equal(slugs[0], "r-both", "同分类+同标签应排第一，实际：" + slugs.join(","));
  assert.equal(slugs.includes("r-self"), false, "不得包含自己");
  assert.equal(slugs.includes("r-none"), false, "毫无共同点的不得进结果");
  assert.equal(related.length, 3, "最多 3 篇");
});

test("相关文章：没有分类也没有标签时返回空数组（不拿最新文章冒充相关）", () => {
  insertPost({ slug: "r-bare", title: "无分类无标签" });
  insertPost({ slug: "r-other", title: "有分类", categories: ["AI"] });
  const bare = postsMod.getPostBySlug("r-bare")!;
  assert.deepEqual(postsMod.relatedPosts(bare, 3), []);
});

test("相关文章：草稿与回收站不出现", () => {
  insertPost({ slug: "r-draft", title: "草稿", categories: ["AI"] });
  dbMod.getDb().prepare("UPDATE posts SET status = 'draft' WHERE slug = 'r-draft'").run();
  insertPost({ slug: "r-trash", title: "回收站", categories: ["AI"] });
  dbMod.getDb().prepare("UPDATE posts SET deleted_at = ? WHERE slug = 'r-trash'").run(timeMod.nowIso());

  const self = postsMod.getPostBySlug("r-self")!;
  const slugs = postsMod.relatedPosts(self, 10).map((p) => p.slug);
  assert.equal(slugs.includes("r-draft"), false, "草稿不得出现");
  assert.equal(slugs.includes("r-trash"), false, "回收站不得出现");
});

test("cleanup", () => {
  dbMod.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});
