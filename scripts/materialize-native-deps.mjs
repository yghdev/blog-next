/**
 * 把 standalone 产物里"空壳"的 native 依赖实体化。
 *
 * 背景（2026-10-26 线上事故 + 2026-10-27 阶段 00 验收）：
 * Next 的 standalone 输出对 serverExternalPackages（本项目是 better-sqlite3）只生成
 *   1) node_modules/better-sqlite3            <- 只有 package.json 的空壳
 *   2) .next/node_modules/better-sqlite3-<hash> <- 软链，指向上面那个空壳
 * 真正的 lib/ 与 build/Release/*.node 都不在 standalone 里。于是直接
 * `node .next/standalone/server.js` 启动会报
 *   Failed to load external module better-sqlite3-<hash>:
 *   Cannot find module '.../better-sqlite3-<hash>/lib/index.js'
 *
 * 只有 `scripts/package-standalone.mjs`（npm run build:dist）会修补它。因此：
 *   - 部署：走 build:dist，正常
 *   - CI 的 test:next 直接指向 .next/standalone/server.js 时必然起不来
 *
 * 所以这段逻辑抽成共享模块，由「打包」和「真实 Next 集成测试」共同调用，
 * 不再各写一份、也不再靠人肉复制修复。
 *
 * 实现要点（都是踩过的坑，勿"优化"）：
 *   - 以 .nft.json 为唯一事实来源反查，不遍历目录项：目录里可能一条都没有。
 *   - 正则必须允许**不带**尾随斜杠的条目（nft 里两种形态都出现过）。
 *   - 实体化后做硬校验，缺了就抛错 / 退出，绝不静默放过 —— 静默的代价是线上 500。
 *   - Windows 上删除文件用 unlinkSync + rmdirSync 手动递归：Node 24 的 fs.rmSync
 *     删除某些中文文件名会让进程直接崩溃（0xC0000409），try/catch 接不住。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 安全递归删除：`fs.rmSync(path, { recursive: true })` 在 Windows 上会**跟进
 * junction/符号链接**，把链接目标里的真实内容一起删掉。
 *
 * 这不是理论风险：2026-10-27 阶段 00 验收中，对项目根 `.next` 执行
 * rmSync 后，`node_modules/better-sqlite3` 被清空成空目录 —— 因为 `next build`
 * 会在 `.next/node_modules/better-sqlite3-<hash>` 建一条指向真实包的链接。
 * 后果是本地原生模块直接失效（Cannot find module 'better-sqlite3'），
 * 而且 build 已经跑完、错误却出现在之后的测试里，非常难归因。
 *
 * 所以凡是可能含链接的目录（.next、dist、standalone），一律走这个函数：
 * lstat 判定为链接就只 unlink 链接本身，绝不递归进去。
 */
export function forceRemove(target) {
  if (!fs.existsSync(target)) return;
  const st = fs.lstatSync(target);
  if (st.isDirectory()) {
    // 目录必须先补上 **执行位** 才能遍历与删除其内容。
    // 这里踩过真坑：原先对目录也写 chmod 0o666，把 x 位剥掉了，目录变成
    // `drw-rw-rw-` —— 之后 readdirSync/rmdirSync 都进不去，下一次
    // `next build` 就在 unlink 该目录内文件时报
    //   EACCES: permission denied, unlink .../better-sqlite3/package.json
    // 而报错完全指不回"是本脚本把权限改坏的"，排查成本极高。
    // 结论：文件用 0o666、目录用 0o777，两者语义不同，不能共用一个常量。
    try { fs.chmodSync(target, 0o777); } catch { /* 已经可写 */ }
    for (const e of fs.readdirSync(target)) forceRemove(path.join(target, e));
    fs.rmdirSync(target);
    return;
  }
  try { fs.chmodSync(target, 0o666); } catch { /* 已经可写 */ }
  fs.unlinkSync(target);
}

