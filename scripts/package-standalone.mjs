#!/usr/bin/env node
/**
 * 把 standalone 产物组装成可直接部署的目录 dist/
 *
 * 注意：.next/standalone 里有符号链接（Next.js 用来避免重复打包原生模块，
 * 例如 .next/node_modules/better-sqlite3-<hash> -> node_modules/better-sqlite3）。
 * Linux 上 tar 会原样保留；Windows 上我们要把它"实体化"成目录，否则复制会失败。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "dist");
const STANDALONE = path.join(ROOT, ".next", "standalone");

/**
 * 递归删除。两个必须绕开的坑：
 *
 * 1) Windows 上遇到只读文件会 EPERM，而 public/ 里就有 444 的文件
 *    （历史上被手工改成只读，git 也保留了位）。
 * 2) **Node 24 在 Windows 上，fs.rmSync 删除某些中文文件名会直接让进程
 *    崩溃（0xC0000409），try/catch 完全接不住** —— 实测 "做.md" 必崩，
 *    而 "中文.md" 正常。这不是权限问题，换个目录、换台机器症状一致。
 *    改用 unlinkSync + rmdirSync 手动递归则一切正常。
 *
 * dist/ 里含大量中文文件名（out/posts/*.md），所以这里绝不能用 rmSync。
 */
function forceRemove(target) {
  if (!fs.existsSync(target)) return;
  const st = fs.lstatSync(target);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target)) forceRemove(path.join(target, e));
    try { fs.chmodSync(target, 0o666); } catch { /* 已经可写 */ }
    fs.rmdirSync(target);
    return;
  }
  try { fs.chmodSync(target, 0o666); } catch { /* 已经可写 */ }
  fs.unlinkSync(target);
}

forceRemove(OUT);
fs.mkdirSync(OUT, { recursive: true });

/**
 * 收集"源树里的坏软链"。
 *
 * 为什么不再静默 skip：Windows 上 .next/standalone/.next/node_modules/<pkg>-<hash>
 * 是一条指向不存在目标的软链，静默跳过后产物里就少了这个包，
 * 线上启动直接 Cannot find module —— 2026-10-26 那次部署失败就是这么来的。
 *
 * 这里只记录不抛出（pnpm 风格的依赖树里可能本来就有无害的坏链），
 * 真正的正确性由 patchNestedNativeDeps() 末尾对 .nft.json 的硬校验兜住，
 * 这里负责把问题**打印出来**，不再让它消失在一条 warn 里。
 */
const danglingLinks = [];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);

    let stat;
    try { stat = fs.lstatSync(s); } catch { continue; }

    if (stat.isSymbolicLink()) {
      // 解析链接目标，实体化复制
      let target;
      try { target = fs.realpathSync(s); } catch {
        danglingLinks.push(s);
        console.warn("dangling link, skip:", s);
        continue;
      }
      const tstat = fs.statSync(target);
      if (tstat.isDirectory()) copyDir(target, d);
      else fs.copyFileSync(target, d);
      continue;
    }

    if (stat.isDirectory()) copyDir(s, d);
    else {
      // 目标可能是上次留下的只读文件，先解锁再覆盖
      if (fs.existsSync(d)) { try { fs.chmodSync(d, 0o666); } catch { /* ignore */ } }
      fs.copyFileSync(s, d);
    }
  }
}

copyDir(STANDALONE, OUT);
copyDir(path.join(ROOT, ".next", "static"), path.join(OUT, ".next", "static"));
if (fs.existsSync(path.join(ROOT, "public"))) copyDir(path.join(ROOT, "public"), path.join(OUT, "public"));
copyDir(path.join(ROOT, "scripts"), path.join(OUT, "scripts"));
if (fs.existsSync(path.join(ROOT, "content"))) copyDir(path.join(ROOT, "content"), path.join(OUT, "content"));
if (fs.existsSync(path.join(ROOT, "deploy"))) copyDir(path.join(ROOT, "deploy"), path.join(OUT, "deploy"));

/**
 * C3：standalone 只追踪 Next 自己能静态分析的依赖。
 * bcryptjs / otpauth / marked / gray-matter 这类通过运行时 require 或动态路径引入的
 * 依赖不会被 trace 进来 —— 这正是 README 要求「在服务器上 npm install --no-save」
 * 的原因，而那个步骤一旦漏掉就是 500。
 *
 * 这里把 package.json 的 dependencies 全部从本地 node_modules 补进产物，
 * 让部署不再需要服务器联网装包。
 */
