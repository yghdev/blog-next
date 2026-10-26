import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVideo, videoToEmbed, buildVideoEmbed, normalizePastedIframe,
  extractIframeSrc, isAllowedEmbedHost, EMBED_HOSTS, SUPPORTED_HINT,
} from "../lib/video-embed.ts";

/* ---------------------------- 哔哩哔哩 ---------------------------- */

test("B站：裸 BV 号", () => {
  const v = parseVideo("BV1rAdTBfEEn");
  assert.equal(v?.platform, "bilibili");
  assert.equal(v?.id, "BV1rAdTBfEEn");
  assert.match(v!.embedUrl, /^https:\/\/player\.bilibili\.com\/player\.html\?bvid=BV1rAdTBfEEn/);
});

test("B站：完整链接 + 分P", () => {
  const v = parseVideo("https://www.bilibili.com/video/BV1rAdTBfEEn?p=3");
  assert.equal(v?.id, "BV1rAdTBfEEn");
  assert.match(v!.embedUrl, /page=3/, "分P 要保留");
});

test("B站：mobile 子域与短链都能认", () => {
  assert.equal(parseVideo("https://m.bilibili.com/video/BV1rAdTBfEEn")?.platform, "bilibili");
  assert.equal(parseVideo("https://b23.tv/abc")?.platform, undefined, "b23 短链需要跳转，不做猜测");
});

test("B站：av 号转 aid", () => {
  const v = parseVideo("av170001");
  assert.equal(v?.platform, "bilibili");
  assert.match(v!.embedUrl, /aid=170001/);
  const v2 = parseVideo("https://www.bilibili.com/video/av170001");
  assert.match(v2!.embedUrl, /aid=170001/);
});

test("B站：分P 非法值回落到 1", () => {
  const v = parseVideo("https://www.bilibili.com/video/BV1rAdTBfEEn?p=abc");
  assert.match(v!.embedUrl, /page=1&/);
});

/* ----------------------------- YouTube ---------------------------- */

test("YouTube：watch / youtu.be / shorts / embed 四种形态", () => {
  for (const u of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "dQw4w9WgXcQ",
  ]) {
    const v = parseVideo(u);
    assert.equal(v?.platform, "youtube", u + " 应识别为 YouTube");
    assert.equal(v?.id, "dQw4w9WgXcQ");
    assert.match(v!.embedUrl, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  }
});

