import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 暗色令牌单源（C-2，2026-11-01）。
 *
 * ## 问题
 *
 * 暗色有两套作用域，结构上**无法合并成一条规则**（一个是选择器条件、
 * 一个是媒体条件）：
 *
 *     :root[data-theme="dark"]            ← 32 个值
 *     @media (prefers-color-scheme: dark) {
 *       :root:not([data-theme="light"]):not([data-theme="dark"])  ← 同样的 32 个值
 *     }
 *
 * 但**值**可以只写一份。原来这 32 个值在两处各写一遍（实测逐 token
 * diff = 0，说明现在是同步的，但那靠的是人肉纪律）。改一个暗色色值要
 * 同时改两处，漏一处就出现「手动切暗色」与「跟随系统变暗」两种状态
 * 颜色不一致 —— 而这种不一致只有同时开两个浏览器（一个手动切、一个
 * 跟随系统）才会看出来，日常开发几乎不可能发现。
 *
 * ## 修法
 *
 * 值抽成一组 `--dark-*` 变量（只写一份），两个作用域只做机械映射：
 *
 *     :root { --dark-bg: #0b0f14; … }              ← 值只在这里
 *     :root[data-theme="dark"] { --bg: var(--dark-bg); … }        ← 映射
 *     @media (…) { :root:not(…) { --bg: var(--dark-bg); … } }     ← 同样的映射
 *
 * ## 这是纯重构
 *
 * **改前改后暗色视觉必须逐像素一致**。如果不一致，说明某个 `--dark-*`
 * 抄错了值 —— 这正是这一步的价值：把"两份可能漂移的字面量"变成
 * "一份值 + 两条机械映射"，任何抄错都会立刻在截图 diff 里暴露。
 */

const ROOT = process.cwd();
const RAW = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}
const CSS = stripComments(RAW);

/** 取选择器后紧跟的声明块内容（不含外层大括号） */
function declsOf(selector: string, from = 0): string | null {
  const idx = CSS.indexOf(selector, from);
  if (idx < 0) return null;
  const open = CSS.indexOf("{", idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  return null;
}

/** 解析声明块里的 --token: value */
function tokensIn(decls: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of decls.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const manual = declsOf(':root[data-theme="dark"] {');
const mediaIdx = CSS.indexOf("@media (prefers-color-scheme: dark)");
const system = declsOf(':root:not([data-theme="light"]):not([data-theme="dark"]) {', mediaIdx);

test("C-2 两个暗色作用域都能找到", () => {
  assert.ok(manual, '应有 :root[data-theme="dark"] 块');
  assert.ok(system, "应有系统暗色块");
});

test("C-2 两个暗色作用域必须映射同一组 --dark-* 变量", () => {
  /**
   * 关键约束：两处的映射必须**逐条相同**。只要有一处写成别的变量名
   * 或写回字面量，`--dark-*` 就不再是唯一真相。
   */
  const a = tokensIn(manual!);
  const b = tokensIn(system!);

  const onlyA = [...a.keys()].filter((k) => !b.has(k));
  const onlyB = [...b.keys()].filter((k) => !a.has(k));
  assert.deepEqual(onlyA, [], "这些令牌只在手动暗色块里：" + onlyA.join(", "));
  assert.deepEqual(onlyB, [], "这些令牌只在系统暗色块里：" + onlyB.join(", "));

  const mismatch: string[] = [];
  for (const [k, va] of a) {
    if (b.get(k) !== va) mismatch.push(k + ": " + va + " vs " + b.get(k));
  }
  assert.deepEqual(mismatch, [], "两个作用域对同一令牌的映射不一致：\n  " + mismatch.join("\n  "));
});

test("C-2 暗色值必须只写一份（两个作用域里不得出现色值字面量）", () => {
  /**
   * 这是本任务的核心。允许的写法只有 `var(--dark-xxx)`；任何 #hex /
   * rgb() / color-mix() 字面量都说明值又被抄了一份。
   */
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bcolor-mix\(/;
  for (const [name, decls] of [["手动暗色", manual!], ["系统暗色", system!]] as const) {
    const bad: string[] = [];
    for (const m of decls.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (LITERAL.test(m[2])) bad.push(m[1] + ": " + m[2].trim());
    }
    assert.deepEqual(
      bad,
      [],
      name + " 块里仍有色值字面量（应改为 var(--dark-*)）：\n  " + bad.join("\n  ")
    );
  }
});

test("C-2 每个 --dark-* 都必须被两个作用域各引用一次", () => {
  /**
   * 反例守卫：抽了 `--dark-xxx` 却没人用，等于新增了一批死 token
   * （C-1 刚清完，不能再造）。
   */
  const rootDecls = declsOf(":root {");
  assert.ok(rootDecls, "应有 :root 主块");
  const darkVars = [...tokensIn(rootDecls).keys()].filter((k) => k.startsWith("--dark-"));
  assert.ok(darkVars.length > 0, "应在 :root 里定义 --dark-* 变量");

  const usedInManual = [...tokensIn(manual!).values()].filter((v) => v.includes("var(--dark-"));
  const usedInSystem = [...tokensIn(system!).values()].filter((v) => v.includes("var(--dark-"));

  for (const v of darkVars) {
    const n1 = usedInManual.filter((x) => x.includes(v + ")")).length;
    const n2 = usedInSystem.filter((x) => x.includes(v + ")")).length;
    assert.ok(n1 >= 1, v + " 未被手动暗色块引用（抽了却不用 = 新的死 token）");
    assert.ok(n2 >= 1, v + " 未被系统暗色块引用");
  }
});

test("C-2 暗色底色在整个文件里只出现一次（--dark-bg 的定义处）", () => {
  /**
   * 路线图给的验收硬指标（原值是 #141414，2026-11-08 第四轮换成 #0b0f14）。
   * 值只在 --dark-bg 定义处出现一次，两个暗色作用域只做机械映射。
   */
  const hits = [...CSS.matchAll(/#0b0f14/g)].length;
  assert.equal(hits, 1, "#0b0f14 应只出现 1 次（--dark-bg 定义处），实际 " + hits + " 次");
});