function copyRuntimeDeps() {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const deps = Object.keys(pkg.dependencies || {});
  const src = path.join(ROOT, "node_modules");
  const dst = path.join(OUT, "node_modules");
  let copied = 0;
  const missing = [];

  // 递归收集依赖的依赖，避免只拷一级导致运行时缺包
  const seen = new Set();
  function walk(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const from = path.join(src, name);
    if (!fs.existsSync(from)) { missing.push(name); return; }
    const to = path.join(dst, name);
    /**
     * 不能因为目标已存在就跳过（原实现是 `if (!exists) copy`）。
     *
     * standalone 会给 native 依赖留一个**只含 package.json 的空壳**目录
     * （better-sqlite3 就是这样），真正的二进制和 lib/ 靠符号链接指过去。
     * 若一路跳过，产物里就只剩个 package.json，运行时报
     * "Cannot find module ...better-sqlite3-<hash>"。
     *
     * copyDir 本身是覆盖式递归复制，直接调用即可把空壳补齐。
     */
    copyDir(from, to);
    copied++;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8")); } catch { return; }
    for (const dep of Object.keys(meta.dependencies || {})) walk(dep);
    for (const dep of Object.keys(meta.optionalDependencies || {})) walk(dep);
  }
  for (const d of deps) walk(d);
  if (missing.length) console.warn("!! 缺少依赖（未安装）：", missing.join(", "));
  console.log("运行时依赖已补入产物：", copied, "个包");
}

copyRuntimeDeps();

/**
 * 修补 .next/node_modules 下的 native 依赖副本（必须在 copyRuntimeDeps 之后）。
 *
 * Next 的 standalone 输出会把 serverExternalPackages（这里是 better-sqlite3）
 * 放两处：
 *   1) node_modules/better-sqlite3           <- 只有 package.json 的空壳
 *   2) .next/node_modules/better-sqlite3-<hash> <- 软链，指向上面那个空壳
 * 真正的 lib/ 与 build/Release/*.node 都不在 standalone 里。
 *
 * copyDir 遇到软链会 realpathSync 解析后复制，但解析到的就是空壳，
 * 于是产物里只剩 package.json，运行时直接
 * "Cannot find module .../lib/index.js"。
 *
 * copyRuntimeDeps 已把完整依赖补进 dist/node_modules/better-sqlite3，
 * 这里把 .next/node_modules 下的副本也补齐（Windows 上软链已被实体化成目录，
 * Linux 上则需要单独处理）。
 */
function patchNestedNativeDeps() {
  const srcRoot = path.join(OUT, "node_modules");
  const nestedRoot = path.join(OUT, ".next", "node_modules");

  /**
   * 2026-10-26 重写：改成**由 .nft.json 反查**，不再遍历目录项。
   *
   * 上一版是 `for (const entry of readdirSync(nestedRoot))` —— 只修补"已经存在的条目"。
   * 而 Windows 上 .next/standalone/.next/node_modules 里那个软链是**坏的**
   * （readlink 得到 /better-sqlite3-<hash>，目标不存在），copyDir 会
   * "dangling link, skip" 之后一个都不留 —— 目录是空的，于是这段修补
   * 什么也没做，产物里就缺 better-sqlite3-<hash>。
   *
   * 线上表现：启动即
   *   Failed to load external module better-sqlite3-90e2652d1716b047
   *   Cannot find module 'better-sqlite3-90e2652d1716b047'
   * 探活失败 -> deploy.sh 自动回滚（2026-10-26 19:56 那次）。
   *
   * 现在：直接从构建产物里的 *.nft.json 抓出所有 "包名-<hash>" 引用，
   * 以它为唯一事实来源逐个实体化。目录里有没有条目都不影响。
   */
  const wanted = new Map(); // nestedName -> real package name

  function scanNft(dir, depth = 0) {
    if (depth > 10) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "node_modules") continue; // 别钻到依赖里
      const q = path.join(dir, e.name);
      if (e.isDirectory()) { scanNft(q, depth + 1); continue; }
      if (!e.name.endsWith(".nft.json")) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(q, "utf8")); } catch { continue; }
      for (const f of data.files || []) {
        // files 里是相对该 .nft.json 的路径，形如
        //   ../../../../.next/node_modules/better-sqlite3-<hash>/lib/index.js
        // 只关心 node_modules 下"包名-16位hex"这种 Next 改写过的名字
        // 注意结尾：nft 里的条目可能**不带**尾随斜杠，例如
        //   ../../../../../../node_modules/better-sqlite3-90e2652d1716b047
        // 上一版正则强制要求后面还有 /，于是全都匹配不到（实测踩过）。
        const m = f.match(/node_modules[\\/]([^\\/]+-[0-9a-f]{16})(?:[\\/]|$)/);
        if (m) wanted.set(m[1], m[1].replace(/-[0-9a-f]{16}$/, ""));
      }
    }
  }
  scanNft(path.join(OUT, ".next"));

  if (wanted.size === 0) {
    console.log("未在 .nft.json 中发现嵌套 native 依赖（无需修补）");
    return;
  }

  fs.mkdirSync(nestedRoot, { recursive: true });

  const missing = [];
  for (const [nestedName, pkgName] of wanted) {
    const realSrc = path.join(srcRoot, pkgName);
    if (!fs.existsSync(realSrc)) { missing.push(pkgName + "（源包不存在）"); continue; }
    const target = path.join(nestedRoot, nestedName);
    forceRemove(target);
    copyDir(realSrc, target);
    console.log("已实体化嵌套 native 依赖：", nestedName, "<-", pkgName);
  }

  /**
   * 这里是硬校验，不再是 warning。
   * 这个目录空了就等于服务起不来，必须在打包阶段炸掉，
   * 而不是等到线上探活失败再回滚。
   */
  for (const [nestedName] of wanted) {
    const idx = path.join(nestedRoot, nestedName, "package.json");
    if (!fs.existsSync(idx)) missing.push(nestedName + "（实体化后仍缺 package.json）");
  }
  if (missing.length) {
    console.error("!! 嵌套 native 依赖缺失：", missing.join(", "));
    console.error("!! 产物不可部署 —— 运行时会报 Cannot find module '<pkg>-<hash>'");
    process.exit(1);
  }
}

