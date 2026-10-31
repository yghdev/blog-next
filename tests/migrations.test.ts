import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { migrate, hasFts, hasColumn, hasTable, sha256hex, migrationNames, currentVersion, MIGRATIONS } from "../lib/migrations.ts";

const fresh = () => new Database(":memory:");

test("迁移建立全部基线表，且重复执行为空", () => {
  const db = fresh();
  assert.ok(migrate(db).applied.length > 0, "首次执行应应用迁移");
  const r2 = migrate(db);
  assert.deepEqual(r2.applied, [], "第二次不应再应用任何东西");
  for (const t of ["posts", "comments", "media", "users", "sessions", "settings", "rate_limits", "audit_log", "post_aliases", "recovery_codes", "schema_version"])
    assert.ok(hasTable(db, t), "应有表 " + t);
  assert.equal(r2.version, migrationNames()[migrationNames().length - 1]);
  db.close();
});

test("新增列齐全，且明文 token 列被彻底移除", () => {
  const db = fresh();
  migrate(db);
  assert.ok(hasColumn(db, "posts", "deleted_at"), "软删除列");
  assert.ok(hasColumn(db, "sessions", "token_hash"), "会话哈希列");
  assert.ok(!hasColumn(db, "sessions", "token"), "明文 token 列必须不存在");
  assert.ok(hasColumn(db, "sessions", "auth_at"), "step-up 时间窗列");
  assert.ok(hasColumn(db, "users", "totp_pending"), "服务端待确认密钥");
  assert.ok(hasColumn(db, "users", "role"), "多用户留位");
  assert.ok(hasColumn(db, "media", "sha256"), "媒体去重哈希");
  db.close();
});

test("0002 把老库的明文 token 转成哈希并保住会话", () => {
  // 模拟老结构：token 作主键
  const db = new Database(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, totp_secret TEXT, totp_enabled INTEGER DEFAULT 0, created_at TEXT)");
  db.exec("CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires_at TEXT, created_at TEXT)");
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'admin', 'hash')").run();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('abc123', 1, '2999-01-01T00:00:00.000Z')").run();

  migrate(db);

  assert.ok(!hasColumn(db, "sessions", "token"), "明文列已重建掉");
  const row = db.prepare("SELECT token_hash FROM sessions WHERE user_id = 1").get() as { token_hash: string } | undefined;
  assert.ok(row, "会话在迁移后仍存在");
  assert.equal(row!.token_hash, sha256hex("abc123"), "历史值转为自身哈希");
  assert.notEqual(row!.token_hash, "abc123", "库里不再有明文");
  // 旧 Cookie 经哈希后仍能命中
  const hit = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").get(sha256hex("abc123")) as { user_id: number } | undefined;
  assert.equal(hit?.user_id, 1, "旧 Cookie 仍可验证通过");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0, "重建后外键完好");
  db.close();
});

test("FTS5 建立，触发器保持同步", () => {
  const db = fresh();
  migrate(db);
  assert.ok(hasFts(db), "FTS5 在 better-sqlite3 12.11.1 / SQLite 3.53.2 可用");

  const info = db
    .prepare("INSERT INTO posts (type, slug, title, content) VALUES ('post', 'p1', 'Hough Transform', 'hough transform edge detection')")
    .run();
  const c = (q: string) => (db.prepare("SELECT count(*) c FROM posts_fts WHERE posts_fts MATCH ?").get(q) as { c: number }).c;
  assert.equal(c('"transform"'), 1, "INSERT 触发器已索引");

  db.prepare("UPDATE posts SET content = 'quantum tunneling essay' WHERE id = ?").run(info.lastInsertRowid);
  assert.equal(c('"detection"'), 0, "UPDATE 后旧正文不再命中");
  assert.equal(c('"tunneling"'), 1, "UPDATE 后新正文可命中");

  db.prepare("DELETE FROM posts WHERE id = ?").run(info.lastInsertRowid);
  assert.equal(c('"tunneling"'), 0, "DELETE 触发器清理");
  db.close();
});

