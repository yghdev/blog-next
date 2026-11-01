import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 搜索页表单（B-6，2026-11-01）。
 *
 * ## 问题
 *
 * 搜索页手写了第二份搜索表单（`app/search/page.tsx:31-45`），用了
 * `className="content-search"`。而 `globals.css` 里有一条：
 *
 *     @media (max-width: 820px) { .content-search { display: none } }
 *
 * 那条规则本来是给**首页**用的（手机端顶部栏已有搜索入口，列表顶部
 * 那个框多余）。但搜索页复用了同一个类名 —— 于是**移动端搜索页
 * 一个输入框都没有**：用户点进来只能看到「搜索」标题和一片空白，
 * 无法输入任何关键词。
 *
 * ## 修法
 *
 * 1. 用现成的 `<SearchBox initial={q} variant="dashed" />`（它支持 initial，
 *    是客户端组件，回车会 router.push 到 /search?q=…）
 * 2. 外层类名从 `content-search` 改成 `search-page-form`
 * 3. 新增 `.search-page-form { margin-bottom: 24px }`，且**不**被
 *    820px 的隐藏规则命中
 * 4. 首页那处 `content-search` 的隐藏规则保留（首页确实有顶栏搜索兜底）
 *
 * 顺带把 B-1 遗留的缩进偏移（SiteShell 内部多缩一级）修正。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("B-6 搜索页必须复用 SearchBox，不再手写表单", () => {
  const src = read("app/search/page.tsx");
  assert.match(src, /<SearchBox\b/, "搜索页应使用 <SearchBox>");
  assert.doesNotMatch(src, /<form\b/, "搜索页不应再手写 <form>");
  assert.doesNotMatch(src, /<input\b/, "搜索页不应再手写 <input>");
});

test("B-6 搜索页表单容器不得再用 content-search 类名", () => {
  /**
   * 这是本任务的核心：`content-search` 在 820px 以下会被 display:none。
   * 换类名才是根治；只在 CSS 里加例外是治标（下一个人复用同类名又会中招）。
   */
  const src = read("app/search/page.tsx");
  assert.doesNotMatch(src, /className="content-search"/, "搜索页不得再用 content-search 类名");
  assert.match(src, /search-page-form/, "搜索页应使用自己的 search-page-form 类名");
});

test("B-6 搜索页把当前关键词传给 SearchBox（否则刷新后输入框是空的）", () => {
  const src = read("app/search/page.tsx");
  assert.match(src, /<SearchBox[^>]*initial=\{q\}/, "SearchBox 应收到 initial={q}");
  assert.match(src, /<SearchBox[^>]*variant="dashed"/, "应保持虚线样式");
});

test("B-6 .search-page-form 有样式，且不被 820px 隐藏规则命中", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.search-page-form\s*\{/, "globals.css 应定义 .search-page-form");

  // 不能在 `@media (max-width:820px)` 块里出现 display:none
  const blocks = css.split("@media (max-width: 820px)");
  for (let i = 1; i < blocks.length; i++) {
    const body = blocks[i].slice(0, blocks[i].indexOf("\n}") + 2);
    assert.doesNotMatch(
      body,
      /\.search-page-form[^{]*\{[^}]*display:\s*none/,
      "820px 断点不应隐藏 .search-page-form（第 " + i + " 个 820 块）"
    );
  }
});

test("B-6 首页仍保留 content-search（它的隐藏规则是给首页用的）", () => {
  /**
   * 反例守卫：不要为了修搜索页而把首页那个框也一起改掉 ——
   * 首页在手机端确实靠顶栏搜索，列表顶部的框应该继续隐藏。
   */
  const home = read("app/page.tsx");
  assert.match(home, /className="content-search"/, "首页应保留 content-search");
  const css = read("app/globals.css");
  assert.match(css, /@media \(max-width: 820px\) \{\s*\.content-search \{ display: none; \}/, "820px 下仍应隐藏首页的 content-search");
});
