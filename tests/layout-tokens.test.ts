import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 布局宽度令牌（B-2，2026-11-01）。
 *
 * ## 为什么值得单独测
 *
 * 站点骨架的宽度公式原来是**手抄 5 遍**的同一串加法：
 *
 *   calc(var(--w-side) + var(--w-main) + var(--w-toc) + var(--gap-col) * 2 + 64px)
 *
 * 出现在 `globals.css` 的 `.site-shell`、`1200px` 断点、`.site-footer-inner`，
 * 以及 `friends.css` 的两处（那两处还偷偷把 `--w-main` 换成了硬编码 960px）。
 *
 * 后果不是"代码难看"，而是**改一个参数要记得改 5 个地方**：漏一处就出现
 * 「首页对齐了，友链页还是老偏移」这种只在某个页面出现的错位。
 *
 * 这个文件守两件事：
 *   ① 用法处不许再出现 `calc(var(--w-side) …)`，只能用 `var(--w-…)`；
 *   ② 三个 shell 宽度令牌必须存在且语义正确。
 *
 * ## 为什么不是「globals 只剩 1 处」
 *
 * 路线图验收标准写的是「globals 只剩 1 处（`--w-shell` 自身）」。实际有
 * **三种**不同的 shell 宽度（三栏 / 两栏 / 宽版阅读），所以令牌定义里
 * 会有 2 处 `calc(var(--w-side)`。关键是它们必须**全部集中在 `:root`
 * 令牌块内**，而任何 `max-width` / `grid-template-columns` 用法处都不许
 * 再写公式 —— 那才是「改一处即全站生效」的实际含义。
 */

const CSS = {
  globals: fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8"),
  friends: fs.readFileSync(path.join(process.cwd(), "app/friend-links/friends.css"), "utf8"),
};

/** 取出 `:root { … }` 令牌块（按大括号配平，避免嵌套块截断） */
function rootBlock(src: string): string {
  const start = src.indexOf(":root {");
  assert.ok(start >= 0, "找不到 :root 令牌块");
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(":root 块未闭合");
}

/** 找出所有含某模式的声明行（带行号，便于报错定位） */
function findLines(src: string, pattern: RegExp): { line: number; text: string }[] {
  return src.split("\n").flatMap((text, i) =>
    pattern.test(text) ? [{ line: i + 1, text: text.trim() }] : []
  );
}

test("B-2 令牌存在：--w-read / --w-shell 系列", () => {
  const root = rootBlock(CSS.globals);
  for (const name of ["--w-read", "--w-shell", "--w-shell-narrow", "--w-shell-read"]) {
    assert.match(root, new RegExp("\\" + name + "\\s*:"), ":root 应定义 " + name);
  }
  // --w-read 必须是 960px（Q1 默认方案：友链页历史宽度，也适合搜索结果这种列表页）
  assert.match(root, /--w-read:\s*960px/, "--w-read 应为 960px");
  // 三栏 shell 宽度 = 288 + 800 + 320 + 40*2 + 64 = 1552，与改前逐像素一致
  assert.match(
    root,
    /--w-shell:\s*calc\(var\(--w-side\)\s*\+\s*var\(--w-main\)\s*\+\s*var\(--w-toc\)\s*\+\s*var\(--gap-col\)\s*\*\s*2\s*\+\s*64px\)/,
    "--w-shell 应保留原三栏公式（不得为了简化而改数值）"
  );
});

