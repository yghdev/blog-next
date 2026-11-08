import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 整页栅格契约（2026-11-08 第二轮）。
 *
 * ## 为什么重写这个文件
 *
 * 第一轮（commit 4d0b9a0）把 12 列画在 `.content` 里，但内容区是单列、
 * 三个"12 列消费者"又各自覆盖了栅距（8/10/12px）——结果 12 列只是叠在
 * 单列内容上的一把尺子，谁也不对齐。用户看截图第一眼就指出了这一点。
 *
 * 第二轮改成**整页**栅格：12 列 × 24px 栅距，三栏页按 1 / 2 / 6 / 2 / 1 分配
 * （留白 / 左导航 / 正文 / 右栏 / 留白），骨架轨道由列反推 —— 因为旧的
 * 288/800/320 + 40 栅距在任何等宽列栅格上都没有整数解（见 globals.css 注释）。
 *
 * 这个文件只守**结构事实**：令牌、列分配、定位公式、页脚对齐、叠加层画在哪；
 * 数值推论在 breakpoints.test.ts，浏览器实测在 grid-alignment.mjs。
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

const GLOBALS = read("app/globals.css");
const FRIENDS = read("app/friend-links/friends.css");
const CSS = strip(GLOBALS);
const CSS_FRIENDS = strip(FRIENDS);

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
  throw new Error(":root 未闭合");
}
const ROOT_BLOCK = rootBlock(CSS);

/** 找出所有含某模式的声明行（带行号，便于报错定位） */
function findLines(src: string, pattern: RegExp): { line: number; text: string }[] {
  return src.split("\n").flatMap((text, i) =>
    pattern.test(text) ? [{ line: i + 1, text: text.trim() }] : []
  );
}

/* ────────────────────────── 令牌 ────────────────────────── */

test("整页栅格：三个令牌存在且语义正确", () => {
  assert.match(ROOT_BLOCK, /--page-max:\s*1552px/, "容器上限应为 1552px（12 列 + 11 栅距 + 两侧各一列留白）");
  assert.match(ROOT_BLOCK, /--page-gutter:\s*24px/, "整页栅距应为 24px");
  // 单列宽必须由「容器宽（被 --page-max 夹住）− 11 个栅距」除以 12 算出
  assert.match(
    ROOT_BLOCK,
    /--page-col:\s*calc\(\(min\(100%,\s*var\(--page-max\)\)\s*-\s*11\s*\*\s*var\(--page-gutter\)\)\s*\/\s*12\)/,
    "--page-col 的公式必须是 (min(100%, --page-max) - 11 * --page-gutter) / 12"
  );
  // 正文行宽是独立的阅读参数，不能被列宽"顺手改掉"
  assert.match(ROOT_BLOCK, /--measure-prose:\s*672px/, "正文行宽应保持 672px");
});

test("整页栅格：旧骨架令牌不得复活（否则两套几何又并存）", () => {
  /**
   * 第一轮之前是 288/800/320 + 40 栅距。如果哪天有人把它们加回来，
   * 就会出现「两套骨架并存、页面各用一套」的错位（B-2/B-3 花了两轮才收敛）。
   */
  for (const name of ["--w-side", "--w-main", "--w-toc", "--gap-col", "--w-shell", "--w-shell-narrow", "--w-shell-read", "--w-read"]) {
    assert.doesNotMatch(ROOT_BLOCK, new RegExp("\\" + name + "\\s*:"), ":root 不应再定义旧骨架令牌 " + name);
  }
  const uses = findLines(CSS, /var\(--(w-side|w-main|w-toc|gap-col|w-shell|w-read)\b/);
  assert.deepEqual(uses, [], "globals.css 仍在引用旧骨架令牌：\n" + uses.map((l) => l.line + ": " + l.text).join("\n"));
});

/* ────────────────────────── 骨架 ────────────────────────── */

test("整页栅格：.site-shell 是 12 列容器，横向留白交给第 1 / 12 列", () => {
  const m = CSS.match(/\.site-shell\s*\{([^}]*)\}/s);
  assert.ok(m, "找不到 .site-shell 规则");
  const body = m[1];
  assert.match(body, /grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/, ".site-shell 应为 12 等宽列");
  assert.match(body, /column-gap:\s*var\(--page-gutter\)/, "列间距应走 --page-gutter");
  assert.match(body, /max-width:\s*var\(--page-max\)/, "容器上限应走 --page-max");
  assert.match(body, /margin:\s*0 auto/, "容器应居中");
  // 横向 padding 必须是 0：左右留白由列承担，否则会变成「留白列 + padding」两层
  assert.match(body, /padding:\s*var\(--space-12\)\s+0\s+var\(--space-24\)/, "横向 padding 应为 0（留白由列承担）");
});

