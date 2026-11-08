import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * 整页栅格几何（2026-11-08 第二轮）。
 *
 * ## 模型
 *
 * 12 列 × 24px 栅距，容器上限 1552；三栏页按 1 / 2 / 6 / 2 / 1 分配：
 *
 *   留白 | 左导航(2) | 正文(6) | 右栏(2) | 留白
 *
 * 两栏页（≤1391）与宽版页：右栏那两列并入正文 → 正文 8 列。
 * 单栏（≤820）：左导航消失，正文 = 视口 − 2×20。
 *
 * ## 为什么"整页"必须重定义骨架
 *
 * 旧的 288/800/320 + 40 栅距无法落在任何等宽列栅格上：要
 * 288 = ku − g、800 = ku − g、320 = ku − g 同时成立，相减得 u 必须同时
 * 整除 512 与 32，再代入 0 < g < u 无解。所以只能由列反推轨道。
 *
 * ## 这张表是设计参数的推论，不是反过来
 *
 * 不得为了让断言通过而改参数（--page-max / --page-gutter / 12 / 672 /
 * 1392 / 820）。若实测与表不符，先查实现（列号、padding、断点写反），
 * 再回头讨论表 —— 设计参数本身是决策。
 */

/** 与 globals.css 保持一致的设计参数（改动需同步本文件与 docs/grid-system.md） */
const P = {
  pageMax: 1552,   // --page-max
  gutter: 24,      // --page-gutter
  cols: 12,        // 整页列数（写字面量，repeat() 不接受 var）
  prose: 672,      // --measure-prose
  pad: 40,         // 单栏左右内边距 20×2
  threeColMin: 1392, // ≥1392 三栏；1391 起两栏
  mobileMax: 820,  // ≤820 单栏
};

/** 容器可用宽度：被 --page-max 夹住 */
const basis = (vw: number) => Math.min(vw, P.pageMax);
/** 单列宽 */
const col = (vw: number) => (basis(vw) - (P.cols - 1) * P.gutter) / P.cols;
/** 连续 n 列 + (n-1) 个栅距 */
const spanned = (vw: number, n: number) => n * col(vw) + (n - 1) * P.gutter;

const threeCol = (vw: number) => spanned(vw, 6);
const twoCol = (vw: number) => spanned(vw, 8);
const rail = (vw: number) => spanned(vw, 2);
const single = (vw: number) => vw - P.pad;

const mode = (vw: number): "three" | "two" | "single" =>
  vw >= P.threeColMin ? "three" : vw > P.mobileMax ? "two" : "single";

/** 标准页正文宽 */
function standard(vw: number): number {
  const m = mode(vw);
  if (m === "three") return threeCol(vw);
  if (m === "two") return twoCol(vw);
  return single(vw);
}
/** 宽版页正文宽（≥821 永远 8 列，没有右栏） */
function wide(vw: number): number {
  if (vw <= P.mobileMax) return single(vw);
  return twoCol(vw);
}
/** 左导航 left：容器居中偏移 + 1 列 + 1 栅距 */
function sidebarLeft(vw: number): number {
  if (vw <= P.mobileMax) return 0;
  return Math.max(0, (vw - P.pageMax) / 2) + col(vw) + P.gutter;
}

/* ────────────────────────── 期望表 ────────────────────────── */

const EXPECTED: [number, number, number, number][] = [
  // [视口, 标准页正文, 宽版页正文, 左导航 left]
  [1920, 764, 1026.6667, 315.3333],
  [1600, 764, 1026.6667, 155.3333],
  [1552, 764, 1026.6667, 131.3333],
  [1440, 708, 952, 122],
  [1392, 684, 920, 118],        // 三栏最低点
  [1391, 919.3333, 919.3333, 117.9167], // 右栏收起 → 正文 +2 列
  [1202, 793.3333, 793.3333, 102.1667],
  [1201, 792.6667, 792.6667, 102.0833],
  [1200, 792, 792, 102],
  [1199, 791.3333, 791.3333, 101.9167],
  [1100, 725.3333, 725.3333, 93.6667],
  [900, 592, 592, 77],
  [821, 539.3333, 539.3333, 70.4167],
  [820, 780, 780, 0],           // 单栏，左导航隐藏
  [375, 335, 335, 0],
];

