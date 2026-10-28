/**
 * 编辑器媒体能力（2026-10-28）：本地视频上传 + 从媒体库插入。
 *
 * 这条测试盯的是三个曾经真实出问题的地方：
 *   1) **只能传图片**。accept 属性只列了图片，视频文件在选择框里根本看不见；
 *      服务端也只认图片 magic bytes，传上去必然 400。
 *   2) **体积上限被静默截断**。Next 默认只读 10MB 进内存，超出的部分丢掉，
 *      于是接口拿到的 FormData 里没有 file，报错是「没有收到文件」——
 *      与真实原因（文件太大）完全无关，实测排查了两轮才定位。
 *   3) **没有媒体库入口**。想复用上个月传过的图，只能重新上传一次
 *      （占双份空间、媒体库里出现两张一样的），或者去 /admin/media 复制再回来。
 *
 * 断言的是**服务端契约**（kind / 拒绝口径）与**前端产出**（插入语法），
 * 不比对像素外观。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";

let server, controller;

/** 造一个能被 detectVideo 认出的 MP4 头（不是真视频，但足以走完识别链路） */
function mp4Bytes(size = 2048) {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from("ftyp", "latin1"),
    Buffer.from("isom", "latin1"),
    Buffer.alloc(28),
  ]);
  return Buffer.concat([ftyp, Buffer.alloc(Math.max(0, size - ftyp.length))]);
}

function pngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
}

