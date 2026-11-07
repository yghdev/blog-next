import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Post } from "../lib/db.ts";
import {
  DEFAULT_OG_IMAGE,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  SITE_URL,
  absoluteUrl,
  articleJsonLd,
  docPath,
  ogImageFor,
  siteAlternates,
} from "../lib/seo.ts";

/**
 * SEO 元信息（P0-5，2026-11-07）。
 *
 * 为什么这些要写成单元测试，而不是只在集成测试里抓 HTML：
 *   canonical / og:url / JSON-LD 的 url 全是**绝对地址**，一旦 SITE_URL 的
 *   拼接方式变了（多一个斜杠、少了协议），错误会静默地出现在每一页的
 *   `<head>` 里 —— 页面看起来完全正常，只有搜索引擎和社交平台拿到坏链接。
 *   抓 HTML 的集成测试成本高（要起真服务），跑不进日常 `npm test`；
 *   这里把规则钉死，集成测试只负责"确实渲染进了 HTML"。
 */

const base: Post = {
  id: 42,
  type: "post",
  title: "一篇测试文章",
  slug: "hello-world",
  content: "正文内容正文内容",
  excerpt: "",
  status: "published",
  categories: '["开发"]',
  tags: '["next", "sqlite"]',
  cover: null,
  wp_id: null,
  published_at: "2026-10-20 18:00:00",
  created_at: "2026-10-20 18:00:00",
  updated_at: "2026-10-21 10:00:00",
  deleted_at: null,
  comments_enabled: 1,
};

const site = { siteTitle: "flechazo's blog", siteDescription: "记录 AI、开发与折腾的日常。", author: "flechazo" };
const post = (over: Partial<Post> = {}): Post => ({ ...base, ...over });

test("SITE_URL 去尾斜杠且与 layout 的 metadataBase 同源", () => {
  assert.equal(SITE_URL, SITE_URL.replace(/\/+$/, ""));
  assert.match(SITE_URL, /^https?:\/\/[^/]+$/);
});

test("absoluteUrl：相对路径补站点根，绝对地址原样返回", () => {
  assert.equal(absoluteUrl("/p/7"), SITE_URL + "/p/7");
  // 少写一个斜杠也不能变成 https://hostp/7 这种拼错
  assert.equal(absoluteUrl("p/7"), SITE_URL + "/p/7");
  assert.equal(absoluteUrl("https://cdn.example.com/a.png"), "https://cdn.example.com/a.png");
  assert.equal(absoluteUrl("http://cdn.example.com/a.png"), "http://cdn.example.com/a.png");
});

test("docPath：文章走编号地址，页面保留语义化 slug", () => {
  assert.equal(docPath(post()), "/p/42");
  // 页面路径要 URL 编码（slug 可能是中文）
  assert.equal(docPath(post({ type: "page", slug: "关于" })), "/" + encodeURIComponent("关于"));
});

test("siteAlternates：canonical 与 RSS autodiscovery 必须成对出现", () => {
  const withCanonical = siteAlternates("/p/42");
  assert.equal(withCanonical.canonical, "/p/42");
  assert.deepEqual(withCanonical.types, { "application/rss+xml": SITE_URL + "/rss.xml" });

  // 不传 canonical 时不能凭空写一个 canonical: undefined（会被渲染成空链接）
  const bare = siteAlternates();
  assert.equal("canonical" in bare, false);
  assert.deepEqual(bare.types, { "application/rss+xml": SITE_URL + "/rss.xml" });
});

test("ogImageFor：有封面用封面，没封面回落到默认 1200×630 分享卡", () => {
  const fallback = ogImageFor(null);
  assert.equal(fallback.url, SITE_URL + DEFAULT_OG_IMAGE);
  assert.equal(fallback.width, OG_IMAGE_WIDTH);
  assert.equal(fallback.height, OG_IMAGE_HEIGHT);
  assert.ok(fallback.alt);

  // 封面尺寸未知，不能瞎标 width/height（平台会按错误比例裁切）
  const cover = ogImageFor("/images/cover.png");
  assert.equal(cover.url, SITE_URL + "/images/cover.png");
  assert.equal("width" in cover, false);
});