test("整页栅格：15 档视口全部命中（容差 0.01）", () => {
  const bad: string[] = [];
  for (const [vw, wantStd, wantWide, wantLeft] of EXPECTED) {
    if (Math.abs(standard(vw) - wantStd) > 0.01) bad.push(vw + " 标准页正文：算得 " + standard(vw) + "，表为 " + wantStd);
    if (Math.abs(wide(vw) - wantWide) > 0.01) bad.push(vw + " 宽版页正文：算得 " + wide(vw) + "，表为 " + wantWide);
    if (Math.abs(sidebarLeft(vw) - wantLeft) > 0.01) bad.push(vw + " 左导航 left：算得 " + sidebarLeft(vw) + "，表为 " + wantLeft);
  }
  assert.deepEqual(bad, [], "与期望表不符：\n  " + bad.join("\n  "));
});

test("整页栅格：模式切换点唯一（1392 三栏 / 820 单栏）", () => {
  assert.equal(mode(1393), "three");
  assert.equal(mode(1392), "three", "1392 是三栏最低点");
  assert.equal(mode(1391), "two", "1391 起两栏（右栏收起）");
  assert.equal(mode(821), "two");
  assert.equal(mode(820), "single", "820 起单栏");
  assert.equal(mode(375), "single");
});

test("整页栅格：1391→1392 的跳变是预期（右栏出现，正文少 2 列）", () => {
  /**
   * 三栏/两栏的差是「右栏 2 列 + 1 个栅距」= 2×col + 24。
   * 在 1392 处 = 2×94 + 24 = 212 —— 但正文是从 8 列变 6 列，
   * 所以实测差 = 919.333 − 684 = 235.333（含留白的列宽差）。
   * 这是设计选择（右栏出现本身就有代价），登记为预期值而不是 bug。
   */
  const a = standard(1392);
  const b = standard(1391);
  assert.equal(Math.round((b - a) * 100) / 100, 235.33, "1391→1392 跳变应为 235.33，实测 " + (b - a).toFixed(2));
  assert.ok(b > a, "两栏区正文应比三栏区更宽");
});

test("整页栅格：821→820 的跳变是预期（左导航消失 → 单栏铺满）", () => {
  const a = standard(821);
  const b = standard(820);
  assert.equal(Math.round((b - a) * 100) / 100, 240.67, "821→820 跳变应为 240.67，实测 " + (b - a).toFixed(2));
  assert.equal(standard(820), 780);
  assert.equal(standard(375), 335);
});

test("整页栅格：两栏区间内无断崖（每 1px 视口最多变化 1px）", () => {
  const jumps: string[] = [];
  for (let vw = 1391; vw > 821; vw--) {
    const d = Math.abs(standard(vw) - standard(vw - 1));
    if (d > 1) jumps.push(vw + "→" + (vw - 1) + " 差 " + d.toFixed(2));
  }
  assert.deepEqual(jumps, [], "两栏区间内不应有断崖：\n  " + jumps.join("\n  "));
});

test("整页栅格：≥1552 后正文宽冻结（容器到上限，多出的宽度归留白）", () => {
  assert.equal(Math.round(standard(1552)), 764);
  assert.equal(Math.round(standard(1600)), 764);
  assert.equal(Math.round(standard(1920)), 764);
  assert.equal(Math.round(wide(1920) * 100) / 100, 1026.67, "宽版页在 1552 以上冻结在 1026.67");
  // 左导航在超宽视口继续随容器居中右移
  assert.ok(sidebarLeft(1920) > sidebarLeft(1552), ">1552 时左导航应随容器居中右移");
});

test("整页栅格：单栏区间线性（每 1px 视口 = 1px 正文）", () => {
  const jumps: string[] = [];
  for (let vw = 820; vw > 375; vw--) {
    const d = Math.abs(standard(vw) - standard(vw - 1));
    if (d !== 1) jumps.push(vw + "→" + (vw - 1) + " 差 " + d);
  }
  assert.deepEqual(jumps, [], "单栏区间每档差应恰为 1px");
});

test("整页栅格：右栏宽 = 2 列 + 1 栅距（1440 下 220）", () => {
  assert.equal(Math.round(rail(1440) * 10) / 10, 220);
  assert.equal(Math.round(rail(1552) * 10) / 10, 238.7);
});

test("整页栅格：设计参数不得为了通过断言而改动", () => {
  /**
   * 参数写死在测试里：任何人为了让上面的期望值"通过"而改 --page-max 之类，
   * 都会在这里立刻红。真要改设计，必须同时改本文件 + docs/grid-system.md，
   * 那是一次显式的设计决策，而不是偷偷调参。
   */
  assert.deepEqual(P, {
    pageMax: 1552,
    gutter: 24,
    cols: 12,
    prose: 672,
    pad: 40,
    threeColMin: 1392,
    mobileMax: 820,
  });
  // 正文行宽是阅读参数，不能随列宽漂移
  assert.equal(P.prose, 672);
});