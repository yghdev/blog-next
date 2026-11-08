#!/usr/bin/env node
/**
 * 在 Linux 环境里产出部署包 dist-upload.tar.gz，并可选地一路发布到线上。
 *
 * 为什么需要它（2026-11-08 从 WSL 迁到 Windows 后实测）：
 *   better-sqlite3 与 sharp 的原生二进制是**平台相关**的。在 Windows 上跑 build:dist，
 *   打进产物的是 better_sqlite3.node（MZ/PE）和缺失的 @img/sharp-linux-x64；部署到 Ubuntu 后
 *   第一行 require 就崩。package-standalone.mjs 里的 pruneForeignPlatformArtifacts() 假设
 *   "构建机就是 linux x64"，它会主动剔除 win32 产物 —— 在 Windows 上剔完就是空的。
 *
 * 所以构建必须发生在 linux x64 里（本机 Docker Desktop 即可）：node_modules 装的就是 linux
 * 原生包，产物才和服务器一致。
 *
 * 用法：
 *   node scripts/release-linux.mjs                 # 只构建，产物在仓库根 dist-upload.tar.gz
 *   node scripts/release-linux.mjs --deploy        # 构建 + 上传 + 远程原子部署 + 版本核对
 *   node scripts/release-linux.mjs --allow-dirty   # 跳过"工作区必须干净"（产物标 dirty，仅用于验证链路）
 *   node scripts/release-linux.mjs --image=node:22-bookworm
 *
 * 前置：Windows/macOS 上需要 Docker Desktop 已启动；linux 上直接本地构建。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forceRemove } from "./materialize-native-deps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const DO_DEPLOY = ARGS.includes("--deploy");
const ALLOW_DIRTY = ARGS.includes("--allow-dirty");
const IMAGE = (ARGS.find((a) => a.startsWith("--image=")) || "--image=node:22-bookworm").slice("--image=".length);
const HOST = process.env.DEPLOY_HOST || "aliyun-ecs";
const BASE = process.env.DEPLOY_BASE || "https://blog.yghsite.cn";

/** 只取输出（用于读版本号/哈希）；失败即抛。 */
function cap(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", ...(opts || {}) }).trim();
}
/** 直通输出（用于 docker build / ssh / scp 这类长流程）。 */
function run(cmd, args, opts) {
  execFileSync(cmd, args, { stdio: "inherit", ...(opts || {}) });
}
const step = (m) => console.log("\n\u001b[1m== " + m + " ==\u001b[0m");
const die = (m) => { console.error("\u001b[31m!! " + m + "\u001b[0m"); process.exit(1); };
const toDockerPath = (p) => p.replace(/\\/g, "/");

const ROOT = cap("git", ["-C", HERE, "rev-parse", "--show-toplevel"]);
const ARCHIVE = path.join(ROOT, "dist-upload.tar.gz");

/* 容器（或本机 linux）里执行的构建脚本：POSIX sh，逐步失败即非零退出。 */
const BUILD_SCRIPT = [
  "set -euo pipefail",
  "node -v; npm -v; uname -m",
  "command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }",
  "mkdir -p /work && cd /work && rm -rf repo && mkdir repo",
  "tar -C /src -cf - --exclude=./node_modules --exclude=./.next --exclude=./dist \\",
  "  --exclude=./.tmp-tests --exclude=./.tmp-review --exclude=./.tmp-audit \\",
  "  --exclude='*.tar.gz' . | tar -C repo -xf -",
  "cd repo",
  "echo '-- npm ci'",
  "npm ci --no-audit --no-fund",
  "echo '-- next build'",
  "npm run build",
  "echo '-- build:dist'",
  "npm run build:dist",
  "echo '-- 原生二进制自检'",
  "fail=0",
  "for f in $(find dist -name '*.node'); do",
  "  magic=$(head -c 4 \"$f\" | od -An -tx1 | tr -d ' \\n')",
  "  case \"$magic\" in",
  "    7f454c46) echo \"   ELF  $f\" ;;",
  "    4d5a*)    echo \"   PE!!  $f\"; fail=1 ;;",
  "    *)        echo \"   ??  $f ($magic)\"; fail=1 ;;",
  "  esac",
  "done",
  "for p in @img/sharp-linux-x64 @img/sharp-libvips-linux-x64; do",
  "  [ -d \"dist/node_modules/$p\" ] || { echo \"缺少 $p\"; fail=1; }",
  "done",
  "[ -f dist/node_modules/better-sqlite3/build/Release/better_sqlite3.node ] || { echo '缺少 better_sqlite3.node'; fail=1; }",
  "[ \"$fail\" = 0 ] || { echo '产物原生依赖不自洽，拒绝出包'; exit 3; }",
  "cat dist/.build-info.json",
  "rm -f /out/dist-upload.tar.gz",
  "tar czf /out/dist-upload.tar.gz -C dist .",
  "sha256sum /out/dist-upload.tar.gz",
].join("\n");

