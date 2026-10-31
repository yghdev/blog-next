import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 样式表健康检查（A-5，2026-10-31）。
 *
 * ## 为什么值得单独一个测试文件
 *
 * `app/globals.css` 里有一处 `/* ═════…` 只有开头没有结尾，于是紧跟着的
 * 整个 `@media (prefers-reduced-motion: reduce)` 块被吞进注释 ——
 * CSS 注释**不报错**，构建也照过，只是那几十行规则**永远不生效**。
 *
 * 症状极其隐蔽：只有开启「减少动态效果」的用户，才会发现动画还在动；
 * 而开发机上几乎没人开这个系统偏好。文件里其他地方看起来都正常，
 * 编辑器语法高亮甚至会把后面一大段标成"注释色"—— 太容易被当成设计。
 *
 * 所以这里守的不是"某条规则对不对"，而是"注释符必须配平"这一结构性事实。
 */

const CSS_FILES = [
  "app/globals.css",
  "app/friend-links/friends.css",
  "app/admin/admin.css",
];

/** 逐字符扫描，正确处理「注释里出现 /* 」这种嵌套写法（CSS 不允许嵌套，但要能报出来） */
function scanComments(src: string): { opens: number; closes: number; unclosedAt: number[] } {
  const opens: number[] = [];
  const unclosedAt: number[] = [];
  let depth = 0;
  let line = 1;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") { line++; i++; continue; }
    if (src.startsWith("/*", i)) {
      if (depth === 0) opens.push(line);
      depth++;
      i += 2;
      continue;
    }
    if (src.startsWith("*/", i)) {
      depth--;
      if (depth === 0) opens.pop();
      if (depth < 0) {
        // 多出来的 */：说明前面少写了 /*
        throw new Error("第 " + line + " 行出现多余的 */");
      }
      i += 2;
      continue;
    }
    i++;
  }
  unclosedAt.push(...opens);
  return { opens: 0, closes: 0, unclosedAt };
}

for (const file of CSS_FILES) {
  test("CSS 注释符配平：" + file, () => {
    const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const openCount = (src.match(/\/\*/g) || []).length;
    const closeCount = (src.match(/\*\//g) || []).length;

    assert.equal(
      openCount,
      closeCount,
      file + " 的注释符不配平：/* = " + openCount + "，*/ = " + closeCount +
        "。CSS 注释不配平不会报错，只会让后面一大段规则**静默失效**。"
    );

    const { unclosedAt } = scanComments(src);
    assert.deepEqual(
      unclosedAt,
      [],
      file + " 有未闭合的注释，起于第 " + unclosedAt.join(", ") + " 行"
    );
  });
}

test("globals.css 的 prefers-reduced-motion 块必须在注释之外（A-5 回归）", () => {
  /**
   * 这条用例针对具体事故：1838 行的 `/* ═════…` 少了闭合，
   * 把 1839 起的 @media 整块吞掉。仅"注释配平"还不够 ——
   * 有人可能把整块删掉来让计数相等，那同样会让减弱动效失效。
   */
  const src = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const lines = src.split("\n");

  // 找到全局那个「把动画压到 0.01ms」的块
  const idx = lines.findIndex((l) => l.includes("@media (prefers-reduced-motion: reduce)") &&
    lines.slice(lines.indexOf(l), lines.indexOf(l) + 6).join("\n").includes(".01ms"));
  assert.ok(idx >= 0, "globals.css 必须保留「全局减弱动效」的 @media 块（不能靠删掉它来配平注释）");

  // 判定这个 @media 是否处在注释内：从文件开头扫到它所在位置，看注释是否已闭合
  const before = lines.slice(0, idx).join("\n");
  const openCount = (before.match(/\/\*/g) || []).length;
  const closeCount = (before.match(/\*\//g) || []).length;
  assert.equal(
    openCount,
    closeCount,
    "@media (prefers-reduced-motion) 之前有 " + (openCount - closeCount) +
      " 个未闭合注释 —— 这个块会被整段吞掉，永远不会生效"
  );

  // 块内必须同时压 animation 与 transition，且 .slide-up 直接显示
  const block = lines.slice(idx, idx + 10).join("\n");
  assert.match(block, /animation-duration:\s*\.?0*\.01ms/, "应压缩 animation-duration");
  assert.match(block, /transition-duration:\s*\.?0*\.01ms/, "应压缩 transition-duration");
  assert.match(block, /\.slide-up/, "应让 .slide-up 直接显示（不做位移）");
});

test("每个 CSS 文件都不得出现「注释一开始就吃到文件尾」的情况", () => {
  /**
   * 另一种失败形态：文件最后一行是 `/* 说明` 且再没闭合。
   * 那种情况下「配平」检查也会红，但这条给出更直白的定位。
   */
  for (const file of CSS_FILES) {
    const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    let depth = 0;
    let i = 0;
    let lastOpenLine = 0;
    let line = 1;
    while (i < src.length) {
      if (src[i] === "\n") { line++; i++; continue; }
      if (src.startsWith("/*", i)) { if (depth === 0) lastOpenLine = line; depth++; i += 2; continue; }
      if (src.startsWith("*/", i)) { depth = Math.max(0, depth - 1); i += 2; continue; }
      i++;
    }
    assert.equal(depth, 0, file + " 在文件结束时仍有未闭合注释（起于第 " + lastOpenLine + " 行）");
  }
});
