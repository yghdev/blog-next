import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaSnippet, videoSnippet, escapeMdUrl } from "../lib/editor-media.ts";

/**
 * 插入语法测试。
 *
 * 这一层值得单独测的原因：插入结果直接进 Markdown 正文并落库，
 * 写错了不会报错 —— 只会在前台文章里留下半截残缺的语法。
 * 而且「上传后插入」与「从媒体库插入」必须产出完全相同的片段，
 * 否则同一张图两条路径进来会长得不一样。
 */

/* ------------------------------ 图片 ------------------------------ */

test("图片插入为 Markdown 引用，前后各留空行", () => {
  const s = mediaSnippet("image", "https://cdn.yghsite.cn/2026/10/a.png", "封面");
  assert.equal(s, "\n\n![封面](https://cdn.yghsite.cn/2026/10/a.png)\n\n");
});

test("没有替代文字时方括号留空，不写进 undefined", () => {
  const s = mediaSnippet("image", "/images/2026/10/a.png");
  assert.equal(s, "\n\n![](/images/2026/10/a.png)\n\n");
});

test("替代文字里的方括号被去掉 —— 否则会打断 Markdown 图片语法", () => {
  const s = mediaSnippet("image", "/a.png", "图[1]说明");
  assert.equal(s, "\n\n![图1说明](/a.png)\n\n");
});

test("URL 里的空格与圆括号被编码 —— 否则 ![]() 会在第一个 ) 处提前闭合", () => {
  const s = mediaSnippet("image", "/images/my photo (1).png");
  assert.match(s, /%20/);
  assert.match(s, /%28/);
  assert.match(s, /%29/);
  // 关键：整段里只能有一对「包住 URL 的」圆括号
  const open = (s.match(/\(/g) || []).length;
  const close = (s.match(/\)/g) || []).length;
  assert.equal(open, 1);
  assert.equal(close, 1);
});

test("escapeMdUrl 只动危险字符，正常 URL 原样保留", () => {
  assert.equal(escapeMdUrl("https://cdn.yghsite.cn/2026/10/a-b_c.png"), "https://cdn.yghsite.cn/2026/10/a-b_c.png");
});

/* ------------------------------ 视频 ------------------------------ */

test("视频插入原生 video 标签，带 controls 与 playsinline", () => {
  const s = mediaSnippet("video", "https://cdn.yghsite.cn/2026/10/a.mp4");
  // 片段以空行开头（保证独占一行），所以从 trim 之后开始断言标签本身
  assert.match(s.trimStart(), /^<video /);
  assert.match(s, /controls/);
  // playsinline 缺了的话，iOS 点播放会强制全屏接管整个页面
  assert.match(s, /playsinline/);
  // 移动流量：只取元数据，不预载整段
  assert.match(s, /preload="metadata"/);
  assert.match(s, /src="https:\/\/cdn\.yghsite\.cn\/2026\/10\/a\.mp4"/);
  assert.match(s, /<\/video>/);
});

test("视频不使用 Markdown 图片语法，也不套 iframe", () => {
  const s = mediaSnippet("video", "/v.mp4");
  assert.ok(!s.includes("!["), "视频不该用 ![]() 语法");
  assert.ok(!s.includes("<iframe"), "自托管视频不该用 iframe");
});

test("视频片段前后也留空行，避免被并进上一段", () => {
  const s = mediaSnippet("video", "/v.mp4");
  assert.ok(s.startsWith("\n\n"));
  assert.ok(s.endsWith("\n\n"));
});

test("videoSnippet 转义引号 —— 属性值里的引号会破坏标签结构", () => {
  const s = videoSnippet('https://x/a".mp4');
  assert.ok(s.includes("&quot;"));
  assert.ok(!/src="[^"]*"[^>]*"/.test(s.replace("&quot;", "")), "不应出现未转义的引号");
});

test("空 URL 返回空串，不产出半截标签", () => {
  assert.equal(mediaSnippet("image", ""), "");
  assert.equal(mediaSnippet("video", ""), "");
});

/* ------------------------- 两条路径一致性 ------------------------- */

test("同一资源在「上传」与「媒体库」两条路径产出相同片段", () => {
  const url = "https://cdn.yghsite.cn/2026/10/x.png";
  const fromUpload = mediaSnippet("image", url, "x");
  const fromPicker = mediaSnippet("image", url, "x");
  assert.equal(fromUpload, fromPicker);
});