test("articleJsonLd：BlogPosting 的必备字段与时间格式", () => {
  const data = JSON.parse(articleJsonLd(post(), site));
  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "BlogPosting");
  assert.equal(data.headline, base.title);
  assert.equal(data.url, SITE_URL + "/p/42");
  assert.deepEqual(data.mainEntityOfPage, { "@type": "WebPage", "@id": SITE_URL + "/p/42" });
  assert.deepEqual(data.image, [SITE_URL + DEFAULT_OG_IMAGE]);
  assert.equal(data.author.name, "flechazo");
  assert.equal(data.publisher.name, site.siteTitle);
  assert.ok(data.publisher.logo.url.startsWith(SITE_URL + "/"));
  assert.equal(data.inLanguage, "zh-CN");
  // 库里存的是 UTC naive 串：JSON-LD 必须是带 Z 的 ISO，否则被解析成当地时间
  assert.equal(data.datePublished, "2026-10-20T18:00:00.000Z");
  assert.equal(data.dateModified, "2026-10-21T10:00:00.000Z");
  assert.equal(data.keywords, "next, sqlite, 开发");
  assert.equal(data.isPartOf["@type"], "Blog");
});

test("articleJsonLd：页面用 WebPage，且不带文章专属字段", () => {
  const data = JSON.parse(articleJsonLd(post({ type: "page", slug: "about" }), site));
  assert.equal(data["@type"], "WebPage");
  assert.equal(data.url, SITE_URL + "/about");
  assert.equal("isPartOf" in data, false);
  assert.equal("wordCount" in data, false);
});

test("articleJsonLd：有封面时 image 用封面，excerpt 为空时用正文摘要", () => {
  const data = JSON.parse(articleJsonLd(post({ cover: "/images/a.png" }), site));
  assert.deepEqual(data.image, [SITE_URL + "/images/a.png"]);
  assert.ok(data.description.length > 0, "excerpt 为空时必须回落到 makeExcerpt，不能是空字符串");

  const withExcerpt = JSON.parse(articleJsonLd(post({ excerpt: "手写摘要" }), site));
  assert.equal(withExcerpt.description, "手写摘要");
});

test("articleJsonLd：标题里的 </script> 不会提前闭合标签（XSS）", () => {
  const evil = '</script><img src=x onerror="alert(1)">';
  const raw = articleJsonLd(post({ title: evil }), site);
  // 序列化后不能出现字面量 </script>，只能出现转义形态
  assert.doesNotMatch(raw, /<\/script/i);
  assert.match(raw, /\\u003c/);
  // 转义不能改变 JSON 语义：解析回来还是原字符串
  assert.equal(JSON.parse(raw).headline, evil);
});

test("articleJsonLd：缺少发布时间时回落创建时间，两者都没有就不输出日期", () => {
  // 草稿转发布的历史数据里 published_at 可能是空的：JSON-LD 用 created_at 兜底，
  // 否则 Google 的结构化数据校验会报 datePublished 缺失
  const fallback = JSON.parse(articleJsonLd(post({ published_at: null, updated_at: "" }), site));
  assert.equal(fallback.datePublished, "2026-10-20T18:00:00.000Z");
  assert.equal(fallback.dateModified, fallback.datePublished);

  // 连创建时间都没有（极端脏数据）：宁可不输出，也不能输出 null/undefined
  const raw = articleJsonLd(post({ published_at: null, created_at: "", updated_at: "" }), site);
  assert.doesNotMatch(raw, /undefined/);
  const data = JSON.parse(raw);
  assert.equal("datePublished" in data, false);
  assert.equal("dateModified" in data, false);
});

test("默认分享图文件确实存在，且尺寸与声明一致（1200×630）", () => {
  const file = path.join(process.cwd(), "public", DEFAULT_OG_IMAGE.replace(/^\//, ""));
  assert.ok(fs.existsSync(file), "缺少 " + file + "：og:image 会 404");
  const buf = fs.readFileSync(file);
  // PNG 头：8 字节签名 + IHDR（宽度在 offset 16，高度在 20，大端）
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "不是 PNG");
  assert.equal(buf.readUInt32BE(16), OG_IMAGE_WIDTH, "宽度与 ogImageFor 声明不一致");
  assert.equal(buf.readUInt32BE(20), OG_IMAGE_HEIGHT, "高度与 ogImageFor 声明不一致");
});
