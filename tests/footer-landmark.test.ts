import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * footer 地标唯一性（B-5，2026-11-01）。
 *
 * ## 为什么这是个真问题
 *
 * `<footer>` 是 HTML 的**地标元素**（landmark）。屏幕上多个 `<footer>`
 * 不一定违反规范 —— 只要每个都在自己的 `sectioning content` 里。
 * 但友链页的情况不是这样：两个 footer 都直接挂在页面主内容流里，
 * 读屏软件的「跳到页脚」会给出两个同名目标，键盘用户分不清哪个是"全站页脚"。
 *
 * 实测当时页面里 `<footer` 出现 2 次：
 *   • `app/friend-links/page.tsx` 的 `<footer className="fr-footer">`
 *     （"FRIENDS & CONNECTIONS / 感谢每一位愿意分享自己小世界的人"）
 *   • `components/SiteFooter.tsx` 的全站页脚（备案号 + footerText），
 *     由 `app/layout.tsx` 统一渲染
 *
 * ## 修法
 *
 * **保留文案，改标签**：`fr-footer` 从 `<footer>` 改成 `<div>`。
 * 它是"页面内的语义收尾"，不是地标。需求文档也没要求删掉那句文案。
 *
 * ## 这个文件守什么
 *
 * 静态：页面源码里不得出现第二个 `<footer>` 字面量。
 * 渲染结果由 `tests/friend-links-page.mjs` 的 `<footer` 计数断言覆盖。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * 去掉 JSX 注释与行注释后再数 <footer>。
 *
 * 注释里出现 `<footer>` 字面量是正常的（我们在解释"为什么不用 footer"），
 * 直接全文匹配会把说明文字当成元素。
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // {/* … */}
    .replace(/\/\*[\s\S]*?\*\//g, "")               // /* … */
    .replace(/^\s*\/\/.*$/gm, "");                    // // …
}


test("B-5 友链页不得再渲染第二个 <footer> 地标", () => {
  const src = stripComments(read("app/friend-links/page.tsx"));
  const hits = src.split("\n").flatMap((line, i) =>
    /<footer\b/.test(line) || /<\/footer>/.test(line) ? [{ line: i + 1, text: line.trim() }] : []
  );
  assert.deepEqual(
    hits,
    [],
    "友链页仍有 <footer>（应改为 <div>，全站页脚由 layout 统一提供）：\n" +
      hits.map((h) => "  第 " + h.line + " 行: " + h.text).join("\n")
  );
});

test("B-5 fr-footer 的文案必须保留（不是删掉这个区块）", () => {
  /**
   * 反例守卫：如果有人图省事把整块删掉，`<footer` 计数也会变成 1，
   * 那样测试会绿但需求丢了。所以这里钉住文案仍在。
   */
  const src = read("app/friend-links/page.tsx");
  assert.match(src, /className="fr-footer"/, "fr-footer 区块应保留（只是改成 div）");
  assert.match(src, /FRIENDS &amp; CONNECTIONS/, "装饰性英文标记应保留");
  assert.match(src, /感谢每一位愿意分享自己小世界的人/, "致谢文案应保留");
});

test("B-5 全站页脚仍由 layout 提供，且仍是 <footer> 地标", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /<SiteFooter\s*\/>/, "layout 应渲染 SiteFooter");
  const footer = read("components/SiteFooter.tsx");
  assert.match(footer, /<footer className="site-footer">/, "SiteFooter 应仍是 <footer>");
});

test("B-5 全站只有一个组件输出 <footer> 地标（排除后台）", () => {
  /**
   * 扫前台页面与组件，列出所有 `<footer` 字面量。允许的只有 SiteFooter
   * 那一个；其它任何地方出现都说明又多了一个地标。
   *
   * 后台（app/admin、components/admin）不扫：后台是另一套壳，不在本任务范围。
   */
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "admin" || e.name === "api") continue;
        walk(p);
      } else if (/\.(tsx|jsx)$/.test(e.name)) {
        files.push(p);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "components"));

  const offenders: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "components/SiteFooter.tsx") continue; // 唯一允许的
    const text = stripComments(fs.readFileSync(f, "utf8"));
    const n = (text.match(/<footer\b/g) || []).length;
    if (n > 0) offenders.push(rel + " (" + n + " 个)");
  }
  assert.deepEqual(offenders, [], "前台只应有 SiteFooter 输出 <footer>，实际还有：\n  " + offenders.join("\n  "));
});
