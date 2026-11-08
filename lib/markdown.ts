import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { EMBED_HOSTS } from "./video-embed";

marked.setOptions({ gfm: true, breaks: false });

/**
 * 正文 HTML 白名单（D，2026-11-08）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * `marked` 会把 Markdown 里的原始 HTML **原样透传**，而正文最终走
 * `dangerouslySetInnerHTML`。也就是说：正文里写 `<img src=x onerror=alert(1)>`
 * 或 `<script>`，浏览器就会执行。内容只有管理员能写，所以风险是"中等"而不是
 * "高危" —— 但"只有管理员能写"不是不做消毒的理由：一次误粘贴、一次账号
 * 被盗、一次从别处导入的 HTML，都会变成存储型 XSS。
 *
 * ── 为什么用 sanitize-html 而不是 DOMPurify ──────────────────
 * DOMPurify 在服务端要配 jsdom（几十 MB 常驻内存），而本机 MemoryHigh=300M，
 * 应用常驻已经 100MB+。sanitize-html 基于 htmlparser2，纯字符串解析、无 DOM，
 * 依赖只有 400KB 左右，是这台机器的正确取舍。
 *
 * ── 白名单怎么定的 ────────────────────────────────────────────
 * 不是"凭感觉列一堆"，而是**按实际内容反推**：
 *   · marked 自己产出的标签（p/h1-h6/ul/ol/li/pre/code/table/a/img/…）；
 *   · 编辑器插入的 `<video>`（lib/editor-media.ts 的 videoSnippet）；
 *   · 视频嵌入的 `<div class="video-container"><iframe>`（lib/video-embed.ts）；
 *   · 历史 WordPress 内容里的 `<sup>/<sub>/<u>/<table>`。
 * 线上内容普查（2026-11-08）确认真实出现的原始标签只有 iframe/div/sup/u/table/sub。
 *
 * ── 几条不能动的边界 ──────────────────────────────────────────
 *   · `id` 必须放行：目录（TOC）靠标题 id 跳转，剥掉就全废；
 *   · `class` 必须放行：代码块语言标记 `language-js`、`.video-container` 都靠它；
 *   · iframe 的 src 只认 `EMBED_HOSTS`（与 lib/video-embed.ts 同一份白名单），
 *     不允许相对地址 —— 否则 `<iframe src="/admin">` 能绕过 frame-ancestors；
 *   · `style` 只对 iframe 放行，且只允许那 7 个属性（历史 WordPress 嵌入用
 *     position:absolute 铺满容器）。其它标签一律不给 style。
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    // 块级
    "p", "br", "hr", "div", "section", "blockquote", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "figure", "figcaption", "details", "summary",
    // 行内
    "a", "strong", "b", "em", "i", "u", "s", "del", "ins", "mark",
    "sup", "sub", "small", "code", "kbd", "span", "abbr", "cite", "q",
    // 媒体
    "img", "video", "source", "iframe",
    // GFM 任务列表
    "input",
  ],
  allowedAttributes: {
    "*": ["class", "id", "title", "lang", "dir"],
    a: ["href", "target", "rel", "name"],
    img: ["src", "alt", "width", "height", "loading", "decoding", "title"],
    iframe: [
      "src", "title", "width", "height", "allow", "allowfullscreen",
      "frameborder", "scrolling", "framespacing", "sandbox", "referrerpolicy",
      "style",
    ],
    video: ["src", "controls", "playsinline", "preload", "poster", "width", "height", "muted", "loop", "title"],
    source: ["src", "type", "media"],
    th: ["colspan", "rowspan", "align", "scope"],
    td: ["colspan", "rowspan", "align"],
    ol: ["start", "type", "reversed"],
    li: ["value"],
    input: ["type", "checked", "disabled"],
  },
  // 只给 iframe 的 style 放行这几个属性（历史 WordPress 嵌入的铺满写法）
  allowedStyles: {
    iframe: {
      position: [/^absolute$/],
      width: [/^100%$/],
      height: [/^100%$/],
      left: [/^0(px)?$/],
      top: [/^0(px)?$/],
      border: [/^none$/],
      overflow: [/^hidden$/],
    },
  },
  allowedSchemes: ["http", "https", "mailto"],
  // 正文里允许 data: 图片（编辑器粘贴的小图），但链接不行
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowedIframeHostnames: [...EMBED_HOSTS],
  allowIframeRelativeUrls: false,
  disallowedTagsMode: "discard",
  /**
   * src 被白名单剥掉的 iframe 直接整块丢掉。
   *
   * 不这么做的话，`<iframe src="https://evil.com">` 会变成 `<iframe></iframe>`
   * —— 危险是没了，但页面上会多一个空白框，看起来像"嵌入坏了"。
   */
  exclusiveFilter: (frame) => frame.tag === "iframe" && !frame.attribs.src,
  /**
   * `target="_blank"` 的链接补 `rel="noopener noreferrer"`。
   *
   * 不加的话，被链接的页面可以通过 `window.opener` 把本站标签页导航走
   * （reverse tabnabbing）。现代浏览器对 `_blank` 默认加了 noopener，
   * 但显式写出来才不依赖浏览器默认行为。
   */
  transformTags: {
    a: (tagName, attribs) => {
      if (attribs.target !== "_blank") return { tagName, attribs };
      const rel = new Set((attribs.rel || "").split(/\s+/).filter(Boolean));
      rel.add("noopener");
      rel.add("noreferrer");
      return { tagName, attribs: { ...attribs, rel: [...rel].join(" ") } };
    },
  },
};