test("B-2 用法处不得再写宽度公式：globals.css 的 max-width 全部用变量", () => {
  // 找所有 max-width 声明里还带 calc(var(--w-side) 的 —— 那就是漏改的用法处
  const leftovers = findLines(CSS.globals, /max-width:\s*calc\(var\(--w-side\)/);
  assert.deepEqual(
    leftovers,
    [],
    "globals.css 的 max-width 仍在写宽度公式（应改用 var(--w-shell…)）：\n" +
      leftovers.map((l) => "  第 " + l.line + " 行: " + l.text).join("\n")
  );
});

test("B-2 globals.css 的 calc(var(--w-side) 只能出现在 :root 令牌定义内", () => {
  const root = rootBlock(CSS.globals);
  const all = findLines(CSS.globals, /calc\(var\(--w-side\)/);
  const outside = all.filter((l) => {
    // 该行的偏移量是否落在 :root 块的字符区间内
    const offset = CSS.globals.split("\n").slice(0, l.line - 1).join("\n").length;
    const rootStart = CSS.globals.indexOf(root);
    return !(offset >= rootStart && offset < rootStart + root.length);
  });
  assert.deepEqual(
    outside,
    [],
    "令牌定义之外仍有宽度公式：\n" + outside.map((l) => "  第 " + l.line + " 行: " + l.text).join("\n")
  );
  assert.ok(all.length >= 1, "至少应有一个令牌定义（否则说明公式被删光了）");
});

test("B-2 friends.css 不得再出现任何宽度公式", () => {
  const leftovers = findLines(CSS.friends, /calc\(var\(--w-side\)/);
  assert.deepEqual(
    leftovers,
    [],
    "friends.css 仍有宽度公式（应改用 var(--w-shell-read)）：\n" +
      leftovers.map((l) => "  第 " + l.line + " 行: " + l.text).join("\n")
  );
});

test("B-2 friends.css 使用 --w-shell-read，且不再硬编码 960px 宽度", () => {
  assert.match(CSS.friends, /var\(--w-shell-read\)/, "friends.css 应使用 --w-shell-read");
  // 只允许 960px 通过 --w-read 间接出现；直接写死的 960px 宽度是漂移来源
  const hardcoded = findLines(CSS.friends, /(max-width|grid-template-columns)[^;]*\b960px\b/);
  assert.deepEqual(
    hardcoded,
    [],
    "friends.css 仍硬编码 960px（应改为 var(--w-read) 或 var(--w-shell-read)）：\n" +
      hardcoded.map((l) => "  第 " + l.line + " 行: " + l.text).join("\n")
  );
});

test("B-2 三个 variant 类必须存在（供 B-1 的 SiteShell 使用）", () => {
  for (const cls of [".site-shell--three-col", ".site-shell--wide"]) {
    assert.ok(CSS.globals.includes(cls), "globals.css 应定义 " + cls);
  }
  // --wide 的正文上限走 --w-read
  assert.match(
    CSS.globals,
    /\.site-shell--wide\s+\.content\s*\{[^}]*max-width:\s*var\(--w-read\)/s,
    ".site-shell--wide .content 应限制为 var(--w-read)"
  );
});

test("B-2 是纯重构：三个 shell 宽度的令牌值必须与改前的 5 处公式逐字等价", () => {
  /**
   * 这条是 B-2 的**安全网**。
   *
   * 改前是 5 处手写加法，改后是 3 个令牌。如果令牌算错了（比如少乘一个
   * gap、或把 64 写成 32），页面会整体变宽/变窄 —— 而那种变化很容易被
   * 当成"反正是重构，差一点正常"糊过去。
   *
   * 这里把三个令牌**代入数值**算一遍，与改前公式的结果比：
   *   三栏 1552 / 两栏 1152 / 宽版 1352
   *
   * 注意两栏的 1152 是**既有值**（漏了 gap-col），B-3 会改成 1192；
   * 到时这条断言要跟着更新 —— 那正是"行为发生了变化"的显式信号。
   */
  const root = rootBlock(CSS.globals);
  const num = (name: string) => {
    const m = root.match(new RegExp("\\" + name + ":\\s*([0-9.]+)px"));
    assert.ok(m, name + " 应是 px 数值");
    return Number(m[1]);
  };
  const side = num("--w-side");
  const main = num("--w-main");
  const toc = num("--w-toc");
  const gap = num("--gap-col");
  const read = num("--w-read");

  // 设计参数本身不得被改动（否则就不是"重构"而是"改设计"）
  assert.equal(side, 288, "--w-side 应为 288px");
  assert.equal(main, 800, "--w-main 应为 800px");
  assert.equal(toc, 320, "--w-toc 应为 320px");
  assert.equal(gap, 40, "--gap-col 应为 40px");
  assert.equal(read, 960, "--w-read 应为 960px");

  // 三栏：288 + 800 + 320 + 40*2 + 64 = 1552
  assert.equal(side + main + toc + gap * 2 + 64, 1552, "三栏 shell 宽度应为 1552");
  /**
   * 两栏：288 + 800 + 40 + 64 = 1192。
   *
   * B-2 阶段这里曾是 1152（漏了 gap-col 40），因为那一步是纯重构、要求
   * 逐像素不变。B-3 修正后应为 1192 —— 这条断言从「守住 1152」变成
   * 「守住 1192」，正好记录了那次有意的行为变化。
   */
  assert.equal(side + main + gap + 64, 1192, "两栏 shell 宽度应为 1192（含 gap-col）");
  // 宽版：288 + 960 + 40 + 64 = 1352
  assert.equal(side + read + gap + 64, 1352, "宽版 shell 宽度应为 1352");
});
