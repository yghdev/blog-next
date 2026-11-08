#!/usr/bin/env node
/**
 * 给已有图片补生成 WebP 变体（C3，2026-11-08）。
 *
 * 上传接口只对**新上传**的图生成变体；这个脚本负责存量。
 *
 * ## 用法
 *
 *   # 1) 先看会做什么（默认 dry-run，不写文件也不写库）
 *   DATA_DIR=/var/lib/blog UPLOAD_DIR=/var/www/blog-images \
 *     node --experimental-strip-types scripts/gen-variants.mjs
 *
 *   # 2) 真正生成（写文件 + 更新 media.variants）
 *   DATA_DIR=/var/lib/blog UPLOAD_DIR=/var/www/blog-images \
 *     node --experimental-strip-types scripts/gen-variants.mjs --apply
 *
 *   # 3) 只输出 SQL（在 A 机生成、B 机执行时用）
 *   ... --sql
 *
 * ## 为什么需要 `--experimental-strip-types`
 *
 * 变体逻辑在 `lib/image-variants.ts` 里，上传接口和这个脚本必须用**同一份**
 * 实现 —— 各写一份必然漂移（宽度档位、质量、命名规则任何一处不一致，
 * 就会出现"新图有 srcset、老图没有"或者"变体路径对不上"）。
 * 所以这里直接 import 那个 .ts，而不是在脚本里复制一遍。
 *
 * ## 幂等
 *
 * 已经有 variants 的行默认跳过；`--force` 才会重算。
 * 生成失败只报告、不中断 —— 一张坏图不该让整批停下。
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { generateVariants, shouldGenerateVariants, variantPath } from "../lib/image-variants.ts";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "public/images");
const DB_PATH = path.join(DATA_DIR, "blog.db");

const APPLY = process.argv.includes("--apply");
const SQL_ONLY = process.argv.includes("--sql");
const FORCE = process.argv.includes("--force");

if (!fs.existsSync(DB_PATH)) {
  console.error("找不到数据库：" + DB_PATH);
  process.exit(1);
}
if (!fs.existsSync(UPLOAD_DIR)) {
  console.error("找不到图片目录：" + UPLOAD_DIR);
  process.exit(1);
}

const db = new Database(DB_PATH);

/**
 * 确保 `media.variants` 列存在。
 *
 * 为什么不 import lib/migrations.ts 的 migrate()：那个模块的相对 import 没带
 * 扩展名（Next/Turbopack 能解析，裸 Node 不能），为了一个 ALTER TABLE 去改
 * 整个 lib 的 import 风格不值得。这里只复刻 0016 那一条，且是幂等的 ——
 * 列已存在就什么都不做，与迁移脚本共存不冲突。
 */
{
  const cols = db.prepare("PRAGMA table_info(media)").all().map((c) => c.name);
  if (!cols.includes("variants")) {
    db.exec("ALTER TABLE media ADD COLUMN variants TEXT NOT NULL DEFAULT ''");
    console.log("已补 media.variants 列（等价于迁移 0016）");
  }
}

const rows = db.prepare(
  "SELECT id, path, mime, width, variants FROM media WHERE mime LIKE 'image/%' ORDER BY id"
).all();

console.log("图片总数：" + rows.length + "（" + (APPLY ? "APPLY" : "dry-run") + "）");

let done = 0, skipped = 0, failed = 0;
const sqlLines = [];

for (const row of rows) {
  if (!shouldGenerateVariants(row.path, row.mime)) {
    skipped++;
    continue;
  }
  if (row.variants && !FORCE) {
    skipped++;
    continue;
  }
  const rel = row.path.replace(/^\/images\//, "");
  const abs = path.join(UPLOAD_DIR, rel);
  if (!fs.existsSync(abs)) {
    console.log("  !! 文件不存在，跳过：" + row.path);
    failed++;
    continue;
  }

  const buf = fs.readFileSync(abs);
  if (!APPLY) {
    const targets = [640, 960, 1280]
      .filter((w) => !row.width || row.width > w)
      .map((w) => variantPath(row.path, w));
    console.log("  " + row.path + " -> " + (targets.length ? targets.join(", ") : "（原图太小，不生成）"));
    done++;
    continue;
  }

  const variants = await generateVariants(buf, row.path, UPLOAD_DIR, row.width ?? null);
  const json = Object.keys(variants).length > 0 ? JSON.stringify(variants) : "";
  if (!json) {
    console.log("  -- 没有可生成的档位：" + row.path);
    skipped++;
    continue;
  }
  db.prepare("UPDATE media SET variants = ? WHERE id = ?").run(json, row.id);
  sqlLines.push(
    "UPDATE media SET variants = '" + json.replace(/'/g, "''") + "' WHERE path = '" + row.path.replace(/'/g, "''") + "';"
  );
  console.log("  ok " + row.path + " -> " + Object.keys(variants).join("/") + "px");
  done++;
}

db.close();

console.log("\n完成：生成 " + done + " · 跳过 " + skipped + " · 失败 " + failed);
if (SQL_ONLY && sqlLines.length > 0) {
  console.log("\n-- 在目标库上执行（如果本机只是副本）：");
  for (const l of sqlLines) console.log(l);
}
if (!APPLY) {
  console.log("\n这是 dry-run。确认无误后加 --apply 真正生成。");
}
