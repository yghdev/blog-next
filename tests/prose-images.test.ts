import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImagePaths, decorateProseImages } from "../lib/prose-images.ts";
import type { MediaMeta } from "../lib/media-size.ts";

/**
 * 正文图片注入（C3，2026-11-08）。
 *
 * 目标：给正文 `<img>` 补 `width`/`height`（防 CLS）与 `srcset`（省流量），
 * 同时**不误伤**：作者显式写的属性不覆盖、查不到的图原样返回、
 * 非本地图片不查库。
 */

const meta = (over: Partial<MediaMeta> = {}): MediaMeta => ({
  width: 1600, height: 900, variants: { 640: "/images/a-640.webp", 1280: "/images/a-1280.webp" }, ...over,
});

test("C3 提取正文图片路径：只认 /images/，去重前先按出现顺序", () => {
  const html =
    '<p><img src="/images/a.png" alt="a"></p>' +
    '<p><img src="https://cdn.example.com/b.png"></p>' +
    '<p><img src="/images/c.jpg"></p>';
  assert.deepEqual(extractImagePaths(html), ["/images/a.png", "/images/c.jpg"]);
});

test("C3 注入 width/height/srcset/sizes", () => {
  const html = '<img src="/images/a.png" alt="a" loading="lazy">';
  const out = decorateProseImages(html, new Map([["/images/a.png", meta()]]));
  assert.match(out, /width="1600"/, "应补 width");
  assert.match(out, /height="900"/, "应补 height");
  assert.match(out, /srcset="\/images\/a-640\.webp 640w, \/images\/a-1280\.webp 1280w"/, "应补 srcset");
  assert.match(out, /sizes="\(max-width: 820px\) 100vw, 672px"/, "应补 sizes");
  assert.match(out, /loading="lazy"/, "原有属性要保留");
});

test("C3 作者显式写的 width/height 不被覆盖", () => {
  const html = '<img src="/images/a.png" width="800" height="450">';
  const out = decorateProseImages(html, new Map([["/images/a.png", meta()]]));
  assert.match(out, /width="800"/, "显式 width 必须保留");
  assert.match(out, /height="450"/, "显式 height 必须保留");
  assert.doesNotMatch(out, /width="1600"/, "不得覆盖成库里的值");
});

test("C3 查不到元信息的图原样返回（不编默认比例）", () => {
  const html = '<img src="/images/unknown.png" alt="x">';
  const out = decorateProseImages(html, new Map([["/images/a.png", meta()]]));
  assert.equal(out, html, "查不到就一个字都不改");
});

test("C3 没有变体时只补宽高，不加 srcset", () => {
  const html = '<img src="/images/a.png">';
  const out = decorateProseImages(html, new Map([["/images/a.png", meta({ variants: {} })]]));
  assert.match(out, /width="1600"/);
  assert.doesNotMatch(out, /srcset=/, "没有变体就不该有 srcset");
});

test("C3 自闭合 <img /> 补属性后仍是合法标签", () => {
  const html = '<img src="/images/a.png" />';
  const out = decorateProseImages(html, new Map([["/images/a.png", meta()]]));
  assert.match(out, /\/>$/, "自闭合斜杠必须保留在末尾，实际：" + out);
  assert.doesNotMatch(out, /\/\s+width=/, "斜杠不能跑到属性中间");
});

test("C3 空元信息表时原样返回（省掉一次无意义的正则替换）", () => {
  const html = '<img src="/images/a.png">';
  assert.equal(decorateProseImages(html, new Map()), html);
});
