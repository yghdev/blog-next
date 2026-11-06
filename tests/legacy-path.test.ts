import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { isolatedDataDir } from "./helpers/isolated-db.ts";

/**
 * 旧 WordPress 日期路径的解析与匹配（2026-11-06 新增）。
 *
 * 两段被测逻辑必须分开验证：
 *   1) `classifyLegacySegments` 是纯解析 —— 不碰库，能穷举各种畸形段
 *   2) `resolveLegacyPath` 要查库 —— 精确 / wp_id / 别名 / 唯一前缀四条路径
 *
 * 「唯一前缀」这条尤其要测**多义必须 404**：旧 slug 只剩 `ai`、`博客` 这种
 * 短前缀时，猜错文章比 404 更糟（会把访客送到另一篇文章上，还污染统计）。
 */

const isolated = isolatedDataDir("legacy-path-");
process.env.DATA_DIR = isolated.dir;
const dbMod = await import("../lib/db.ts");
const { classifyLegacySegments, resolveLegacyPath, findPostByLegacySlug } = await import(
  "../lib/legacy-path.ts"
);

let db: ReturnType<typeof dbMod.getDb>;

function insertPost(row: {
  id?: number;
  slug: string;
  title?: string;
  type?: "post" | "page";
  status?: "draft" | "published";
  wpId?: number | null;
  deletedAt?: string | null;
}) {
  const info = db
    .prepare(
      "INSERT INTO posts (type, title, slug, content, status, wp_id, published_at, deleted_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .run(
      row.type ?? "post",
      row.title ?? row.slug,
      row.slug,
      "",
      row.status ?? "published",
      row.wpId ?? null,
      "2026-06-07T14:13:00.000Z",
      row.deletedAt ?? null
    );
  return Number(info.lastInsertRowid);
}

before(() => {
  db = dbMod.getDb();
  insertPost({ slug: "imghub图床", wpId: 29 });
  insertPost({ slug: "ai做了个部落冲突管理网站", wpId: 42 });
  insertPost({ slug: "十大经典排序算法", wpId: 151 });
  insertPost({ slug: "claude-code-安装和接入-deepseek", wpId: 222 });
  insertPost({ slug: "本地部署开源大模型", wpId: 35 });
  insertPost({ slug: "博客迁移记录", wpId: 232 });
  // 页面不参与日期路径：WP 的日期 permalink 只给 post
  insertPost({ slug: "about", type: "page" });
  // 草稿不应被旧链接命中
  insertPost({ slug: "draft-only", status: "draft" });
  // 回收站（deleted_at 非空）同样不可命中
  insertPost({ slug: "trashed", deletedAt: "2026-11-01 00:00:00" });
});

after(() => {
  dbMod.closeDb();
  isolated.cleanup();
});

/* ------------------------------ 纯解析 ------------------------------ */

test("classifyLegacySegments：日期路径取出旧 slug", () => {
  assert.deepEqual(classifyLegacySegments(["2026", "06", "07", "imghub"]), {
    kind: "dated",
    year: "2026",
    month: "06",
    day: "07",
    slug: "imghub",
  });
  // slug 后面的 /feed、/page/2 之类不参与匹配
  assert.equal((classifyLegacySegments(["2026", "06", "07", "imghub", "feed"]) as any).slug, "imghub");
});

test("classifyLegacySegments：年/月/日归档与年份分页都归到 archive", () => {
  assert.deepEqual(classifyLegacySegments(["2026"]), { kind: "archive" });
  assert.deepEqual(classifyLegacySegments(["2026", "06"]), { kind: "archive" });
  assert.deepEqual(classifyLegacySegments(["2026", "06", "07"]), { kind: "archive" });
  assert.deepEqual(classifyLegacySegments(["2026", "page", "2"]), { kind: "archive" });
  assert.deepEqual(classifyLegacySegments(["2026", "page", "3"]), { kind: "archive" });
});