/** 覆盖式递归复制；遇到软链先解析再实体化（产物里不能留软链） */
export function copyDir(src, dst, onDangling) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    let stat;
    try { stat = fs.lstatSync(s); } catch { continue; }
    if (stat.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync(s); } catch {
        if (onDangling) onDangling(s);
        continue;
      }
      const tstat = fs.statSync(target);
      if (tstat.isDirectory()) copyDir(target, d, onDangling);
      else fs.copyFileSync(target, d);
      continue;
    }
    if (stat.isDirectory()) copyDir(s, d, onDangling);
    else {
      if (fs.existsSync(d)) { try { fs.chmodSync(d, 0o666); } catch { /* ignore */ } }
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * 扫描产物里所有 *.nft.json，收集形如 "包名-<16位hex>" 的嵌套 native 依赖引用。
 * @returns {Map<string,string>} 嵌套名 -> 真实包名
 */
export function collectNestedNativeDeps(outDir) {
  const wanted = new Map();

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
        const m = f.match(/node_modules[\\/]([^\\/]+-[0-9a-f]{16})(?:[\\/]|$)/);
        if (m) wanted.set(m[1], m[1].replace(/-[0-9a-f]{16}$/, ""));
      }
    }
  }

  scanNft(path.join(outDir, ".next"));
  return wanted;
}

/**
 * 选出一个可用的包源目录。
 *
 * 为什么需要回退：Next 的 standalone 会把 serverExternalPackages 写成
 * 「只有 package.json 的空壳」，真实代码留在仓库根的 node_modules 里。
 * 打包流程里 copyRuntimeDeps() 会先把空壳填满再修补，所以源可用；
 * 但**直接对 .next/standalone 修补（集成测试的路径）时，源就是空壳本身** ——
 * 于是"实体化"出来的目录仍只有 package.json，启动照样 Cannot find module。
 * 2026-10-27 验收就撞在这上面。
 *
 * 判据用 package.json 的 main 是否真实存在，而不是"目录里文件数>1"：
 * 后者会被 README/LICENSE 之类的附属文件骗过去。
 */
export function resolvePackageSource(outDir, pkgName) {
  const candidates = [
    path.join(outDir, "node_modules", pkgName),
    path.join(outDir, "..", "..", "node_modules", pkgName), // .next/standalone -> 仓库根
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { continue; }
    const main = meta.main || "index.js";
    if (fs.existsSync(path.join(dir, main))) return dir;
  }
  return null;
}

/**
 * 实体化产物里的嵌套 native 依赖。
 * @param {string} outDir standalone 产物根目录（含 server.js、node_modules、.next）
 * @returns {{ repaired: string[], missing: string[] }}
 */
export function materializeNestedNativeDeps(outDir) {
  const srcRoot = path.join(outDir, "node_modules");
  const nestedRoot = path.join(outDir, ".next", "node_modules");
  const wanted = collectNestedNativeDeps(outDir);
  const repaired = [];
  const missing = [];

  if (wanted.size === 0) {
    console.log("未在 .nft.json 中发现嵌套 native 依赖（无需修补）");
    return { repaired, missing };
  }

  fs.mkdirSync(nestedRoot, { recursive: true });

  for (const [nestedName, pkgName] of wanted) {
    const realSrc = resolvePackageSource(outDir, pkgName) || path.join(srcRoot, pkgName);
    if (!fs.existsSync(realSrc)) { missing.push(pkgName + "（源包不存在）"); continue; }
    const target = path.join(nestedRoot, nestedName);
    forceRemove(target);
    copyDir(realSrc, target);
    repaired.push(nestedName);
    console.log("已实体化嵌套 native 依赖：", nestedName, "<-", pkgName);
  }

  // 硬校验：缺了就等于服务起不来，必须在这里失败，而不是等启动时报错。
  // 除了 package.json，还要确认 main 指向的文件真的在了 —— 只查 package.json
  // 会放过"空壳实体化"这个最隐蔽的失败形态。
  for (const [nestedName] of wanted) {
    const dir = path.join(nestedRoot, nestedName);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch {
      missing.push(nestedName + "（实体化后仍缺 package.json）");
      continue;
    }
    const main = meta.main || "index.js";
    if (!fs.existsSync(path.join(dir, main))) missing.push(nestedName + "（实体化后仍缺 " + main + "）");
  }
  return { repaired, missing };
}

/**
 * 断言产物可直接启动；失败时抛出可读错误。
 * 打包脚本和集成测试共用，保证"能部署"与"能测试"是同一个判据。
 */
export function assertNativeDepsReady(outDir) {
  const { missing } = materializeNestedNativeDeps(outDir);
  if (missing.length) {
    throw new Error(
      "嵌套 native 依赖缺失：" + missing.join(", ") +
      " —— 产物不可启动，运行时会报 Cannot find module '<pkg>-<hash>'"
    );
  }
}
