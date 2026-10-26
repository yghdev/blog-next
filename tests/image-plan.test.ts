import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isHeic, fitDimensions, planUpload, shouldReencode, outputMimeFor,
  formatBytes, explainUploadFailure, MAX_DIMENSION, COMPRESS_THRESHOLD_BYTES,
  MAX_UPLOAD_BYTES_ASSUMED,
} from "../lib/image-plan.ts";
import { MAX_UPLOAD_BYTES } from "../lib/upload.ts";

/* ---------------- HEIC 识别：这是"传不上去"的头号原因 ---------------- */

test("HEIC 靠 MIME 认出", () => {
  assert.equal(isHeic("IMG_0001.HEIC", "image/heic"), true);
  assert.equal(isHeic("a.heif", "image/heif"), true);
  assert.equal(isHeic("x", "image/heic-sequence"), true);
});

test("HEIC 靠扩展名兜底（Chrome 常给空 type）", () => {
  assert.equal(isHeic("IMG_0001.HEIC", ""), true, "空 MIME 时扩展名必须兜住");
  assert.equal(isHeic("photo.Heic", undefined as unknown as string), true, "大小写不敏感");
  assert.equal(isHeic("photo.heif", ""), true);
  assert.equal(isHeic("photo.hif", ""), true);
});

test("普通图片不会被误判成 HEIC", () => {
  for (const [n, m] of [["a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.webp", "image/webp"], ["a.avif", "image/avif"], ["heic.png", "image/png"]]) {
    assert.equal(isHeic(n, m), false, n + " 不该判成 HEIC");
  }
});

/* ---------------- 缩放计算 ---------------- */

test("长边不超限时原样返回，且标记未缩放", () => {
  assert.deepEqual(fitDimensions(1920, 1080), { width: 1920, height: 1080, scaled: false });
  assert.deepEqual(fitDimensions(MAX_DIMENSION, MAX_DIMENSION), { width: MAX_DIMENSION, height: MAX_DIMENSION, scaled: false });
});

test("横图按宽缩放，比例保持", () => {
  const r = fitDimensions(5120, 2880);
  assert.equal(r.scaled, true);
  assert.equal(r.width, MAX_DIMENSION);
  assert.equal(r.height, Math.round(2880 * (MAX_DIMENSION / 5120)));
});

test("竖图按高缩放（手机照片最常见）", () => {
  const r = fitDimensions(3024, 4032);
  assert.equal(r.scaled, true);
  assert.equal(r.height, MAX_DIMENSION);
  assert.equal(r.width, Math.round(3024 * (MAX_DIMENSION / 4032)));
});

test("超宽全景图也不会出 0 像素", () => {
  const r = fitDimensions(20000, 300);
  assert.ok(r.width > 0 && r.height >= 1, "高度取整后不能变 0");
});

test("非法尺寸不抛错", () => {
  assert.equal(fitDimensions(0, 100).scaled, false);
  assert.equal(fitDimensions(NaN, 100).width, 0);
  assert.equal(fitDimensions(-5, 10).width, 0);
});

/* ---------------- 处理策略 ---------------- */

test("HEIC 一律走转码（不论体积）", () => {
  const p = planUpload({ name: "IMG_1.HEIC", type: "image/heic", size: 500 });
  assert.equal(p.kind, "heic");
});

test("HEIC 转出来够小就不再二次压缩（避免 JPEG 再压 JPEG）", () => {
  const p = planUpload({ name: "IMG_1.HEIC", type: "image/heic", size: 3_000_000 });
  // 转码后 400KB、尺寸也不超限 -> 不该再走一次 canvas
  const r = shouldReencode(p, { width: 2000, height: 1500 }, 400_000);
  assert.equal(r.reencode, false);
});

test("HEIC 转出来仍偏大则继续压", () => {
  const p = planUpload({ name: "IMG_1.HEIC", type: "image/heic", size: 8_000_000 });
  const r = shouldReencode(p, { width: 2000, height: 1500 }, COMPRESS_THRESHOLD_BYTES + 1);
  assert.equal(r.reencode, true);
});

