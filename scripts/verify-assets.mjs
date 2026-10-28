#!/usr/bin/env node
/**
 * 前端资产比对：本地构建产物  vs  线上实际下发的 CSS/JS
 *
 * 解决什么问题：healthz 的 commit 能告诉你"部署的是哪次提交"，但如果是
 * 手工改过服务器文件、或部分文件没覆盖成功，commit 字段照样显示新版本
 * —— 因为 .build-info.json 是随包里一起拷过去的。
 *
 * 这个脚本直接从**线上拉真实资产**，和本地 dist 逐字节比哈希。
 * 对不上就说明产物没完整部署。
 *
 * 用法：
 *   node scripts/verify-assets.mjs                       # 比对线上
 *   node scripts/verify-assets.mjs http://127.0.0.1:8090
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const base = (process.argv[2] || "https://blog.yghsite.cn").replace(/\/+$/, "");
const chunksDir = path.join(process.cwd(), "dist", ".next", "static", "chunks");

const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

if (!fs.existsSync(chunksDir)) {
  console.error(`${RED}✗ 本地没有 dist/.next/static/chunks${OFF}`);
  console.error("  先跑 npm run build && npm run build:dist");
  process.exit(2);
}

// 取本地产物里最大的那个 CSS（就是全站样式主包）
const cssFiles = fs
  .readdirSync(chunksDir)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ f, size: fs.statSync(path.join(chunksDir, f)).size }))
  .sort((a, b) => b.size - a.size);

if (cssFiles.length === 0) {
  console.error(`${RED}✗ 本地 dist 里没有 CSS 产物${OFF}`);
  process.exit(2);
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

/**
 * 比对**每一个**本地 CSS chunk，而不是只挑最大的那个。
 *
 * 旧的判据是「取本地最大的 CSS，当作全站主包，再去比线上首页引用的那份」。
 * 这个假设在 2026-10-28 后台改版后失效了：后台样式（app/admin/admin.css）
 * 现在比前台主包更大，于是脚本把**后台**包当成前台包去比，报出
 * 「文件名不同 / 线上跑的不是这份构建」的假失败 —— 而实际两台机器字节一致。
 *
 * 更稳的判据：CSS 是内容哈希命名的，同名必然同内容。只要本地每个 chunk
 * 都能在线上按同名取到且逐字节一致，就说明产物完整落盘；再单独确认
 * 前台首页与后台入口各自引用到的 CSS 都在这一批里，覆盖「线上引用了一个
 * 本地根本没有的旧文件」这一反向失败。
 */
console.log(`目标  ${base}`);

const localChunks = cssFiles.map(({ f }) => {
  const buf = fs.readFileSync(path.join(chunksDir, f));
  return { name: f, size: buf.length, sha: sha(buf) };
});
for (const c of localChunks) console.log(`本地  ${c.name}  ${c.size}B  sha ${c.sha}`);

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { connection: "close" } });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

const problems = [];

for (const c of localChunks) {
  let remote;
  try {
    remote = await fetchText(`${base}/_next/static/chunks/${c.name}`);
  } catch (e) {
    problems.push(`取不到线上 ${c.name}：${e.message}`);
    continue;
  }
  if (remote.status !== 200) {
    problems.push(`线上没有 ${c.name}（HTTP ${remote.status}）—— 该 chunk 未部署`);
    continue;
  }
  const remoteSha = sha(remote.buf);
  const ok = remoteSha === c.sha;
  console.log(`线上  ${c.name}  ${remote.buf.length}B  sha ${remoteSha}  ${ok ? GREEN + "一致" + OFF : RED + "不一致" + OFF}`);
  if (!ok) problems.push(`${c.name} 字节不一致（本地 ${c.sha} / 线上 ${remoteSha}）—— 可能部署不完整或被改过`);
}

/* 反向检查：线上页面引用的 CSS 必须在本地这一批里 */
const remoteNames = new Set(localChunks.map((c) => c.name));
for (const [label, pathName] of [["首页", "/"], ["后台登录", "/admin/login"]]) {
  let html = "";
  try {
    html = (await fetchText(base + pathName)).buf.toString("utf8");
  } catch (e) {
    problems.push(`取不到线上${label}：${e.message}`);
    continue;
  }
  const refs = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/([\w.-]+\.css)/g)].map((m) => m[1]))];
  if (refs.length === 0) problems.push(`线上${label}没有引用任何 CSS，异常`);
  for (const r of refs) {
    if (!remoteNames.has(r)) problems.push(`线上${label}引用了本地没有的 ${r} —— 线上跑的不是这份构建`);
  }
  console.log(`${DIM}${label} 引用 ${refs.join(", ") || "(无)"}${OFF}`);
}

if (problems.length === 0) {
  console.log(`\n${GREEN}✓ 前端资产一致（${localChunks.length} 个 CSS chunk 全部逐字节匹配）${OFF}`);
  process.exitCode = 0;
} else {
  console.log("");
  for (const p of problems) console.log(`${RED}✗ ${p}${OFF}`);
  console.log(`\n${DIM}提示：本地 dist 是刚构建的，线上需要重新部署才能一致${OFF}`);
  process.exitCode = 1;
}