try {
  server = await startIsolatedServer({ label: "editor-media" });
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  const upload = (name, bytes, type) =>
    page.request.post(server.base + "/api/admin/upload", {
      multipart: { file: { name, mimeType: type, buffer: bytes } },
    });

  /* ---------- 1. 本地视频上传被接受 ---------- */
  const vid = await upload("clip.mp4", mp4Bytes(), "video/mp4");
  assert.equal(vid.status(), 200, await vid.text());
  const vidJson = await vid.json();
  assert.equal(vidJson.kind, "video", "服务端必须回报 kind=video，前端据此决定插入 <video>");
  assert.equal(vidJson.mime, "video/mp4");
  assert.ok(/\.mp4$/.test(vidJson.url), "扩展名由服务端按 magic bytes 决定，应落在 .mp4");
  console.log("PASS media: 本地 MP4 上传成功，返回 kind=video");

  /* ---------- 2. WebM 也支持 ---------- */
  const webmBytes = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8),
    Buffer.from("webm", "latin1"), Buffer.alloc(400),
  ]);
  const webm = await upload("clip.webm", webmBytes, "video/webm");
  assert.equal(webm.status(), 200, await webm.text());
  assert.equal((await webm.json()).kind, "video");
  console.log("PASS media: WebM 上传成功");

  /* ---------- 3. 图片仍然正常（不能因为加视频把老路径弄坏） ---------- */
  const img = await upload("pic.png", pngBytes(), "image/png");
  assert.equal(img.status(), 200, await img.text());
  const imgJson = await img.json();
  assert.equal(imgJson.kind, "image");
  assert.equal(imgJson.mime, "image/png");
  console.log("PASS media: 图片上传未回归，kind=image");

  /* ---------- 4. 安全：HTML 伪装成 mp4 必须被拒 ---------- */
  const evil = await upload("evil.mp4", Buffer.from("<!DOCTYPE html><script>alert(1)</script>"), "video/mp4");
  assert.equal(evil.status(), 400, "伪装成 mp4 的 HTML 必须被拒（同域存储型 XSS 的入口）");
  console.log("PASS media: HTML 伪装 mp4 被拒");

  /* ---------- 5. 超过上限的视频被明确拒绝，且报错说清是体积 ---------- */
  // 上限 16MB（实测内存决定，见 lib/upload.ts）。这里用 17MB 刚好越过它。
  const bigBytes = mp4Bytes(17 * 1024 * 1024);
  const big = await upload("big.mp4", bigBytes, "video/mp4");
  assert.equal(big.status(), 400, "17MB 必须拒绝");
  const bigJson = await big.json();
  assert.match(
    bigJson.error,
    /过大|16MB|视频/,
    "报错必须指到体积上。历史上这里报的是「没有收到文件」——那是 Next 静默截断" +
    " 之后的假象，与真实原因无关。实际：" + JSON.stringify(bigJson.error)
  );
  console.log("PASS media: 超限视频报「过大」，不再是误导性的「没有收到文件」");

  /* ---------- 6. 未登录一律 401 ---------- */
  const anon = await page.request.post(server.base + "/api/admin/upload", {
    multipart: { file: { name: "a.mp4", mimeType: "video/mp4", buffer: mp4Bytes() } },
  });
  // page 带着登录态，所以这里换一个干净 context 才能测匿名
  assert.equal(anon.status(), 200, "已登录的 page.request 应当成功（作为对照）");
  const anonCtx = await controller.browser.newContext();
  const anonRes = await anonCtx.request.post(server.base + "/api/admin/upload", {
    multipart: { file: { name: "a.mp4", mimeType: "video/mp4", buffer: mp4Bytes() } },
  });
  assert.equal(anonRes.status(), 401, "未登录上传必须 401");
  await anonCtx.close();
  console.log("PASS media: 未登录上传 401");

  /* ---------- 7. 媒体库接口支持 kind 筛选 ---------- */
  const vids = await page.request.get(server.base + "/api/admin/media?kind=video");
  const vJson = await vids.json();
  assert.ok(vJson.total >= 2, "应至少有两段视频，实际 " + vJson.total);
  assert.ok(vJson.rows.every((r) => r.kind === "video"), "kind=video 只能返回视频");

  const imgs = await page.request.get(server.base + "/api/admin/media?kind=image");
  const iJson = await imgs.json();
  assert.ok(iJson.rows.every((r) => r.kind === "image"), "kind=image 只能返回图片");
  console.log("PASS media: 媒体库 kind 筛选正确（视频 " + vJson.total + " / 图片 " + iJson.total + "）");

  /* ---------- 8. 前端：上传后正文里出现 <video> ---------- */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.base + "/admin/new", { waitUntil: "networkidle" });

  const toolbar = await page.locator(".editor-toolbar button").allTextContents();
  for (const label of ["上传", "媒体库", "外链视频"]) {
    assert.ok(toolbar.includes(label), "工具栏缺少「" + label + "」，实际=" + JSON.stringify(toolbar));
  }

  // accept 必须同时列图片与视频，否则选择框里根本看不到视频文件
  const accept = await page.locator('.editor-toolbar ~ div input[type="file"], input[type="file"]').first().getAttribute("accept");
  assert.match(accept ?? "", /video\/mp4/, "文件选择框的 accept 必须包含 video/mp4");
  assert.match(accept ?? "", /image\/png/, "文件选择框的 accept 必须仍包含图片");

  await page.locator('input[type="file"]').first().setInputFiles({
    name: "clip.mp4", mimeType: "video/mp4", buffer: mp4Bytes(),
  });
  // 等自动插入落到正文
  await page.waitForFunction(
    () => (document.querySelector(".editor-textarea")?.value ?? "").includes("<video"),
    { timeout: 15000 }
  );
  const ta = await page.locator(".editor-textarea").inputValue();
  assert.match(ta, /<video[^>]*controls/, "插入的片段必须带 controls");
  assert.match(ta, /playsinline/, "必须带 playsinline，否则 iOS 点播放会强制全屏接管整页");
  assert.match(ta, /src="[^"]+\.mp4"/, "src 必须指向刚上传的文件");
  console.log("PASS media: 上传视频后正文插入 <video controls playsinline>");

  /* ---------- 9. 前端：从媒体库插入（视频与图片） ---------- */
  await page.locator(".editor-textarea").fill("");
  await page.locator('.editor-toolbar button:has-text("媒体库")').click();
  await page.locator(".fx-picker").waitFor({ timeout: 5000 });
  // 防抖 300ms + 首屏请求
  await page.waitForFunction(
    () => document.querySelectorAll(".fx-picker-item").length > 0,
    { timeout: 10000 }
  );
  const allCount = await page.locator(".fx-picker-item").count();
  assert.ok(allCount >= 3, "选择器应列出全部资源，实际 " + allCount);

  await page.locator(".fx-picker-tab", { hasText: "视频" }).click();
  /**
   * 必须等到「筛完之后的结果」落定，而不是「有条目」。
   * 切筛选时旧的条目还在 DOM 里（React 尚未用新结果替换），
   * 只断言 length > 0 会立刻通过，然后点到上一轮的条目上 ——
   * 测试于是插入了一个视频却期待图片，表现为一个与功能无关的超时。
   * 这里直接等第一条目的文件名后缀符合预期。
   */
  await page.waitForFunction(
    () => {
      const first = document.querySelector(".fx-picker-item .fx-picker-name");
      return !!first && /\.(mp4|webm)$/i.test(first.textContent || "");
    },
    { timeout: 10000 }
  );
  await page.locator(".fx-picker-item").first().click();
  await page.waitForFunction(
    () => (document.querySelector(".editor-textarea")?.value ?? "").includes("<video"),
    { timeout: 10000 }
  );
  assert.match(await page.locator(".editor-textarea").inputValue(), /<video[^>]*src="[^"]+"/);
  console.log("PASS media: 从媒体库插入视频");

  await page.locator(".editor-textarea").fill("");
  await page.locator('.editor-toolbar button:has-text("媒体库")').click();
  await page.locator(".fx-picker").waitFor({ timeout: 5000 });
  await page.waitForTimeout(700);
  await page.locator(".fx-picker-tab", { hasText: "图片" }).click();
  await page.waitForFunction(
    () => {
      const first = document.querySelector(".fx-picker-item .fx-picker-name");
      return !!first && /\.png$/i.test(first.textContent || "");
    },
    { timeout: 10000 }
  );
  await page.locator(".fx-picker-item").first().click();
  await page.waitForFunction(
    () => (document.querySelector(".editor-textarea")?.value ?? "").includes("!["),
    { timeout: 10000 }
  );
  assert.match(await page.locator(".editor-textarea").inputValue(), /!\[[^\]]*\]\([^)]+\.png\)/);
  console.log("PASS media: 从媒体库插入图片（Markdown 语法）");

  /* ---------- 10. 选择器可关闭，不劫持 Esc 之外的行为 ---------- */
  await page.locator('.editor-toolbar button:has-text("媒体库")').click();
  await page.locator(".fx-picker").waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.locator(".fx-picker").waitFor({ state: "detached", timeout: 5000 });
  console.log("PASS media: 选择器 Esc 可关闭");

  /* ---------- 11. 375px 无横向溢出 ---------- */
  await page.setViewportSize({ width: 375, height: 780 });
  await page.locator('.editor-toolbar button:has-text("媒体库")').click();
  await page.locator(".fx-picker").waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  const of = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  assert.ok(of.sw <= of.cw + 1, "375px 下选择器不得横向溢出：" + JSON.stringify(of));
  console.log("PASS media: 375px 选择器无溢出（" + of.sw + "/" + of.cw + "）");

  console.log("All editor-media checks passed.");
} catch (e) {
  if (server?.logs) console.error(server.logs());
  throw e;
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
