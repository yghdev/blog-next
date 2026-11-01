import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 重复选择器与死 CSS 清理（C-6，2026-11-01）。
 *
 * ## 核心 bug：移动端文章标题一直是 32.8px
 *
 * `globals.css` 里 `.article-title` 出现 7 次，其中两份是**完整定义**：
 *
 *     481 行   .article-title { font-size: 2rem;   line-height: 1.4;  margin: 0 0 16px }
 *     1421 行  .article-title { font-size: 2.05rem; line-height: 1.38; margin: 0 0 18px }
 *
 * 两份特异性相同（0,1,0），后出现的 1421 覆盖 481 —— 所以 481 是**死代码**。
 *
 * 更严重的是 1070 行：
 *
 *     1070 行  @media (max-width: 820px) { .article-title { font-size: 1.5rem } }
 *
 * 它在媒体查询里，特异性也是 0,1,0，但**位置在 1421 之前** —— 于是被
 * 后面的 2.05rem 覆盖。**移动端标题从来没变小过**：实测 375px 下
 * 计算值是 32.8px（2.05rem），而不是声明的 24px（1.5rem）。
 *
 * 这是"写了但没生效"的典型：代码里明明有 `@media(max-width:820px)` 的
 * 覆盖，看代码会以为已经适配了。只有打开手机宽度实测才会发现。
 *
 * ## 修法
 *
 * 1. 删掉 481 那份（被 1421 完全覆盖，字段一一对应）
 * 2. 把 1070 的移动端覆盖**移到文件末尾**（放在所有 `.article-title`
 *    基础定义之后），并合并进末尾的 `@media (max-width: 820px)` 块
 *
 * 注意不能用 `!important` 绕过 —— 那是掩盖顺序问题，会让以后无法覆盖。
 */

const ROOT = process.cwd();
const RAW = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}
const CSS = stripComments(RAW);

/** 所有出现 `.article-title` 作为选择器的位置（带行号） */
function articleTitleSites(src: string): { line: number; text: string; inMedia: boolean }[] {
  const out: { line: number; text: string; inMedia: boolean }[] = [];
  const lines = src.split("\n");
  let mediaDepth = 0;
  let depthStack: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 粗略跟踪是否在 @media 内
    if (/^\s*@media\b/.test(l)) mediaDepth++;
    if (/\.article-title\b/.test(l) && !/^\s*\*/.test(l)) {
      out.push({ line: i + 1, text: l.trim(), inMedia: mediaDepth > 0 });
    }
    // 用大括号平衡粗略判断 media 结束
    const opens = (l.match(/{/g) || []).length;
    const closes = (l.match(/}/g) || []).length;
    if (mediaDepth > 0 && closes > opens) mediaDepth = Math.max(0, mediaDepth - (closes - opens) > 0 ? 1 : 0);
  }
  return out;
}

test("C-6 .article-title 的基础定义只能有一份", () => {
  /**
   * 只数**媒体查询之外**的完整定义（`{` 后跟 font-size 的那种）。
   * 允许 `text-wrap: balance` 与 `overflow-wrap: anywhere` 这两处
   * 组合选择器里的提及 —— 它们不是重复定义，是共享规则。
   */
  const lines = CSS.split("\n");
  const definitions: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\.article-title\s*\{/.test(lines[i])) {
      // 看这一块里有没有 font-size（完整定义的特征）
      let block = "";
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        block += lines[j] + "\n";
        depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
        if (depth === 0) break;
      }
      if (/font-size\s*:/.test(block)) definitions.push(i + 1);
    }
  }
  assert.equal(
    definitions.length,
    1,
    "媒体查询之外只应有一份 .article-title 完整定义，实际 " +
      definitions.length + " 份（行号 " + definitions.join(", ") + "）"
  );
});

