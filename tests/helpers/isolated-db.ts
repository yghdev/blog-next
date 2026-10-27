import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

type Cleanup = () => void;
export type IsolatedDb = {
  dir: string;
  dbPath: string;
  cleanup: Cleanup;
};

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "../..");

/** Refuse development/production locations before importing lib/db.ts. */
export function assertIsolatedDataDir(dir: string): void {
  const resolved = path.resolve(dir);
  const tempRoots = [fs.realpathSync(os.tmpdir()), path.join(projectRoot, ".tmp-tests")];
  const safe = tempRoots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!safe) throw new Error("Test DATA_DIR must be inside an isolated temporary directory: " + resolved);
  if (resolved === path.join(projectRoot, "data")) throw new Error("Tests must never use data/blog.db");
}

export function isolatedDataDir(prefix = "posts-"): IsolatedDb {
  const root = path.join(projectRoot, ".tmp-tests");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, prefix));
  assertIsolatedDataDir(dir);
  process.env.DATA_DIR = dir;
  let cleaned = false;
  return {
    dir,
    dbPath: path.join(dir, "blog.db"),
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeAdmin(db: any): { id: number } {
  db.prepare("DELETE FROM users WHERE username = 'test-admin'").run();
  const info = db.prepare(
    "INSERT INTO users (username, password_hash, totp_enabled, role, created_at) VALUES ('test-admin', 'not-used', 0, 'admin', datetime('now'))"
  ).run();
  return { id: Number(info.lastInsertRowid) };
}

export function setTestSession(token: string | null): void {
  const store = {
    get(name: string) {
      return name === "blog_session" && token ? { name, value: token } : undefined;
    },
    set() {},
    delete() {},
  };
  (globalThis as any).__blogTestNext.cookies = async () => store;
}

export function installTestSession(db: any): { token: string; userId: number } {
  const { id } = makeAdmin(db);
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at, user_agent, ip, auth_at) " +
    "VALUES (?, ?, ?, ?, ?, '', '', ?)"
  ).run(hash, id, "2999-01-01T00:00:00.000Z", now, now, now);
  setTestSession(token);
  return { token, userId: id };
}

export function postPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "post",
    title: "Baseline article",
    content: "# Heading\n\nBody with **Markdown**.",
    status: "draft",
    categories: [],
    tags: [],
    ...overrides,
  };
}
