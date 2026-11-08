import { buildSrcset } from "./image-variants";
import type { MediaMeta } from "./media-size";

/**
 * 正文图片的 `width`/`height`/`srcset` 注入（C3，2026-11-08）。
 *
 * 为什么在 HTML 输出层做，而不是改 marked 的 renderer：
 * 正文里的图片有三种来源 —— Markdown 图片语法、直接贴的 `<img>`、
 * WordPress 迁移留下的 HTML。renderer 只能覆盖第一种；统一在输出上补属性，
 * 三种都能吃到（与 F9 的 loading/decoding 是同一套思路）。
 *
 * 为什么不在 `renderMarkdown` 里做：那个模块是纯函数（不碰数据库），
 * 而宽高与变体都在 `media` 表里。所以拆成两步：
 *   renderMarkdown（纯） -> ArticleView 查库 -> decorateProseImages（纯）
 */

/** 正文列宽（与 globals.css 的 --measure-prose 一致）。改这里要同步改 CSS */
const PROSE_SIZES = "(max-width: 820px) 100vw, 672px";

/** 从渲染后的 HTML 里取出所有本地图片路径（只认 `/images/`，CDN 直链不查库） */
export function extractImagePaths(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)) {
    if (m[1].startsWith("/images/")) out.push(m[1]);
  }
  return out;
}

/**
 * 给正文 `<img>` 补 `width`/`height`/`srcset`/`sizes`。
 *
 * 只补**缺失**的属性：作者显式写了 `width="800"` 的图不会被覆盖。
 * 查不到元信息的图原样返回 —— 不编默认比例（猜错比不预留更糟）。
 */
export function decorateProseImages(html: string, meta: Map<string, MediaMeta>): string {
  if (meta.size === 0) return html;
  return html.replace(/<img\b([^>]*?)(\/?)>/gi, (whole, attrs: string, selfClose: string) => {
    const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (!src) return whole;
    const m = meta.get(src);
    if (!m) return whole;

    let out = attrs;
    if (m.width && !/\bwidth\s*=/i.test(out)) out += ' width="' + m.width + '"';
    if (m.height && !/\bheight\s*=/i.test(out)) out += ' height="' + m.height + '"';
    const srcset = buildSrcset(src, m.variants);
    if (srcset && !/\bsrcset\s*=/i.test(out)) {
      out += ' srcset="' + srcset + '"';
      if (!/\bsizes\s*=/i.test(out)) out += ' sizes="' + PROSE_SIZES + '"';
    }
    return "<img" + out + selfClose + ">";
  });
}