/** 渲染 Markdown，并给标题加 anchor id 以便生成目录 */
/**
 * 修复历史数据里的畸形链接：
 *   "## (https://.../#anchor)标题"  ->  "## 标题"
 *   "[00:20(http://...)]"           ->  "00:20"
 *   "文本 (https://...)"            ->  "文本"
 * 这些都是从 WordPress 的标题锚点转换时产生的噪音。
 */
export function sanitizeMarkdown(md: string): string {
  let t = md;

  // ① 标题行开头的 (URL) 噪音：  "## (https://...#x)标题"  ->  "## 标题"
  //    只匹配行首、且后面紧跟文字的情况
  t = t.replace(/^(#{1,6}[ \t]+)\([ \t]*https?:\/\/[^\s)]+[ \t]*\)[ \t]*/gm, "$1");

  // ② 方括号里套了链接：  "[00:20(http://...)]"  ->  "00:20"
  //    先处理这种，避免被后面的规则误伤
  t = t.replace(/\[([^\[\]]*?)\([ \t]*https?:\/\/[^\s)]+[ \t]*\)\]/g, "$1");

  // ③ 中文/文字后面紧跟的裸括号链接：  "文字 (https://...)"  ->  "文字"
  //    注意必须前面是「非 Markdown 链接语法」的位置：用 (?!\]) 排除 "](url)" 
  t = t.replace(/([^\s\]\[()])[ \t]+\([ \t]*https?:\/\/[^\s)]+[ \t]*\)/g, "$1");

  // ④ 整理多余空格
  t = t.replace(/[ \t]+$/gm, "");

  return t;
}

export function renderMarkdown(md: string): { html: string; toc: { level: number; text: string; id: string }[] } {
  md = sanitizeMarkdown(md);
  const toc: { level: number; text: string; id: string }[] = [];
  const renderer = new marked.Renderer();

  renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
    const plain = text.replace(/<[^>]+>/g, "");
    const id = slugifyHeading(plain);
    if (depth === 2 || depth === 3) toc.push({ level: depth, text: plain, id });
    return `<h${depth} id="${id}">${text}</h${depth}>`;
  };

  // 顺序很重要：先消毒（去掉危险标签/属性），再补我们自己的图片属性。
  // 反过来做的话，decorateImages 加的 loading/decoding 会被消毒器当成
  // "未知属性"再判断一遍 —— 虽然白名单里有，但没必要多绕一圈。
  const raw = marked.parse(md, { renderer, async: false }) as string;
  const html = decorateImages(sanitizeHtml(raw, SANITIZE_OPTIONS));
  return { html, toc };
}

/**
 * 给正文图片补 `loading="lazy"` / `decoding="async"`（F9，2026-11-07）。
 *
 * 为什么在 HTML 输出层做，而不是改 marked 的 renderer：历史正文里的图片
 * 有三种来源 —— Markdown 图片语法、直接贴的 `<img>`、WordPress 迁移留下的
 * HTML。renderer 只能覆盖第一种，统一在输出上补属性三种都能吃到。
 *
 * 只补**缺失**的属性：作者显式写了 `loading="eager"` 的图（比如首屏大图）
 * 不会被覆盖。自闭合写法 `<img … />` 要保留那个斜杠，否则会产出非法标签。
 */
function decorateImages(html: string): string {
  return html.replace(/<img\b([^>]*?)(\/?)>/gi, (_whole, attrs: string, selfClose: string) => {
    let out = attrs;
    if (!/\bloading\s*=/i.test(out)) out += ' loading="lazy"';
    if (!/\bdecoding\s*=/i.test(out)) out += ' decoding="async"';
    return `<img${out}${selfClose}>`;
  });
}

function slugifyHeading(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "section";
}
