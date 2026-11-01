import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 断点几何（B-3，2026-11-01）。
 *
 * ## 为什么单独测"公式"而不是只靠浏览器
 *
 * 断点错位最典型的形态不是"页面炸了"，而是**某一档视口突然变窄**：
 * 1201px 时正文 449px、1200px 时 760px —— 只差 1px 视口，内容却差 311px。
 * 浏览器全量截图能看出来，但很难钉住"到底哪一档错了"。
 *
 * 这里直接把路线图 §10.3 的期望值写成表，用公式算一遍。真正的浏览器
 * 实测放在 `tests/layout-regression.mjs`（那里比的是渲染结果）。
 *
 * ## 关键约束（路线图 §10.3 尾注）
 *
 * **不得为了让断言通过而修改设计参数**（--w-side / --w-main / --w-toc /
 * --gap-col / 1392）。参数是设计决策，下表是它的推论；若实测与表不符，
 * 先查实现（padding 是否 32×2、max-width 上限、断点写反），再回头讨论表。
 */

/** 与 globals.css 保持一致的设计参数（改动需同步本文件与路线图 §10.3） */
const P = {
  side: 288,
  main: 800,
  toc: 320,
  read: 960,
  gap: 40,
  pad: 64,      // 左右内边距合计 32*2
  singlePad: 40, // 单栏 padding 20*2
  threeColMin: 1392,
};

/** 三栏：中间列弹性，上限 --w-main */
const threeCol = (vw: number) => Math.min(P.main, vw - P.pad - P.side - P.toc - P.gap * 2);

/** 两栏：上限 --w-shell-narrow（= side + main + gap + pad），内容 = min(main, vw - pad - side - gap) */
const twoCol = (vw: number) => Math.min(P.main, vw - P.pad - P.side - P.gap);

/** 宽版：上限 --w-read */
const wide = (vw: number) => Math.min(P.read, vw - P.pad - P.side - P.gap);

/** 单栏 */
const single = (vw: number) => vw - P.singlePad;

/** 某视口下标准页是几栏 */
const mode = (vw: number): "three" | "two" | "single" =>
  vw >= P.threeColMin ? "three" : vw > 820 ? "two" : "single";

/** 标准页正文宽 */
function standardContent(vw: number): number {
  const m = mode(vw);
  if (m === "three") return threeCol(vw);
  if (m === "two") return twoCol(vw);
  return single(vw);
}

/** 宽版页正文宽（永远两栏，≥821 时） */
function wideContent(vw: number): number {
  if (vw <= 820) return single(vw);
  return wide(vw);
}

/* ────────────────────────── 期望表（§10.3） ────────────────────────── */

const EXPECTED: [number, number, number][] = [
  // [视口, 标准页 content, 宽版页 content]
  [1600, 800, 960],
  [1552, 800, 960],
  [1440, 688, 960],
  [1392, 640, 960],
  [1391, 800, 960],
  [1202, 800, 810],
  [1201, 800, 809],
  [1200, 800, 808],
  [1199, 800, 807],
  [1100, 708, 708],
  [900, 508, 508],
  [821, 429, 429],
  [820, 780, 780],
  [375, 335, 335],
];

test("B-3 断点模式：三栏阈值必须是 1392（1391 起两栏）", () => {
  assert.equal(mode(1393), "three", "1393 应仍是三栏");
  assert.equal(mode(1392), "three", "1392 是三栏最低点");
  assert.equal(mode(1391), "two", "1391 应变成两栏");
  assert.equal(mode(1390), "two");
  assert.equal(mode(821), "two", "821 是两栏最窄点");
  assert.equal(mode(820), "single", "820 起单栏");
});

