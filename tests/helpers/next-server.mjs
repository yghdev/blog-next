/**
 * 隔离的真实 Next 服务上下文（阶段 00 基础设施）。
 *
 * 为什么需要它：验收矩阵 §11.0 要求「真实 Next 集成测试负责 unstable_cache、
 * 缓存预热、revalidateTag、RSS/搜索/sitemap 各自语义、308、HTTP 鉴权。缓存失效
 * 断言只能在这一层执行，需要真实起服务」。所以这里把「起一个用临时库的
 * standalone 服务」收成一个函数，供 HTTP 集成测试与浏览器双页测试共用 ——
 * 两处各写一份启动逻辑就会漂移（端口、探活、清理、native 依赖实体化）。
 *
 * 硬约束（都有事故背景，别简化）：
 *   1. DATA_DIR 必须落在 .tmp-tests 下的临时目录；绝不碰 data/blog.db。
 *   2. standalone 产物里的 better-sqlite3 是「空壳 + 指向空壳的软链」，
 *      不先实体化，server.js 启动必失败（Cannot find module '<pkg>-<hash>'）。
 *      这里直接复用打包脚本的共享实现，保证「能部署」和「能测试」同一判据。
 *   3. 任何失败路径都必须关掉子进程并删掉临时目录；否则失败一次就留一堆垃圾。
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { assertNativeDepsReady, forceRemove, copyDir as copyRaw } from "../../scripts/materialize-native-deps.mjs";

const root = process.cwd();
const tempRoot = path.join(root, ".tmp-tests");

/** 取一个空闲端口：先 listen(0) 拿系统分配，再关掉交给子进程 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

/**
 * 起一个隔离的 standalone 服务。
 * @returns {Promise<{base:string,dataDir:string,fixture:{username:string,password:string,token:string},close:()=>Promise<void>}>}
 */
export async function startIsolatedServer({ label = "next-integration", env: extraEnv = {} } = {}) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tempRoot, label + "-"));
  if (dataDir === path.join(root, "data")) throw new Error("Refusing development database");

  const standaloneDir = path.join(root, ".next/standalone");
  const serverEntry = path.join(standaloneDir, "server.js");
  if (!fs.existsSync(serverEntry)) throw new Error("Run npm run build before the integration tests");

  // 启动前先把 native 依赖实体化，否则一定会 Cannot find module
  assertNativeDepsReady(standaloneDir);

  /**
   * 清掉上一次运行留下的 Next 缓存目录（**不能省**）。
   *
   * standalone 的 server.js 里 distDir 被写死成 "./.next"（相对 __dirname），
   * 于是 unstable_cache / ISR 的落盘目录是
   *   .next/standalone/.next/cache           <- fetch/数据缓存
   *   .next/standalone/.next/server/route-cache <- ISR 页面
   * 它跟着**构建产物**走，而不是跟着 DATA_DIR 走。而每次测试用的是全新的临时库，
   * 缓存键（keyParts + buildId）却和上次完全相同 —— 结果就是新库读到旧库的缓存。
   *
   * 2026-10-27 实测的典型症状：上一轮跑完缓存里是 CACHE_AFTER_BODY，
   * 这一轮刚建的文章正文是 CACHE_BEFORE_BODY，但预热读到的还是 CACHE_AFTER_BODY，
   * 断言随机失败；而且**同一个脚本连跑两次结果不同**，很容易被误判成"代码有竞态"。
   *
   * 删的是纯缓存产物（可重建），不是构建产物本体，也不碰 DATA_DIR。
   * 返回 clearedCachePaths 供测试断言，把"隔离"这件事变成可验证的事实而不是口头承诺。
   */
  /**
   * 把 .next/static 与 public 复制进 standalone（**不能省**）。
   *
   * next build 产出的 .next/standalone 只包含 server 代码，静态资源留在
   * 项目的 .next/static 与 public/；standalone 的 server.js 以自身目录为根
   * 去找 .next/static，找不到就**一个样式表都不返回**。
   *
   * 这不是"样式难看"级别的问题：2026-10-27 阶段 01-A 走查时
   * document.styleSheets.length === 0，所有组件计算样式全是初始值，
   * 于是"暗色主题切换"之类的断言读到 rgba(0,0,0,0) 与 rgb(0,0,0)，
   * 看起来像组件坏了，实际是测试环境缺资源。部署走 build:dist 会复制，
   * 测试直连 standalone 就必须自己补。
   */
  const staticSrc = path.join(root, ".next", "static");
  const staticDst = path.join(standaloneDir, ".next", "static");
  if (fs.existsSync(staticSrc)) {
    forceRemove(staticDst);
    copyRaw(staticSrc, staticDst);
  }
  const publicSrc = path.join(root, "public");
  const publicDst = path.join(standaloneDir, "public");
  if (fs.existsSync(publicSrc)) {
    forceRemove(publicDst);
    copyRaw(publicSrc, publicDst);
  }

  const clearedCachePaths = [];
  for (const dir of [path.join(standaloneDir, ".next", "cache"), path.join(standaloneDir, ".next", "server", "route-cache")]) {
    // 必须用 forceRemove 而不是 fs.rmSync：后者在 Windows 上会跟进 junction
    // 删掉链接目标里的真实内容（见 scripts/materialize-native-deps.mjs 的说明）。
    if (fs.existsSync(dir)) { forceRemove(dir); clearedCachePaths.push(dir); }
  }

  const fixtureOutput = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--import=./tests/register.mjs", "tests/helpers/seed-next-fixture.mjs"],
    { cwd: root, env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: "test" }, encoding: "utf8" }
  );
  const fixtureLine = fixtureOutput.split(/\r?\n/).find((line) => line.startsWith("::BLOG_TEST_FIXTURE::"));
  if (!fixtureLine) throw new Error("Fixture output missing: " + fixtureOutput);
  const fixture = JSON.parse(fixtureLine.slice("::BLOG_TEST_FIXTURE::".length));

  const port = await freePort();
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: path.dirname(serverEntry),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000).unref();
      });
    }
    forceRemove(dataDir);
  };

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await close();
      throw new Error("Next server exited: " + logs);
    }
    try {
      const response = await fetch(base + "/api/healthz", { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { base, dataDir, fixture, close, logs: () => logs, clearedCachePaths, standaloneDir };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await close();
  throw new Error("Next server did not become ready: " + logs);
}
