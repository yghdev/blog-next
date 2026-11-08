import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../lib/markdown.ts";

/**
 * 正文 HTML 消毒（D，2026-11-08）。
 *
 * 背景：`marked` 把 Markdown 里的原始 HTML 原样透传，正文最终走
 * `dangerouslySetInnerHTML`。内容只有管理员能写，所以风险是"中等"而不是
 * "高危" —— 但一次误粘贴、一次账号被盗、一次从别处导入的 HTML，都会变成
 * 存储型 XSS。这一组用例把"哪些必须被剥掉、哪些必须保留"钉死。
 *
 * 注意：这里测的是**渲染结果**，不是 sanitize-html 本身 —— 库的行为变了
 * （升级）或者白名单被改窄/改宽，都会在这里露出来。
 */

const render = (md: string) => renderMarkdown(md).html;

/* ------------------------------ 必须剥掉 ------------------------------ */

test("D 脚本标签整块丢弃（含内容）", () => {
  const html = render("前<script>alert(1)</script>后");
  assert.doesNotMatch(html, /<script/i, "不得残留 script 标签");
  assert.doesNotMatch(html, /alert\(1\)/, "脚本内容也必须丢掉");
  assert.match(html, /前后|前\s*后/, "正常文字要保留");
});

test("D 事件属性一律剥掉", () => {
  for (const attr of ["onerror", "onload", "onclick", "onmouseover"]) {
    const html = render(`<img src="/images/a.png" ${attr}="alert(1)">`);
    assert.doesNotMatch(html, new RegExp(attr, "i"), attr + " 必须被剥掉，实际：" + html);
  }
});

test("D javascript: / data: 链接被剥掉（保留文字）", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x"]) {
    const html = render(`[点我](${href})`);
    assert.doesNotMatch(html, /href=/i, href + " 不应留下 href，实际：" + html);
    assert.match(html, /点我/, "链接文字要保留");
  }
});

test("D 非白名单域名的 iframe 整块丢弃（不留空白框）", () => {
  const html = render('<iframe src="https://evil.example.com/x"></iframe>');
  assert.doesNotMatch(html, /<iframe/i, "非白名单 iframe 必须整块丢掉，实际：" + html);
});

test("D 相对地址的 iframe 被拒（防绕过 frame-ancestors）", () => {
  const html = render('<iframe src="/admin"></iframe>');
  assert.doesNotMatch(html, /<iframe/i, "相对地址 iframe 必须被拒");
});

test("D style / object / embed / form / base / meta 一律剥掉", () => {
  const html = render(
    '<style>body{display:none}</style>' +
    '<object data="x"></object><embed src="x">' +
    '<form action="https://evil"><input name="a"></form>' +
    '<base href="https://evil/">' +
    '<meta http-equiv="refresh" content="0;url=https://evil">'
  );
  for (const tag of ["style", "object", "embed", "form", "base", "meta"]) {
    assert.doesNotMatch(html, new RegExp("<" + tag, "i"), tag + " 必须被剥掉，实际：" + html);
  }
});

test("D svg 及其事件属性被剥掉", () => {
  const html = render('<svg onload="alert(1)"><circle r="1"/></svg>');
  assert.doesNotMatch(html, /<svg/i, "svg 不在白名单里");
  assert.doesNotMatch(html, /onload/i);
});

test("D 普通标签上的 style 被剥掉（只有 iframe 例外）", () => {
  const html = render('<div style="position:fixed;inset:0;background:red">x</div>');
  assert.doesNotMatch(html, /style=/i, "div 不应保留 style，实际：" + html);
  assert.match(html, />x</, "内容要保留");
});

/* ------------------------------ 必须保留 ------------------------------ */

test("D 白名单平台的 iframe 保留（B 站 / YouTube）", () => {
  const bili = render(
    '<div class="video-container"><iframe src="https://player.bilibili.com/player.html?bvid=BV1x" ' +
    'allowfullscreen frameborder="0"></iframe></div>'
  );
  assert.match(bili, /<iframe[^>]*player\.bilibili\.com/, "B 站 iframe 必须保留，实际：" + bili);
  assert.match(bili, /allowfullscreen/, "allowfullscreen 要保留");
  assert.match(bili, /class="video-container"/, "外层容器类名要保留");

  const yt = render('<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>');
  assert.match(yt, /<iframe[^>]*youtube-nocookie/, "YouTube iframe 必须保留");
});