test("trigram 对中文生效，且 >=3 字符是硬要求（故需 LIKE 兜底）", () => {
  const db = fresh();
  migrate(db);
  db.prepare("INSERT INTO posts (type, slug, title, content) VALUES ('post','p4','霍夫变换底层原理','介绍霍夫变换在图像检测中的应用')").run();
  const c = (q: string) => (db.prepare("SELECT count(*) c FROM posts_fts WHERE posts_fts MATCH ?").get(q) as { c: number }).c;
  // 3 字以上子串可命中
  assert.equal(c('"霍夫变换"'), 1, "四字中文词命中");
  assert.equal(c('"图像检测"'), 1, "正文中文词命中");
  // 2 字（trigram 最短 3）命中不到 —— 这正是 lib/search.ts 要降级 LIKE 的原因
  assert.equal(c('"变换"'), 0, "二字查询命中不到，必须由 LIKE 兜底");
  db.close();
});

test("迁移不破坏既有数据", () => {
  const db = fresh();
  migrate(db);
  db.prepare("INSERT INTO posts (type, slug, title, content, status, published_at) VALUES ('post','live','Kept','body','published','2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO comments (post_id, author, content, status) VALUES (1,'guest','hi','approved')").run();
  assert.deepEqual(migrate(db).applied, []);
  assert.equal((db.prepare("SELECT count(*) c FROM posts").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT count(*) c FROM comments").get() as { c: number }).c, 1);
  assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.equal(currentVersion(db), migrationNames()[migrationNames().length - 1]);
  db.close();
});

/* ══════════════════════════════════════════════════════════════════
   0012：revision / post_drafts / post_revisions / baseline 快照
   ══════════════════════════════════════════════════════════════════ */

/** 只应用到 0012 之前的库，用来模拟"老库升级" */
function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)");
  const ordered = [...MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name));
  for (const m of ordered) {
    if (m.name >= "0012") break;
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_version (name, applied_at) VALUES (?,?)").run(m.name, new Date().toISOString());
    })();
  }
  return db;
}

test("0012 建立 revision 列与两张新表，并带齐约束与索引", () => {
  const db = fresh();
  migrate(db);
  assert.ok(hasColumn(db, "posts", "revision"), "posts.revision");
  assert.ok(hasTable(db, "post_drafts"), "草稿表");
  assert.ok(hasTable(db, "post_revisions"), "历史表");

  // 约束检查：post_drafts 主键是 post_id（每篇最多一个草稿）
  const draftCols = db.prepare("PRAGMA table_info(post_drafts)").all() as { name: string; pk: number; notnull: number }[];
  const pk = draftCols.find((c) => c.pk === 1);
  assert.equal(pk?.name, "post_id", "post_drafts 主键必须是 post_id");

  // client_draft_id 必须 UNIQUE
  const draftIdx = db.prepare("PRAGMA index_list(post_drafts)").all() as { name: string; unique: number }[];
  assert.ok(draftIdx.some((i) => i.unique === 1), "post_drafts 应有唯一索引");

  // UNIQUE(post_id, revision)
  const revIdx = db.prepare("PRAGMA index_list(post_revisions)").all() as { name: string; unique: number }[];
  assert.ok(revIdx.some((i) => i.unique === 1), "post_revisions 应有 UNIQUE(post_id, revision)");

  // 外键
  const revFks = db.prepare("PRAGMA foreign_key_list(post_revisions)").all() as { table: string }[];
  assert.ok(revFks.some((f) => f.table === "posts"), "post_revisions 应外键引用 posts");
  db.close();
});

