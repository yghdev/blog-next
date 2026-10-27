/**
 * 隔离集成测试的种子数据：一个管理员 + 一条真实会话。
 *
 * 必须导出 `createSession()` 的**真实返回值**，而不是自己再造一个随机串：
 * 会话表里只存 token 的 SHA-256，随手 randomBytes 出来的串根本查不到会话，
 * 测试却会「看起来拿到了 token」—— 2026-10-27 验收时实测 exportedTokenValid=false。
 * 那种假 token 一旦被当成 Cookie 用，401 会伪装成别的失败，极难定位。
 */
import bcrypt from "bcryptjs";
import { getDb, closeDb } from "../../lib/db.ts";
import { createSession } from "../../lib/session.ts";

const db = getDb();
const username = "integration-admin";
const password = "integration-password";

db.prepare("INSERT INTO users (username, password_hash, totp_enabled, role, created_at) VALUES (?, ?, 0, 'admin', ?)")
  .run(username, bcrypt.hashSync(password, 4), new Date().toISOString());
const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
const { token } = createSession(user.id);
closeDb();

// 只回给父进程：token 是明文会话凭据，不进任何持久文件
process.stdout.write("::BLOG_TEST_FIXTURE::" + JSON.stringify({ username, password, token }) + "\n");
