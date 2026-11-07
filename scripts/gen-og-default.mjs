#!/usr/bin/env node
/**
 * 生成默认分享图 `public/og-default.png`（1200×630，P0-5，2026-11-07）。
 *
 * 为什么是生成而不是手绘/外链：
 *   · 分享卡必须是**稳定 URL**，且不能依赖第三方图床（图床挂了，所有分享链接
 *     的预览一起空）；
 *   · 之前全站没有任何 og:image，微信/Twitter/Telegram 分享出去只有一行字。
 *
 * 为什么不再走 `app/opengraph-image.tsx`（ImageResponse）：
 *   那个方案要在运行时用 satori 渲染，CJK 字体必须随产物打包（字体子集/体积/
 *   构建机字体缺失三处都会炸）；本站只有一张固定默认图，静态 PNG 更省事。
 *
 * 输出物已提交进仓库，**只有改文案/配色时才需要重跑**：
 *     node scripts/gen-og-default.mjs
 *
 * 依赖 sharp：它是 Next 的 image-optimizer 可选依赖，通常已在 node_modules 里；
 * 缺失时本脚本报错退出，不影响线上（PNG 已提交）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "og-default.png");

/* 配色与站点设计令牌一致（app/globals.css）：--bg / --text-p0 / --link，
   元信息灰取 --text-meta 合成到浅底后的等效实色。 */
const BG = "#fffefc";
const INK = "#111111";
const META = "#616161";
const LINK = "#2f7a6b";
const LINE = "#e7e4dd";

const SERIF = "Noto Serif CJK SC, Source Han Serif SC, Songti SC, serif";
const SANS = "Noto Sans CJK SC, Source Han Sans SC, PingFang SC, WenQuanYi Zen Hei, sans-serif";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>
  <!-- 右侧极淡的同心弧：给纯文字卡一点纵深，不抢字 -->
  <g fill="none" stroke="${LINK}" stroke-opacity="0.10">
    <circle cx="1130" cy="90" r="180" stroke-width="1.5"/>
    <circle cx="1130" cy="90" r="260" stroke-width="1.2"/>
    <circle cx="1130" cy="90" r="340" stroke-width="1"/>
  </g>

  <text x="96" y="176" font-family="${SANS}" font-size="20" font-weight="600"
        letter-spacing="6" fill="${LINK}">PERSONAL BLOG</text>

  <text x="92" y="300" font-family="${SERIF}" font-size="86" font-weight="700"
        fill="${INK}">flechazo's blog</text>

  <line x1="96" y1="360" x2="704" y2="360" stroke="${LINE}" stroke-width="2"/>

  <text x="96" y="424" font-family="${SANS}" font-size="34" fill="${META}">记录 AI、开发与折腾的日常。</text>

  <text x="96" y="556" font-family="${SANS}" font-size="22" letter-spacing="2"
        fill="${META}">blog.yghsite.cn</text>
</svg>`;

let sharp;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  console.error("缺少 sharp（Next 的可选依赖）。先 `npm i -D sharp`，或直接从仓库取已提交的 public/og-default.png。");
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const info = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
fs.writeFileSync(out, info.data);
console.log("wrote " + path.relative(root, out) + " (" + info.info.width + "×" + info.info.height + ", " + info.data.length + " bytes)");
