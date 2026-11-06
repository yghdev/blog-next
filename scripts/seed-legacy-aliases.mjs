#!/usr/bin/env node
/**
 * 把 WordPress 时代「改过标题」的旧 slug 补进 post_aliases。
 *
 * 旧日期路径（`/2026/04/20/十大排序算法`）现在由 `app/[...legacy]` 接管，
 * 匹配顺序是：精确 slug → 数字 wp_id/id → 别名 → 唯一前缀。
 * 大部分旧 slug 能靠前三种命中；但有四篇文章在 WordPress 里改过标题，
 * 旧 slug 与现在的 slug 没有前缀关系，只能靠别名表补：
 *
 *   十大排序算法            → 十大经典排序算法（wp_id 151）
 *   构建历程                → 博客迁移记录（wp_id 232）
 *   Claude-Code-安装与接入DeepSeek及使用指南 → claude-code-安装和接入-deepseek（wp_id 222）
 *   coc助手                 → 给部落造一个数据中枢…（wp_id 109）
 *
 * 用法：
 *   DATA_DIR=/var/lib/blog node scripts/seed-legacy-aliases.mjs           # dry-run，只报告
 *   DATA_DIR=/var/lib/blog node scripts/seed-legacy-aliases.mjs --apply   # 真正写入
 *
 * 幂等：已存在的别名会跳过；找不到 wp_id 的条目只报告，不猜。
 * 备份：写入前请先跑一次 `blog-backup`（后台改 slug 也走同一张表，风险相同）。
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "blog.db");
const APPLY = process.argv.includes("--apply");

/** 旧 slug -> WordPress post ID（wp_id 是迁移时写入的稳定锚点，比标题可靠） */
const ALIASES = [
  { slug: "十大排序算法", wpId: 151, note: "标题改为「十大经典排序算法」" },
  { slug: "构建历程", wpId: 232, note: "标题改为「博客迁移记录」" },
  {
    slug: "Claude-Code-安装与接入DeepSeek及使用指南",
    wpId: 222,
    note: "slug 改为 claude-code-安装和接入-deepseek",
  },
  { slug: "coc助手", wpId: 109, note: "标题改为「给部落造一个数据中枢…」" },
];

if (!fs.existsSync(DB_PATH)) {
  console.error("找不到数据库：" + DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma("busy_timeout = 5000");

let written = 0;
let skipped = 0;
let missing = 0;

for (const item of ALIASES) {
  const post = db
    .prepare("SELECT id, slug FROM posts WHERE wp_id = ? AND type = 'post' AND deleted_at IS NULL")
    .get(item.wpId);

  if (!post) {
    missing += 1;
    console.log(`跳过  ${item.slug} —— 找不到 wp_id=${item.wpId}（${item.note}）`);
    continue;
  }

  const existing = db.prepare("SELECT post_id FROM post_aliases WHERE slug = ?").get(item.slug);
  if (existing) {
    if (existing.post_id === post.id) {
      skipped += 1;
      console.log(`已存在 ${item.slug} -> /p/${post.id}（${post.slug}）`);
    } else {
      console.log(
        `冲突！ ${item.slug} 已指向 /p/${existing.post_id}，而 wp_id=${item.wpId} 是 /p/${post.id} —— 不覆盖，请人工确认`
      );
      missing += 1;
    }
    continue;
  }

  if (!APPLY) {
    written += 1;
    console.log(`将写入 ${item.slug} -> /p/${post.id}（${post.slug}）`);
    continue;
  }

  db.prepare("INSERT INTO post_aliases (slug, post_id) VALUES (?, ?)").run(item.slug, post.id);
  written += 1;
  console.log(`写入  ${item.slug} -> /p/${post.id}（${post.slug}）`);
}

db.close();
console.log(
  `\n${APPLY ? "已写入" : "将写入"} ${written} 条，已存在 ${skipped} 条，待人工 ${missing} 条。` +
    (APPLY ? "" : "\n这是 dry-run：确认无误后加 --apply 才真正写库。")
);
