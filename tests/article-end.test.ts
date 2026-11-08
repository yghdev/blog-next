import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderMarkdown } from "../lib/markdown.ts";

/**
 * 文章页「读完去哪」与图片属性（F9 / F11 / F12，2026-11-07）。
 *
 * 这一组是**结构断言**：它们不测像素，只钉住"该有的东西还在、不该有的写法
 * 没有回来"。像素层面的验收在 tests/layout-regression.mjs 与人工截图里。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* --------------------------- F9：正文图片 --------------------------- */

test("F9 正文图片自动补 loading=lazy / decoding=async", () => {
  const { html } = renderMarkdown("![图](/images/a.png)");
  assert.match(html, /<img[^>]*loading="lazy"/, "应补 loading=lazy，实际：" + html);
  assert.match(html, /<img[^>]*decoding="async"/, "应补 decoding=async，实际：" + html);
});

test("F9 作者显式写了 loading 的图不被覆盖", () => {
  const { html } = renderMarkdown('<img src="/images/hero.png" loading="eager">');
  assert.match(html, /loading="eager"/, "显式 eager 必须保留");
  assert.doesNotMatch(html, /loading="lazy"/, "不得再补一个 lazy");
});

test("F9 自闭合 <img /> 补属性后仍是合法标签", () => {
  const { html } = renderMarkdown('<img src="/images/x.png" />');
  assert.match(html, /<img[^>]*\/>/, "自闭合斜杠必须保留，实际：" + html);
  assert.doesNotMatch(html, /\/\s+loading=/, "斜杠不能跑到属性中间");
});

test("F9 封面：eager + high 优先级 + 有尺寸时输出 width/height", () => {
  const src = read("components/ArticleView.tsx");
  assert.match(src, /className="article-cover"/);
  assert.match(src, /loading="eager"/, "封面是 LCP 元素，不能 lazy");
  assert.match(src, /fetchPriority="high"/, "封面应高优先级");
  // C3（2026-11-08）：coverSize 改名为 coverMeta（多了 variants），断言跟着改
  assert.match(src, /coverMeta/, "应使用 media 表查到的尺寸与变体");
  assert.match(src, /getMediaSizeCached/, "尺寸走缓存读取");
  assert.match(src, /coverSrcset/, "封面也要有 srcset（C3）");

  const css = read("app/globals.css");
  const block = css.slice(css.indexOf(".article-cover {"));
  const body = block.slice(0, block.indexOf("\n}") + 2);
  assert.match(body, /height:\s*auto/, "必须 height:auto，否则 width/height 属性会把图压扁");
});

/* --------------------------- F11：文末区块 --------------------------- */

test("F11 文末有作者卡 + 相关文章 + 订阅入口", () => {
  const src = read("components/ArticleEnd.tsx");
  assert.match(src, /className="author-card"/, "应有作者卡");
  assert.match(src, /className="related"/, "应有相关文章区块");
  assert.match(src, /href="\/rss\.xml"/, "应有 RSS 订阅入口");
  assert.match(src, /href="\/about"/, "应有关于本站入口");
  assert.match(src, /<PostCard/, "相关文章复用 PostCard，不另写一套卡片");
});

test("F11 只对文章渲染文末区块（页面没有「相关」语义）", () => {
  const src = read("components/ArticleView.tsx");
  assert.match(src, /const isPost = doc\.type === "post"/);
  assert.match(src, /\{isPost \? \(/, "文末区块必须被 isPost 包住");
  assert.match(src, /relatedPostsCached\(doc\.id, 3\)/, "相关文章取 3 篇");
});

test("F11 相关文章规则：同分类 +2、同标签 +1，无分类无标签返回空", () => {
  const src = read("lib/posts.ts");
  const block = src.slice(src.indexOf("export function relatedPosts"));
  assert.match(block, /score \+= 2/, "同分类权重 2");
  assert.match(block, /score \+= 1/, "同标签权重 1");
  assert.match(block, /if \(cats\.size === 0 && tags\.size === 0\) return \[\]/, "无分类无标签不硬凑");
  assert.match(block, /id != \?/, "必须排除自己");
});

/* --------------------------- F12：动效约束 --------------------------- */

test("F12 光斑只在精细指针 + 未要求减弱动效时启用，且 rAF 节流", () => {
  const src = read("components/Animations.tsx");
  assert.match(src, /prefers-reduced-motion: reduce/, "必须尊重 reduced-motion");
  assert.match(src, /\(pointer: fine\)/, "必须判断精细指针");
  assert.match(src, /requestAnimationFrame/, "mousemove 必须 rAF 节流");
  assert.match(src, /cancelAnimationFrame/, "卸载时要取消未执行的帧");
  assert.match(src, /passive: true/, "mousemove 监听应 passive");
});

/* --------------------------- F8：标题尺度 --------------------------- */

test("F8 文章标题用 clamp 覆盖移动端，不再靠媒体查询覆盖", () => {
  const css = read("app/globals.css");
  // 注意：不能用 indexOf(".article-title {") —— 文件里有一处**注释**也写着
  // `.article-title { font-size: 2rem; …`（C-6 的说明），会先命中注释。
  // 必须按"行首就是选择器"来找真正的规则。
  const lines = css.split("\n");
  const start = lines.findIndex((l) => /^\.article-title\s*\{/.test(l));
  assert.ok(start >= 0, "应能找到 .article-title 基础定义");
  let body = "";
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    body += lines[i] + "\n";
    depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
    if (depth === 0) break;
  }
  assert.match(body, /font-size:\s*clamp\(1\.75rem, 1\.5rem \+ 1vw, 2\.35rem\)/, "基础定义应使用 clamp，实际：" + body);
  // 断言"覆盖已删除"时必须先剥掉注释 —— 文件末尾的说明性注释里仍然写着
  // 那条旧规则（作为历史记录），不剥注释会误判成"规则还在"。
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(noComments, /\.article-title\s*\{\s*font-size:\s*1\.5rem/, "旧的 1.5rem 覆盖应已删除");
});

test("F8 正文 H2/H3 尺度上调", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.prose h2 \{ font-size: 1\.4rem/);
  assert.match(css, /\.prose h3 \{ font-size: 1\.15rem/);
});

/* --------------------------- F7：卡片元信息 --------------------------- */

test("F7 卡片元信息分两级：主级在 .meta，次级在 .meta-sub", () => {
  const src = read("components/PostCard.tsx");
  assert.match(src, /className="meta-sub"/, "次级元信息应有独立容器");
  // 次级块里放阅读时长与浏览量
  const sub = src.slice(src.indexOf('className="meta-sub"'));
  assert.match(sub, /分钟/, "次级块应含阅读时长");
  assert.match(sub, /views-badge/, "次级块应含浏览量");

  const css = read("app/globals.css");
  const block = css.slice(css.indexOf(".meta-sub {"));
  const body = block.slice(0, block.indexOf("\n}") + 2);
  assert.match(body, /font-size:\s*\.74rem/, "次级字号应小一档");
  assert.match(body, /margin-left:\s*auto/, "次级应靠右，形成两级");
});