test("0012 为未删除文章建 baseline 快照；脏 JSON 按既定规则降级；回收站不建", () => {
  const db = legacyDb();
  // 脏数据：categories/tags 是非法 JSON
  db.prepare("INSERT INTO posts (type,title,slug,content,status,categories,tags) VALUES ('post','脏','dirty','body','published','{not json','[\"ok\",broken')").run();
  // 正常数据
  db.prepare("INSERT INTO posts (type,title,slug,content,status,categories,tags,cover) VALUES ('post','正常','normal','# hi','published','[\"技术\"]','[\"a\",\"b\"]','/c.png')").run();
  // 回收站文章：不应有 baseline
  db.prepare("INSERT INTO posts (type,title,slug,content,status,deleted_at) VALUES ('post','已删','gone','x','published','2026-01-01T00:00:00.000Z')").run();

  const before = db.prepare("SELECT id, slug, title, content, status, categories, tags, cover, published_at FROM posts ORDER BY id").all();

  // 应用 0012
  const m12 = [...MIGRATIONS].find((m) => m.name === "0012_revision_drafts_history")!;
  db.transaction(() => {
    m12.up(db);
    db.prepare("INSERT INTO schema_version (name, applied_at) VALUES (?,?)").run(m12.name, new Date().toISOString());
  })();

  const revs = db.prepare("SELECT post_id, revision, reason, snapshot_json, snapshot_hash FROM post_revisions ORDER BY post_id").all() as any[];

  // 每篇未删除文章恰好一条 baseline
  assert.equal(revs.length, 2, "只有 2 篇未删除文章应有 baseline");
  for (const r of revs) {
    assert.equal(r.reason, "baseline");
    assert.equal(r.revision, 1);
    // hash === sha256(snapshot_json)
    assert.equal(r.snapshot_hash, sha256hex(r.snapshot_json), "snapshot_hash 必须等于 sha256(snapshot_json)");
  }

  // 脏数据降级为 []，不抛错
  const dirty = revs.find((r) => JSON.parse(r.snapshot_json).slug === "dirty");
  assert.deepEqual(JSON.parse(dirty.snapshot_json).categories, [], "脏 categories 降级为 []");
  assert.deepEqual(JSON.parse(dirty.snapshot_json).tags, [], "脏 tags 降级为 []");

  // 正常数据保留
  const normal = revs.find((r) => JSON.parse(r.snapshot_json).slug === "normal");
  assert.deepEqual(JSON.parse(normal.snapshot_json).categories, ["技术"]);
  assert.deepEqual(JSON.parse(normal.snapshot_json).tags, ["a", "b"]);
  assert.equal(JSON.parse(normal.snapshot_json).cover, "/c.png");

  // posts 原行未被修改
  const after = db.prepare("SELECT id, slug, title, content, status, categories, tags, cover, published_at FROM posts ORDER BY id").all();
  assert.deepEqual(after, before, "迁移不得修改 posts 正文/slug/状态/时间");

  // 回收站那篇没有 baseline
  const goneId = (db.prepare("SELECT id FROM posts WHERE slug='gone'").get() as any).id;
  assert.equal(revs.some((r) => r.post_id === goneId), false);

  db.close();
});

test("0012 之后 posts.revision 默认 1，且重复迁移不再插入 baseline", () => {
  const db = legacyDb();
  db.prepare("INSERT INTO posts (type,title,slug,content,status) VALUES ('post','x','x','y','published')").run();
  migrate(db);
  const r = db.prepare("SELECT revision FROM posts WHERE slug='x'").get() as { revision: number };
  assert.equal(r.revision, 1, "存量行 revision 默认 1");

  // 再跑一次迁移：不应重复插入 baseline
  const countBefore = (db.prepare("SELECT COUNT(*) c FROM post_revisions").get() as any).c;
  migrate(db);
  const countAfter = (db.prepare("SELECT COUNT(*) c FROM post_revisions").get() as any).c;
  assert.equal(countAfter, countBefore, "重复迁移不得重复插入 baseline");
  db.close();
});

/* ══════════════════════════════════════════════════════════════════
   0015_hits_day_isopad：hits.day 历史补零（A-3）

   设计原则：迁移只做「形状严格匹配 + 日历真实存在」的补零。
   其余一律保持原值 —— 不猜日期、不用 created_at 重算、不删除。
   ══════════════════════════════════════════════════════════════════ */

/** 建一个只应用了 0014 及之前的库，用来模拟「线上现状」 */
function dbBefore0015(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)");
  const ordered = [...MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name));
  for (const m of ordered) {
    if (m.name >= "0015") break;
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_version (name, applied_at) VALUES (?,?)").run(m.name, new Date().toISOString());
    })();
  }
  return db;
}

