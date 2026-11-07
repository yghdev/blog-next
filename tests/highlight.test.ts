import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMatcher, countMatches, highlightTerms, isHit, scoreHit, snippetAround, splitHighlights,
} from "../lib/highlight.ts";
import { makeExcerpt, plainText } from "../lib/posts.ts";

/**
 * 搜索命中规则（P0-6，2026-11-07）。
 *
 * 这套规则同时决定「哪些结果算命中 / 怎么排序 / 摘要从哪截 / 界面上标哪几个字」。
 * 四件事用同一个 matcher 是这次改版的核心不变量 —— 一旦有人只改其中一处
 * （比如高亮用大小写敏感的正则、排序用另一份），就会出现"列表里有这条，
 * 但摘要里找不到关键词"的错位，而这种错位极难被肉眼测试发现。
 * 所以这里先在纯函数层把规则钉死。
 */

/* ----------------------------- 词拆分 ----------------------------- */

test("highlightTerms：按空白拆分、去重（忽略大小写）、长词优先", () => {
  assert.deepEqual(highlightTerms("  deepseek   视频 "), ["deepseek", "视频"]);
  // 同一个词大小写不同只保留一个，且保留第一次出现的写法
  assert.deepEqual(highlightTerms(["AI", "ai", "Ai"]), ["AI"]);
  // 长词在先，否则 "deepseek" 会被 "deep" 先吃掉一半
  assert.deepEqual(highlightTerms(["AI", "deepseek"]), ["deepseek", "AI"]);
  assert.deepEqual(highlightTerms(""), []);
  assert.deepEqual(highlightTerms("   "), []);
  assert.deepEqual(highlightTerms([]), []);
});

/* ----------------------------- 命中判定 ----------------------------- */

test("ASCII 词有词边界：AI 不命中 email，但命中「用 AI 写」与 (AI)", () => {
  assert.ok(isHit("用 AI 写代码", "AI"));
  assert.ok(isHit("聊聊 AI 与写作", "AI"));
  assert.ok(isHit("（AI）", "AI"));
  assert.equal(isHit("email 通知", "AI"), false, "AI 不能命中 email 里的 ai");
  assert.equal(isHit("main 函数", "AI"), false, "AI 不能命中 main");
  assert.equal(isHit("again", "AI"), false);
  // 同上，但换多个文本连续判断：不能因为 RegExp 的 lastIndex 残留而串味
  assert.deepEqual(
    ["用 AI 写代码", "email 通知", "（AI）", "main 函数"].map((t) => isHit(t, "AI")),
    [true, false, true, false]
  );
});

test("中文没有词边界：按子串命中（变换 -> 霍夫变换）", () => {
  assert.ok(isHit("霍夫变换底层原理", "变换"));
  assert.ok(isHit("图像变换", "变换"));
  assert.equal(buildMatcher("")!, null, "空查询不应产生匹配器（否则会匹配空串）");
});

test("大小写不敏感，但高亮保留原文大小写", () => {
  const parts = splitHighlights("AI 与 ai 都是同一个词", ["AI"]);
  const hits = parts.filter((p) => p.hit).map((p) => p.text);
  assert.deepEqual(hits, ["AI", "ai"], "命中文本必须取原文，而不是查询串");
});

test("多词命中：任一词出现即算命中（用于打分，不要求全部出现）", () => {
  assert.ok(isHit("deepseek 生成的视频", "deepseek 视频"));
  assert.ok(isHit("只有视频", "deepseek 视频"));
  assert.equal(countMatches("视频 视频 视频", "deepseek 视频"), 3);
});

/* ----------------------------- 片段切分 ----------------------------- */

test("splitHighlights：片段拼起来必须等于原文（不丢字、不重复）", () => {
  const texts = [
    "普通文本没有命中词",
    "AI 在开头",
    "结尾是 AI",
    "a<b>&c 与 AI</span>",
    "",
  ];
  for (const text of texts) {
    const parts = splitHighlights(text, ["AI"]);
    assert.equal(parts.map((p) => p.text).join(""), text, "拼接失真: " + JSON.stringify(text));
  }
});

test("splitHighlights：不生成 HTML（标题里的尖括号原样作为文本）", () => {
  const text = '<img src=x onerror="alert(1)"> AI';
  const parts = splitHighlights(text, ["AI"]);
  // 尖括号只可能出现在普通文本片段里，组件会把它当文本渲染 -> 天然免疫 XSS
  assert.equal(parts.map((p) => p.text).join(""), text);
  assert.equal(parts.filter((p) => p.hit).length, 1);
});

test("splitHighlights：正则元字符按字面量处理，不抛异常", () => {
  for (const q of ["c++", "a.b", "[", "(", "\\", "a|b", "?"]) {
    assert.doesNotThrow(() => buildMatcher(q), "查询 " + JSON.stringify(q) + " 不应抛粗");
  }
  const parts = splitHighlights("学 c++ 的第一天", ["c++"]);
  assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ["c++"]);
  // "a.b" 是字面量：不该匹配 "axb"
  assert.equal(countMatches("axb", ["a.b"]), 0);
});

/* ------------------------------- 打分 ------------------------------- */

