import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, groupHunks, diffSnapshotFields } from "../lib/diff.ts";

/**
 * 行级 diff 测试（阶段 03.3）。
 *
 * 重点不是"能不能输出红绿"，而是三件会影响判断的事：
 *   1. 完全相同的长文本必须判定为 identical（退出门槛「复杂文章 diff 为空」）
 *   2. 只改一行时，不能把整篇都标成变化（噪声会淹没真正的改动）
 *   3. 空行是有意义的（Markdown 里它分隔段落），不能被吞掉
 */

test("完全相同的文本 -> identical，无增删", () => {
  const text = ["# 标题", "", "普通段落", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "```ts", "const x = 1;", "```"].join("\n");
  const d = diffLines(text, text);
  assert.equal(d.identical, true);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.ok(d.lines.every((l) => l.op === "equal"));
});

test("改一行 -> 只标记该行为 1 增 1 删，其余保持 equal", () => {
  const a = ["第一行", "第二行", "第三行"].join("\n");
  const b = ["第一行", "第二行改过了", "第三行"].join("\n");
  const d = diffLines(a, b);
  assert.equal(d.identical, false);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  const changed = d.lines.filter((l) => l.op !== "equal");
  assert.equal(changed.length, 2, "只应有一删一增，不能整篇标红");
  assert.equal(d.lines.filter((l) => l.op === "equal").length, 2);
});

test("纯插入 -> 只有 added", () => {
  const d = diffLines("a\nc", "a\nb\nc");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  assert.deepEqual(d.lines.map((l) => l.op), ["equal", "insert", "equal"]);
});

test("纯删除 -> 只有 removed", () => {
  const d = diffLines("a\nb\nc", "a\nc");
  assert.equal(d.added, 0);
  assert.equal(d.removed, 1);
  assert.deepEqual(d.lines.map((l) => l.op), ["equal", "delete", "equal"]);
});

test("空行是有效内容，必须保留而不是被吞掉", () => {
  const a = "第一段\n\n第二段";
  const b = "第一段\n第二段";   // 去掉了中间空行
  const d = diffLines(a, b);
  assert.equal(d.identical, false, "去掉空行是真实改动");
  assert.equal(d.removed, 1);
});

test("行号正确标注：delete 无右行号，insert 无左行号", () => {
  const d = diffLines("a\nb", "a\nx\nb");
  const ins = d.lines.find((l) => l.op === "insert")!;
  assert.equal(ins.leftNo, null);
  assert.equal(ins.rightNo, 2);
  const tail = d.lines[d.lines.length - 1];
  assert.equal(tail.op, "equal");
  assert.equal(tail.leftNo, 2);
  assert.equal(tail.rightNo, 3);
});

test("复杂 Markdown：图片/iframe/表格/代码块都不影响 equal 判定", () => {
  const complex = [
    "## 二级标题",
    "",
    "![图](/images/a.png)",
    "",
    '<iframe src="https://player.bilibili.com/player.html?bvid=BV1xx" />',
    "",
    "| 列1 | 列2 |",
    "| --- | --- |",
    "| 值1 | 值2 |",
    "",
    "```js",
    "const a = `模板${x}`;",
    "```",
    "",
    "尾注[^1]",
    "",
    "[^1]: 脚注内容",
  ].join("\n");
  const d = diffLines(complex, complex);
  assert.equal(d.identical, true, "复杂文章未改动时 diff 必须为空");
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
});

test("尾部换行差异不算改动（避免每篇都多一个空行差异）", () => {
  const withNl = "a\nb\n";
  const withoutNl = "a\nb";
  const d = diffLines(withNl, withoutNl);
  assert.equal(d.identical, true, "仅结尾换行不同不应判为改动");
});

test("超长文本按上限截断，且不谎报 identical", () => {
  const a = Array.from({ length: 20 }, (_, i) => "行 " + i).join("\n");
  const b = a + "\n额外一行";
  const d = diffLines(a, b, { maxLines: 10 });
  // 截断后两份都只取前 10 行，但必须不声称"完全相同"
  assert.equal(d.identical, false, "截断时不得声称内容一致");
});

test("groupHunks 把连续同类行压成块", () => {
  const d = diffLines("a\nb\nc\nd", "a\nX\nY\nd");
  const hunks = groupHunks(d.lines);
  // 期望：equal(a) / delete(b),delete(c) / insert(X),insert(Y) / equal(d)
  assert.ok(hunks.length >= 3);
  for (const h of hunks) {
    assert.ok(h.lines.every((l) => l.op === h.op), "块内操作类型必须一致");
  }
  // 所有行都还在
  assert.equal(hunks.reduce((n, h) => n + h.lines.length, 0), d.lines.length);
});

test("快照字段差异：只标真正变了的那几个", () => {
  const a = { title: "旧标题", slug: "old", categories: ["技术"], tags: ["a"], cover: null, comments_enabled: 1 };
  const b = { title: "新标题", slug: "old", categories: ["技术"], tags: ["a"], cover: null, comments_enabled: 1 };
  const rows = diffSnapshotFields(a, b);
  const changed = rows.filter((r) => r.changed).map((r) => r.field);
  assert.deepEqual(changed, ["title"], "只有标题变了");

  assert.equal(rows.find((r) => r.field === "title")!.from, "旧标题");
  assert.equal(rows.find((r) => r.field === "title")!.to, "新标题");
});

test("快照字段差异：空值显示为 (空) 而不是空白", () => {
  const rows = diffSnapshotFields({ cover: null, categories: [], tags: [] }, { cover: "/x.png", categories: ["技术"], tags: ["t"] });
  assert.equal(rows.find((r) => r.field === "cover")!.from, "(空)");
  assert.equal(rows.find((r) => r.field === "categories")!.from, "(空)");
  assert.equal(rows.find((r) => r.field === "categories")!.to, "技术");
});

test("快照字段差异：允许评论用开启/关闭表达", () => {
  const rows = diffSnapshotFields({ comments_enabled: 1 }, { comments_enabled: 0 });
  const r = rows.find((x) => x.field === "comments_enabled")!;
  assert.equal(r.from, "开启");
  assert.equal(r.to, "关闭");
  assert.equal(r.changed, true);
});
