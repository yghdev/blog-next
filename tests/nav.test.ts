import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * 导航单源与 active 自判（B-7）。
 *
 * ## 为什么需要
 *
 * 原来 `active` 是**手工传的字符串**：每个页面自己写 `<Sidebar active="/archives" />`。
 * 只要有人忘写或写错，那个页面就没有选中态 —— 而且不会报错，只有肉眼能发现。
 * 实测已经漏了 3 个：`/about`（传 `""`）、`/tags/*`（传 `""`）、`/search`（传 `"/search"`，
 * 但 `/search` 根本不在导航数组里）。
 *
 * 改成 `usePathname()` + `activeHref()` 之后，"忘写"这个错误在类型上就不可能发生
 * （`Sidebar` 不再接受 `active` prop）。这个文件守的是 `activeHref` 的映射规则。
 */

const nav = await import("../lib/nav.ts");

test("NAV_ITEMS 是唯一事实来源：5 项、顺序固定、href 唯一", () => {
  assert.equal(nav.NAV_ITEMS.length, 5, "导航应为 5 项");
  assert.deepEqual(
    nav.NAV_ITEMS.map((n) => n.href),
    ["/", "/shuoshuo", "/archives", "/friend-links", "/about"],
    "顺序必须与需求文档 2.1 一致"
  );
  assert.deepEqual(
    nav.NAV_ITEMS.map((n) => n.label),
    ["文章", "说说", "归档", "友链", "关于"],
    "标签统一为这一套（移动端也用它）"
  );
  const hrefs = nav.NAV_ITEMS.map((n) => n.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "href 不得重复");
  for (const item of nav.NAV_ITEMS) {
    assert.ok(item.icon && item.icon.length > 0, item.href + " 必须有图标");
  }
});

test("activeHref：精确匹配的页面各自高亮自己", () => {
  assert.equal(nav.activeHref("/"), "/");
  assert.equal(nav.activeHref("/shuoshuo"), "/shuoshuo");
  assert.equal(nav.activeHref("/archives"), "/archives");
  assert.equal(nav.activeHref("/friend-links"), "/friend-links");
  assert.equal(nav.activeHref("/about"), "/about");
});

test("activeHref：文章详情 /p/* 归到「文章」(/)，这是原来漏掉的", () => {
  // 原来 ArticleView 传的是 doc.type === "post" ? "/" : ""，
  // 硬编码在组件里；现在由路径自己判定。
  assert.equal(nav.activeHref("/p/123"), "/", "/p/<id> 应高亮「文章」");
  assert.equal(nav.activeHref("/p/1"), "/");
});

test("activeHref：标签页 /tags/* 归到「文章」(/)，这是原来漏掉的", () => {
  assert.equal(nav.activeHref("/tags/ai"), "/");
  assert.equal(nav.activeHref("/tags/%E4%B8%AD%E6%96%87"), "/");
});

test("activeHref：/search 不在导航里，必须返回 null（原来传了不存在的 /search）", () => {
  assert.equal(nav.activeHref("/search"), null, "/search 不是导航项，不应有选中态");
});

test("activeHref：尾部斜杠与查询串不影响判定", () => {
  assert.equal(nav.activeHref("/archives/"), "/archives", "尾斜杠应被忽略");
  assert.equal(nav.activeHref("/archives?page=2"), "/archives", "查询串应被忽略");
  assert.equal(nav.activeHref("/tags/ai/"), "/", "标签页尾斜杠仍归到「文章」");
  // `/tags/` 去掉尾斜杠就是 `/tags`，而它本身没有页面（404），
  // 所以不该点亮任何项 —— 这与「尾斜杠无关」并不冲突：
  // 归到「文章」的前提是**带了一个实际的 tag 段**。
  assert.equal(nav.activeHref("/tags"), null, "/tags 本身 404，不点亮任何项");
});

test("activeHref：未知路径返回 null，不能误把某一项点亮", () => {
  for (const p of ["/unknown", "/admin", "/admin/overview", "/p", "/p/"]) {
    assert.equal(nav.activeHref(p), null, p + " 不应命中任何导航项");
  }
});

test("activeHref：不能前缀误匹配（/archives-old 不该点亮 /archives）", () => {
  assert.equal(nav.activeHref("/archives-old"), null, "前缀相似不等于命中");
  assert.equal(nav.activeHref("/shuoshuo-x"), null);
  assert.equal(nav.activeHref("/about-us"), null);
});
