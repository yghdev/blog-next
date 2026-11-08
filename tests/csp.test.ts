import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsp } from "../next.config.ts";

/**
 * CSP 内容守卫（D，2026-11-08）。
 *
 * CSP 从 report-only 切到 enforce 之后，**漏一个源就是真拦截**：
 * 页面不报错、只是某个功能静默失效（评论区空白、表情包没了、字体不加载）。
 * 这类问题在隔离冒烟里也测不出来 —— 因为 Artalk 是跨域的，临时实例的
 * origin 不在它的 CORS 白名单里，widget 根本不会加载。
 *
 * 所以这里用静态断言把"必须放行的源"钉住。
 */

const csp = buildCsp();
const directives = new Map(
  csp.split(";").map((d) => {
    const [name, ...rest] = d.trim().split(/\s+/);
    return [name, rest];
  })
);

test("D CSP：评论系统 Artalk 的源必须在 script/style/connect 三处都放行", () => {
  for (const name of ["script-src", "style-src", "connect-src"]) {
    const vals = directives.get(name) ?? [];
    assert.ok(
      vals.some((v) => v.includes("artalk")),
      name + " 必须放行 Artalk 源，实际：" + vals.join(" ")
    );
  }
});

test("D CSP：Artalk 表情包 CDN 必须在 connect-src 放行", () => {
  /**
   * 2026-11-08 切 enforce 后实测到的唯一一条违规：
   *   Connecting to 'https://cdn.jsdelivr.net/gh/ArtalkJS/Emoticons/grps/default.json'
   * 不放行的话表情选择器是空的，而评论本身还能发 —— 很容易被当成"表情包没了"。
   */
  const vals = directives.get("connect-src") ?? [];
  assert.ok(
    vals.includes("https://cdn.jsdelivr.net"),
    "connect-src 必须放行 jsDelivr（Artalk 表情包清单），实际：" + vals.join(" ")
  );
});

test("D CSP：script-src 不得放行 jsDelivr（只放 connect，不放脚本）", () => {
  const vals = directives.get("script-src") ?? [];
  assert.equal(
    vals.includes("https://cdn.jsdelivr.net"),
    false,
    "表情包只需要 connect，不需要把 jsDelivr 加进 script-src"
  );
});

test("D CSP：关键防护指令齐全", () => {
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"], "必须禁止被嵌套");
  assert.deepEqual(directives.get("object-src"), ["'none'"], "必须禁止插件内容");
  assert.deepEqual(directives.get("base-uri"), ["'self'"], "必须限制 base 标签");
  assert.deepEqual(directives.get("form-action"), ["'self'"], "必须限制表单提交目标");
  assert.deepEqual(directives.get("default-src"), ["'self'"], "默认源必须是 self");
});

test("D CSP：iframe 播放器需要 frame-src 放行 https", () => {
  const vals = directives.get("frame-src") ?? [];
  assert.ok(vals.includes("https:"), "文章里嵌了 B 站等播放器，frame-src 必须放行 https");
});
