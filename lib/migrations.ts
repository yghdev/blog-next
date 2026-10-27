import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { safeStringArray, snapshotIdentity } from "./snapshot";

/**
 * 迁移的唯一事实来源（方案 C13）。
 * 原先 lib/db.ts 与 scripts/init-db.mjs 各写了一份 DDL，会互相漂移 —— 现在只有这里有一份。
 *
 * 约定：
 *   - 每条幂等（IF NOT EXISTS / 列存在性判断），可在任意状态的库上重复执行
 *   - 只前进不后退；回滚依赖变更前生成的 .backup 快照
 *   - schema_version 记录已应用的 name，按数组顺序补齐
 */
export type Migration = { name: string; up: (db: Database.Database) => void };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** PRAGMA 的表名不支持参数绑定，白名单校验后再拼接 */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!IDENT.test(table) || !IDENT.test(column)) throw new Error("illegal identifier: " + table + "." + column);
  const rows = db.prepare("PRAGMA table_info(" + table + ")").all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

export function addColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + ddl);
}

export function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
}

export function hasFts(db: Database.Database): boolean {
  return hasTable(db, "posts_fts");
}

/** 0001 的 DDL 由既有库的 sqlite_master 导出，保证与线上结构一字不差。
 *  注意：SQLite 在写入 sqlite_master 时会丢掉 "IF NOT EXISTS"，
 *  因此导出后必须重新补上，否则重放到已有库上会直接报 "table already exists"。
 *  顺序也有讲究：posts 必须最先建，其他表的外键引用它。 */
const BASELINE_SQL: string[] = [
  "CREATE TABLE IF NOT EXISTS posts (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  type TEXT NOT NULL CHECK (type IN ('post','page','shuoshuo')),\n  title TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL,\n  content TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',\n  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),\n  categories TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',\n  cover TEXT, wp_id INTEGER, published_at TEXT,\n  created_at TEXT NOT NULL DEFAULT (datetime('now')),\n  updated_at TEXT NOT NULL DEFAULT (datetime('now')),\n  UNIQUE(type, slug))",
  "CREATE TABLE IF NOT EXISTS comments (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,\n  author TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',\n  content TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','spam')),\n  ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',\n  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,\n  created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS media (\n  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,\n  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,\n  created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,\n  password_hash TEXT NOT NULL, totp_secret TEXT,\n  totp_enabled INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS sessions (\n  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, reset_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, published_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type, status)",
];

/**
 * 迁移定义。导出是为了让测试能**只应用到指定版本**，
 * 从而构造出"0012 之前的老库"来验证基线与脏数据降级 ——
 * 否则基线测试只能在一个已经是新结构的库上跑，等于什么都没验证。
 */