test("HEIC 尺寸超限时优先缩（与体积无关）", () => {
  const p = planUpload({ name: "IMG_1.HEIC", type: "image/heic", size: 3_000_000 });
  const r = shouldReencode(p, { width: 4032, height: 3024 }, 200_000);
  assert.equal(r.reencode, true);
  assert.equal(r.target.width, MAX_DIMENSION);
});

test("空 MIME 的 HEIC 也走转码", () => {
  assert.equal(planUpload({ name: "IMG_1.HEIC", type: "", size: 3_000_000 }).kind, "heic");
});

test("小图原样上传，不做无谓重编码", () => {
  const p = planUpload({ name: "a.png", type: "image/png", size: 80_000 });
  assert.equal(p.kind, "as-is");
  assert.deepEqual(shouldReencode(p, { width: 800, height: 600 }), {
    reencode: false, target: { width: 800, height: 600, scaled: false },
  });
});

test("大体积但尺寸正常 -> 重编码（多数能压掉一半）", () => {
  const p = planUpload({ name: "big.jpg", type: "image/jpeg", size: COMPRESS_THRESHOLD_BYTES + 1 });
  assert.equal(p.kind, "compress");
  assert.equal(shouldReencode(p, { width: 1920, height: 1080 }).reencode, true);
});

test("小体积但尺寸超限 -> 仍要缩", () => {
  const p = planUpload({ name: "wide.png", type: "image/png", size: 50_000 });
  const r = shouldReencode(p, { width: 6000, height: 1000 });
  assert.equal(r.reencode, true, "尺寸超限必须缩，与体积无关");
  assert.equal(r.target.width, MAX_DIMENSION);
});

/* ---------------- 输出格式 ---------------- */

test("PNG 保持 PNG（截图/透明通道），HEIC 转 JPEG", () => {
  assert.equal(outputMimeFor("image/png"), "image/png");
  assert.equal(outputMimeFor("image/jpeg"), "image/jpeg");
  assert.equal(outputMimeFor("image/webp"), "image/jpeg");
  assert.equal(outputMimeFor("image/heic", true), "image/jpeg");
  assert.equal(outputMimeFor("image/png", true), "image/jpeg", "HEIC 源即使是 png 名义也转 JPEG");
});

/* ---------------- 报错文案 ---------------- */

test("体积单位可读化", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatBytes(-1), "?");
});

test("服务端拒绝时给出可操作的说明", () => {
  assert.match(explainUploadFailure("a.heic", 400, "只支持 PNG / JPEG / GIF / WEBP / AVIF 图片"), /HEIC/);
  assert.match(explainUploadFailure("a.svg", 400, "不支持该格式：SVG/HTML 等可携带脚本的文件一律拒绝"), /SVG/);
  assert.match(explainUploadFailure("a.png", 413, ""), /太大/);
  assert.match(explainUploadFailure("a.png", 429, "今日上传已达上限（100 张）"), /上限/);
  assert.match(explainUploadFailure("a.png", 401, ""), /登录/);
  assert.equal(explainUploadFailure("a.png", 500, "内部错误"), "内部错误", "未知错误原样透出");
});

/* ---------------- 客户端与服务端的常量一致性 ---------------- */

test("客户端假设的上传上限必须与服务端一致", () => {
  // 客户端不能 import lib/upload.ts（它带 node:path/node:crypto），
  // 所以常量是手抄的一份。这条断言就是防"改了服务端忘了改客户端"。
  assert.equal(
    MAX_UPLOAD_BYTES_ASSUMED,
    MAX_UPLOAD_BYTES,
    "lib/image-plan.ts 的 MAX_UPLOAD_BYTES_ASSUMED 与 lib/upload.ts 的 MAX_UPLOAD_BYTES 不同步"
  );
});