patchNestedNativeDeps();

/**
 * 剔除平台无关的构建产物（2026-10-23）。
 *
 * 背景：copyRuntimeDeps 会按 package.json 的 dependencies 递归复制整个包，
 * 于是 @next/swc-win32-x64-msvc（105MB 的 Windows 专用 .node 二进制）也被打进产物。
 * 它在 Linux 服务器上永远不会被加载 —— 只在 next build（构建期）通过
 * next/dist/build/swc 解析，运行期 SSR 完全不需要。
 *
 * 实测：移除后 healthz / 首页 / 手机侧栏全部正常（见 2026-10-23 验证记录）。
 * 产物 368MB -> 264MB。同时剔除 @img/sharp-* 里非 linux-x64 的平台包。
 */
function pruneForeignPlatformArtifacts() {
  const nm = path.join(OUT, "node_modules");
  if (!fs.existsSync(nm)) return;
  let reclaimed = 0;
  const dirSize = (p) => {
    let t = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      try { t += e.isDirectory() ? dirSize(q) : fs.statSync(q).size; } catch { /* skip */ }
    }
    return t;
  };
  // 服务器是 linux x64；darwin/freebsd/win32/musl/arm 等一律清理
  const FOREIGN = /-(darwin|freebsd|win32|linuxmusl|linux-arm|linux-ppc64|linux-riscv64|linux-s390x|webcontainers)-/;

  /**
   * 明确剔除的包（2026-10-26 补）。
   *
   * @next/swc-* 是 **构建期** 用的 Rust 编译器，运行期 SSR 完全不需要：
   * 实测 .next 下 0 个文件 require("@next/swc")，server.js 里出现的
   * "swc*" 只是 config 里的键名（swcTraceProfiling 之类）。
   * 服务器是 Ubuntu/glibc，musl 那份（93.9MB）永远不可能被加载。
   *
   * @img/sharp-wasm32 同理：wasm 兜底包，x64 上不会走这条路。
   * 注意保留 @img/sharp-linux-x64（Next 的图像优化真的会用它）。
   */
  const ALWAYS_DROP = [
    "@next/swc-linux-x64-musl",
    "@img/sharp-wasm32",
  ];
  for (const rel of ALWAYS_DROP) {
    const full = path.join(nm, rel);
    if (!fs.existsSync(full)) continue;
    const size = dirSize(full);
    forceRemove(full);
    reclaimed += size;
    console.log("已剔除运行期不需要的包：", rel, "（" + (size / 1048576).toFixed(1) + " MB）");
  }
  const scopes = ["@next", "@img"];
  for (const scope of scopes) {
    const dir = path.join(nm, scope);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!FOREIGN.test(entry)) continue;
      const full = path.join(dir, entry);
      const size = dirSize(full);
      forceRemove(full);
      reclaimed += size;
      console.log("已剔除平台无关产物：", scope + "/" + entry, "（" + (size / 1048576).toFixed(1) + " MB）");
    }
  }
  // 递归清理 .next 下可能存在的同名副本
  const walk = (p) => {
    let ents;
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const q = path.join(p, e.name);
      if (FOREIGN.test(e.name)) { const s2 = dirSize(q); forceRemove(q); reclaimed += s2; continue; }
      walk(q);
    }
  };
  walk(path.join(OUT, ".next"));
  if (reclaimed > 0) console.log("平台产物清理合计：", (reclaimed / 1048576).toFixed(1), "MB");
}

pruneForeignPlatformArtifacts();

/**
 * 打版本戳：产出 dist/.build-info.json，供运行期 healthz 读取。
 * 顺序无所谓（读的是 git 状态而非产物），放最后让日志更清楚。
 */
const { execFileSync } = await import("node:child_process");
try {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "stamp-version.mjs")], {
    cwd: ROOT, stdio: "inherit",
  });
} catch {
  console.warn("!! 版本戳写入失败，healthz 的 commit 将为 null");
}

/**
 * 收尾自检：把坏软链一次性列出来。
 * 它们未必都是致命的（前面 patchNestedNativeDeps 已对 .nft.json 要求的包做了硬校验），
 * 但"静默跳过"这个行为必须留下痕迹，否则下次又要靠线上 500 来发现。
 */
if (danglingLinks.length > 0) {
  console.warn("!! 跳过 " + danglingLinks.length + " 条坏软链（目标不存在）：");
  for (const l of danglingLinks.slice(0, 20)) console.warn("   -", l.replace(ROOT, "."));
  if (danglingLinks.length > 20) console.warn("   ... 其余 " + (danglingLinks.length - 20) + " 条略");
}

console.log("dist ready:", OUT);