export const MIGRATIONS: Migration[] = [
  {
    name: "0001_baseline",
    up: (db) => {
      // 已有库上 CREATE TABLE IF NOT EXISTS 自然跳过；缺失的表/列由后续条目补齐
      for (const sql of BASELINE_SQL) db.exec(sql);
    },
  },
  {
    name: "0002_session_hardening",
    up: (db) => {
      // A5：原先把会话 token 以**明文**存成主键 —— 每日备份外流或一次拖库，
      // 就等于把所有管理员会话一起交出去。改为只存 SHA-256。
      // token 是主键，SQLite 不能直接 DROP，所以整表重建。
      // 历史明文行迁移成它自己的哈希：现有 Cookie 仍可匹配（登录后自然换新），库里不留明文。
      if (hasColumn(db, "sessions", "token")) {
        if (!hasColumn(db, "sessions", "token_hash")) db.exec("ALTER TABLE sessions ADD COLUMN token_hash TEXT");
        const rows = db.prepare("SELECT token FROM sessions WHERE token_hash IS NULL").all() as { token: string }[];
        const upd = db.prepare("UPDATE sessions SET token_hash = ? WHERE token = ?");
        for (const r of rows) upd.run(sha256hex(r.token), r.token);

        db.exec(
          "CREATE TABLE sessions_new (" +
          "  token_hash   TEXT PRIMARY KEY," +
          "  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
          "  expires_at   TEXT NOT NULL," +
          "  created_at   TEXT NOT NULL DEFAULT (datetime('now'))," +
          "  last_seen_at TEXT," +
          "  user_agent   TEXT NOT NULL DEFAULT ''," +
          "  ip           TEXT NOT NULL DEFAULT ''," +
          "  auth_at      TEXT" +
          ")"
        );
        db.exec(
          "INSERT INTO sessions_new (token_hash, user_id, expires_at, created_at) " +
          "  SELECT token_hash, user_id, expires_at, COALESCE(created_at, datetime('now')) FROM sessions WHERE token_hash IS NOT NULL"
        );
        db.exec("DROP TABLE sessions");
        db.exec("ALTER TABLE sessions_new RENAME TO sessions");
      } else {
        addColumn(db, "sessions", "token_hash", "TEXT");
        addColumn(db, "sessions", "last_seen_at", "TEXT");
        addColumn(db, "sessions", "user_agent", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "sessions", "ip", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "sessions", "auth_at", "TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)");
    },
  },
  {
    name: "0003_totp_pending_and_recovery",
    up: (db) => {
      // A7：绑定 2FA 必须由服务端暂存待确认密钥，绝不能信客户端回传的 secret
      addColumn(db, "users", "totp_pending", "TEXT");
      addColumn(db, "users", "totp_pending_at", "TEXT");
      addColumn(db, "users", "password_updated_at", "TEXT");
      addColumn(db, "users", "role", "TEXT NOT NULL DEFAULT 'admin'"); // 多用户留位，UI 暂不实现
      db.exec(
        "CREATE TABLE IF NOT EXISTS recovery_codes (" +
        "  id        INTEGER PRIMARY KEY AUTOINCREMENT," +
        "  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE," +
        "  code_hash TEXT NOT NULL UNIQUE," +
        "  used_at   TEXT," +
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
        ")"
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id, used_at)");
    },
  },
  {
    name: "0004_soft_delete",
    up: (db) => {
      // P3-4：后台删除原本是硬 DELETE，而 comments.post_id 带 ON DELETE CASCADE ——
      // 删一篇文章会连带永久删光它的全部评论。改成软删除 + 回收站。
      addColumn(db, "posts", "deleted_at", "TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(deleted_at)");
    },
  },
  {
    name: "0005_slug_aliases",
    up: (db) => {
      // B8：改 slug 会让已收录链接直接 404，需要别名 + 301
      db.exec(
        "CREATE TABLE IF NOT EXISTS post_aliases (" +
        "  slug       TEXT PRIMARY KEY," +
        "  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE," +
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
        ")"
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_aliases_post ON post_aliases(post_id)");
    },
  },
  {
    name: "0006_audit_log",
    up: (db) => {
      // C1：在此之前，任何「文章怎么没了」都只能靠猜
      db.exec(
        "CREATE TABLE IF NOT EXISTS audit_log (" +
        "  id            INTEGER PRIMARY KEY AUTOINCREMENT," +
        "  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL," +
        "  actor_name    TEXT NOT NULL DEFAULT ''," +
        "  action        TEXT NOT NULL," +
        "  target_type   TEXT," +
        "  target_id     TEXT," +
        "  meta_json     TEXT NOT NULL DEFAULT '{}'," +
        "  ip            TEXT NOT NULL DEFAULT ''," +
        "  user_agent    TEXT NOT NULL DEFAULT ''," +
        "  created_at    TEXT NOT NULL" +
        ")"
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC)");
    },
  },
  {
    name: "0007_media_columns",
    up: (db) => {
      // C5：media 表此前只写不读，补齐媒体库需要的字段
      addColumn(db, "media", "width", "INTEGER");
      addColumn(db, "media", "height", "INTEGER");
      addColumn(db, "media", "title", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "media", "sha256", "TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC)");
    },
  },
  {
    name: "0008_comment_ip_index",
    up: (db) => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip, status)");
    },
  },
  {
    name: "0009_fts",
    up: (db) => {
      // C10：原先 LIKE 全表扫 + 把整篇正文回传前端再截断（单篇最大 13,871 B）。
      // trigram 分词让中文子串检索成立；但它要求查询串 >= 3 字符，
      // 1~2 字查询由 lib/search.ts 降级为 LIKE —— 这是刻意的混合策略。
      // 注意：external-content 表的列名必须与被索引表的列名一致（本版本 SQLite 不支持 columnmap）。
      if (hasTable(db, "posts_fts")) return;
      try {
        db.exec(
          "CREATE VIRTUAL TABLE posts_fts USING fts5(" +
          "  title, content, content='posts', content_rowid='id', tokenize='trigram'" +
          ")"
        );
        db.exec(
          "CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN" +
          "  INSERT INTO posts_fts (rowid, title, content) VALUES (new.id, new.title, new.content);" +
          "END"
        );
        db.exec(
          "CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN" +
          "  INSERT INTO posts_fts (posts_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);" +
          "END"
        );
        db.exec(
          "CREATE TRIGGER posts_fts_au AFTER UPDATE OF title, content ON posts BEGIN" +
          "  INSERT INTO posts_fts (posts_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);" +
          "  INSERT INTO posts_fts (rowid, title, content) VALUES (new.id, new.title, new.content);" +
          "END"
        );
        db.prepare("INSERT INTO posts_fts (posts_fts) VALUES ('rebuild')").run();
      } catch (e) {
        // FTS5 不可用时降级为 LIKE 兜底（方案 §5 风险 1），不阻塞其余迁移
        console.warn("[migrations] FTS5 unavailable, search falls back to LIKE:", (e as Error).message);
      }
    },
  },
  {
    name: "0010_page_comments",
    up: (db) => {
      // 页面（page）也能有评论区，但隐私政策这类不该有。
      // 给 posts 加一个开关，默认页面关闭、文章开启（文章本就有评论，不受影响）。
      addColumn(db, "posts", "comments_enabled", "INTEGER NOT NULL DEFAULT 1");
      // 隐私政策默认关掉；其余页面保持开启
      db.prepare("UPDATE posts SET comments_enabled = 0 WHERE type = 'page' AND slug = 'privacy-policy'").run();
    },
  },

  {
    name: "0011_friend_links",
    up: (db) => {
      // 友链/聚合外链（2026-10-23）：此前 settings.friend_links 只是一段自由文本，
      // 全库 0 处渲染 —— 既没有前台展示，也没法在后台逐条增删。
      // 改成独立表：一行一条外链，带排序与显示开关，后台可增删改。
      // sort_order 升序（小的在前），同值时按 id 保序，避免顺序抖动。
      db.exec(
        "CREATE TABLE IF NOT EXISTS friend_links (" +
        "  id         INTEGER PRIMARY KEY AUTOINCREMENT," +
        "  name       TEXT NOT NULL," +
        "  url        TEXT NOT NULL," +
        "  desc       TEXT NOT NULL DEFAULT ''," +
        "  kind       TEXT NOT NULL DEFAULT 'friend'," +
        "  sort_order INTEGER NOT NULL DEFAULT 100," +
        "  visible    INTEGER NOT NULL DEFAULT 1," +
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
        ")"
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_friend_links_order ON friend_links(visible, sort_order, id)");

      // 预置「开往」聚合外链：这是本站明确要求常驻的入口。
      // 只在表为空时插入，避免覆盖用户在后台已有的数据；用户删掉后不会复活（迁移只跑一次）。
      const empty = (db.prepare("SELECT COUNT(*) c FROM friend_links").get() as { c: number }).c === 0;
      if (empty) {
        db.prepare(
          "INSERT INTO friend_links (name, url, desc, kind, sort_order, visible) VALUES (?, ?, ?, ?, ?, 1)"
        ).run(
          "开往",
          "https://www.travellings.cn/go.html",
          "友链接力 · 随机去往一个陌生博客",
          "hub",
          10
        );
      }
    },
  },

  {
    name: "0012_revision_drafts_history",
    up: (db) => {
      /**
       * 阶段 03.1 数据协议（方案 §3）。
       *
       * 解决的核心问题：自动保存若直接写 posts，未发布的修改会立刻暴露到前台。
       * 因此引入三层分离：
       *   posts            —— 公开内容的事实来源，只有显式发布/元数据操作才改
       *   post_drafts      —— 服务端当前草稿，每篇最多一条
       *   post_revisions   —— 不可变的发布/基线历史
       *
       * revision 是**行版本**，不是发布次数：新文章壳为 1，第一次发布通常为 2。
       * 它只用于"检测别人改过没有"，不承担"这是第几次发布"的语义 ——
       * 那个语义由 post_revisions.reason 表达。
       */

      // ---- posts.revision ----
      addColumn(db, "posts", "revision", "INTEGER NOT NULL DEFAULT 1");
      // 已有行默认 revision=1（SQLite 的 ADD COLUMN DEFAULT 会补齐存量行）。

      // ---- post_drafts：每篇最多一个当前服务端草稿 ----
      db.exec(
        "CREATE TABLE IF NOT EXISTS post_drafts (" +
        "  post_id          INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE," +
        "  client_draft_id  TEXT NOT NULL UNIQUE," +
        "  owner_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL," +
        "  base_revision    INTEGER NOT NULL," +
        "  draft_revision   INTEGER NOT NULL DEFAULT 1," +
        "  snapshot_json    TEXT NOT NULL," +
        "  snapshot_hash    TEXT NOT NULL," +
        "  created_at       TEXT NOT NULL," +
        "  updated_at       TEXT NOT NULL," +
        "  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL" +
        ")"
      );
      // PRIMARY KEY(post_id) 同时是"每篇一个草稿"的约束与防并发重复创建的闸门：
      // 两个会话同时发现"无草稿"并各自插入时，后到的那个会撞主键而失败，
      // 不会出现两条草稿互相覆盖。
      db.exec("CREATE INDEX IF NOT EXISTS idx_drafts_owner ON post_drafts(owner_user_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_drafts_updated ON post_drafts(updated_at DESC)");

      // ---- post_revisions：发布/基线历史（不可变） ----
      db.exec(
        "CREATE TABLE IF NOT EXISTS post_revisions (" +
        "  id                 INTEGER PRIMARY KEY AUTOINCREMENT," +
        "  post_id            INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE," +
        "  revision           INTEGER NOT NULL," +
        "  snapshot_json      TEXT NOT NULL," +
        "  snapshot_hash      TEXT NOT NULL," +
        "  reason             TEXT NOT NULL CHECK (reason IN ('baseline','publish'))," +
        "  publish_request_id TEXT," +
        "  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL," +
        "  created_at         TEXT NOT NULL," +
        "  UNIQUE(post_id, revision)" +
        ")"
      );
      // 发布幂等：同一 publishRequestId 只能对应一次成功发布。
      // 用部分索引（WHERE ... IS NOT NULL）而不是普通 UNIQUE，
      // 因为 baseline 的 publish_request_id 全是 NULL，普通 UNIQUE 在 SQLite 里
      // 允许多个 NULL，但语义上强调"只对真实发布请求去重"更清楚。
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_request " +
        "ON post_revisions(publish_request_id) WHERE publish_request_id IS NOT NULL"
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_revisions_post ON post_revisions(post_id, revision DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_revisions_created ON post_revisions(post_id, created_at DESC)");

      // ---- 为所有未删除的现有文章创建 baseline 快照 ----
      //
      // 方案 §3.4 明确禁止在 SQL 里对 categories/tags 调 json()：
      // 现有数据可能含脏 JSON，且 SQL 另写一套格式容易与哈希口径漂移。
      // 所以这里先读出整行，再用共享的 TS 函数（与接口、脚本同一份）
      // 做安全解析 -> canonicalize -> hash -> INSERT。
      const rows = db.prepare(
        "SELECT id, type, title, slug, content, cover, categories, tags, comments_enabled " +
        "FROM posts WHERE deleted_at IS NULL ORDER BY id"
      ).all() as {
        id: number; type: string; title: string; slug: string; content: string;
        cover: string | null; categories: string; tags: string; comments_enabled: number;
      }[];

      const insert = db.prepare(
        "INSERT OR IGNORE INTO post_revisions " +
        "(post_id, revision, snapshot_json, snapshot_hash, reason, publish_request_id, created_by, created_at) " +
        "VALUES (?, ?, ?, ?, 'baseline', NULL, NULL, ?)"
      );

      for (const r of rows) {
        // baseline 快照描述的是"这一版线上内容长什么样"，
        // 因此 revision 取当前 posts.revision（存量行都是 1）。
        const snapshot = {
          type: r.type as "post" | "page" | "shuoshuo",
          title: r.title,
          slug: r.slug,
          content: r.content,
          // cover 允许为 null，且必须显式保留 null —— 不能写成 undefined
          cover: r.cover === null ? null : String(r.cover),
          // 脏 JSON 按既有降级规则处理（解析失败即 []），不抛错、不中断迁移
          categories: safeStringArray(r.categories),
          tags: safeStringArray(r.tags),
          comments_enabled: (r.comments_enabled ? 1 : 0) as 0 | 1,
        };
        const { snapshotJson, snapshotHash } = snapshotIdentity(snapshot);
        // baseline 不伪造原发布时间：created_at 用实际迁移时间，
        // 排序展示按 id/created_at，不能把 revision 当连续发布序号。
        insert.run(r.id, 1, snapshotJson, snapshotHash, new Date().toISOString());
      }
      // 注意：不修改 posts 正文、slug、状态或时间；回收站文章（deleted_at 非空）不建基线。
      // 任一行失败都会抛错，由 migrate() 的事务整体回滚 —— 不接受
      // "部分文章有基线"的启动状态。
    },
  },
];

export function currentVersion(db: Database.Database): string | null {
  if (!hasTable(db, "schema_version")) return null;
  const row = db.prepare("SELECT name FROM schema_version ORDER BY id DESC LIMIT 1").get() as { name: string } | undefined;
  return row?.name ?? null;
}

export function migrate(db: Database.Database): { applied: string[]; version: string | null } {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  name TEXT NOT NULL UNIQUE," +
    "  applied_at TEXT NOT NULL" +
    ")"
  );
  const done = new Set((db.prepare("SELECT name FROM schema_version").all() as { name: string }[]).map((r) => r.name));
  // 按 name 排序后执行：迁移编号本身就是顺序的唯一依据，
  // 这样即使数组里手写顺序错了（曾经把 0010 写在 0009 前面导致 0010 被跳过），也不会漏应用。
  const ordered = [...MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name));
  const applied: string[] = [];
  const ins = db.prepare("INSERT INTO schema_version (name, applied_at) VALUES (?, ?)");
  for (const m of ordered) {
    if (done.has(m.name)) continue;
    db.transaction(() => {
      m.up(db);
      ins.run(m.name, new Date().toISOString());
    })();
    applied.push(m.name);
  }
  return { applied, version: currentVersion(db) };
}

export function migrationNames(): string[] {
  return MIGRATIONS.map((m) => m.name);
}