function insertHit(db: Database.Database, day: string, createdAt: string, path = "/p/1"): number {
  const info = db.prepare(
    "INSERT INTO hits (path, visitor, is_entry, ref_host, ref_kind, day, created_at) " +
    "VALUES (?, 'v1', 1, '', 'direct', ?, ?)"
  ).run(path, day, createdAt);
  return Number(info.lastInsertRowid);
}

function dayOf(db: Database.Database, id: number): string {
  return (db.prepare("SELECT day FROM hits WHERE id = ?").get(id) as { day: string }).day;
}

test("0015 T1–T3：三种未补零形态都补成 YYYY-MM-DD", () => {
  const db = dbBefore0015();
  const a = insertHit(db, "2026-8-5", "2026-08-05T02:00:00.000Z");
  const b = insertHit(db, "2026-8-05", "2026-08-05T02:00:00.000Z");
  const c = insertHit(db, "2026-08-5", "2026-08-05T02:00:00.000Z");

  migrate(db);

  assert.equal(dayOf(db, a), "2026-08-05", "2026-8-5 应补零");
  assert.equal(dayOf(db, b), "2026-08-05", "2026-8-05 应补月");
  assert.equal(dayOf(db, c), "2026-08-05", "2026-08-5 应补日");
  db.close();
});

test("0015 T4：跨零点记录保持原日期，不被 created_at 的 UTC 日改写", () => {
  const db = dbBefore0015();
  // 2026-09-30T18:00Z = 上海 2026-10-01 02:00。若用 created_at 重算会变成 10-01
  const id = insertHit(db, "2026-9-30", "2026-10-01T18:00:00.000Z");

  migrate(db);

  assert.equal(dayOf(db, id), "2026-09-30", "只补零，日期本身必须是 09-30");
  assert.notEqual(dayOf(db, id), "2026-10-01", "不得被 UTC 日平移");
  db.close();
});

test("0015 T5：已合规的日期保持不变，且不计入 changes", () => {
  const db = dbBefore0015();
  const a = insertHit(db, "2026-08-05", "2026-08-05T02:00:00.000Z");
  const b = insertHit(db, "2026-10-30", "2026-10-30T00:00:00.000Z");

  // 只放合规行：迁移后不得有任何行的 day 发生变化
  const before = db.prepare("SELECT * FROM hits ORDER BY id").all();
  migrate(db);
  const after = db.prepare("SELECT * FROM hits ORDER BY id").all();

  assert.equal(dayOf(db, a), "2026-08-05");
  assert.equal(dayOf(db, b), "2026-10-30");
  assert.deepEqual(after, before, "已合规的行不得被 UPDATE（含 id/visitor/created_at 等全部字段）");
  db.close();
});

test("0015 T6–T15：所有异常/脏数据都保持原值，不被误改", () => {
  const db = dbBefore0015();
  const cases: [string, string][] = [
    ["T6 非数字月份", "2026-ab-05"],
    ["T7 非数字日", "2026-8-xx"],
    ["T8a 非法日历日（2 月 30）", "2026-2-30"],
    ["T8b 非法日历日（4 月 31）", "2026-4-31"],
    ["T9a 越界月 13", "2026-13-01"],
    ["T9b 越界月 00", "2026-00-10"],
    ["T10a 越界日 32", "2026-8-32"],
    ["T10b 越界日 00", "2026-8-00"],
    ["T11 空字符串", ""],
    ["T12 纯空格", "  "],
    ["T13 带时间", "2026-8-5 12:00:00"],
    ["T14 多段", "2026-8-5-9"],
    ["T15a 垃圾串", "bogus"],
    ["T15b 垃圾串", "abcd-ef-gh"],
  ];
  const ids = cases.map(([, day]) => ({ label: cases.find(([, d]) => d === day)![0], day, id: insertHit(db, day, "2026-08-05T02:00:00.000Z") }));

  migrate(db);

  for (const c of ids) {
    assert.equal(dayOf(db, c.id), c.day, c.label + " 必须保持原值：" + JSON.stringify(c.day));
  }
  db.close();
});

