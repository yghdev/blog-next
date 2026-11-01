import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 友链页布局去覆盖（B-4，2026-11-01）。
 *
 * ## 问题
 *
 * `friends.css` 曾经自己重算了一遍骨架：网格、max-width、甚至移动端 padding
 * 都覆盖全局。后果是**本页左栏与其它页对不齐**：
 *
 *   1440px  首页 .sidebar.left = 32   友链页 = 76   （差 44px）
 *
 * 根因：本页用 `--w-shell-read`(1352) 收起容器，1352 在 1440 里居中 →
 * 左右各留 44px，再加 padding 32 = 76。而首页的三栏 shell 是 1552，在 1440
 * 里反向溢出（容器占满视口），左栏就是 32。
 *
 * ## 修法
 *
 * 本页只声明"我是宽版"，**不再重算几何**。`SiteShell variant="wide"` +
 * 全局令牌已经给出正确结果（B-1 已完成骨架改造）。本任务删除 friends.css
 * 里所有 `.site-shell.fr-shell` / `.content.fr-main` 的布局覆盖。
 *
 * ## 这个文件守什么
 *
 * 静态检查：friends.css 里不得再出现骨架类的几何声明。渲染结果由
 * `tests/layout-regression.mjs` 的「首页 vs 友链页 sidebar.left 差 ≤1px」断言。
 */

const CSS = fs.readFileSync(path.join(process.cwd(), "app/friend-links/friends.css"), "utf8");

test("B-4 friends.css 不得再定义 .site-shell.fr-shell 的布局", () => {
  const hits = CSS.split("\n").flatMap((line, i) =>
    /\.site-shell\.fr-shell\s*\{/.test(line) ? [{ line: i + 1, text: line.trim() }] : []
  );
  assert.deepEqual(
    hits,
    [],
    "friends.css 仍有 .site-shell.fr-shell 规则（应改用 SiteShell variant=\"wide\"）：\n" +
      hits.map((h) => "  第 " + h.line + " 行: " + h.text).join("\n")
  );
});

test("B-4 friends.css 不得覆盖 grid-template-columns / max-width 于骨架类", () => {
  /**
   * 更宽的检查：即使把选择器改名，只要还在给 `.site-shell` 或 `.content`
   * 写几何属性，就仍然在"本页重算布局"。这里是那个约束的兜底。
   */
  const bad: string[] = [];
  const lines = CSS.split("\n");
  let selector = "";
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (depth === 0 && line.includes("{")) {
      selector = line.split("{")[0].trim();
    }
    if (/^\s*(grid-template-columns|max-width)\s*:/.test(line)) {
      if (/\.site-shell|\.content\.fr-main|\.content\b/.test(selector) && selector.includes("fr")) {
        bad.push("第 " + (i + 1) + " 行 [" + selector + "] " + line.trim());
      }
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  }
  assert.deepEqual(bad, [], "friends.css 仍在覆盖骨架几何：\n  " + bad.join("\n  "));
});

test("B-4 移动端 padding 覆盖已删除（应回到全局 14px 20px）", () => {
  /**
   * 原来 `@media(max-width:820px)` 里把 padding 改成了 `8px 20px ...`，
   * 而全局是 `14px 20px ...`。差 6px 看不出来，但"本页例外"越积越多，
   * 最后没人知道哪个页面用哪套间距。
   */
  const bad = CSS.split("\n").flatMap((line, i) =>
    /\.site-shell[^{]*\{[^}]*padding\s*:/.test(line) ? [{ line: i + 1, text: line.trim() }] : []
  );
  // 允许 .fr-hero 等页面内部元素的 padding，不允许骨架容器的
  const serious = bad.filter((b) => /site-shell/.test(b.text));
  assert.deepEqual(serious, [], "friends.css 仍在覆盖骨架 padding：\n  " + serious.map((b) => "  第 " + b.line + " 行: " + b.text).join("\n"));
});

test("B-4 `.fr-main` 已彻底移除（宽度改由全局 --w-read 承担）", () => {
  /**
   * 这个类原本只做一件事：把正文限到 960px。B-4 之后这件事由
   * `.site-shell--wide .content { max-width: var(--w-read) }` 统一负责，
   * 所以类和规则都应该消失 —— 留着会变成"没有样式的死类"。
   */
  const hits = CSS.split("\n").flatMap((line, i) =>
    /\.fr-main\b/.test(line) && !/^\s*\*/.test(line) ? [{ line: i + 1, text: line.trim() }] : []
  );
  assert.deepEqual(hits, [], "friends.css 仍有 .fr-main 引用：\n  " + hits.map((h) => "  第 " + h.line + " 行: " + h.text).join("\n"));
});
