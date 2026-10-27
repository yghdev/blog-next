/**
 * 颜色对比度计算（WCAG 2.1 §1.4.3）。
 *
 * 为什么单独抽成模块并配单元测试：
 * 阶段 01-A 走查里，同样的页面用两版"手写对比度"算出 2.77 和 1.89 两个
 * 完全不同的结果，而人工手算约 8.1 —— 说明问题出在计算，不在样式。
 * 拿一个自己都算不准的尺子去改设计，只会把真问题掩盖成"改完就过了"。
 *
 * 所以这里把数学固定下来：用 WCAG 官方示例值做断言（黑白 21:1、
 * #767676 对白 4.54:1），浏览器测试只负责取原始颜色字符串。
 */

/** 解析 "rgb(1,2,3)" / "rgba(1,2,3,.5)" / "#rrggbb" / "#rgb" */
export function parseColor(input) {
  if (!input) return null;
  const s = String(input).trim();

  const rgbMatch = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((x) => parseFloat(x.trim()));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  const hexMatch = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b, a };
  }

  return null;
}

/** 把 src 按自身的 alpha 叠加到 dst 上（src 在上） */
export function compositeOver(src, dst) {
  const a = src.a === undefined ? 1 : src.a;
  return {
    r: src.r * a + dst.r * (1 - a),
    g: src.g * a + dst.g * (1 - a),
    b: src.b * a + dst.b * (1 - a),
    a: 1,
  };
}

/** WCAG 相对亮度 */
export function relativeLuminance(c) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/**
 * 对比度比值。
 * @param fg 前景色（可带 alpha）
 * @param bg 有效背景色（必须不透明；带 alpha 时会先叠加到黑/白兜底上再算 —— 调用方应保证不透明）
 */
export function contrastRatio(fg, bg) {
  const bgOpaque = bg.a === undefined || bg.a >= 1 ? bg : compositeOver(bg, { r: 0, g: 0, b: 0, a: 1 });
  const fgEffective = fg.a === undefined || fg.a >= 1 ? fg : compositeOver(fg, bgOpaque);
  const l1 = relativeLuminance(fgEffective);
  const l2 = relativeLuminance(bgOpaque);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * 从"元素自身的颜色 + 由近及远的背景层"算出实际对比度。
 * @param fgColor 元素 getComputedStyle().color
 * @param bgLayers 向上收集的背景色字符串数组，由近及远；最后一个必须是页面兜底底色
 */
export function contrastFromLayers(fgColor, bgLayers) {
  const fg = parseColor(fgColor);
  if (!fg) return null;
  const layers = bgLayers.map(parseColor).filter((c) => c && c.a > 0);
  if (!layers.length) return null;

  // 由底向上合成，得到真正显示的背景
  let acc = layers[layers.length - 1];
  if (acc.a < 1) acc = compositeOver(acc, { r: 255, g: 255, b: 255, a: 1 });
  for (let i = layers.length - 2; i >= 0; i--) acc = compositeOver(layers[i], acc);

  return contrastRatio(fg, acc);
}
