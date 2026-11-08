import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  VARIANT_WIDTHS, variantPath, shouldGenerateVariants, parseVariants, buildSrcset, generateVariants,
} from "../lib/image-variants.ts";

/**
 * 关掉 libvips 的文件缓存（2026-11-08，Windows 实测）。
 *
 * 下面「真实生成」用例在 finally 里 rmSync 整个临时目录。libvips 默认会缓存它读过的
 * 文件句柄，而 **Windows 不允许删除仍被打开的文件** —— 于是 rmSync 抛 EPERM，
 * 用例红在清理阶段而不是断言阶段。maxRetries 也救不了（句柄会一直占着）。
 * 设 files: 0 只关文件缓存，不影响内存缓存与转换结果。
 */
sharp.cache({ files: 0 });

/**
 * 图片变体（C3，2026-11-08）。
 *
 * 这一组覆盖三件事：
 *   1. 命名与筛选规则（哪些图该生成、路径怎么拼）；
 *   2. `srcset` 的拼装（顺序、描述符、空变体时不输出）；
 *   3. 真实生成（用 sharp 现造一张图，验证文件真的落盘、尺寸真的对）。
 */

/* ------------------------------ 纯函数 ------------------------------ */

test("C3 变体路径：原图扩展名换成 -<宽度>.webp", () => {
  assert.equal(variantPath("/images/2026/09/a.png", 640), "/images/2026/09/a-640.webp");
  assert.equal(variantPath("/images/2026/09/a.b.c.jpg", 960), "/images/2026/09/a.b.c-960.webp");
  // 没有扩展名的怪路径也不能崩
  assert.equal(variantPath("/images/x", 1280), "/images/x-1280.webp");
});

test("C3 只给本地图片生成变体：GIF 与 CDN 直链跳过", () => {
  assert.equal(shouldGenerateVariants("/images/a.png", "image/png"), true);
  assert.equal(shouldGenerateVariants("/images/a.jpg", "image/jpeg"), true);
  // GIF 转 WebP 会丢动画 —— "动图不动了"比"图大一点"严重
  assert.equal(shouldGenerateVariants("/images/a.gif", "image/gif"), false);
  // 七牛直链的变体要另外上传，这里不处理
  assert.equal(shouldGenerateVariants("https://cdn.example.com/a.png", "image/png"), false);
  assert.equal(shouldGenerateVariants("/images/a.mp4", "video/mp4"), false);
});

test("C3 变体 JSON 解析：脏数据一律当没有，不抛错", () => {
  assert.deepEqual(parseVariants('{"640":"/images/a-640.webp"}'), { 640: "/images/a-640.webp" });
  for (const bad of ["", null, undefined, "not json", "[]", "null", '{"x":"y"}', '{"640":123}']) {
    assert.deepEqual(parseVariants(bad as never), {}, "应容忍：" + JSON.stringify(bad));
  }
});

test("C3 srcset：按宽度升序、带 w 描述符；没有变体时返回空串", () => {
  assert.equal(
    buildSrcset("/images/a.png", { 1280: "/images/a-1280.webp", 640: "/images/a-640.webp" }),
    "/images/a-640.webp 640w, /images/a-1280.webp 1280w"
  );
  assert.equal(buildSrcset("/images/a.png", {}), "", "没有变体时不能输出只有原图的 srcset");
});

/* ------------------------------ 真实生成 ------------------------------ */

test("C3 真实生成：三档 WebP 落盘、尺寸正确、不放大", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "variants-"));
  try {
    // 造一张 1600×900 的图（比 1280 宽，三档都该生成）
    const buf = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 40, g: 120, b: 100 } },
    }).png().toBuffer();

    const variants = await generateVariants(buf, "/images/t/a.png", dir, 1600);
    assert.deepEqual(Object.keys(variants).sort(), ["1280", "640", "960"], "三档都要生成");

    for (const w of VARIANT_WIDTHS) {
      const abs = path.join(dir, "t", "a-" + w + ".webp");
      assert.ok(fs.existsSync(abs), w + "px 变体应落盘：" + abs);
      const meta = await sharp(abs).metadata();
      assert.equal(meta.format, "webp", w + "px 应是 WebP");
      assert.equal(meta.width, w, w + "px 变体宽度应为 " + w);
      // 等比缩放：1600×900 -> 640×360
      assert.equal(meta.height, Math.round((900 * w) / 1600), w + "px 高度应等比");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C3 原图比目标窄时不放大", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "variants-"));
  try {
    const buf = await sharp({
      create: { width: 500, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer();
    const variants = await generateVariants(buf, "/images/t/small.png", dir, 500);
    assert.deepEqual(variants, {}, "500px 的图不该生成任何变体（放大只会更糊更大）");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C3 源文件超过 4MB 时跳过（内存保护）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "variants-"));
  try {
    // 造一个 >4MB 的 buffer（内容不重要，大小检查在解码之前）
    const big = Buffer.alloc(4 * 1024 * 1024 + 1);
    const variants = await generateVariants(big, "/images/t/big.png", dir, 3000);
    assert.deepEqual(variants, {}, "超过 4MB 应直接跳过，不进解码");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C3 坏图不抛错（变体是优化项，原图才是事实）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "variants-"));
  try {
    const variants = await generateVariants(Buffer.from("not an image"), "/images/t/bad.png", dir, 1000);
    assert.deepEqual(variants, {}, "坏图应返回空变体而不是抛错");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