test("D 编辑器插入的 <video> 保留（controls / playsinline / preload）", () => {
  const html = render('<video controls playsinline preload="metadata" src="/images/a.mp4"></video>');
  assert.match(html, /<video[^>]*controls/, "controls 要保留");
  assert.match(html, /playsinline/, "playsinline 要保留");
  assert.match(html, /preload="metadata"/, "preload 要保留");
  assert.match(html, /src="\/images\/a\.mp4"/, "src 要保留");
});

test("D 标题 id 保留（目录靠它跳转）", () => {
  const { html, toc } = renderMarkdown("## 小节一\n\n正文\n\n### 小节二");
  assert.match(html, /<h2 id="小节一">/, "标题 id 必须保留，实际：" + html);
  assert.equal(toc.length, 2, "目录应有两项");
  assert.equal(toc[0].id, "小节一");
});

test("D 代码块语言类名保留（高亮靠它）", () => {
  const html = render("```js\nconst a = 1;\n```");
  assert.match(html, /<code class="language-js">/, "language-js 必须保留，实际：" + html);
});

test("D 图片：src/alt/宽高保留，data: 图片允许", () => {
  const html = render("![图](/images/a.png)");
  assert.match(html, /<img[^>]*src="\/images\/a\.png"/);
  assert.match(html, /alt="图"/);

  const data = render("![内联](data:image/png;base64,iVBORw0KGgo=)");
  assert.match(data, /src="data:image\/png/, "data: 图片应允许");
});

test("D 表格与上标下标保留（历史 WordPress 内容用到）", () => {
  const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\nH<sub>2</sub>O 与 x<sup>2</sup>");
  assert.match(html, /<table>/, "表格要保留");
  assert.match(html, /<sub>/, "sub 要保留");
  assert.match(html, /<sup>/, "sup 要保留");
});

test("D target=_blank 的链接自动补 rel=noopener noreferrer", () => {
  const html = render('[外链](https://example.com)');
  // marked 默认不加 target，这里直接构造原始 HTML 验证 transformTags
  const raw = render('<a href="https://example.com" target="_blank">外链</a>');
  assert.match(raw, /rel="[^"]*noopener/, "应补 noopener，实际：" + raw);
  assert.match(raw, /rel="[^"]*noreferrer/, "应补 noreferrer，实际：" + raw);
  assert.ok(html.length > 0);
});

test("D iframe 的 style 只保留安全属性（历史 WordPress 铺满写法）", () => {
  const html = render(
    '<iframe src="https://player.bilibili.com/player.html?bvid=BV1x" ' +
    'style="position:absolute;width:100%;height:100%;left:0;top:0;border:none;overflow:hidden;background:url(javascript:alert(1))"></iframe>'
  );
  assert.match(html, /position:absolute/, "position:absolute 要保留");
  assert.match(html, /width:100%/, "width:100% 要保留");
  assert.doesNotMatch(html, /javascript:/i, "style 里的 javascript: 必须被剥掉");
  assert.doesNotMatch(html, /background/, "不在白名单里的属性要剥掉");
});

/* ------------------------------ 不误伤 ------------------------------ */

test("D 普通 Markdown 渲染结果不受影响", () => {
  const html = render("# 标题\n\n**粗体** 与 *斜体* 与 `代码`\n\n- 列表项\n\n> 引用");
  assert.match(html, /<h1[^>]*>标题<\/h1>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code>代码<\/code>/);
  assert.match(html, /<li>列表项<\/li>/);
  assert.match(html, /<blockquote>/);
});

test("D 正文里的 <name> 这类伪标签不会把后面的文字吃掉", () => {
  // 线上真实内容里有「/skill new <name>（加 --global …）」这种写法。
  // 伪标签被丢弃后，后面的中文必须还在。
  const html = render("快速创建：/skill new <name>（加 --global 可写到全局）");
  assert.match(html, /加 --global 可写到全局/, "伪标签后面的文字必须保留，实际：" + html);
});