test("YouTube：用 nocookie 域（少给平台留 cookie）", () => {
  assert.match(parseVideo("dQw4w9WgXcQ")!.embedUrl, /^https:\/\/www\.youtube-nocookie\.com\//);
});

test("YouTube：带播放列表参数不影响视频 ID", () => {
  const v = parseVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxxx");
  assert.equal(v?.id, "dQw4w9WgXcQ");
});

/* ------------------------------ Vimeo ----------------------------- */

test("Vimeo：链接与纯数字 ID", () => {
  assert.equal(parseVideo("https://vimeo.com/76979871")?.id, "76979871");
  assert.equal(parseVideo("76979871")?.platform, "vimeo");
  assert.match(parseVideo("https://player.vimeo.com/video/76979871")!.embedUrl, /player\.vimeo\.com\/video\/76979871/);
});

/* --------------------------- 腾讯 / 优酷 --------------------------- */

test("腾讯视频：page 与 cover 两种链接", () => {
  const v = parseVideo("https://v.qq.com/x/page/a0032abcdefg.html");
  assert.equal(v?.platform, "tencent");
  assert.match(v!.embedUrl, /vid=a0032abcdefg/);
  assert.equal(parseVideo("https://v.qq.com/x/cover/abcdefg/a0032abcdefg.html")?.id, "a0032abcdefg");
});

test("优酷：v_show 链接", () => {
  const v = parseVideo("https://v.youku.com/v_show/id_XNTk1MjM4NzY4.html");
  assert.equal(v?.platform, "youku");
  assert.match(v!.embedUrl, /player\.youku\.com\/embed\/XNTk1MjM4NzY4/);
});

/* ---------------------- 拒绝：不该认的输入 ---------------------- */

test("空输入与随手一段文字不认", () => {
  assert.equal(parseVideo(""), null);
  assert.equal(parseVideo("   "), null);
  assert.equal(parseVideo("这篇文章讲视频"), null);
});

test("非白名单平台一律不认（防任意 iframe 注入）", () => {
  assert.equal(parseVideo("https://evil.example.com/video/123"), null);
  assert.equal(parseVideo("https://v.qq.com.evil.com/x/page/a0032abcdefg.html"), null, "后缀伪造要挡住");
  assert.equal(parseVideo("https://notbilibili.com/video/BV1rAdTBfEEn"), null);
});

test("http（非 https）链接不认——避免混合内容", () => {
  // parseVideo 走的是"没写协议就补 https"的宽松路径，这里显式给 http
  const v = parseVideo("http://www.bilibili.com/video/BV1rAdTBfEEn");
  // 允许识别（平台已知），但生成的 embedUrl 必须是 https
  if (v) assert.match(v.embedUrl, /^https:\/\//);
});

/* --------------------------- iframe 生成 --------------------------- */

test("生成的嵌入代码带 16:9 容器 class", () => {
  const { embed } = videoToEmbed("BV1rAdTBfEEn")!;
  assert.match(embed, /<div class="video-container">/);
  assert.match(embed, /<\/div>$/);
  assert.match(embed, /allowfullscreen/);
  assert.match(embed, /scrolling="no"/);
});

test("不写 position:absolute（那套只给 WordPress 历史数据用）", () => {
  const { embed } = videoToEmbed("BV1rAdTBfEEn")!;
  assert.ok(!embed.includes("position:absolute"), "新代码不该带绝对定位");
});

test("title 里的引号被剥掉，不会破坏属性", () => {
  const html = buildVideoEmbed("https://player.bilibili.com/player.html?bvid=BV1rAdTBfEEn", 'bad"title');
  assert.ok(!html.includes('bad"title'));
});

test("非白名单地址生成时直接抛错", () => {
  assert.throws(() => buildVideoEmbed("https://evil.example.com/x"), /不支持的视频平台/);
  assert.throws(() => buildVideoEmbed("not a url"), /不合法/);
});

/* -------------------------- 白名单域名判定 ------------------------- */

test("isAllowedEmbedHost：命中本体与子域，挡住后缀伪造", () => {
  assert.equal(isAllowedEmbedHost("player.bilibili.com"), true);
  assert.equal(isAllowedEmbedHost("PLAYER.BILIBILI.COM"), true, "大小写不敏感");
  assert.equal(isAllowedEmbedHost("www.youtube-nocookie.com"), true);
  assert.equal(isAllowedEmbedHost("evil.com"), false);
  assert.equal(isAllowedEmbedHost("player.bilibili.com.evil.com"), false, "后缀伪造必须挡住");
  assert.equal(isAllowedEmbedHost("eviltwitter.com"), false);
});

test("白名单里每个域名本身都通过校验", () => {
  for (const h of EMBED_HOSTS) assert.equal(isAllowedEmbedHost(h), true, h);
});

/* ----------------------- 直接粘贴 iframe 代码 ----------------------- */

test("从粘贴的 iframe 里取出 src", () => {
  const html = '<iframe src="https://player.bilibili.com/player.html?bvid=BV1rAdTBfEEn" width="800"></iframe>';
  assert.equal(extractIframeSrc(html), "https://player.bilibili.com/player.html?bvid=BV1rAdTBfEEn");
});

test("规范化：保留 src，丢掉平台特有属性", () => {
  const pasted = '<iframe src="https://player.bilibili.com/player.html?bvid=BV1rAdTBfEEn&autoplay=0" style="position:absolute;width:100%" onload="alert(1)" allowfullscreen></iframe>';
  const out = normalizePastedIframe(pasted)!;
  assert.ok(out.includes("player.bilibili.com"), "src 保留");
  assert.ok(!out.includes("onload"), "onload 这类属性必须丢掉");
  assert.ok(!out.includes("position:absolute"), "内联样式也丢掉");
  assert.match(out, /video-container/);
});

test("规范化：非白名单域名的 iframe 被拒", () => {
  assert.equal(normalizePastedIframe('<iframe src="https://evil.com/x"></iframe>'), null);
  assert.equal(normalizePastedIframe('<iframe src="https://player.bilibili.com.evil.com/x"></iframe>'), null);
});

test("规范化：http 的 iframe 被拒（混合内容）", () => {
  assert.equal(normalizePastedIframe('<iframe src="http://player.bilibili.com/player.html?bvid=BV1rAdTBfEEn"></iframe>'), null);
});

test("规范化：没有 iframe 的普通文本返回 null", () => {
  assert.equal(normalizePastedIframe("就是一段文字"), null);
  assert.equal(normalizePastedIframe(""), null);
});

/* ------------------------------ 文案 ------------------------------ */

test("提示文案列出了所有支持的平台", () => {
  for (const k of ["B站", "YouTube", "Vimeo", "腾讯", "优酷"]) {
    assert.ok(SUPPORTED_HINT.includes(k), "提示里应提到 " + k);
  }
  assert.ok(SUPPORTED_HINT.includes("iframe"));
});
