import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectImage, detectVideo, looksLikeMarkup, buildRelativePath, safeJoin, imageSize,
  MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, limitFor,
} from "../lib/upload.ts";

// 真实图片头的构造（只造头部，足以判定签名）
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8), // IHDR length + type
  Buffer.from([0, 0, 0x01, 0x00, 0, 0, 0x00, 0x80]), // 256 x 128
  Buffer.alloc(20),
]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([0x10, 0x00, 0x08, 0x00]), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ", "latin1"), Buffer.alloc(30)]);

test("A1 核心：PNG 字节永远拿到 .png，与客户端文件名无关", () => {
  const d = detectImage(png);
  assert.equal(d?.ext, ".png");
  assert.equal(d?.mime, "image/png");
});

test("A1 回归：HTML 伪装成 image/png 被拒", () => {
  const evil = Buffer.from("<!DOCTYPE html><script>alert(1)</script>", "utf8");
  assert.equal(detectImage(evil), null, "非图片签名必须识别不出");
  assert.equal(looksLikeMarkup(evil), true, "应能识别为标记语言，便于给出准确报错");
});

test("A1 回归：SVG 被拒（可携带 script）", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
  assert.equal(detectImage(svg), null);
  assert.equal(looksLikeMarkup(svg), true);
});

test("A1 回归：PHP / 可执行文件被拒", () => {
  assert.equal(detectImage(Buffer.from("<?php system($_GET['c']); ?>", "utf8")), null);
  assert.equal(detectImage(Buffer.from("MZ\x90\x00\x03", "latin1")), null);
  assert.equal(detectImage(Buffer.alloc(0)), null, "空文件不崩");
  assert.equal(detectImage(Buffer.from([0x89, 0x50])), null, "截断的 PNG 不误判");
});

test("真实 JPEG / GIF / WEBP 各自识别出正确扩展名", () => {
  assert.equal(detectImage(jpeg)?.ext, ".jpg");
  assert.equal(detectImage(gif)?.ext, ".gif");
  assert.equal(detectImage(webp)?.ext, ".webp");
});

test("落盘路径由服务端生成，且不含任何客户端输入", () => {
  const rel = buildRelativePath(".png", new Date("2026-10-21T10:00:00Z"));
  assert.match(rel, /^2026\/10\/\d+-[0-9a-f]{8}\.png$/, "应为 年/月/时间戳-随机.扩展名");
  assert.ok(!rel.includes(".."), "不含路径穿越");
  assert.notEqual(buildRelativePath(".png"), buildRelativePath(".png"), "两次生成不重名");
});

test("safeJoin 挡住路径穿越", () => {
  const base = "C:/var/www/blog-images";
  assert.ok(safeJoin(base, "2026/10/a.png").includes("a.png"));
  assert.throws(() => safeJoin(base, "../../etc/passwd"), /path traversal/);
  assert.throws(() => safeJoin(base, "..\\..\\windows\\system32\\x.dll"), /path traversal/);
});

test("尺寸解析：PNG 头部读出宽高", () => {
  assert.deepEqual(imageSize(png, "image/png"), { width: 256, height: 128 });
  assert.deepEqual(imageSize(Buffer.from("GIF89a", "latin1"), "image/gif"), null, "长度不足返回 null 而非抛错");
});

test("上传上限为 8MB（与 nginx 12m 留余量）", () => {
  assert.equal(MAX_UPLOAD_BYTES, 8 * 1024 * 1024);
});

/* ══════════════════════════════════════════════════════════════════════
   视频识别（2026-10-28）
   ──────────────────────────────────────────────────────────────────────
   与图片同一套白名单策略：只认 magic bytes，识别不出就拒。
   这些用例盯的是「别把不该进来的东西认成视频」，以及
   「别把该进来的 mp4 家族漏掉」——两个方向都会让用户看到错的结论。
   ══════════════════════════════════════════════════════════════════════ */

/** 造一个 ISO BMFF 头：4 字节长度 + "ftyp" + brand */
function ftyp(brand: string): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from("ftyp", "latin1"),
    Buffer.from(brand.padEnd(4).slice(0, 4), "latin1"),
    Buffer.alloc(32),
  ]);
}

/** 造一个 EBML 头，并在前 64 字节内带上 webm DocType */
function webmBuf(docType = "webm"): Buffer {
  const head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  return Buffer.concat([head, Buffer.alloc(8), Buffer.from(docType, "latin1"), Buffer.alloc(40)]);
}

test("视频：常见 mp4 brand 都能认出", () => {
  for (const brand of ["isom", "mp42", "mp41", "avc1", "iso5", "M4V ", "dash"]) {
    const d = detectVideo(ftyp(brand));
    assert.equal(d?.mime, "video/mp4", brand + " 应识别为 mp4");
    assert.equal(d?.ext, ".mp4");
  }
});

test("视频：webm 能认出；matroska 不算 webm", () => {
  assert.equal(detectVideo(webmBuf("webm"))?.ext, ".webm");
  // matroska 是 .mkv 的容器名，浏览器支持度远不如 webm，不应伪装通过
  assert.equal(detectVideo(webmBuf("matroska")), null, "matroska 不该被当成 webm 放行");
});

test("视频：QuickTime(.mov) 必须被拒 —— 浏览器基本播不了", () => {
  // qt 的 brand 是 "qt  "，与 mp4 同一容器但浏览器支持极差。
  // 放过它等于让用户传一个「上传成功但打不开」的文件。
  assert.equal(detectVideo(ftyp("qt  ")), null);
});

test("视频：图片字节不会被认成视频，反之亦然", () => {
  assert.equal(detectVideo(png), null, "PNG 不该被认成视频");
  assert.equal(detectVideo(jpeg), null, "JPEG 不该被认成视频");
  assert.equal(detectImage(ftyp("isom")), null, "mp4 不该被认成图片");
  assert.equal(detectImage(webmBuf()), null, "webm 不该被认成图片");
});

test("视频：HTML/脚本永远不会被认成视频", () => {
  const evil = Buffer.from("<!DOCTYPE html><script>alert(1)</script>", "utf8");
  assert.equal(detectVideo(evil), null);
  // 伪造成 ftyp 但 brand 不在白名单
  const fake = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftyp", "latin1"),
    Buffer.from("<htm", "latin1"), Buffer.alloc(32)]);
  assert.equal(detectVideo(fake), null, "brand 不在白名单必须拒绝");
});

test("视频：超短文件不抛错，只返回 null", () => {
  for (const n of [0, 1, 3, 7, 11]) {
    assert.equal(detectVideo(Buffer.alloc(n)), null, n + " 字节应安全返回 null");
  }
});

test("上限：视频 16MB，图片 8MB，且视频更大", () => {
  // 16MB 是实测出来的：本机 MemoryHigh=300M、基线约 120MB，
  // 而上传的内存放大约 6.5x。40MB 会让进程顶进 cgroup 节流，
  // 进而拖垮同进程所有请求（2026-10-28 线上事故）。
  assert.equal(MAX_VIDEO_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_UPLOAD_BYTES, 8 * 1024 * 1024);
  assert.ok(MAX_VIDEO_BYTES > MAX_UPLOAD_BYTES);
  // 按类型取上限：接口要靠它做精确复核
  assert.equal(limitFor("video/mp4"), MAX_VIDEO_BYTES);
  assert.equal(limitFor("image/png"), MAX_UPLOAD_BYTES);
});
