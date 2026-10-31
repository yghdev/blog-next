#!/usr/bin/env node
/**
 * hits.day 历史数据归一化（A-3 配套脚本，2026-10-31）。
 *
 * ## 用途
 *
 * 在**数据库副本**上预览 / 执行历史 `hits.day` 的补零。
 * 与迁移 `0015_hits_day_isopad` **共用同一套判定规则**，
 * 但多两件事：① 打印逐类计数与待人工清单；② 支持 `--apply` 显式执行。
 *
 * 默认 **dry-run**：只读、只报告，不改一个字节。
 * 只有传 `--apply` 才会写库，且整段包在事务里。
 *
 * ## 为什么要单独有这个脚本
 *
 * 迁移在生产上是「部署后首个请求触发」的自动动作 —— 那时已经没有机会
 * 先看一眼「到底会改多少行、有多少行修不了」。上线前的正确流程是：
 *   备份 → 把备份副本拉下来 → 跑本脚本 dry-run → 人工确认数字 → 再部署。
 *
 * ## 用法
 *
 *   DATA_DIR=/path/to/copy node scripts/normalize-hits-day.mjs           # dry-run
 *   DATA_DIR=/path/to/copy node scripts/normalize-hits-day.mjs --apply   # 执行
 *
 * ## 安全约束
 *
 *   • **没有 DATA_DIR 时直接拒绝运行**，不会退回 `./data`。
 *     这个脚本的本意就是在副本上跑；默认落到某个真实数据目录太危险，
 *     宁可要求显式指定，也不要「猜一个大概对」的路径。
 *   • 不删任何行、不改 `created_at` / `path` / `visitor` / 其他任何字段。
 *   • `--apply` 前后各做一次完整统计，并跑 `PRAGMA integrity_check`。
 *   • 任何异常 → 回滚 + 非零退出码，绝不静默失败。
 *
 * ## 与 dist 的兼容性
 *
 * 本文件只依赖 `better-sqlite3` 与 node 内置模块，**不引用 `../lib/`**。
 * 原因见 scripts/import-umami-events.mjs 顶部注释：`dist/` 只打包
 * `scripts/`（scripts/package-standalone.mjs:89），不含 `lib/`，
 * 引用它会让脚本在生产上 `ERR_MODULE_NOT_FOUND`。
 * 判定规则在这里重写了一遍，由 tests/migrations.test.ts 的用例锁死
 * 与迁移 0015 等价。
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const DATA_DIR = process.env.DATA_DIR;

if (!DATA_DIR) {
  console.error("拒绝运行：必须显式提供 DATA_DIR（本脚本用于数据库副本，不会猜测路径）。");
  console.error("示例：DATA_DIR=/tmp/probe node scripts/normalize-hits-day.mjs");
  process.exit(2);
}

const DB_PATH = path.join(DATA_DIR, "blog.db");
if (!fs.existsSync(DB_PATH)) {
  console.error("数据库不存在：" + DB_PATH);
  process.exit(1);
}

/* ────────────────────────── 判定规则 ──────────────────────────
   必须与 lib/migrations.ts 的 0015 逐字一致。
   ────────────────────────────────────────────────────────────── */

/** 候选值：把 YYYY-M-D 补零成 YYYY-MM-DD（调用前必须先过形状闸门） */
const CANDIDATE_SQL =
  "printf('%s-%02d-%02d'," +
  " substr(day, 1, 4)," +
  " CAST(substr(day, 6, instr(substr(day, 6), '-') - 1) AS INTEGER)," +
  " CAST(substr(day, 6 + instr(substr(day, 6), '-')) AS INTEGER))";

/** 形状闸门：只认三种未补零形态，且必须在此结束（不能用 GLOB 的 *） */
const SHAPE_SQL =
  "(day GLOB '[0-9][0-9][0-9][0-9]-[0-9]-[0-9]'" +
  " OR day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9]'" +
  " OR day GLOB '[0-9][0-9][0-9][0-9]-[0-9]-[0-9][0-9]')";

/** 已合规：形状为 10 位补零 + 日历真实存在 */
const VALID_SQL =
  "(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(day) IS day)";

/** 可自动修复：形状匹配、确实需要变、且补零后的日期在日历上真实存在 */
const FIXABLE_SQL =
  "(" + SHAPE_SQL + " AND day <> " + CANDIDATE_SQL + " AND date(" + CANDIDATE_SQL + ") = " + CANDIDATE_SQL + ")";

