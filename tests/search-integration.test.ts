import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 搜索集成测试（真实 SQLite + FTS5）。
 *
 * 必须独立成文件：lib/db.ts 的 getDb() 是进程级单例，
 * 若与其它测试同文件，会沿用已被前序用例初始化的 data/blog.db。
 * 这里在**任何 lib 动态导入之前**先把 DATA_DIR 指向临时目录。
 */
// 注意：不要放在 .probe 下 —— 那是会被清理的一次性目录，
// 父目录不存在时 mkdtempSync 会直接抛错（且沙箱里 os.tmpdir() 可能为空）。
const TMP_ROOT = path.join(process.cwd(), ".tmp-tests");
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, "search-"));
process.env.DATA_DIR = TMP;

const dbMod = await import("../lib/db.ts");
const searchMod = await import("../lib/search.ts");
const timeMod = await import("../lib/time.ts");
const settingsMod = await import("../lib/settings.ts");
const statsMod = await import("../lib/site-stats.ts");

test("FTS 集成：>=3 字走 FTS，2 字自动降级 LIKE", () => {
  const db = dbMod.getDb();
  const longBody = "介绍霍夫变换在图像检测中的应用。" + "填充".repeat(400);
  db.prepare("INSERT INTO posts (type, slug, title, content, status, published_at, created_at, updated_at) VALUES ('post','hough','霍夫变换底层原理',?,'published',?,?,?)")
    .run(longBody, timeMod.nowIso(), timeMod.nowIso(), timeMod.nowIso());

  const fts = searchMod.searchPosts("霍夫变换");
  assert.equal(fts.mode, "fts", "四字中文应走 FTS");
  assert.equal(fts.hits.length, 1);
  assert.equal(fts.hits[0].slug, "hough");

  const two = searchMod.searchPosts("变换");
  assert.equal(two.mode, "like", "二字中文应降级 LIKE");
  assert.equal(two.hits.length, 1, "降级后仍搜得到");

  // 只回摘要，绝不回传整篇正文（原实现单篇 13,871 B 全量回传）
  assert.ok([...fts.hits[0].excerpt].length <= 100);
});

test("草稿与软删除都不出现在搜索结果里", () => {
  const db = dbMod.getDb();
  db.prepare("UPDATE posts SET status = 'draft' WHERE slug = 'hough'").run();
  assert.equal(searchMod.searchPosts("霍夫变换").hits.length, 0, "草稿不可搜到");
  db.prepare("UPDATE posts SET status = 'published', deleted_at = ? WHERE slug = 'hough'").run(timeMod.nowIso());
  assert.equal(searchMod.searchPosts("霍夫变换").hits.length, 0, "回收站不可搜到");
  db.prepare("UPDATE posts SET deleted_at = NULL WHERE slug = 'hough'").run();
});

test("FTS 语法字符不会造成注入或异常", () => {
  for (const q of ['a" OR "b', "NEAR/2", "foo*", '"', "  ", "AND OR NOT"]) {
    assert.doesNotThrow(() => searchMod.searchPosts(q), "查询 " + JSON.stringify(q) + " 不应抛错");
  }
});

test("settings 默认值可用，写入后立刻可读（不再有进程内缓存）", () => {
  const d = settingsMod.getSettings();
  assert.equal(d.siteTitle, "flechazo's blog");
  assert.equal(d.commentEnabled, true);

  settingsMod.updateSettings({ siteTitle: "测试站点", commentEnabled: false });
  const after = settingsMod.getSettings();
  assert.equal(after.siteTitle, "测试站点", "写入后立即生效（缓存已失效）");
  assert.equal(after.commentEnabled, false, "布尔值以 1/0 存储并正确还原");
  assert.equal(settingsMod.getRawSetting("site_title"), "测试站点");
});