test("B-3 §10.3 期望值全部命中（容差 0）", () => {
  const bad: string[] = [];
  for (const [vw, wantStd, wantWide] of EXPECTED) {
    const std = standardContent(vw);
    const wd = wideContent(vw);
    if (std !== wantStd) bad.push(vw + "px 标准页：算得 " + std + "，表为 " + wantStd);
    if (wd !== wantWide) bad.push(vw + "px 宽版页：算得 " + wd + "，表为 " + wantWide);
  }
  assert.deepEqual(bad, [], "与 §10.3 不符：\n  " + bad.join("\n  "));
});

test("B-3 断点内连续性：1202/1201/1200/1199 四档相邻差 ≤ 1px", () => {
  /**
   * 这是本任务的**真正目标**：原实现在 1201→1200 之间从 449 跳到 760，
   * 差 311px。现在四档同属两栏区，公式都是 min(800, vw-392)，
   * 在这段区间恒为 800。
   */
  const vals = [1202, 1201, 1200, 1199].map(standardContent);
  assert.deepEqual(vals, [800, 800, 800, 800], "1202/1201/1200/1199 应恒为 800，实际 " + JSON.stringify(vals));
  for (let i = 1; i < vals.length; i++) {
    assert.ok(Math.abs(vals[i] - vals[i - 1]) <= 1, "相邻差必须 ≤ 1px");
  }
});

test("B-3 断点切换点唯一：跳变只发生在 1391→1392", () => {
  /**
   * 1393→1392→1391 为 641 → 640 → 800：160px 跳变是「右栏让位」的有意设计，
   * 断言里显式登记为预期值（不是 bug）。
   * 关键是：**除了这一处，两栏区间内不该再有别的跳变**。
   */
  assert.equal(standardContent(1393), 641);
  assert.equal(standardContent(1392), 640);
  assert.equal(standardContent(1391), 800);
  assert.equal(standardContent(1390), 800, "1391→1390 应无变化");

  // 两栏区间 821..1391：只允许线性收缩，不允许跳变
  const jumps: string[] = [];
  for (let vw = 1391; vw > 821; vw--) {
    const d = Math.abs(standardContent(vw) - standardContent(vw - 1));
    // 线性区每降 1px 视口，内容最多降 1px（触到上限时为 0）
    if (d > 1) jumps.push(vw + "→" + (vw - 1) + " 差 " + d + "px");
  }
  assert.deepEqual(jumps, [], "两栏区间内不应有断崖：\n  " + jumps.join("\n  "));
});

test("B-3 单栏边界：821→820 的 351px 跳变是预期（三栏收窄 → 单栏铺满）", () => {
  assert.equal(standardContent(821), 429);
  assert.equal(standardContent(820), 780);
  assert.equal(standardContent(820) - standardContent(821), 351, "该跳变登记为预期值");
  // 820 以下必须线性
  const jumps: string[] = [];
  for (let vw = 820; vw > 375; vw--) {
    const d = Math.abs(standardContent(vw) - standardContent(vw - 1));
    if (d > 1) jumps.push(vw + "→" + (vw - 1) + " 差 " + d);
  }
  assert.deepEqual(jumps, [], "单栏区间内每档差应 = 视口差（线性）");
});

test("B-3 宽版页相邻差 ≤ 1px（1199→1200→1201→1202）", () => {
  const vals = [1199, 1200, 1201, 1202].map(wideContent);
  assert.deepEqual(vals, [807, 808, 809, 810], "宽版页应线性，实际 " + JSON.stringify(vals));
  for (let i = 1; i < vals.length; i++) {
    assert.ok(Math.abs(vals[i] - vals[i - 1]) <= 1, "相邻差必须 ≤ 1px");
  }
});

test("B-3 设计参数不得为了通过断言而改动", () => {
  /**
   * 把参数写死在这里，任何人为了让上面的期望值"通过"而改 --w-main 之类，
   * 都会在这里立刻红。真要改设计，必须同时改本文件 + 路线图 §10.3，
   * 那是一次显式的设计决策，而不是偷偷调参。
   */
  assert.deepEqual(P, {
    side: 288, main: 800, toc: 320, read: 960, gap: 40,
    pad: 64, singlePad: 40, threeColMin: 1392,
  });
});
