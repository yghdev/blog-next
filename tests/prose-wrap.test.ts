import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 正文长串换行（R1，2026-11-01）。
 *
 * ## 问题
 *
 * 文章正文里出现**不可断行的长串**时，整页会横向撑破。实测 1200px 视口：
 *
 *   超长 URL（https://example.com/ + 180 个 a）  scrollWidth 2109  溢出 909px
 *   超长英文单词（44 字母 × 5）                  scrollWidth 1507  溢出 307px
 *   超长中文（200 个「很」）                      scrollWidth 1200  正常
 *
 * 中文能正常换行是因为浏览器默认允许在汉字间断行；英文/URL 没有空格就
 * 只能整串排下去。`.post-card .excerpt` 与 `.toc-list li a` 早就有
 * `overflow-wrap: anywhere`，唯独**正文 `.prose` 没有** —— 于是列表页
 * 不出问题、点进文章页就爆。
 *
 * ## 为什么值得修而不是"用户自己别写长 URL"
 *
 * 正文里贴链接是最正常的写作行为。博客文章引用一个长 GitHub URL、
 * 一段 API 路径、一个没有空格的文件名，都会触发。这不是极端输入，
 * 是**必然会遇到的日常内容**。
 *
 * ## 修法
 *
 * 给 `.prose` 的**文字类元素**加 `overflow-wrap: anywhere`：
 * p / li / blockquote / h1–h4 / td / th。
 *
 * 不给 `pre` 加：代码块靠 `overflow-x: auto` 横向滚动，这是正确行为
 * （代码换行会破坏缩进语义）。`table` 同理已有 `overflow-x: auto`。
 */

const ROOT = process.cwd();
const RAW = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");

/** 去掉 CSS 注释，避免把说明文字当成选择器 */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

const CSS = stripCssComments(RAW);

/** 取某个选择器块的声明（按大括号配平） */
function blockOf(selector: string): string | null {
  const idx = CSS.indexOf(selector + " {");
  if (idx < 0) {
    // 也支持选择器列表形式（.a, .b {）
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{");
    const m = re.exec(CSS);
    if (!m) return null;
    const start = m.index;
    let depth = 0;
    for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}") {
        depth--;
        if (depth === 0) return CSS.slice(start, i + 1);
      }
    }
    return null;
  }
  let depth = 0;
  for (let i = CSS.indexOf("{", idx); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(idx, i + 1);
    }
  }
  return null;
}

test("R1 正文文字类元素必须有 overflow-wrap（防止长 URL 撑破页面）", () => {
  /**
   * 不逐个断言每个选择器，而是断言"存在一条覆盖 .prose 文字元素的
   * overflow-wrap 规则"——实现可以是一条合并规则，也可以是分开写。
   */
  const rules = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) =>
    /overflow-wrap\s*:\s*(anywhere|break-word)/.test(m[2]) && /\.prose\b/.test(m[1])
  );
  assert.ok(
    rules.length > 0,
    "`.prose` 下应有 overflow-wrap: anywhere 规则（正文长串不换行会撑破整页）"
  );

  // 收集被这条规则覆盖的选择器
  const covered = rules.flatMap((m) => m[1].split(",").map((s) => s.trim()));
  const needed = [".prose p", ".prose li", ".prose blockquote"];
  const missing = needed.filter((n) => !covered.some((c) => c === n || c.startsWith(n + " ") || c === n.replace(".prose ", ".prose > ")));
  assert.deepEqual(missing, [], "这些文字元素仍缺换行保护：" + JSON.stringify(missing) +
    "\n现有覆盖：" + JSON.stringify(covered));
});

test("R1 标题也要能换行（长英文标题不撑破）", () => {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) =>
    /overflow-wrap\s*:\s*(anywhere|break-word)/.test(m[2])
  );
  const covered = rules.flatMap((m) => m[1].split(",").map((s) => s.trim()));
  for (const h of [".prose h1", ".prose h2", ".prose h3", ".prose h4"]) {
    assert.ok(
      covered.some((c) => c === h || c.includes(h)),
      h + " 应能换行（长英文标题会撑破容器）"
    );
  }
});

test("R1 代码块不得被 overflow-wrap 影响（应保留横向滚动）", () => {
  /**
   * 反例守卫：代码块靠 `overflow-x: auto` 横向滚动 —— 这是正确行为。
   * 给 pre/code 加 anywhere 会把代码折成一片，缩进语义全毁。
   */
  const pre = blockOf(".prose pre");
  assert.ok(pre, "应有 .prose pre 规则");
  assert.doesNotMatch(pre, /overflow-wrap\s*:\s*(anywhere|break-word)/, ".prose pre 不应设置 overflow-wrap");
  assert.match(pre, /overflow-x\s*:\s*auto/, ".prose pre 应保留 overflow-x: auto");

  // 全局也不能有 * { overflow-wrap } 这种粗暴写法
  assert.doesNotMatch(CSS, /^\s*\*\s*\{[^}]*overflow-wrap/m, "不应给 * 加 overflow-wrap（会波及代码块）");
});

test("R1 表格保留横向滚动（不靠换行硬挤）", () => {
  const table = blockOf(".prose table");
  assert.ok(table, "应有 .prose table 规则");
  assert.match(table, /overflow-x\s*:\s*auto/, ".prose table 应保留 overflow-x: auto");
});