test("浏览量来自 hits 表 + 历史基线，渲染路径不请求外部服务", () => {
  /**
   * 2026-10-30 换数据源：Umami 的聚合值不再参与运行期展示。
   * 侧栏也去掉了「访问」—— 那个数字的口径换过三次，标签却始终只有两个字。
   */
  assert.equal(
    statsMod.getSiteStats().find((s) => s.label === "访问"),
    undefined,
    "侧栏不再显示口径不清的「访问」"
  );

  const db = dbMod.getDb();
  const postId = (db.prepare("SELECT id FROM posts WHERE slug = 'hough'").get() as { id: number }).id;

  // 一条真实 hit：path 用解码后的中文也行、编码态也行，归一化后必须同一个 key
  db.prepare(
    "INSERT INTO hits (path, post_id, visitor, is_entry, ref_host, ref_kind, day, created_at) " +
    "VALUES (?, ?, 'v1', 1, '', 'direct', ?, ?)"
  ).run("/hough", postId, timeMod.dateKeyIn(timeMod.nowIso()), timeMod.nowIso());

  assert.equal(statsMod.getPageViews("/hough", postId), 1, "按 post_id 命中 1 条");
  assert.equal(statsMod.getPageViews("/nope", null), null, "一条都没有时返回 null 而不是 0");

  // 历史基线叠加：模拟上线前的 umami 数值被迁移冻结
  settingsMod.setStatValue("stats:baseline:post:" + postId, "77");
  assert.equal(statsMod.getPageViews("/hough", postId), 78, "本地 1 条 + 历史基线 77");

  const map = statsMod.getViewsMap();
  assert.equal(map.get(postId), 78, "首页批量取一次查询即可，key 是 post_id");
});

/* ---------- P0-6（2026-11-07）：2 字词 / 相关性排序 / 计数 / 摘要 ---------- */

/** 插一篇已发布文章（走 posts 表的 FTS 触发器，索引自动更新） */
function insertPost(opts: {
  slug: string; title: string; content: string; at?: string;
  /** C2：筛选测试需要分类/标签 */
  categories?: string[]; tags?: string[];
}) {
  const db = dbMod.getDb();
  const at = opts.at ?? timeMod.nowIso();
  db.prepare(
    "INSERT INTO posts (type, slug, title, content, categories, tags, status, published_at, created_at, updated_at) " +
    "VALUES ('post', ?, ?, ?, ?, ?, 'published', ?, ?, ?)"
  ).run(
    opts.slug, opts.title, opts.content,
    JSON.stringify(opts.categories ?? []), JSON.stringify(opts.tags ?? []),
    at, at, at
  );
}

test("P0-6：2 字查询（LIKE 兜底）也按相关性排序，标题命中在前", () => {
  insertPost({ slug: "p06-video-title", title: "视频剪辑入门", content: "从零开始学剪辑。", at: "2026-10-01 00:00:00" });
  // 正文里出现 5 次但没有标题命中：按时间它更新，但相关性更低，必须排在后面
  insertPost({ slug: "p06-video-body", title: "随便聊聊", content: "视频 视频 视频 视频 视频", at: "2026-10-30 00:00:00" });

  const r = searchMod.searchPosts("视频", { limit: 10 });
  assert.equal(r.mode, "like", "2 字查询走关键词匹配");
  const slugs = r.hits.map((h) => h.slug);
  assert.equal(slugs[0], "p06-video-title", "标题命中必须排第一，实际顺序: " + slugs.join(","));
  assert.equal(r.total, 2, "total 应等于命中总数");
  assert.equal(r.capped, false);
});

test("P0-6：total 是命中总数，不随 limit 截断（此前把 hits.length 当总数）", () => {
  const r = searchMod.searchPosts("视频", { limit: 1 });
  assert.equal(r.hits.length, 1, "limit=1 只回一条");
  assert.ok(r.total >= 2, "但 total 仍是真实命中数，实际 " + r.total);
});

test("P0-6：ASCII 词有边界 —— AI 不命中 email / main", () => {
  insertPost({ slug: "p06-ai", title: "AI 写作工具", content: "用 AI 辅助写作。" });
  insertPost({ slug: "p06-email", title: "邮件备忘", content: "email 通知与 main 函数都会出现 a i 字样。" });

  const r = searchMod.searchPosts("AI", { limit: 10 });
  const slugs = r.hits.map((h) => h.slug);
  assert.ok(slugs.includes("p06-ai"), "AI 应命中标题里的 AI，实际: " + slugs.join(","));
  assert.equal(slugs.includes("p06-email"), false, "AI 不得命中 email/main");
  assert.equal(r.total, slugs.length > 0 ? slugs.length : 0);
});