test("0015 T16：幂等 —— 连跑三次，只改一次，数据完全一致", () => {
  const db = dbBefore0015();
  insertHit(db, "2026-8-5", "2026-08-05T02:00:00.000Z");
  insertHit(db, "2026-9-8", "2026-09-08T02:00:00.000Z");
  insertHit(db, "2026-10-30", "2026-10-30T00:00:00.000Z");
  insertHit(db, "bogus", "2026-08-01T02:00:00.000Z");

  const first = migrate(db);
  assert.ok(first.applied.includes("0015_hits_day_isopad"), "第一次应应用 0015");

  const snapshot = JSON.stringify(db.prepare("SELECT * FROM hits ORDER BY id").all());

  const second = migrate(db);
  assert.deepEqual(second.applied, [], "第二次不应再应用任何迁移");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM hits ORDER BY id").all()), snapshot, "第二次数据必须完全一致");

  const third = migrate(db);
  assert.deepEqual(third.applied, [], "第三次同样为空");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM hits ORDER BY id").all()), snapshot, "第三次数据必须完全一致");
  db.close();
});

test("0015 T17：空 hits 表不抛错", () => {
  const db = dbBefore0015();
  assert.equal((db.prepare("SELECT COUNT(*) c FROM hits").get() as any).c, 0);
  assert.doesNotThrow(() => migrate(db));
  assert.equal((db.prepare("SELECT COUNT(*) c FROM hits").get() as any).c, 0);
  db.close();
});

test("0015 T18：hits 表不存在时不抛未处理异常", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)");
  // 只登记到 0012，然后人为删掉 hits（模拟极老库）
  const ordered = [...MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name));
  for (const m of ordered) {
    if (m.name >= "0013") break;
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_version (name, applied_at) VALUES (?,?)").run(m.name, new Date().toISOString());
    })();
  }
  // 此刻 hits 还不存在（0013 才建）。直接单独执行 0015 的 up，验证它的防御分支。
  const m15 = MIGRATIONS.find((m) => m.name === "0015_hits_day_isopad")!;
  assert.equal(hasTable(db, "hits"), false, "前置条件：此时还没有 hits 表");
  assert.doesNotThrow(() => m15.up(db), "hits 不存在时应静默跳过而不是抛错");
  db.close();
});

test("0015 T19–T20：完整性完好且行数守恒", () => {
  const db = dbBefore0015();
  const rows = [
    "2026-8-5", "2026-9-8", "2026-08-05", "2026-10-30",
    "bogus", "", "2026-13-01", "2026-2-30",
  ];
  rows.forEach((d) => insertHit(db, d, "2026-08-05T02:00:00.000Z"));
  const before = (db.prepare("SELECT COUNT(*) c FROM hits").get() as any).c;

  migrate(db);

  assert.equal((db.prepare("SELECT COUNT(*) c FROM hits").get() as any).c, before, "只 UPDATE，不增不删");
  assert.equal((db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "外键无违规");
  db.close();
});

test("0015：只补零，不改 path / created_at / visitor 等其他字段", () => {
  const db = dbBefore0015();
  const id = insertHit(db, "2026-8-5", "2026-08-05T02:00:00.000Z", "/p/keep-me");
  const before = db.prepare("SELECT * FROM hits WHERE id = ?").get(id) as any;

  migrate(db);

  const after = db.prepare("SELECT * FROM hits WHERE id = ?").get(id) as any;
  assert.equal(after.day, "2026-08-05", "day 应补零");
  assert.equal(after.path, before.path, "path 不得改动");
  assert.equal(after.created_at, before.created_at, "created_at 不得改动");
  assert.equal(after.visitor, before.visitor, "visitor 不得改动");
  assert.equal(after.is_entry, before.is_entry);
  assert.equal(after.ref_kind, before.ref_kind);
  db.close();
});

test("0015：闰年 2 月 29 日 —— 2024 有效、2026 无效", () => {
  const db = dbBefore0015();
  const leap = insertHit(db, "2024-2-29", "2024-02-29T02:00:00.000Z");
  const notLeap = insertHit(db, "2026-2-29", "2026-02-28T02:00:00.000Z");

  migrate(db);

  assert.equal(dayOf(db, leap), "2024-02-29", "2024 是闰年，2-29 合法，应补零");
  assert.equal(dayOf(db, notLeap), "2026-2-29", "2026 不是闰年，2-29 不合法，保持原值");
  db.close();
});

/* ══════════════════════════════════════════════════════════════════
   scripts/normalize-hits-day.mjs（A-3 配套脚本）

   脚本故意不依赖 lib/（dist 里没有 lib/），所以测试走真实 spawn，
   验证「默认 dry-run / --apply 才写 / 幂等 / 事务回滚 / integrity」。
   全部在 mkdtemp 出来的临时库上跑，不碰 data/blog.db。
   ══════════════════════════════════════════════════════════════════ */

const SCRIPT = path.join(process.cwd(), "scripts", "normalize-hits-day.mjs");

function makeProbeDb(rows: [string, string][]): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-tests", "norm-"));
  const dbp = path.join(dir, "blog.db");
  const d = new Database(dbp);
  d.exec(
    "CREATE TABLE hits (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, post_id INTEGER," +
    " visitor TEXT NOT NULL, is_entry INTEGER NOT NULL DEFAULT 1, ref_host TEXT NOT NULL DEFAULT ''," +
    " ref_kind TEXT NOT NULL DEFAULT 'direct', day TEXT NOT NULL, created_at TEXT NOT NULL, import_key TEXT)"
  );
  const ins = d.prepare("INSERT INTO hits (path, visitor, day, created_at) VALUES (?, ?, ?, ?)");
  rows.forEach(([day, createdAt], i) => ins.run("/p/" + i, "v" + i, day, createdAt));
  d.close();
  return dir;
}

