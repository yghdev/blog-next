import type { Metadata } from "next";
import { makeExcerpt, parseJsonArray, postHref } from "./posts";
import { toUtcIso } from "./time";
import type { Post } from "./db";

/**
 * SEO 元信息的**唯一事实来源**（P0-5，2026-11-07）。
 *
 * 改这一版之前的实测问题（2026-11-07 抓线上 HTML）：
 *   1. 文章页没有 `<link rel="canonical">` —— 同一篇内容在 `/p/12` 与
 *      旧中文 slug（308 后再到 /p/12）两种形态下都可能被外部引用，
 *      没有 canonical 时权重与索引会分散；
 *   2. 没有 og:image —— 分享到微信/Twitter/Telegram 只有一行字 + 空白；
 *   3. 没有 JSON-LD —— 搜索结果拿不到文章的发布/更新时间与作者；
 *   4. 没有 RSS autodiscovery —— 浏览器/阅读器无法自动发现 /rss.xml；
 *   5. `app/sitemap.ts` 有 `revalidate = 3600`，Next 在 **build 时**预渲染，
 *      构建机本地库是空的，于是线上 sitemap 会空一整个小时（见 downline）。
 *
 * 这里刻意只收「纯函数 + 常量」，不碰数据库：路由层负责取 doc/settings，
 * 传进来之后元信息怎么拼只由这份文件决定。好处是能被单元测试直接钉住
 * （tests/seo.test.ts），而不是只能靠启服务抓 HTML 才能验证。
 */

/** 站点根地址：与 layout 的 metadataBase 必须同一个来源，否则 canonical 会漂 */
export const SITE_URL = (process.env.SITE_URL || "https://blog.yghsite.cn").replace(/\/+$/, "");

/** 默认分享图（scripts/gen-og-default.mjs 生成，已提交进仓库） */
export const DEFAULT_OG_IMAGE = "/og-default.png";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** RSS 路径：autodiscovery、页脚分享、阅读器都指向它 */
export const RSS_PATH = "/rss.xml";

/** JSON-LD 里 publisher.logo 用的稳定图标（PWA 512 图标，已存在） */
const SITE_LOGO = "/icon-512.png";

/** 元信息只需要设置里的这几项；用结构类型，调用方传 Settings 即可 */
export type SiteIdentity = {
  siteTitle: string;
  siteDescription: string;
  author: string;
};

/**
 * 相对路径 -> 绝对 URL。
 *
 * canonical / og:url / JSON-LD 的 url 都要求绝对地址；而 openGraph.images
 * 里的相对路径 Next 会按 metadataBase 补全 —— 两处口径不统一时，
 * 社交平台抓到的地址与 canonical 不一致，是最难查的一类 SEO 问题。
 */
export function absoluteUrl(pathname: string): string {
  if (/^https?:\/\//i.test(pathname)) return pathname;
  return SITE_URL + (pathname.startsWith("/") ? pathname : "/" + pathname);
}

/** 文章 / 页面的规范路径（文章 `/p/<id>`，页面保留语义化 slug） */
export function docPath(doc: Pick<Post, "id" | "type" | "slug">): string {
  return postHref(doc);
}

/**
 * `alternates` 的统一构造。
 *
 * ⚠️ 为什么必须成对出现：Next 的 metadata 是**浅合并** —— 页面一旦写了
 * `alternates`，父级 layout 的整个 `alternates` 就被替换掉，RSS autodiscovery
 * 会一起消失。所以凡是设置 canonical 的页面，都得从这里拿 alternates。
 */
export function siteAlternates(canonicalPath?: string): NonNullable<Metadata["alternates"]> {
  return {
    ...(canonicalPath ? { canonical: canonicalPath } : {}),
    types: { "application/rss+xml": absoluteUrl(RSS_PATH) },
  };
}

/**
 * og:image 的取值。
 *
 * 有封面用封面（尺寸未知，不瞎写 width/height）；没有封面用默认分享卡
 * （此时尺寸是确定的 1200×630，写上能让平台首屏就按大图排）。
 */
export function ogImageFor(cover?: string | null) {
  if (cover) return { url: absoluteUrl(cover) };
  return {
    url: absoluteUrl(DEFAULT_OG_IMAGE),
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    alt: "flechazo's blog",
  };
}

/** 文章 / 页面的 JSON-LD（schema.org）。返回**已序列化**的字符串，见下方转义说明 */
export function articleJsonLd(doc: Post, site: SiteIdentity): string {
  const url = absoluteUrl(docPath(doc));
  const desc = doc.excerpt || makeExcerpt(doc.content);
  const published = toUtcIso(doc.published_at || doc.created_at);
  const modified = toUtcIso(doc.updated_at) || published || undefined;
  const keywords = [...parseJsonArray(doc.tags), ...parseJsonArray(doc.categories)];
  const isPost = doc.type === "post";

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": isPost ? "BlogPosting" : "WebPage",
    headline: doc.title,
    name: doc.title,
    description: desc,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    image: [absoluteUrl(doc.cover || DEFAULT_OG_IMAGE)],
    author: { "@type": "Person", name: site.author, url: SITE_URL },
    publisher: {
      "@type": "Organization",
      name: site.siteTitle,
      logo: { "@type": "ImageObject", url: absoluteUrl(SITE_LOGO) },
    },
    inLanguage: "zh-CN",
    ...(published ? { datePublished: published } : {}),
    ...(modified ? { dateModified: modified } : {}),
    ...(keywords.length > 0 ? { keywords: keywords.join(", ") } : {}),
    ...(isPost
      ? {
          isPartOf: { "@type": "Blog", name: site.siteTitle, url: SITE_URL },
          wordCount: doc.content.length,
        }
      : {}),
  };

  /**
   * `</script>` 转义：JSON-LD 是内联进 HTML 的，标题里只要出现 `</script>`
   * 就会把脚本标签提前闭合（XSS）。`<` 一律写成 `\u003c`，JSON 语义不变。
   * 另外 U+2028/U+2029 在旧 JS 引擎里是行终止符，一并转义。
   */
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