test("P0-6：多词是 AND —— 两个词都出现才进结果", () => {
  insertPost({ slug: "p06-both", title: "deepseek 生成视频", content: "两条都在。" });
  insertPost({ slug: "p06-only-ds", title: "deepseek 笔记", content: "只有前一个词。" });
  insertPost({ slug: "p06-only-video", title: "视频杂谈", content: "只有后一个词。" });

  const r = searchMod.searchPosts("deepseek 视频", { limit: 10 });
  const slugs = r.hits.map((h) => h.slug);
  assert.ok(slugs.includes("p06-both"));
  assert.equal(slugs.includes("p06-only-ds"), false, "只有一个词的不能进 AND 结果");
  assert.equal(slugs.includes("p06-only-video"), false);
});

test("P0-6：摘要以命中位置为中心截取（此前永远取正文开头）", () => {
  insertPost({
    slug: "p06-deep",
    title: "长文一篇",
    content: "铺垫".repeat(300) + "这里才是霍夫变换的详解" + "收尾".repeat(100),
  });

  const r = searchMod.searchPosts("霍夫变换", { limit: 5 });
  const hit = r.hits.find((h) => h.slug === "p06-deep");
  assert.ok(hit, "应命中长文（全文索引）");
  assert.ok(hit.excerpt.includes("霍夫变换"), "摘要里必须能看到命中词，实际: " + hit.excerpt);
  assert.ok(hit.excerpt.startsWith("…"), "命中不在开头时应带前导省略号");
  assert.equal(r.mode, "fts", "4 字中文走全文索引");
});

test("P0-6：候选被上限截断时 capped=true，total 只是下限", () => {
  const N = searchMod.CANDIDATE_CAP + 3;
  for (let i = 0; i < N; i++) {
    insertPost({ slug: "p06-cap-" + i, title: "容量测试 " + i, content: "CAPMARK 内容" });
  }
  const r = searchMod.searchPosts("CAPMARK", { limit: 1 });
  assert.equal(r.hits.length, 1);
  assert.equal(r.capped, true, "超过候选上限时应标记 capped，界面才能写 N+");
  assert.equal(r.total, searchMod.CANDIDATE_CAP, "被截断时 total 是下限而不是谎报精确值");
});

test("单字查询只在标题里匹配（正文命中不算，避免全站噪音）", () => {
  // 标题含「的」：应命中
  insertPost({ slug: "p1c-title", title: "我的第一篇", content: "正文里没有那个字。" });
  // 只有正文含「的」：不应命中 —— 否则「的」会命中全站每一篇
  insertPost({ slug: "p1c-body", title: "随便聊聊", content: "的 的 的 的 的" });

  const r = searchMod.searchPosts("的", { limit: 10 });
  assert.equal(r.titleOnly, true, "单字查询应标记 titleOnly，界面据此显示提示");
  const slugs = r.hits.map((h) => h.slug);
  assert.ok(slugs.includes("p1c-title"), "标题含该字应命中，实际: " + slugs.join(","));
  assert.equal(slugs.includes("p1c-body"), false, "只有正文含该字不得命中");
  assert.equal(r.total, 1, "total 只算标题命中");
});

test("两字及以上查询不受 titleOnly 影响（正文命中仍算）", () => {
  insertPost({ slug: "p2c-body", title: "随便聊聊", content: "这里提到视频两个字。" });
  const r = searchMod.searchPosts("视频", { limit: 10 });
  assert.equal(r.titleOnly, false, "两字查询不是 titleOnly");
  assert.ok(r.hits.some((h) => h.slug === "p2c-body"), "两字查询仍应命中正文");
});

/* ------------------------- C2（2026-11-08）：分页 / 筛选 ------------------------- */

test("C2 分页：total 是筛选后的总数，page/pageCount 正确，越界页码夹回最后一页", () => {
  // 造 25 篇都命中 PAGEMARK 的文章
  for (let i = 0; i < 25; i++) {
    insertPost({
      slug: "c2-page-" + i,
      title: "分页测试 " + i + " PAGEMARK",
      content: "PAGEMARK 正文",
      at: "2026-03-0" + ((i % 9) + 1) + " 00:00:00",
    });
  }

  const p1 = searchMod.searchPosts("PAGEMARK", { limit: 10, page: 1 });
  assert.equal(p1.total, 25, "total 是命中总数，不是本页条数");
  assert.equal(p1.pageCount, 3, "25 条 / 每页 10 = 3 页");
  assert.equal(p1.hits.length, 10, "第 1 页 10 条");
  assert.equal(p1.page, 1);

  const p3 = searchMod.searchPosts("PAGEMARK", { limit: 10, page: 3 });
  assert.equal(p3.hits.length, 5, "第 3 页 5 条");
  assert.equal(p3.page, 3);

  // 越界：手改 URL 到第 99 页，应夹回最后一页而不是空白
  const p99 = searchMod.searchPosts("PAGEMARK", { limit: 10, page: 99 });
  assert.equal(p99.page, 3, "越界页码夹回最后一页");
  assert.equal(p99.hits.length, 5);

  // 第 1 页与第 2 页不能有重复
  const p2 = searchMod.searchPosts("PAGEMARK", { limit: 10, page: 2 });
  const ids1 = new Set(p1.hits.map((h) => h.id));
  assert.equal(p2.hits.some((h) => ids1.has(h.id)), false, "相邻页不得重复");
});