test("classifyLegacySegments：非法日期/非日期形态一律 null（交给 404）", () => {
  assert.equal(classifyLegacySegments(["2026", "13", "01", "x"]), null);
  assert.equal(classifyLegacySegments(["2026", "06", "32", "x"]), null);
  assert.equal(classifyLegacySegments(["2026", "page"]), null);
  assert.equal(classifyLegacySegments(["06", "07", "x"]), null); // 第一段不是年份
  assert.equal(classifyLegacySegments(["about"]), null);
  assert.deepEqual(classifyLegacySegments(["2026", "06"]), { kind: "archive" });
  assert.equal(classifyLegacySegments(["abc", "06", "07", "x"]), null);
});

test("classifyLegacySegments：URL 编码的中文段要先解码", () => {
  const encoded = encodeURIComponent("博客迁移记录");
  const shape = classifyLegacySegments(["2026", "09", "03", encoded]);
  assert.equal(shape?.kind, "dated");
  assert.equal((shape as any).slug, "博客迁移记录");
});

/* ------------------------------ 查库匹配 ------------------------------ */

test("resolveLegacyPath：旧 slug 精确命中", () => {
  const target = resolveLegacyPath(["2026", "09", "03", "博客迁移记录"]);
  assert.equal(target?.kind, "post");
  assert.equal((target as any).post.slug, "博客迁移记录");
});

test("resolveLegacyPath：纯数字旧 slug 按 wp_id 命中", () => {
  // /2026/05/25/35 —— WP 里 post_name 就是 35，对应 wp_id=35 的那篇文章
  const target = resolveLegacyPath(["2026", "05", "25", "35"]);
  assert.equal(target?.kind, "post");
  assert.equal((target as any).post.slug, "本地部署开源大模型");
});

test("resolveLegacyPath：被改短的旧 slug 走唯一前缀", () => {
  for (const [oldSlug, expectSlug] of [
    ["imghub", "imghub图床"],
    ["ai", "ai做了个部落冲突管理网站"],
    ["claude-code-", "claude-code-安装和接入-deepseek"],
  ] as const) {
    const target = resolveLegacyPath(["2026", "06", "07", oldSlug]);
    assert.equal(target?.kind, "post", oldSlug + " 应命中前缀");
    assert.equal((target as any).post.slug, expectSlug);
  }
});

test("resolveLegacyPath：前缀有多条候选时必须 404，不许猜", () => {
  // 再插一篇也以 `ai` 开头的文章，让 /2026/06/12/ai 变成多义
  insertPost({ slug: "ai-agent-实践笔记" });
  assert.equal(findPostByLegacySlug("ai"), undefined);
  assert.equal(resolveLegacyPath(["2026", "06", "12", "ai"]), null);
});

test("resolveLegacyPath：别名表兜住改过标题的旧 slug", () => {
  const postId = (db.prepare("SELECT id FROM posts WHERE slug = ?").get("十大经典排序算法") as { id: number }).id;
  db.prepare("INSERT INTO post_aliases (slug, post_id) VALUES (?, ?)").run("十大排序算法", postId);
  const target = resolveLegacyPath(["2026", "04", "20", "十大排序算法"]);
  assert.equal(target?.kind, "post");
  assert.equal((target as any).post.slug, "十大经典排序算法");
});

test("resolveLegacyPath：归档类路径返回 archive", () => {
  assert.deepEqual(resolveLegacyPath(["2026", "06", "07"]), { kind: "archive" });
  assert.deepEqual(resolveLegacyPath(["2026", "page", "2"]), { kind: "archive" });
});

test("resolveLegacyPath：页面、草稿、回收站、未知 slug 都不能被旧链接命中", () => {
  assert.equal(resolveLegacyPath(["2026", "06", "07", "about"]), null);
  assert.equal(resolveLegacyPath(["2026", "06", "07", "draft-only"]), null);
  assert.equal(resolveLegacyPath(["2026", "06", "07", "trashed"]), null);
  assert.equal(resolveLegacyPath(["2026", "06", "07", "完全不存在的文章"]), null);
});
