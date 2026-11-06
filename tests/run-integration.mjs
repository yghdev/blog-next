#!/usr/bin/env node
/**
 * 集成测试收集式执行器（阶段 A 收尾，2026-10-31）。
 *
 * ## 为什么需要它
 *
 * 原来 `test:integration` 是一长串 `npm run a && npm run b && …`。
 * `&&` 的语义是**首个失败立即中断**，于是：
 *
 *   - 排在失败项之后的所有套件**根本不会执行**，它们的状态是未知的，
 *     但报告里看起来"什么都没坏"；
 *   - 一次只能修一个失败，修完再跑又冒出下一个 —— 修复成本被串行化；
 *   - 2026-10-31 实测：`test:next` 一个假红把后面 15 个套件全遮住了，
 *     其中 `test:editor` 还有一个独立的假红，藏了整整一周没人知道。
 *
 * 这个执行器把「跑」和「判定」拆开：**全部跑完，再统一判定**。
 * 任何子套件失败都不会阻止后面的执行，最终以非零退出码报告失败。
 *
 * ## 输出约定
 *
 *   每个套件一行实时结果 + 末尾一张汇总表：
 *     ✅ pass    ❌ fail    ⏭️ skip（本次未启用）
 *
 *   失败套件的**最后 40 行**stderr/stdout 会被保留下来 —— 足够看清断言，
 *   又不至于把整个日志刷掉。完整日志落在 `.tmp-tests/integration-logs/`。
 *
 * ## 用法
 *
 *   npm run test:integration           # 跑全部
 *   npm run test:integration -- --only=test:next,test:editor
 *   npm run test:integration -- --list # 只列出套件
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, ".tmp-tests", "integration-logs");

/**
 * 套件清单。顺序即执行顺序：**先快后慢**，这样最便宜的反馈最早到。
 * 每个条目说明它覆盖什么 —— 失败时看名字就知道该去哪个文件。
 */
const SUITES = [
  { name: "test:next",        label: "HTTP 集成（缓存 / 308 / 搜索 / RSS / sitemap）" },
  { name: "test:legacy",      label: "旧 WordPress 日期路径（308 / 归档 / 不过度接管）" },
  { name: "test:browser",     label: "双 context 隔离（storage + cookies）" },
  { name: "test:ui",          label: "UI 原子件与热区" },
  { name: "test:layout",      label: "布局回归（滚动容器唯一性 / sticky 对齐 / 10 档断点）" },
  { name: "test:dark",        label: "暗色主题一致性" },
  { name: "test:motion",      label: "减弱动效（prefers-reduced-motion）" },
  { name: "test:admin",       label: "后台侧栏导航与概览" },
  { name: "test:content",     label: "后台内容列表" },
  { name: "test:comments",    label: "评论审核" },
  { name: "test:media",       label: "媒体库" },
  { name: "test:settings",    label: "设置 / 日志" },
  { name: "test:autosave",    label: "编辑器自动保存" },
  { name: "test:editor",      label: "编辑器六道门槛" },
  { name: "test:workbench",   label: "编辑工作台" },
  { name: "test:publish",     label: "发布回归" },
  { name: "test:media-editor", label: "编辑器内媒体" },
  { name: "test:cmdk",        label: "命令面板" },
  { name: "test:friends",     label: "友链专题页（页面 + 边界态）" },
];

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)) : null;
const LIST = argv.includes("--list");

if (LIST) {
  for (const s of SUITES) console.log(s.name.padEnd(20), s.label);
  process.exit(0);
}

const SELECTED = ONLY ? SUITES.filter((s) => ONLY.has(s.name)) : SUITES;
if (SELECTED.length === 0) {
  console.error("没有匹配的套件：" + [...ONLY].join(", "));
  process.exit(2);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runLogDir = path.join(LOG_DIR, stamp);
fs.mkdirSync(runLogDir, { recursive: true });

/** 跑一个 npm script，实时透传输出并留全量日志 */
function runSuite(suite) {
  return new Promise((resolve) => {
    const logPath = path.join(runLogDir, suite.name.replace(/:/g, "-") + ".log");
    const fd = fs.openSync(logPath, "w");
    const child = spawn("npm", ["run", suite.name], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks = [];
    const collect = (buf) => {
      chunks.push(buf);
      fs.writeSync(fd, buf);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("close", (code, signal) => {
      fs.closeSync(fd);
      resolve({
        suite,
        code: code ?? -1,
        signal,
        logPath,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
    child.on("error", (err) => {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
      resolve({ suite, code: -1, signal: null, logPath, output: String(err) });
    });
  });
}

/** 从输出里提炼一行「结论」（套件自己的最后一条 PASS/All 行） */
function digest(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const tail = lines.filter((l) => /^(All |\d+\/\d+ 通过|PASS |FAIL |ok |# (pass|fail))/.test(l));
  return tail.length ? tail[tail.length - 1].slice(0, 110) : (lines[lines.length - 1] || "").slice(0, 110);
}

function tailOf(output, n = 40) {
  const lines = output.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

const started = Date.now();
console.log("集成测试收集式执行：" + SELECTED.length + " 个套件（失败不会中断后续）");
console.log("完整日志：" + path.relative(ROOT, runLogDir));
console.log("");

const results = [];
for (let i = 0; i < SELECTED.length; i++) {
  const suite = SELECTED[i];
  const n = String(i + 1).padStart(2, " ");
  process.stdout.write("[" + n + "/" + SELECTED.length + "] " + suite.name.padEnd(20) + " 运行中…\r");
  const t0 = Date.now();
  const r = await runSuite(suite);
  r.ms = Date.now() - t0;
  results.push(r);

  const status = r.code === 0 ? "✅ pass" : "❌ fail";
  process.stdout.write(
    "[" + n + "/" + SELECTED.length + "] " + suite.name.padEnd(20) + " " +
    status + "  " + (r.ms / 1000).toFixed(1) + "s  " + digest(r.output) + "\n"
  );
}

/* ────────────────────────── 汇总 ────────────────────────── */

const passed = results.filter((r) => r.code === 0);
const failed = results.filter((r) => r.code !== 0);

console.log("\n" + "═".repeat(78));
console.log("汇总：" + passed.length + " 通过 / " + failed.length + " 失败 / " + results.length + " 总计" +
  "  用时 " + ((Date.now() - started) / 1000).toFixed(1) + "s");
console.log("═".repeat(78));

for (const r of results) {
  const status = r.code === 0 ? "✅" : "❌";
  console.log(status + "  " + r.suite.name.padEnd(20) + " exit=" + String(r.code).padEnd(3) +
    " " + (r.ms / 1000).toFixed(1).padStart(6) + "s   " + r.suite.label);
}

if (failed.length > 0) {
  console.log("\n" + "─".repeat(78));
  console.log("失败详情（每个套件最后 40 行，完整日志见 " + path.relative(ROOT, runLogDir) + "）");
  for (const r of failed) {
    console.log("\n▶ " + r.suite.name + "  exit=" + r.code + (r.signal ? " signal=" + r.signal : ""));
    console.log("  日志：" + path.relative(ROOT, r.logPath));
    console.log("─".repeat(78));
    console.log(tailOf(r.output, 40));
  }
  console.log("\n" + "❌ 集成测试未全部通过：" + failed.length + " 个套件失败 —— " +
    failed.map((r) => r.suite.name).join(", "));
  process.exit(1);
}

console.log("\n✅ 全部 " + passed.length + " 个集成套件通过。");
process.exit(0);
