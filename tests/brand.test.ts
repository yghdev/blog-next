import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 品牌信息去硬编码（C-9，2026-11-01）。
 *
 * ## 问题
 *
 * 站名 `flechazo` 与简介 `记录 AI、开发与折腾的日常` 硬编码在 2 个组件里：
 *   components/Sidebar.tsx    brand-title / brand-desc
 *   components/MobileNav.tsx  顶栏站名
 *
 * 而 `settings` 表里**已经有** `siteTitle` / `siteDescription` / `author`
 * 三个字段，后台也能编辑。也就是说：后台改站名 → 浏览器 tab 标题变了
 * （metadata 走 settings），但**前台侧栏和顶栏还是老的**。
 *
 * 这种不一致很难发现，因为 tab 标题和页面内的站名不在同一个视觉焦点上。
 *
 * ## 修法
 *
 * `SiteShell`（服务端组件）取 `getSettingsCached()`，把品牌字段传给
 * `Sidebar` / `MobileNav`。`Sidebar` 与 `MobileNav` 是客户端组件
 * （需要 `usePathname`），只能接收 props，不能自己查库。
 *
 * ## 为什么 SiteShell 要变成 async
 *
 * 它是唯一同时包住 `Sidebar` 与正文的地方，且本身就是服务端组件。
 * 改成 `async function` 后，调用它的页面本来就是 async 的，无需再改。
 *
 * ## avatar 不在本次范围
 *
 * 头像固定为 `/avatar.jpg`（不是 settings 字段）。要让它可配置需要新增
 * 设置项 + 上传逻辑，属于另一个任务。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("C-9 SiteShell 必须是 async 且取 settings", () => {
  const src = read("components/SiteShell.tsx");
  assert.match(src, /export async function SiteShell/, "SiteShell 应保持 async（兄弟组件与调用方依赖）");
  assert.match(src, /getSettings\(/, "SiteShell 应调用 getSettings() 取品牌信息");
  assert.doesNotMatch(src, /getSettingsCached/, "settings 不再走数据缓存（P0-7 后续，改完要立刻生效）");
});

test("C-9 Sidebar 接收品牌 props，不再硬编码站名/简介", () => {
  const src = read("components/Sidebar.tsx");
  for (const prop of ["siteName", "siteDesc"]) {
    assert.ok(new RegExp("\\b" + prop + "\\b").test(src), "Sidebar 应接收 " + prop);
  }
  /**
   * 允许作为**默认参数值**出现（`siteDesc = "…"`）—— 那是兜底，
   * 不是硬编码：调用方传了 props 就用 props。禁止的是直接写进 JSX。
   */
  const jsxText = src.replace(/siteDesc\s*=\s*"[^"]*"/g, "").replace(/siteName\s*=\s*"[^"]*"/g, "");
  assert.doesNotMatch(
    jsxText,
    />\s*记录 AI、开发与折腾的日常\s*</,
    "Sidebar 的 JSX 里不应再写死站点简介（应渲染 {siteDesc}）"
  );
  assert.match(src, /\{siteDesc\}/, "Sidebar 应渲染 {siteDesc}");
  assert.match(src, /\{siteName\}/, "Sidebar 应渲染 {siteName}");
});

test("C-9 MobileNav 接收品牌 props，不再硬编码站名", () => {
  const src = read("components/MobileNav.tsx");
  assert.ok(/\bsiteName\b/.test(src), "MobileNav 应接收 siteName");
  assert.doesNotMatch(
    src,
    /<span>flechazo<\/span>/,
    "MobileNav 不应再硬编码站名（应来自 settings.siteTitle）"
  );
});

test("C-9 前台 .tsx 里不得再有硬编码的站名与简介", () => {
  /**
   * 全项目扫一遍：除了 settings 的默认值（lib/settings.ts）与文档，
   * 任何前台组件都不该出现这两个字面量。
   */
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "dist", ".git"].includes(e.name)) continue;
      // 后台（app/admin、components/admin）不在 C-9 范围：后台的品牌标识
      // 是后台自己的壳，与前台 settings 无关
      if (e.isDirectory() && e.name === "admin") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "components"));

  const offenders: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const text = fs.readFileSync(f, "utf8");
    // 去掉注释再查，避免把"解释这个约束"的注释当成违规
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // 只在**JSX 文本节点**里才算违规；作为默认参数值是兜底，允许
    if (/>\s*记录 AI、开发与折腾的日常\s*</.test(code)) offenders.push(rel + "（简介）");
    if (/>\s*flechazo\s*</.test(code)) offenders.push(rel + "（站名文本）");
  }
  assert.deepEqual(offenders, [], "这些组件仍硬编码品牌信息：\n  " + offenders.join("\n  "));
});

test("C-9 Sidebar / MobileNav 的 props 必须有 fallback（不能因设置缺失而空白）", () => {
  /**
   * settings 可能为空（全新安装、数据库未初始化）。如果直接把
   * `settings.siteTitle` 传下去而不兜底，侧栏会渲染成空白 —— 比硬编码更糟。
   */
  const shell = read("components/SiteShell.tsx");
  assert.match(shell, /\|\|/, "SiteShell 取 settings 时应有 || 兜底");
  const sidebar = read("components/Sidebar.tsx");
  // 默认参数值也是兜底的一种（`siteName = "flechazo"`）
  assert.match(
    sidebar,
    /siteName\s*=\s*"[^"]+"|siteName\s*\?\?|siteName\s*\|\|/,
    "Sidebar 应对 siteName 兜底（默认参数值或 || / ??）"
  );
});

test("C-9 站点标题的默认值仍留在 lib/settings.ts（单一事实来源）", () => {
  const src = read("lib/settings.ts");
  assert.match(src, /siteTitle:\s*"flechazo's blog"/, "settings 的默认站名应保留在 lib/settings.ts");
  assert.match(src, /siteDescription:/, "settings 的默认简介应保留");
});