test("C2 筛选：tag 同时匹配分类与标签", () => {
  insertPost({ slug: "c2-cat", title: "分类命中 FILTERMARK", content: "x", categories: ["AI"], tags: ["其它"] });
  insertPost({ slug: "c2-tag", title: "标签命中 FILTERMARK", content: "x", categories: ["生活"], tags: ["deepseek"] });
  insertPost({ slug: "c2-none", title: "都不命中 FILTERMARK", content: "x", categories: ["生活"], tags: ["随笔"] });

  const byCat = searchMod.searchPosts("FILTERMARK", { tag: "AI" });
  assert.deepEqual(byCat.hits.map((h) => h.slug), ["c2-cat"], "按分类筛选");

  const byTag = searchMod.searchPosts("FILTERMARK", { tag: "deepseek" });
  assert.deepEqual(byTag.hits.map((h) => h.slug), ["c2-tag"], "按标签筛选");

  const none = searchMod.searchPosts("FILTERMARK", { tag: "不存在" });
  assert.equal(none.total, 0, "不存在的标签应 0 条");
});

test("C2 筛选：year 按发布年份", () => {
  insertPost({ slug: "c2-y2026", title: "年份命中 YEARMARK", content: "x", at: "2026-05-01 00:00:00" });
  insertPost({ slug: "c2-y2025", title: "年份命中 YEARMARK", content: "x", at: "2025-05-01 00:00:00" });

  const y2026 = searchMod.searchPosts("YEARMARK", { year: "2026" });
  assert.deepEqual(y2026.hits.map((h) => h.slug), ["c2-y2026"], "2026 只出 2026 的");
  const y2025 = searchMod.searchPosts("YEARMARK", { year: "2025" });
  assert.deepEqual(y2025.hits.map((h) => h.slug), ["c2-y2025"], "2025 只出 2025 的");
});

test("C2 筛选 + 分页组合：total 是筛选后的数量", () => {
  for (let i = 0; i < 12; i++) {
    insertPost({
      slug: "c2-combo-" + i,
      title: "组合测试 COMBO",
      content: "x",
      categories: ["组合"],
      at: "2026-06-01 00:00:00",
    });
  }
  const r = searchMod.searchPosts("COMBO", { limit: 10, page: 1, tag: "组合" });
  assert.equal(r.total, 12, "筛选后的总数");
  assert.equal(r.pageCount, 2, "12 条 / 每页 10 = 2 页");
  assert.equal(r.hits.length, 10);
});

test("C2 分面：标签取分类∪标签并去重计数，年份按发布年", () => {
  const f = searchMod.searchFacets();
  const names = f.tags.map((t) => t.name);
  assert.ok(names.includes("AI"), "分面应含分类 AI");
  assert.ok(names.includes("deepseek"), "分面应含标签 deepseek");
  assert.ok(names.includes("组合"), "分面应含分类 组合");
  // 同一篇里分类与标签重名只算一次：c2-cat 的 categories=AI、tags=其它，不重名；
  // 这里用「组合」验证计数 = 12（12 篇各一次），而不是 24
  const combo = f.tags.find((t) => t.name === "组合");
  assert.equal(combo?.count, 12, "同一篇里重名只算一次");
  assert.ok(f.years.some((y) => y.year === "2026"), "分面应含 2026");
  // 年份倒序
  const ys = f.years.map((y) => y.year);
  assert.deepEqual([...ys].sort((a, b) => b.localeCompare(a)), ys, "年份应倒序");
});

test("cleanup", () => {
  dbMod.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});
