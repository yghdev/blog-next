import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * nginx HTML 微缓存（C1，2026-11-08）的配置守卫。
 *
 * 缓存是最容易"看起来生效、实际把站点弄坏"的一类改动：
 *   · 忘了 bypass 登录态 -> 站主改完内容刷新还是旧的，以为发布失败；
 *   · 忘了 bypass RSC    -> 客户端导航拿到 HTML，页面直接坏掉；
 *   · 忽略了 Set-Cookie  -> 登录态可能被写进公共缓存；
 *   · 缓存了 5xx         -> 一次后端抖动被固化 30 秒。
 *
 * 这些都不是"跑一次 curl 能发现"的问题（要特定请求形态才触发），
 * 所以用静态断言钉住配置里的安全边界。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const CACHE = read("deploy/nginx-cache.conf");
const SITE = read("deploy/nginx-blog.conf");

/** 取出 `location / { ... }` 这一段（大括号配平） */
function locationRoot(src: string): string {
  const start = src.indexOf("location / {");
  assert.ok(start >= 0, "nginx-blog.conf 应有 location / 块");
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("location / 块没有闭合");
}

const LOC = locationRoot(SITE);

test("C1 缓存区定义在 http 上下文（conf.d），且 zone 名与 location 一致", () => {
  assert.match(CACHE, /proxy_cache_path\s+\/var\/cache\/nginx\/blog/, "应定义缓存目录");
  assert.match(CACHE, /keys_zone=blog_html:/, "应定义 keys_zone=blog_html");
  assert.match(CACHE, /max_size=/, "应限制缓存体积");
  assert.match(CACHE, /inactive=/, "应设置 inactive 清理");
  assert.match(LOC, /proxy_cache\s+blog_html;/, "location / 应引用同一个 zone");
});

test("C1 只缓存内容页：接口 / 后台 / 搜索不得进缓存", () => {
  const mapBlock = CACHE.slice(CACHE.indexOf("map $request_uri $blog_cacheable"));
  const body = mapBlock.slice(0, mapBlock.indexOf("}") + 1);
  for (const bad of ["/api", "/admin", "/search", "/rss.xml", "/sitemap.xml"]) {
    assert.equal(body.includes(bad), false, "可缓存路径里不应出现 " + bad);
  }
  // 至少覆盖首页与文章页（nginx 的 map 正则带 `~` 前缀）
  assert.match(body, /"~?\^\/\$"/, "应包含首页");
  assert.match(body, /"~?\^\/p\/\[0-9\]\+\$"/, "应包含文章页 /p/<id>");
});

test("C1 登录态与 RSC 请求必须 bypass", () => {
  const mapBlock = CACHE.slice(CACHE.indexOf("map \"$blog_cacheable"));
  assert.match(mapBlock, /\$cookie_blog_session/, "bypass 判定必须看登录 cookie");
  assert.match(mapBlock, /\$http_rsc/, "bypass 判定必须看 RSC 头");
  assert.match(mapBlock, /"1::"\s+0;/, "只有「可缓存 + 无 cookie + 无 RSC」才允许走缓存");
  assert.match(LOC, /proxy_cache_bypass\s+\$blog_cache_bypass;/, "location 应使用 bypass 变量");
  assert.match(LOC, /proxy_no_cache\s+\$blog_cache_bypass;/, "bypass 时也不应写入缓存");
});

test("C1 只缓存 200，且不忽略 Set-Cookie", () => {
  assert.match(LOC, /proxy_cache_valid\s+200\s+30s;/, "只缓存 200，TTL 30s");
  assert.doesNotMatch(LOC, /proxy_cache_valid\s+(?:[45]\d\d|any)/, "不得缓存 4xx/5xx");

  const ignore = LOC.match(/proxy_ignore_headers\s+([^;]+);/);
  assert.ok(ignore, "应显式声明 proxy_ignore_headers");
  assert.match(ignore![1], /Cache-Control/, "需要覆盖 Next 下发的 no-store");
  assert.doesNotMatch(ignore![1], /Set-Cookie/, "绝不能忽略 Set-Cookie（登录态泄漏的安全网）");
});

test("C1 后端故障时用 stale 顶住，并暴露 X-Cache-Status 便于验证", () => {
  assert.match(LOC, /proxy_cache_use_stale[^;]*error/, "后端错误时应回退 stale");
  assert.match(LOC, /proxy_cache_use_stale[^;]*http_50\d/, "5xx 时应回退 stale");
  assert.match(LOC, /add_header\s+X-Cache-Status\s+\$upstream_cache_status\s+always;/, "应暴露缓存命中状态");
});

test("C1 缓存键包含 host 与 request_uri（防串站、防查询串串味）", () => {
  const key = LOC.match(/proxy_cache_key\s+"([^"]+)";/);
  assert.ok(key, "应显式声明 proxy_cache_key");
  assert.match(key![1], /\$host/, "缓存键必须含 host");
  assert.match(key![1], /\$request_uri/, "缓存键必须含 request_uri（含查询串）");
});