/* ── 1. 预检 ─────────────────────────────────────────────── */
step("1/4 预检");
const branch = cap("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"]);
const head = cap("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
const dirty = cap("git", ["-C", ROOT, "status", "--porcelain"]);
console.log("分支 " + branch + " · HEAD " + head);
if (dirty) {
  console.log(dirty.split(/\r?\n/).slice(0, 8).join("\n"));
  if (!ALLOW_DIRTY) die("工作区有未提交改动。产物必须对应可复现的 commit；确认无误可加 --allow-dirty（产物不可上线）。");
  console.warn("!! 工作区不干净，产物会被标 dirty —— 只用它验证构建链路，别上线");
}

/* ── 2. 构建 ─────────────────────────────────────────────── */
const native = process.platform === "linux" && process.env.FORCE_DOCKER !== "1";
step("2/4 构建（" + (native ? "本机 linux" : "docker " + IMAGE) + "）");
if (native) {
  const script = BUILD_SCRIPT.replace(/\/out\//g, toDockerPath(ROOT) + "/");
  run("bash", ["-lc", script], { cwd: ROOT });
} else {
  try { cap("docker", ["version", "--format", "{{.Server.Version}}"]); }
  catch { die("Docker 没就绪：先启动 Docker Desktop（或装好 linux 构建环境）。"); }
  const outDir = path.join(os.tmpdir(), "blog-dist-out");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  run("docker", ["run", "--rm",
    "-v", toDockerPath(ROOT) + ":/src:ro",
    "-v", toDockerPath(outDir) + ":/out",
    IMAGE, "bash", "-lc", BUILD_SCRIPT]);
  fs.copyFileSync(path.join(outDir, "dist-upload.tar.gz"), ARCHIVE);
  fs.rmSync(outDir, { recursive: true, force: true });
}

/* ── 3. 校验产物 ─────────────────────────────────────────── */
step("3/4 校验产物");
const list = cap("tar", ["-tzf", ARCHIVE], { maxBuffer: 128 * 1024 * 1024 }).split(/\r?\n/);
if (!list.includes("./server.js")) die("归档里没有 ./server.js，层级打错了");
if (!list.includes("./.build-info.json")) die("归档里没有版本戳");
if (!list.some((e) => e.startsWith("./node_modules/"))) die("归档里没有 node_modules，build:dist 可能没跑");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bi-"));
cap("tar", ["-xzf", ARCHIVE, "-C", tmp, "./.build-info.json"]);
const info = JSON.parse(fs.readFileSync(path.join(tmp, ".build-info.json"), "utf8"));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("版本 " + info.shortCommit + " · reproducible=" + info.reproducible + " · builtBy=" + info.builtBy + " · node=" + info.nodeVersion);
if (!ALLOW_DIRTY && info.reproducible !== true) die("产物标记为不可复现（dirty），停止");
const size = (fs.statSync(ARCHIVE).size / 1048576).toFixed(1);
const sum = cap("node", ["-e",
  "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))",
  ARCHIVE]);
console.log("归档 " + size + " MB · sha256 " + sum.slice(0, 16) + "…  → " + ARCHIVE);

/*
 * 把产物展开到本地 dist/。
 *
 * 为什么必须做这一步（2026-11-08 首次实跑部署时踩到）：verify-assets.mjs 拿
 * dist/.next/static/chunks 里的本地文件去和线上逐字节比哈希，而容器构建的 dist
 * 在容器里、跑完就没了 —— 于是部署明明成功，最后一步却以
 * 「本地没有 dist/.next/static/chunks」exit 2 收场。
 *
 * 注意必须用 forceRemove 而不是 fs.rmSync：Windows 上 rmSync 会**跟进** junction
 * 把链接目标里的真实文件删掉（详见 materialize-native-deps.mjs 的说明）。
 */
if (DO_DEPLOY) {
  const distDir = path.join(ROOT, "dist");
  forceRemove(distDir);
  fs.mkdirSync(distDir, { recursive: true });
  cap("tar", ["-xzf", ARCHIVE, "-C", distDir]);
  console.log("已展开到 dist/（供 verify-assets 做逐字节比对）");
}

if (!DO_DEPLOY) {
  step("4/4 停在构建完成");
  console.log("确认无误后：node scripts/release-linux.mjs --deploy");
  process.exit(0);
}

/* ── 4. 上传 + 远程部署 + 核对 ───────────────────────────── */
step("4/4 上传并部署到 " + HOST);
const REMOTE = "/tmp/blog-dist-" + info.shortCommit + ".tar.gz";
run("scp", ["-o", "BatchMode=yes", ARCHIVE, HOST + ":" + REMOTE]);
const remoteSum = cap("ssh", ["-o", "BatchMode=yes", HOST, "sha256sum " + REMOTE + " | cut -d' ' -f1"]);
if (remoteSum !== sum) die("上传后哈希不一致（" + remoteSum + " ≠ " + sum + "）：传输被截断，别继续");
console.log("哈希一致");
run("ssh", ["-o", "BatchMode=yes", HOST, "/opt/blog/deploy.sh " + REMOTE]);
/*
 * 两个核对各跑一次，失败**不中断**后续步骤 —— 但要在最后如实报错。
 * 原因：走到这里线上已经切换完成，此时提前 throw 会掩盖"部署成功、核对失败"
 * 这个真实状态，还会跳过服务器 /tmp 的清理（曾有 107MB 包留在 /tmp 里）。
 */
let verifyFailed = false;
const verify = (label, file, arg) => {
  try {
    run("node", [path.join(ROOT, "scripts", file), arg], { cwd: ROOT });
    return true;
  } catch {
    console.error("!! " + label + " 未通过（见上面输出）");
    verifyFailed = true;
    return false;
  }
};
verify("版本一致性核对", "verify-deploy.mjs", BASE + "/api/healthz");
verify("静态资产逐字节核对", "verify-assets.mjs", BASE);
try { cap("ssh", ["-o", "BatchMode=yes", HOST, "rm -f /tmp/blog-dist-*.tar.gz"]); console.log("已清理服务器 /tmp/blog-dist-*.tar.gz"); }
catch { console.warn("!! 远程清理失败（不影响线上）"); }

if (verifyFailed) {
  die("部署已经切到 " + info.shortCommit + "，但核对没通过 —— 不要当成发布成功。\n   回滚：ssh " + HOST + " '/opt/blog/deploy.sh --rollback'");
}
console.log("\n发布完成：" + info.shortCommit + " -> " + BASE);
console.log("回滚：ssh " + HOST + " '/opt/blog/deploy.sh --rollback'");
