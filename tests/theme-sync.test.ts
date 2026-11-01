import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 主题切换多实例同步与主题色单源（C-4，2026-11-01）。
 *
 * ## 问题一：4 个实例各持 state，互相不同步
 *
 * `<ThemeToggle />` 在项目里有 4 个实例：
 *   components/Sidebar.tsx        桌面左栏底部
 *   components/MobileNav.tsx      手机顶栏
 *   components/admin/AdminShell.tsx  后台侧栏 + 后台顶栏
 *
 * 每个都 `useState<Theme | null>(null)`，只在自己被点时更新自己。
 * 于是在桌面点侧栏那个切换按钮 → 手机顶栏那个的 `aria-label` 仍是旧值。
 * 读屏用户会被告知「切换到夜间模式」，而实际已经在夜间了 —— 点了反而切回白天。
 *
 * 这是**无障碍缺陷**，而且只有同时看到两个实例才会发现（比如桌面宽屏时
 * 侧栏与顶栏都在，或者用读屏）。
 *
 * ## 问题二：主题色散落在 5 处
 *
 * `#fffefc`（浅）/`#141414`（深）在 5 个文件里各写一份：
 *   app/layout.tsx:55           metadata.themeColor
 *   app/manifest.ts:12-13       PWA 的 background/theme color
 *   components/ThemeToggle.tsx  切换时同步 meta
 *   components/ThemeScript.tsx  首屏防闪烁脚本
 *
 * 改一个色要记得改 5 处，漏一处就出现「地址栏是旧色、页面是新色」。
 *
 * ## 修法
 *
 * 1. `ThemeToggle` 改用 `useSyncExternalStore` 订阅 `documentElement` 的
 *    `data-theme` 属性（MutationObserver）。任一实例写入 → 所有实例同步。
 * 2. 新建 `lib/theme-colors.ts` 导出 `LIGHT_BG` / `DARK_BG`，5 处引用它。
 *    `ThemeScript` 是内联字符串，只能拼值进去（这是可接受的例外，
 *    但值本身来自常量，不再是字面量）。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("C-4 存在 lib/theme-colors.ts 且导出两个主题色", () => {
  const f = path.join(ROOT, "lib/theme-colors.ts");
  assert.ok(fs.existsSync(f), "应存在 lib/theme-colors.ts");
  const src = read("lib/theme-colors.ts");
  assert.match(src, /export const LIGHT_BG\s*=\s*"#fffefc"/, "应导出 LIGHT_BG = #fffefc");
  assert.match(src, /export const DARK_BG\s*=\s*"#141414"/, "应导出 DARK_BG = #141414");
});

test("C-4 ThemeToggle 必须用 useSyncExternalStore 订阅 data-theme", () => {
  const src = read("components/ThemeToggle.tsx");
  assert.match(src, /useSyncExternalStore/, "ThemeToggle 应用 useSyncExternalStore 订阅主题");
  assert.match(src, /MutationObserver/, "应通过 MutationObserver 监听 data-theme 变化");
  // 不能再自持一份 theme state（那是不同步的根源）
  assert.doesNotMatch(
    src,
    /const \[theme, setTheme\]\s*=\s*useState/,
    "不应再用 useState 自持主题状态（多实例会不同步）"
  );
});

test("C-4 主题色不得再散落成字面量（除 lib/theme-colors.ts 本身）", () => {
  /**
   * 逐文件检查：除了定义处，任何 .ts/.tsx 都不该出现 #fffefc / #141414。
   * CSS 里当然还有（那是设计令牌定义），这里只管 TS/TSX。
   */
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "components"));
  walk(path.join(ROOT, "lib"));

  const offenders: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "lib/theme-colors.ts") continue; // 定义处
    const text = fs.readFileSync(f, "utf8");
    if (/#fffefc|#141414/i.test(text)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "这些文件仍硬编码主题色（应 import { LIGHT_BG, DARK_BG }）：\n  " + offenders.join("\n  ")
  );
});

test("C-4 ThemeScript 的脚本必须引用常量而不是字面量", () => {
  /**
   * 内联脚本没法 import，只能把值拼进字符串。但**值的来源**必须是常量，
   * 否则改了 theme-colors.ts 而忘了改这里，首屏就会闪一下旧色。
   */
  const src = read("components/ThemeScript.tsx");
  assert.match(src, /theme-colors/, "ThemeScript 应 import 主题色常量");
  assert.match(src, /LIGHT_BG|DARK_BG/, "应使用 LIGHT_BG / DARK_BG 拼脚本");
  // 字符串里不该再出现原始色值
  assert.doesNotMatch(src, /#fffefc|#141414/i, "ThemeScript 的脚本字面量里不应再有原始色值");
});

test("C-4 四个 ThemeToggle 实例都还在（不能靠删实例解决同步）", () => {
  /**
   * 反例守卫：最省事的"修复"是把重复实例删掉。但侧栏/顶栏/后台的两处
   * 都是不同断点下的必要入口，删了就没有切换按钮了。
   */
  const expected: [string, number][] = [
    ["components/Sidebar.tsx", 1],
    ["components/MobileNav.tsx", 1],
    ["components/admin/AdminShell.tsx", 2],
  ];
  for (const [f, n] of expected) {
    const src = read(f);
    const count = (src.match(/<ThemeToggle\b/g) || []).length;
    assert.equal(count, n, f + " 应有 " + n + " 个 <ThemeToggle>，实际 " + count);
  }
});
