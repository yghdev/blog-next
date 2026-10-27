import { test } from "node:test";
import assert from "node:assert/strict";
import { parseColor, compositeOver, relativeLuminance, contrastRatio, contrastFromLayers } from "../tests/helpers/contrast.mjs";

/**
 * 对比度算法的单元测试。
 *
 * 存在的理由：阶段 01-A 用两版手写公式得出 2.77 / 1.89 两个互不相同的结果，
 * 于是"暗色对比度不达标"这个结论本身不可信。这里用 WCAG 官方示例值把它钉死：
 *   - 黑对白 = 21:1（定义上限）
 *   - 同色对同色 = 1:1（定义下限）
 *   - #767676 对白 ≈ 4.54:1（W3C 文档里的经典边界值）
 * 只有先证明尺子是准的，才有资格拿它去判样式。
 */

test("parseColor 支持 rgb / rgba / 三位与六位 hex", () => {
  assert.deepEqual(parseColor("rgb(26, 26, 25)"), { r: 26, g: 26, b: 25, a: 1 });
  assert.deepEqual(parseColor("rgba(255, 255, 255, 0.38)"), { r: 255, g: 255, b: 255, a: 0.38 });
  assert.deepEqual(parseColor("#767676"), { r: 118, g: 118, b: 118, a: 1 });
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor("#00000080")!.a.toFixed(3), (128 / 255).toFixed(3));
  assert.equal(parseColor("nonsense"), null);
  assert.equal(parseColor(""), null);
});

test("compositeOver 按 alpha 正确叠加", () => {
  const half = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual([half.r, half.g, half.b], [127.5, 127.5, 127.5]);
  // alpha=0 时应完全取背景
  const none = compositeOver({ r: 255, g: 0, b: 0, a: 0 }, { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual([none.r, none.g, none.b], [10, 20, 30]);
});

test("relativeLuminance 符合 WCAG 定义（黑 0 / 白 1）", () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
});

test("contrastRatio 命中 WCAG 已知值", () => {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  assert.equal(Math.round(contrastRatio(black, white) * 100) / 100, 21);
  assert.equal(contrastRatio(black, black), 1);
  // #767676 vs white 是 W3C 文档中"刚好达标 AA"的示例
  const gray = { r: 118, g: 118, b: 118, a: 1 };
  assert.ok(Math.abs(contrastRatio(gray, white) - 4.54) < 0.02, "actual=" + contrastRatio(gray, white));
  // 对称性：交换前景背景结果不变
  assert.equal(contrastRatio(black, white), contrastRatio(white, black));
});

test("contrastFromLayers 处理半透明前景与多层背景", () => {
  // 暗色卡片 rgb(26,26,25) 上的 rgba(255,255,255,.38) 次要文字
  const ratio = contrastFromLayers("rgba(255, 255, 255, 0.38)", ["rgba(0, 0, 0, 0)", "rgb(26, 26, 25)"])!;
  // 半透明白字合成后仍应明显亮于背景，落在 3~5 之间（不是 1.x 那种明显错误的量级）
  assert.ok(ratio > 2.5 && ratio < 6, "actual=" + ratio);

  // 完全透明前景 = 看不见，比值应接近 1
  const invisible = contrastFromLayers("rgba(255, 255, 255, 0)", ["rgb(26, 26, 25)"])!;
  assert.ok(invisible < 1.05, "actual=" + invisible);

  // 不透明黑字在白底上 = 21
  const full = contrastFromLayers("rgb(0, 0, 0)", ["rgb(255, 255, 255)"])!;
  assert.equal(Math.round(full * 100) / 100, 21);

  assert.equal(contrastFromLayers("nonsense", ["rgb(0,0,0)"]), null);
  assert.equal(contrastFromLayers("rgb(0,0,0)", []), null);
});

test("最底层背景半透明时直接报错，不用猜测的兜底色", () => {
  // 这一条防的是"暗色页面上按白底合成"导致的假结论：
  // 同一条 rgba 前景色，叠在深色底和白色底上，对比度完全不同。
  assert.throws(
    () => contrastFromLayers("rgb(224,176,98)", ["rgba(224, 176, 98, 0.12)"]),
    /最底层背景必须不透明/
  );

  // 正确用法：把真实底色补在最后一层
  const onDark = contrastFromLayers("rgb(224,176,98)", ["rgba(224, 176, 98, 0.12)", "rgb(26, 26, 25)"])!;
  const onLight = contrastFromLayers("rgb(224,176,98)", ["rgba(224, 176, 98, 0.12)", "rgb(252, 252, 251)"])!;
  assert.ok(onDark > onLight, "同一前景色在深底上对比度应高于浅底: dark=" + onDark + " light=" + onLight);
});
