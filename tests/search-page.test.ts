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

/* ------------------- P0-6（2026-11-07）：计数 / 高亮 / 2 字词 ------------------- */

test("P0-6 计数用 total（不是 hits.length），被截断时写 N+", () => {
  const src = read("app/search/page.tsx");
  // 结果被 limit 截断时，hits.length 只是"这一页几条"，不能当总数
  assert.match(src, /searchPosts\(/, "应调用 searchPosts");
  assert.match(src, /total/, "计数必须用 total");
  assert.match(src, /capped/, "候选被截断时要能写 N+");
  // C2（2026-11-08）：分页取代了原来的「显示前 N 条」—— 现在由页码说明位置
  assert.match(src, /pageCount/, "多页时要显示总页数");
  assert.match(src, /第 \{page\} \/ \{pageCount\} 页/, "多页时要显示「第 X / Y 页」");
  assert.doesNotMatch(src, /"找到 " \+ hits\.length \+ " 篇"/, "不得再把本页条数说成总数");
});

test("C2 分页：每页 10 条，页码越界由 searchPosts 夹回有效范围", () => {
  const src = read("app/search/page.tsx");
  assert.match(src, /const PAGE_SIZE = 10/, "每页 10 条");
  assert.match(src, /page: pageParam/, "页码要传给 searchPosts");
  assert.match(src, /pageCount > 1/, "只有一页时不渲染分页控件");
});

test("C2 筛选：标签同时匹配分类与标签，年份按 YYYY", () => {
  const src = read("app/search/page.tsx");
  assert.match(src, /searchFacets/, "筛选条要用 searchFacets 的分面");
  assert.match(src, /tag:/, "应支持 tag 参数");
  assert.match(src, /year:/, "应支持 year 参数");
  assert.match(src, /search-chip/, "筛选条用 chip 样式");
  assert.match(src, /清除筛选/, "带筛选且无结果时要给清除出口");
});

test("P0-6 高亮：页面把命中词传给卡片，卡片用 <mark> 渲染", () => {
  const page = read("app/search/page.tsx");
  assert.match(page, /highlightTerms/, "页面必须从 lib/highlight 取词（与排序/摘要同源）");
  assert.match(page, /highlight=\{terms\}/, "PostCard 应收到 highlight={terms}");

  const card = read("components/PostCard.tsx");
  assert.match(card, /highlight\?:/, "PostCard 应声明可选 highlight 属性");
  assert.match(card, /<Highlight\b/, "PostCard 应复用 Highlight 组件");

  const comp = read("components/Highlight.tsx");
  assert.match(comp, /<mark className="search-hit">/, "命中片段必须渲染成 <mark class=search-hit>");
  // 只看代码用法（注释里提到这个词是用来解释"为什么不用"的）
  assert.doesNotMatch(comp, /dangerouslySetInnerHTML\s*=\s*\{\{/, "高亮不得拼 HTML 字符串（XSS 面）");
});

test("P0-6 高亮样式：不用浏览器默认亮黄，且不改变文字颜色", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.search-hit\s*\{/, "globals.css 应定义 .search-hit");
  const block = css.slice(css.indexOf(".search-hit {"));
  const body = block.slice(0, block.indexOf("\n}") + 2);
  assert.match(body, /background:\s*color-mix\(/, "背景走 color-mix（跟随主题主色）");
  assert.match(body, /color:\s*inherit/, "文字颜色必须继承，否则会破坏层级/对比度");
});

test("P0-6 文案与 TRIGRAM_MIN 对齐：全文索引是 3 个字，不是 2 个", () => {
  const page = read("app/search/page.tsx");
  assert.doesNotMatch(page, /两字以上/, "界面不得再声称「两字以上走全文索引」");
  assert.match(page, /三个字以上/, "应改成 3 个字以上");
});

test("P0-6 API：返回 total/capped/terms，且仍带 no-store", () => {
  const src = read("app/api/search/route.ts");
  assert.match(src, /total/, "公开搜索接口应返回 total");
  assert.match(src, /capped/, "公开搜索接口应返回 capped");
  assert.match(src, /terms/, "公开搜索接口应返回 terms（前端高亮用）");
  assert.match(src, /no-store/, "公开搜索必须 no-store（草稿泄露主探针依赖它）");
});

test("单字查询：页面显示「只在标题里匹配」的提示，且空态文案不同", () => {
  /**
   * 单字在正文里几乎每篇都有（`的` 命中全部 25 篇、高亮几十处），
   * 所以 lib/search.ts 对单字只匹配标题。页面必须解释这条规则，
   * 否则用户会以为"正文里明明有，怎么搜不到"。
   */
  const page = read("app/search/page.tsx");
  assert.match(page, /titleOnly/, "搜索页应读取 titleOnly");
  assert.match(page, /search-hint/, "应渲染 .search-hint 提示块");
  assert.match(page, /只在/, "提示里要说明「只在标题里匹配」");
  assert.match(page, /标题/, "提示里要出现「标题」二字");

  const css = read("app/globals.css");
  assert.match(css, /\.search-hint\s*\{/, "globals.css 应定义 .search-hint");
});

test("单字查询：公开搜索接口也回 titleOnly", () => {
  const src = read("app/api/search/route.ts");
  assert.match(src, /titleOnly/, "API 应回 titleOnly，调用方才能提示");
});