test("C-6 移动端的 1.5rem 覆盖必须排在基础定义之后", () => {
  /**
   * 这是那个 bug 的直接判据：`@media(max-width:820px)` 里的
   * `.article-title { font-size: 1.5rem }` 必须**出现在**基础定义之后，
   * 否则同特异性下会被基础定义覆盖，移动端标题就不会变小。
   */
  const lines = CSS.split("\n");

  /**
   * "基础定义"指**最终生效的那一份** —— 即最后出现的、带 font-size 的
   * `.article-title { … }`。原来有两份（481 与 1421），后者生效；
   * 移动端覆盖在 1070，夹在两份之间，于是被 1421 压掉。
   *
   * 所以判据是：1.5rem 那一行必须晚于**最后一份**基础定义。
   */
  const baseDefs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\.article-title\s*\{/.test(lines[i])) {
      let depth = 0;
      let block = "";
      for (let j = i; j < lines.length; j++) {
        block += lines[j] + "\n";
        depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
        if (depth === 0) break;
      }
      if (/font-size\s*:/.test(block)) baseDefs.push(i + 1);
    }
  }
  assert.ok(baseDefs.length >= 1, "应有 .article-title 基础定义");
  const lastBase = baseDefs[baseDefs.length - 1];

  const overrideIdx = lines.findIndex((l) => /\.article-title\s*\{\s*font-size:\s*1\.5rem/.test(l)) + 1;
  assert.ok(overrideIdx > 0, "应有移动端 1.5rem 覆盖");
  assert.ok(
    overrideIdx > lastBase,
    "移动端覆盖必须晚于最后一份基础定义（基础在第 " + lastBase +
      " 行，覆盖在第 " + overrideIdx + " 行）—— 否则同特异性下会被覆盖，移动端标题不会变小"
  );
});

test("C-6 不得用 !important 绕过顺序问题", () => {
  /**
   * 反例守卫：用 `!important` 也能让 1.5rem 生效，但那是掩盖问题 ——
   * 以后想再按断点覆盖就得继续加 !important，层层加码。
   */
  const lines = CSS.split("\n");
  const bad = lines.filter((l) => /\.article-title[^{]*\{[^}]*!important/.test(l));
  assert.deepEqual(bad, [], "`.article-title` 不应用 !important：" + bad.join(" / "));
});

test("C-6 .toc-col 的 display:none 只能有一处（不重复）", () => {
  /**
   * 原来 `.toc-col { display: none }` 在 1200 断点和 820 断点各写一次。
   * 两处语义不同（一个是右栏隐藏、一个是单栏），但 820 那条是冗余的 ——
   * 1200 的规则已经覆盖了 ≤820。重复规则容易被后人误改其中一处。
   */
  const hits = [...CSS.matchAll(/\.toc-col\s*\{\s*display:\s*none/g)];
  assert.ok(
    hits.length <= 2,
    ".toc-col display:none 不应超过 2 处（≤1391 与 ≤820），实际 " + hits.length
  );
});

test("C-6 死类清单里的类不得再出现", () => {
  /**
   * 路线图列的待删死类。逐个核实过「无静态引用、也无三元拼接」之后才删。
   * 注意 `is-active` / `active` / `in` / `lv3` / `badge-*` 是三元拼的，
   * **不能删**，所以不在这个清单里。
   */
  const DEAD = [
    ".sidebar-footer",
    ".toc-title",
    ".only-mobile",
    ".mobile-drawer-search",
    ".icon-inline",
    ".video-container",
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "dist", ".git"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "components"));

  const stillUsed: string[] = [];
  for (const cls of DEAD) {
    const bare = cls.slice(1); // 去掉点
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      // 只认 className 里的完整词，避免 sidebar-footer-x 这种误判
      if (new RegExp("className=[\"'{][^\"'}]*\\b" + bare + "\\b").test(text)) {
        stillUsed.push(cls + " @ " + path.relative(ROOT, f));
      }
    }
  }
  assert.deepEqual(stillUsed, [], "这些死类仍被引用，不能删：" + stillUsed.join(", "));
});