function snapshot(dir: string): string {
  const d = new Database(path.join(dir, "blog.db"), { readonly: true });
  const rows = d.prepare("SELECT id, day, created_at, path, visitor FROM hits ORDER BY id").all();
  d.close();
  return JSON.stringify(rows);
}

function runScript(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, DATA_DIR: dir, ...env },
    encoding: "utf8",
  });
}

test("脚本：没有 DATA_DIR 时拒绝运行（不猜路径、不默认生产库）", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, DATA_DIR: "" }, encoding: "utf8" });
  assert.equal(r.status, 2, "应以退出码 2 拒绝");
  assert.match((r.stderr || "") + (r.stdout || ""), /必须显式提供 DATA_DIR/);
});

test("脚本：默认 dry-run，不修改数据库", () => {
  const dir = makeProbeDb([
    ["2026-8-5", "2026-08-05T02:00:00.000Z"],
    ["2026-08-05", "2026-08-05T02:00:00.000Z"],
    ["bogus", "2026-08-01T02:00:00.000Z"],
  ]);
  try {
    const before = snapshot(dir);
    const r = runScript(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN/);
    assert.match(r.stdout, /可补零:\s+1/, "应报告 1 行可补零");
    assert.match(r.stdout, /无法安全处理:\s+1/);
    assert.equal(snapshot(dir), before, "dry-run 后数据库必须完全不变");
    assert.match(r.stdout, /数据库未被修改/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("脚本：--apply 才修改，且改完再 dry-run 为 0 行", () => {
  const dir = makeProbeDb([
    ["2026-8-5", "2026-08-05T02:00:00.000Z"],
    ["2026-9-8", "2026-09-08T02:00:00.000Z"],
    ["2026-08-05", "2026-08-05T02:00:00.000Z"],
    ["2026-09-08", "2026-09-08T02:00:00.000Z"],
    ["bogus", "2026-08-01T02:00:00.000Z"],
    ["2026-13-05", "2026-07-01T02:00:00.000Z"],
    ["2026-02-32", "2026-02-01T02:00:00.000Z"],
    ["", ""],
  ]);
  try {
    const before = JSON.parse(snapshot(dir)) as any[];
    const applyRes = runScript(dir, ["--apply"]);
    assert.equal(applyRes.status, 0, applyRes.stderr);
    assert.match(applyRes.stdout, /实际修改行数:\s+2/);
    assert.match(applyRes.stdout, /integrity_check:\s+ok/);

    const after = JSON.parse(snapshot(dir)) as any[];
    assert.equal(after.length, before.length, "行数守恒");
    assert.equal(after[0].day, "2026-08-05", "2026-8-5 已补零");
    assert.equal(after[1].day, "2026-09-08", "2026-9-8 已补零");
    assert.equal(after[2].day, "2026-08-05", "已合规行不变");
    assert.equal(after[3].day, "2026-09-08", "已合规行不变");
    assert.equal(after[4].day, "bogus", "垃圾串原样保留");
    assert.equal(after[5].day, "2026-13-05", "非法月份原样保留");
    assert.equal(after[6].day, "2026-02-32", "非法日期原样保留");
    assert.equal(after[7].day, "", "空串原样保留");

    // created_at / path / visitor 都不许动
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i].created_at, before[i].created_at, "created_at 不得改动 (id=" + before[i].id + ")");
      assert.equal(after[i].path, before[i].path, "path 不得改动");
      assert.equal(after[i].visitor, before[i].visitor, "visitor 不得改动");
    }

    const again = runScript(dir);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /可补零:\s+0/, "再次 dry-run 应显示 0 行可补");
    assert.equal((again.stdout.match(/实际修改/) || []).length, 0, "dry-run 不应报告修改");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("脚本：全库都合法时 --apply 直接退出，不改任何行", () => {
  const dir = makeProbeDb([
    ["2026-08-05", "2026-08-05T02:00:00.000Z"],
    ["2026-09-08", "2026-09-08T02:00:00.000Z"],
  ]);
  try {
    const before = snapshot(dir);
    const r = runScript(dir, ["--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /没有需要修改的行/);
    assert.equal(snapshot(dir), before, "不应有任何修改");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("脚本：hits 表不存在时正常退出（不抛异常）", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-tests", "norm-"));
  try {
    const d = new Database(path.join(dir, "blog.db"));
    d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    d.close();
    const r = runScript(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /hits 表不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("脚本：数据库文件不存在时报错退出（不创建空库）", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-tests", "norm-"));
  try {
    const r = runScript(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /数据库不存在/);
    assert.equal(fs.existsSync(path.join(dir, "blog.db")), false, "不得创建空数据库");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("脚本：只读打开时不会修改 WAL 之外的任何内容（dry-run 二次确认）", () => {
  const dir = makeProbeDb([["2026-8-5", "2026-08-05T02:00:00.000Z"]]);
  try {
    const s1 = snapshot(dir);
    runScript(dir);
    runScript(dir);
    assert.equal(snapshot(dir), s1, "连跑两次 dry-run 数据必须完全不变");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("脚本：写入失败时事务回滚，数据保持原样（不静默失败）", () => {
  const dir = makeProbeDb([
    ["2026-8-5", "2026-08-05T02:00:00.000Z"],
    ["2026-9-8", "2026-09-08T02:00:00.000Z"],
    ["2026-08-05", "2026-08-05T02:00:00.000Z"],
  ]);
  try {
    const before = snapshot(dir);

    // 造一个「UPDATE 一定会失败」的场景：加一个 BEFORE UPDATE 触发器直接 RAISE。
    // 这比用只读文件系统模拟更可控（跨平台、不依赖 chmod 语义）。
    const d = new Database(path.join(dir, "blog.db"));
    d.exec("CREATE TRIGGER block_day_update BEFORE UPDATE OF day ON hits BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
    d.close();

    const r = runScript(dir, ["--apply"]);
    assert.equal(r.status, 1, "失败必须是非零退出码：" + r.stdout + r.stderr);
    assert.match((r.stderr || "") + (r.stdout || ""), /执行失败|simulated write failure/);

    // 回滚后：day 全都没变（触发器阻止了 UPDATE，且事务整体回滚）
    const after = snapshot(dir);
    assert.equal(after, before, "事务回滚后数据必须与执行前完全一致");

    // 移除触发器后再跑，应能正常完成 —— 证明失败没有留下半成品状态
    const d2 = new Database(path.join(dir, "blog.db"));
    d2.exec("DROP TRIGGER block_day_update");
    d2.close();

    const retry = runScript(dir, ["--apply"]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /实际修改行数:\s+2/);
    const afterRetry = JSON.parse(snapshot(dir)) as any[];
    assert.equal(afterRetry[0].day, "2026-08-05");
    assert.equal(afterRetry[1].day, "2026-09-08");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