test("整页栅格：正文 / 右栏 / 宽版的列号分配固定", () => {
  assert.match(CSS, /\.content\s*\{[^}]*grid-column:\s*4 \/ span 6/s, "三栏正文应占 4–9 列（6 列）");
  assert.match(CSS, /\.site-shell--three-col \.content\s*\{\s*grid-column:\s*4 \/ span 6/, "三栏 variant 显式写 4 / span 6");
  assert.match(CSS, /\.site-shell--wide \.content\s*\{[^}]*grid-column:\s*4 \/ span 8/s, "宽版正文应占 4–11 列（8 列）");
  assert.match(CSS, /\.toc-col\s*\{\s*grid-column:\s*10 \/ span 2/, "右栏应占 10–11 列（2 列）");
  // ≤1391：右栏收起，它那两列并入正文
  assert.match(
    CSS,
    /@media \(max-width: 1391px\) \{[\s\S]*?\.site-shell--three-col \.content\s*\{\s*grid-column:\s*4 \/ span 8/,
    "两栏区应把正文扩到 4–11 列"
  );
});

test("整页栅格：左导航固定定位必须落在第 2 列起点", () => {
  /**
   * 左栏是 fixed，脱离文档流，没法靠 grid-column 落位 —— 只能用
   * --page-col 算「容器居中偏移 + 1 列 + 1 栅距」。这条断言守的就是
   * 「别再用写死的 32px / 288px」。
   */
  const m = CSS.match(/\.sidebar\s*\{([^}]*)\}/s);
  assert.ok(m, "找不到 .sidebar 规则");
  const body = m[1];
  assert.match(
    body,
    /left:\s*calc\(max\(0px,\s*\(100% - var\(--page-max\)\) \/ 2\) \+ var\(--page-col\) \+ var\(--page-gutter\)\)/,
    "左栏 left 应为「容器居中偏移 + 1 列 + 1 栅距」"
  );
  assert.match(
    body,
    /width:\s*calc\(2 \* var\(--page-col\) \+ var\(--page-gutter\)\)/,
    "左栏宽度应为 2 列 + 1 栅距"
  );
  assert.match(body, /position:\s*fixed/, "左栏必须仍是 fixed");
});

test("整页栅格：页脚内边距与栅格留白同源", () => {
  const m = CSS.match(/\.site-footer-inner\s*\{([^}]*)\}/s);
  assert.ok(m, "找不到 .site-footer-inner 规则");
  const body = m[1];
  assert.match(body, /max-width:\s*var\(--page-max\)/, "页脚容器上限应与骨架一致");
  assert.match(
    body,
    /padding:\s*26px calc\(var\(--page-col\) \+ var\(--page-gutter\)\) 34px/,
    "页脚内边距应为「1 列 + 1 栅距」（文字仍居中，但盒与栅格同源）"
  );
});

/* ────────────────────────── 叠加层 ────────────────────────── */

test("整页栅格：叠加层画在整页容器上，而不是内容区", () => {
  /**
   * 第一轮画在 `.content` 上 —— 单列内容里那 12 条线谁也不碰，看起来就是摆设。
   * 现在必须画在 `.site-shell` 的内容盒里，12 列才与左导航/正文/右栏的边界一一对应。
   */
  assert.match(CSS, /html\[data-grid="1"\] \.site-shell\s*\{\s*position:\s*relative/, "叠加层的定位上下文应是 .site-shell");
  assert.match(
    CSS,
    /html\[data-grid="1"\] \.site-shell::before \{[\s\S]*?background-size:\s*calc\(\(100% \+ var\(--page-gutter\)\) \/ 12\) 100%/,
    "整页叠加层应用 --page-gutter 铺 12 列"
  );
  // 不允许再有"画在 .content 上"的旧叠加层（两份会互相叠）
  const stale = findLines(CSS, /html\[data-grid="1"\] \.content::before/);
  assert.deepEqual(stale, [], "旧的 .content 叠加层应已删除：" + stale.map((l) => l.line).join(", "));
});

test("整页栅格：叠加层小屏切 4 列", () => {
  assert.match(
    CSS,
    /@media \(max-width: 820px\) \{\s*html\[data-grid="1"\] \.site-shell::before \{[\s\S]*?\/ 4\)/,
    "手机端叠加层应切 4 列（12 列在 335px 宽下不可读）"
  );
});

test("friends.css 不再参与任何宽度计算（骨架全在 globals）", () => {
  /**
   * B-4 的教训：友链页曾自己覆盖 grid-template-columns / max-width，
   * 导致 1440 下左栏比首页偏 44px。页面骨架只应有 SiteShell 一个出口。
   */
  const serious = findLines(CSS_FRIENDS, /var\(--page-(max|gutter|col)\)|var\(--w-\w+\)|960px/);
  assert.deepEqual(
    serious,
    [],
    "friends.css 不应再引用骨架/栅格宽度令牌或硬编码 960px：\n" +
      serious.map((l) => "  第 " + l.line + " 行: " + l.text).join("\n")
  );
});