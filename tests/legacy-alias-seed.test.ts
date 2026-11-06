import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isolatedDataDir } from "./helpers/isolated-db.ts";

/**
 * `scripts/seed-legacy-aliases.mjs` 的行为测试。
 *
 * 这个脚本会往生产库的 post_aliases 写数据，所以「写对了」不是唯一要求：
 *   - dry-run 必须真的不写（否则"先看看"变成"已经改了"）
 *   - 重复执行必须幂等（部署脚本可能被重跑）
 *   - 别名已指向别的文章时**不许覆盖**（那会把旧链接改跳到另一篇上）
 */

const isolated = isolatedDataDir("legacy-alias-");
process.env.DATA_DIR = isolated.dir;
const dbMod = await import("../lib/db.ts");
const ROOT = process.cwd();

let db: ReturnType<typeof dbMod.getDb>;

function runScript(args: string[] = []) {
  return execFileSync("node", [path.join("scripts", "seed-legacy-aliases.mjs"), ...args], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: isolated.dir },
    encoding: "utf8",
  });
}

function insertPost(slug: string, wpId: number) {
  return Number(
    db
      .prepare(
        "INSERT INTO posts (type, title, slug, content, status, wp_id, published_at) VALUES ('post',?,?,'','published',?,?)"
      )
      .run(slug, slug, wpId, "2026-06-07T00:00:00.000Z").lastInsertRowid
  );
}

before(() => {
  db = dbMod.getDb();
  insertPost("十大经典排序算法", 151);
  insertPost("博客迁移记录", 232);
  insertPost("claude-code-安装和接入-deepseek", 222);
  insertPost("给部落造一个数据中枢：我用-ai-结对开发写了个-coc-战", 109);
  dbMod.closeDb(); // 脚本会自己打开同一个库文件
});

after(() => {
  isolated.cleanup();
});

test("seed: dry-run 只报告、不写库", () => {
  const out = runScript();
  assert.match(out, /将写入 4 条/);
  assert.match(out, /dry-run/);
  const check = dbMod.getDb().prepare("SELECT COUNT(*) AS n FROM post_aliases").get() as { n: number };
  assert.equal(check.n, 0, "dry-run 不应写任何别名");
  dbMod.closeDb();
});

test("seed: --apply 写入四条，且重复执行幂等", () => {
  const out = runScript(["--apply"]);
  assert.match(out, /已写入 4 条/);

  const rows = dbMod
    .getDb()
    .prepare(
      "SELECT a.slug, p.slug AS target FROM post_aliases a JOIN posts p ON p.id = a.post_id ORDER BY a.slug"
    )
    .all() as { slug: string; target: string }[];
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => [r.slug, r.target]).sort(),
    [
      ["Claude-Code-安装与接入DeepSeek及使用指南", "claude-code-安装和接入-deepseek"],
      ["coc助手", "给部落造一个数据中枢：我用-ai-结对开发写了个-coc-战"],
      ["构建历程", "博客迁移记录"],
      ["十大排序算法", "十大经典排序算法"],
    ].sort()
  );
  dbMod.closeDb();

  const again = runScript(["--apply"]);
  assert.match(again, /已写入 0 条，已存在 4 条/);
});

test("seed: 别名已指向别的文章时拒绝覆盖", () => {
  const targetId = (
    dbMod.getDb().prepare("SELECT id FROM posts WHERE slug = ?").get("十大经典排序算法") as { id: number }
  ).id;
  // 把旧 slug 指向另一篇，模拟"人工已在后台改过"
  dbMod.getDb().prepare("DELETE FROM post_aliases WHERE slug = ?").run("coc助手");
  dbMod.getDb()
    .prepare("INSERT INTO post_aliases (slug, post_id) VALUES (?, ?)")
    .run("coc助手", targetId);
  dbMod.closeDb();

  const out = runScript(["--apply"]);
  assert.match(out, /冲突！ coc助手/);
  const row = dbMod
    .getDb()
    .prepare("SELECT post_id FROM post_aliases WHERE slug = ?")
    .get("coc助手") as { post_id: number };
  assert.equal(row.post_id, targetId, "已存在的别名不能被脚本改指向");
  dbMod.closeDb();
});