test("scoreHit：标题命中权重 10，压过正文里的零星出现", () => {
  assert.equal(scoreHit("视频剪辑", "", ["视频"]), 10);
  assert.equal(scoreHit("杂谈", "视频 视频 视频", ["视频"]), 3);
  // 正文出现 9 次仍输给标题 1 次；第 10 次才追平（这是刻意的权重选择）
  assert.ok(scoreHit("视频", "视频".repeat(9), ["视频"]) > scoreHit("无关", "视频".repeat(9), ["视频"]));
  assert.equal(scoreHit("无关", "无关", ["视频"]), 0);
});

/* ------------------------------- 摘要 ------------------------------- */

test("snippetAround：以命中位置为中心截取，而不是永远取开头", () => {
  const body = "铺垫".repeat(200) + "这里是霍夫变换的详解" + "收尾".repeat(50);
  const snip = snippetAround(body, "霍夫变换", 60);
  assert.ok(snip.includes("霍夫变换"), "摘要里必须能看到命中的词，实际: " + snip);
  assert.ok(snip.startsWith("…"), "命中不在开头时应带前导省略号");
  assert.ok([...snip].length <= 63, "摘要不该超长: " + [...snip].length);
});

test("snippetAround：短文本原样返回，不画蛇添足加省略号", () => {
  assert.equal(snippetAround("霍夫变换", "霍夫", 90), "霍夫变换");
});

test("snippetAround：没有命中时退回「从头截断」，行为与 makeExcerpt 一致", () => {
  const long = "无关内容".repeat(100);
  const snip = snippetAround(long, "霍夫", 30);
  assert.ok(snip.endsWith("…"));
  assert.ok(!snip.startsWith("…"));
});

test("snippetAround：英文摘要不从单词中间开始（截图里出现过 …gent 这种断头）", () => {
  const body = "aaaaaaaaaa bbbbbbbbbb cccccccccc HIT dddddddddd";
  const snip = snippetAround(body, "HIT", 20);
  assert.ok(snip.includes("HIT"));
  const stripped = snip.startsWith("…") ? snip.slice(1) : snip;
  // 正确结果是从命中词本身开始（前面那个单词被整段跳过），而不是 "…c HIT"
  assert.equal(stripped, body.slice(body.indexOf("HIT")), "窗口起点应挪到单词边界，实际: " + JSON.stringify(snip));
});

test("snippetAround：不把 emoji 从代理对中间切开", () => {
  const body = "😀".repeat(80) + "霍夫变换" + "😀".repeat(80);
  const snip = snippetAround(body, "霍夫", 40);
  // 落单的高位/低位代理项在输出里表现为替换字符或半个字形
  assert.doesNotMatch(snip, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "出现了落单的高位代理项");
  assert.doesNotMatch(snip, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "出现了落单的低位代理项");
});

/* --------------------- 正文清洗（makeExcerpt 复用） --------------------- */

test("plainText：保留连字符与下划线（日期/标识符不被吃掉），只删行首列表符号", () => {
  /**
   * 这是 P0-6 抓到的回归：旧清洗规则 `[*_~`>\-]` 见字符就删，
   *   · 日期 `2026-11-07` 被摘成 `20261107`；
   *   · 搜索词 `CACHE_DB_ONLY` 因为下划线被删，永远匹配不到正文里的同名串
   *     （集成测试里通过"绕过应用直改库再搜"暴露出来的）。
   */
  const plain = plainText("- 发布于 2026-11-07 的 coc-tool 与 CACHE_DB_ONLY\n1. 第二项");
  assert.ok(plain.includes("2026-11-07"), "日期里的连字符必须保留: " + plain);
  assert.ok(plain.includes("coc-tool"), "标识符里的连字符必须保留: " + plain);
  assert.ok(plain.includes("CACHE_DB_ONLY"), "标识符里的下划线必须保留: " + plain);
  assert.equal(plain.startsWith("-"), false, "行首列表符号应删除");
  assert.equal(plain.includes("1. 第二项"), false, "有序列表序号应删除");
});

test("plainText / makeExcerpt：清洗规则不变（代码块、链接语法、标题井号、裸 URL）", () => {
  const md = [
    "# 标题",
    "```js",
    "const a = 1;",
    "```",
    "正文里有 [链接文字](https://example.com/a) 和 https://bare.example.com/x",
    "**加粗** 与 `行内代码`",
  ].join("\n");
  const plain = plainText(md);
  assert.doesNotMatch(plain, /```|const a/);
  assert.ok(plain.includes("链接文字"), "保留链接文字、丢掉 URL");
  assert.doesNotMatch(plain, /https?:\/\//, "裸 URL 应被去掉");
  assert.doesNotMatch(plain, /\*\*|`/, "Markdown 修饰符应被去掉");
  assert.doesNotMatch(plain, /^#\s/, "标题井号应被去掉");

  // makeExcerpt 的长文截断与省略号行为保持不变
  assert.equal(makeExcerpt("字".repeat(200), 120).length, 121);
  assert.ok(makeExcerpt("字".repeat(200), 120).endsWith("…"));
  assert.equal(makeExcerpt("短文本", 120), "短文本");
});
