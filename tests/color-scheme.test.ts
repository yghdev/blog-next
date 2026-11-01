import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * `color-scheme` 支持（C-3，2026-11-01）。
 *
 * ## 问题
 *
 * 三个样式表里 `color-scheme` 属性出现 **0 次**（注意别和
 * `prefers-color-scheme` 混了 —— 后者是媒体查询，前者是声明）。
 *
 * 后果：暗色主题下，**浏览器原生控件仍是亮色**：
 *   • 滚动条是浅灰的（页面一片深色，右侧一条白）
 *   • `<select>` 下拉、`<input type="date">` 的日历弹层、`<input type="number">`
 *     的上下箭头、自动填充（autofill）的底色 —— 全是亮色
 *   • 移动端点击输入框时的系统键盘配色也不跟随
 *
 * 这些都不是"我们没写样式"，而是**浏览器按 `color-scheme` 决定原生控件配色**，
 * 而它默认是 `light`。所以必须在 :root 上显式声明，并让两个暗色作用域
 * 都把它改成 `dark`。
 *
 * ## 三处缺一不可
 *
 *   1. `:root`                                    → light
 *   2. `:root[data-theme="dark"]`                 → dark（手动切换）
 *   3. `@media (prefers-color-scheme: dark)` 的
 *      `:root:not([data-theme=light]):not([data-theme=dark])` → dark（系统偏好）
 *
 * 第 3 处容易漏：它只对「从未点过切换按钮」的用户生效，而那正是大多数
 * 首次访问者。
 */

const ROOT = process.cwd();
const RAW = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");

/** 去掉注释，避免把说明文字当成声明 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}
const CSS = stripComments(RAW);

/** 取某个选择器之后紧跟的声明块（按大括号配平） */
function blockAfter(selector: string): string | null {
  const idx = CSS.indexOf(selector);
  if (idx < 0) return null;
  const brace = CSS.indexOf("{", idx);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(brace, i + 1);
    }
  }
  return null;
}

test("C-3 :root 必须声明 color-scheme: light", () => {
  const b = blockAfter(":root {");
  assert.ok(b, "应有 :root 主令牌块");
  assert.match(b, /color-scheme\s*:\s*light/, ":root 应声明 color-scheme: light（原生控件默认亮色）");
});

test("C-3 手动暗色作用域必须声明 color-scheme: dark", () => {
  const b = blockAfter(':root[data-theme="dark"] {');
  assert.ok(b, '应有 :root[data-theme="dark"] 块');
  assert.match(b, /color-scheme\s*:\s*dark/, "手动暗色应声明 color-scheme: dark");
});

test("C-3 系统暗色作用域必须声明 color-scheme: dark", () => {
  /**
   * 这一条最容易漏：它嵌套在 @media 里，且只对"从没点过切换按钮"的
   * 用户生效 —— 而那正是大多数首次访问者。
   */
  const media = blockAfter("@media (prefers-color-scheme: dark) {");
  assert.ok(media, "应有 prefers-color-scheme: dark 媒体块");
  const inner = blockAfter(':root:not([data-theme="light"]):not([data-theme="dark"])');
  assert.ok(inner, "媒体块内应有 :root:not([data-theme=light]):not([data-theme=dark]) 选择器");
  assert.match(inner, /color-scheme\s*:\s*dark/, "系统暗色也应声明 color-scheme: dark");
});

test("C-3 三个样式表都不得声明冲突的 color-scheme", () => {
  /**
   * admin.css 与 friends.css 会与 globals 一起加载。如果它们各自声明
   * `color-scheme: light`，会按层叠顺序把 globals 的 dark 覆盖掉 ——
   * 后台暗色下滚动条又变白，而且没有任何报错。
   *
   * 这两个文件**不需要**声明 color-scheme（继承 :root 即可）。
   */
  for (const f of ["app/admin/admin.css", "app/friend-links/friends.css"]) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
    // 用行首锚定 + 排除 prefers- 前缀：`prefers-color-scheme: dark` 里的
    // "color-scheme: dark" 也会被裸正则匹配到，那是媒体查询不是声明。
    // （这条坑我在写 CSS 注释时已经踩过一次，测试里又踩了一次。）
    const hits = [...src.matchAll(/(?:^|[;{\s])color-scheme\s*:\s*(\w+)/gm)]
      .filter((m) => !/prefers-$/.test(src.slice(Math.max(0, m.index - 10), m.index + 1)))
      .map((m) => m[1]);
    assert.deepEqual(
      hits,
      [],
      f + " 不应自行声明 color-scheme（应与 globals 的 :root 保持一致，否则暗色下会被覆盖）：" + JSON.stringify(hits)
    );
  }
});
