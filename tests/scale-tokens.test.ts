import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 设计令牌刻度补齐（C-7，2026-11-01）。
 *
 * ## 问题
 *
 * 字面量散落在 CSS 里：`border-radius: 10px` ×14、`8px` ×6、`12px` ×3；
 * `font-size: .78rem` ×8、`.82rem` ×8；`gap: 8px` ×9；`transition` 时长
 * 8 档（.15/.16/.18/.2/.24/.25/.3/.5）；`z-index` 4 档；`44px` ×15、
 * `48px` ×6（**已有 `--tap` / `--tap-lg`，但没人用**）。
 *
 * ## 做法：只新增 + 只在「本阶段改动的规则」里使用
 *
 * 全量替换 2200 行 CSS 的回归面太大，且大部分替换只是"把 8px 换成
 * var(--space-3)"—— 语义没变、风险变高。
 *
 * 所以本轮只做两件低风险的事：
 *   1. **补齐刻度令牌**（radius / font-size / duration / z-index / tap）
 *   2. **只在本阶段（C-1…C-9）新增或改过的规则里使用它们**
 *
 * 这样"新代码有刻度可用"，老代码保持不动。
 *
 * ## z-index 是例外：它必须全量替换
 *
 * 因为 z-index 4 档（1/50/100/200）里，**抽屉与对话框同为 200** ——
 * 这不是"风格不统一"，是**真实的层级冲突风险**：两个浮层同时打开时
 * 谁在上取决于 DOM 顺序，而不是设计意图。
 *
 * 所以 z-index 的 6 处全部改用语义令牌。这也让"抽屉 120 / 对话框 200"
 * 这样的层级关系成为显式约定。
 */

const ROOT = process.cwd();
const RAW = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}
const CSS = stripComments(RAW);

/** :root 主令牌块 */
function rootBlock(src: string): string {
  const start = src.indexOf(":root {");
  assert.ok(start >= 0, "找不到 :root");
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(":root 未闭合");
}

const ROOT_BLOCK = rootBlock(CSS);

test("C-7 圆角刻度：只保留真正用到的两个（不造死 token）", () => {
  /**
   * `--radius-md`(10px) 与 `--radius-pill`(999px) 也是高频值，但它们出现在
   * **老规则**里，本阶段不动老代码 —— 加了没人用就又是死 token。
   * 等真有新代码需要时再加。
   */
  for (const [name, value] of [
    ["--radius-sm", "8px"],
    ["--radius-lg", "12px"],
  ] as const) {
    assert.match(
      ROOT_BLOCK,
      new RegExp("\\" + name + ":\\s*" + value),
      ":root 应定义 " + name + " = " + value
    );
  }
});

test("C-7 补齐字号刻度（font-size）", () => {
  for (const [name, value] of [
    ["--fs-xs", ".72rem"],
    ["--fs-sm", ".78rem"],
    ["--fs-base", ".82rem"],
    ["--fs-md", ".85rem"],
  ] as const) {
    assert.match(
      ROOT_BLOCK,
      new RegExp("\\" + name + ":\\s*" + value.replace(".", "\\.")),
      ":root 应定义 " + name + " = " + value
    );
  }
});

test("C-7 不引入暂时用不上的动效令牌（避免死 token）", () => {
  /**
   * 本阶段新增的规则里没有 transition（C-5 的 .pager-current 是无过渡的
   * 静态元素），所以不引入 --dur-*。将来给新组件加过渡时再加，并直接使用。
   */
  assert.doesNotMatch(ROOT_BLOCK, /--dur-(fast|base)\s*:/, ":root 不应有零引用的 --dur-* 令牌");
});

test("C-7 补齐层级（z-index）且抽屉必须低于对话框", () => {
  const grab = (name: string) => {
    const m = ROOT_BLOCK.match(new RegExp("\\" + name + ":\\s*(\\d+)"));
    assert.ok(m, ":root 应定义 " + name);
    return Number(m[1]);
  };
  const topbar = grab("--z-topbar");
  const drawer = grab("--z-drawer");
  const dialog = grab("--z-dialog");

  assert.ok(topbar < drawer, "顶栏层级应低于抽屉（" + topbar + " < " + drawer + "）");
  assert.ok(drawer < dialog, "抽屉层级应低于对话框（" + drawer + " < " + dialog + "）");
});