const UPDATE_SQL = "UPDATE hits SET day = " + CANDIDATE_SQL + " WHERE " + FIXABLE_SQL;

/* ────────────────────────── 统计 ────────────────────────── */

function collect(db) {
  const total = db.prepare("SELECT COUNT(*) c FROM hits").get().c;
  const valid = db.prepare("SELECT COUNT(*) c FROM hits WHERE " + VALID_SQL).get().c;
  const fixable = db.prepare("SELECT COUNT(*) c FROM hits WHERE " + FIXABLE_SQL).get().c;
  // 剩下的：既不是合法日期、也无法安全自动修复
  const broken = total - valid - fixable;
  return { total, valid, fixable, broken };
}

/** 待人工清单（只读）。最多打印 50 条，其余只报数量。 */
function listBroken(db, limit = 50) {
  return db.prepare(
    "SELECT id, day, created_at, path FROM hits " +
    " WHERE NOT " + VALID_SQL + " AND NOT " + FIXABLE_SQL +
    " ORDER BY id LIMIT ?"
  ).all(limit);
}

function printReport(label, s) {
  console.log("── " + label + " ──");
  console.log("  数据库:            " + DB_PATH);
  console.log("  hits 总记录数:      " + s.total);
  console.log("  已符合格式:        " + s.valid);
  console.log("  可补零:            " + s.fixable);
  console.log("  无法安全处理:      " + s.broken);
  console.log("  预计修改总数:      " + s.fixable);
}

/* ────────────────────────── 主流程 ────────────────────────── */

const db = new Database(DB_PATH, { readonly: !APPLY });
try {
  const hasHits = db.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='hits'"
  ).get().c > 0;
  if (!hasHits) {
    console.log("hits 表不存在，无需处理：" + DB_PATH);
    process.exit(0);
  }

  console.log(APPLY ? "== APPLY 模式（会写库）==" : "== DRY RUN（只读，不修改）==");
  const before = collect(db);
  printReport("迁移前", before);

  const brokenRows = listBroken(db);
  if (before.broken > 0) {
    console.log("\n  需要人工处理的样例（最多 50 条）:");
    for (const r of brokenRows) {
      console.log("    id=" + r.id + "  day=" + JSON.stringify(r.day) +
        "  created_at=" + JSON.stringify(r.created_at) + "  path=" + r.path);
    }
    if (before.broken > brokenRows.length) {
      console.log("    …还有 " + (before.broken - brokenRows.length) + " 条未显示");
    }
  } else {
    console.log("\n  没有需要人工处理的行。");
  }

  if (!APPLY) {
    console.log("\nDRY RUN 结束：数据库未被修改。加 --apply 才会执行。");
    process.exit(before.fixable > 0 ? 0 : 0);
  }

  if (before.fixable === 0 && before.broken === 0) {
    console.log("\n没有需要修改的行，直接退出。");
    process.exit(0);
  }

  // ── 写库：单事务，失败整体回滚 ──
  let changes = 0;
  try {
    db.transaction(() => {
      // 写之前再确认一次：避免「统计完到写入之间」被别的进程改动
      const again = collect(db);
      if (again.total !== before.total) {
        throw new Error("hits 行数在统计与写入之间发生变化（" + before.total + " -> " + again.total + "），已中止");
      }
      changes = db.prepare(UPDATE_SQL).run().changes;
    })();
  } catch (err) {
    console.error("\n!! 执行失败，事务已回滚：" + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  }

  if (process.exitCode === 1) {
    // 回滚后确认数据没被改
    const afterFail = collect(db);
    console.log("  回滚后状态：可补零 " + afterFail.fixable + " 行（应与执行前一致）");
  } else {
    const after = collect(db);
    printReport("迁移后", after);
    console.log("\n  实际修改行数:      " + changes);
    console.log("  剩余异常行数:      " + after.broken);

    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    console.log("  integrity_check:   " + integrity);
    if (integrity !== "ok") {
      console.error("!! integrity_check 未通过");
      process.exitCode = 1;
    }

    if (changes !== before.fixable) {
      console.warn("!! 实际修改行数（" + changes + "）与预计（" + before.fixable + "）不一致");
    }
  }
} finally {
  db.close();
}