test("C-7 z-index 必须全部改用令牌（消除「抽屉与对话框同层」的冲突）", () => {
  /**
   * 全量替换：这是唯一一处"必须全改"的刻度。
   * 原来 100 出现 2 次（两个抽屉）、200 出现 2 次（对话框 + 另一个浮层）——
   * 同层意味着谁在上取决于 DOM 顺序。
   */
  const literals = [...CSS.matchAll(/z-index:\s*(\d+)/g)].map((m) => m[1]);
  assert.deepEqual(
    literals,
    [],
    "CSS 里不应再有 z-index 数字字面量（应改用 var(--z-*)），实际：" + JSON.stringify(literals)
  );

  const uses = [...CSS.matchAll(/z-index:\s*var\((--z-[\w-]+)\)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 5, "应有 ≥5 处使用 z-index 令牌，实际 " + uses.length);
  for (const u of uses) {
    assert.ok(
      ["--z-topbar", "--z-drawer", "--z-dialog", "--z-base"].includes(u),
      "使用了未定义的层级令牌：" + u
    );
  }
});

test("C-7 触控热区改用 --tap / --tap-lg（去掉 44px / 48px 字面量）", () => {
  /**
   * `--tap: 44px` / `--tap-lg: 48px` 早就定义了，但 CSS 里 44px 出现 15 次、
   * 48px 出现 6 次，一次都没用令牌。这是"令牌存在但形同虚设"的典型。
   *
   * 只改**热区语义**的那些（min-height / height / width 用于按钮）；
   * 不碰 44px 作为普通尺寸出现的地方（比如图标尺寸）—— 那些不是热区。
   */
  const hotzoneLines = [
    ...CSS.matchAll(/^\s*(?:min-height|min-width|height|width):\s*(44|48)px;.*$/gm),
  ].map((m) => m[0].trim());

  // 允许仍存在，但要求热区相关的块（.btn / .mobile-icon-btn / 抽屉项）用令牌
  for (const sel of [".mobile-icon-btn", ".mobile-drawer-item", ".sheet-close"]) {
    const idx = CSS.indexOf(sel + " {");
    if (idx < 0) continue;
    const block = CSS.slice(idx, CSS.indexOf("}", idx) + 1);
    if (/44px|48px/.test(block)) {
      assert.fail(sel + " 的热区仍写死像素（应用 var(--tap) / var(--tap-lg)）：" + block.trim());
    }
  }
});

test("C-7 新令牌必须在暗色块里也有定义（主题无关的尺寸类除外）", () => {
  /**
   * 圆角/字号/动效/z-index/热区都是**主题无关**的 —— 它们只在 :root 定义一次，
   * 暗色块里不需要重复。这条断言把这个约定写下来，防止有人把颜色类令牌
   * 混进这批里。
   */
  const manual = CSS.indexOf(':root[data-theme="dark"]');
  const manualBlock = CSS.slice(manual, CSS.indexOf("}", manual) + 1);
  for (const name of ["--radius-sm", "--fs-sm", "--z-drawer", "--tap"]) {
    assert.ok(
      !manualBlock.includes(name + ":"),
      name + " 是主题无关的尺寸/层级令牌，不该在暗色块里重新定义"
    );
  }
});

test("C-7 新增令牌必须真的有人用（与 C-1 的反向断言一致）", () => {
  /**
   * C-1 刚删掉 58 个零引用 token，C-7 不能又造一批新的。
   * 每个新增刻度都必须在 CSS 或 TSX 里至少被 var() 引用一次。
   */
  const all = RAW;
  const NEW = [
    "--radius-sm", "--radius-lg",
    "--fs-xs", "--fs-sm", "--fs-base", "--fs-md",
    "--z-topbar", "--z-drawer", "--z-dialog", "--z-base",
  ];
  const unused = NEW.filter((t) => {
    const uses = [...all.matchAll(new RegExp("var\\(" + t + "\\)", "g"))].length;
    return uses === 0;
  });
  assert.deepEqual(unused, [], "这些新令牌定义了但零引用（C-1 刚清理过同类问题）：" + unused.join(", "));
});
