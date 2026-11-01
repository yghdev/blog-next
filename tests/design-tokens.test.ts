import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 令牌完整性：源码里引用的 CSS 自定义属性必须真的被定义过。
 *
 * 为什么值得单独一条测试（阶段 01-B 的真实根因）：
 * MediaGrid 与 StoragePanel 的状态徽章写的是
 *   background: var(--ok-bg, #e7f7ee); color: var(--ok-fg, #1a7f4b);
 * 其中 --ok-fg / --err-bg / --ok-bd / --err-bd **从未定义**。
 * 于是每一次渲染都走 fallback —— 硬编码的浅色主题色值。
 * 表现出来就是"暗色主题下这块是个刺眼的亮斑"，而代码读起来却像
 * "已经用了 token，应该是主题安全的"。这个 bug 靠肉眼审代码极难发现，
 * 靠测试却是一句话的事：名字查不到就是错。
 *
 * 两类东西不算错：
 *   - 有 fallback 且名字带 --mx/--my 这类局部变量（运行时由 JS 写入）
 *   - 纯局部自定义属性（在 :root 之外的块里定义）
 * 所以这里只断言"引用了但全文件都没定义、且没有合理来源"的情况。
 */

const ROOT = process.cwd();

/** All stylesheets that ship with the app: globals + route-level admin.css. */
function cssFiles(): string[] {
  return walk(path.join(ROOT, "app")).filter((p) => p.endsWith(".css"));
}
function allCss(): string {
  return cssFiles().map((p) => fs.readFileSync(p, "utf8")).join("\n");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist", ".git", ".tmp-tests"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 收集所有被定义的 --token 名（含 @media / [data-theme] 块里的） */
function definedTokens(cssText: string): Set<string> {
  return new Set([...cssText.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

test("所有被引用的 CSS 令牌都有定义（防止 fallback 静默接管）", () => {
  const defined = definedTokens(allCss());
  const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components"))];

  // 运行时由 JS 注入的局部变量，不属于设计令牌
  const RUNTIME_VARS = new Set(["--mx", "--my"]);

  const offenders: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/var\((--[\w-]+)/g)) {
      const name = m[1];
      if (defined.has(name) || RUNTIME_VARS.has(name)) continue;
      offenders.push(path.relative(ROOT, file).replace(/\\/g, "/") + " -> " + name);
    }
  }

  assert.deepEqual(
    [...new Set(offenders)],
    [],
    "以下引用的令牌从未定义，fallback 会静默接管（暗色主题通常因此失效）：\n" + [...new Set(offenders)].join("\n")
  );
});

test("状态徽章不再回退到硬编码的浅色主题色值", () => {
  // 直接盯住这次修掉的具体写法：带 #hex fallback 的 var()
  const targets = ["components/admin/MediaGrid.tsx", "components/admin/StoragePanel.tsx"];
  for (const rel of targets) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    // 去掉注释再查，避免把"解释这个 bug"的注释本身当成 bug
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const bad = [...code.matchAll(/var\(--[\w-]+,\s*#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]);
    assert.deepEqual(bad, [], rel + " 仍有带硬编码色值的 var() 回退：" + bad.join(", "));
  }
});

/**
 * 类名完整性：className 里用到的类必须在 CSS 里真的定义过。
 *
 * 与上面令牌那条同源：StoragePanel 一直写着 className="card"，
 * 而 .card 从未定义，且没有行内 border/background 兜底 ——
 * 结果这个面板渲染成一块没有边框的裸内容，和旁边用 Card 组件的区块不齐。
 * 类名写错不会报错，只会"看起来差点意思"，所以更值得上锁。
 *
 * 只检查**静态** className（模板串与三元拼接的结果无法静态判定，
 * 那类引用在这里会被跳过，属于已知覆盖边界）。
 */
test("静态 className 用到的类都有对应样式", () => {
  const cssText = allCss();
  const definedClasses = new Set([...cssText.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

  /**
   * 已知不属于本仓 CSS 的类：
   *   - prev / brand-avatar 属前台既有问题（.prev 在 app/[slug]，.brand-avatar
   *     在 Avatar），不在后台重构范围内，先登记在这里而不是让测试长期红着
   *     （长期红的测试等于没有测试）。
   */
  const KNOWN_FRONTEND = new Set(["prev", "brand-avatar"]);

  const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components"))];
  const missing: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/className="([^"{}]+)"/g)) {
      for (const cls of m[1].split(/\s+/).filter(Boolean)) {
        if (definedClasses.has(cls) || KNOWN_FRONTEND.has(cls)) continue;
        missing.push(path.relative(ROOT, file).replace(/\\/g, "/") + " -> ." + cls);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], "以下类名没有对应样式：\n" + [...new Set(missing)].join("\n"));
});

/* ══════════════════════════════════════════════════════════════════
   C-1：令牌反向断言 —— 定义了就必须有人用
   ══════════════════════════════════════════════════════════════════ */

/**
 * 上面那条测的是「引用了没定义」（fallback 静默接管）；
 * 这条测的是反过来：「定义了没人用」。
 *
 * 58 个零引用 token 的特征是：名字看起来像一套完整的设计系统
 * （`--space-0…10`、`--radius-xs…pill`、`--fs-2xs…2xl`、`--btn-*`、
 * `--field-*`、`--table-*`、`--skeleton-*`、`--toast-*`），实际 `var()`
 * 引用 **0 处**。危害不是"多几行" —— 而是让后来者**以为这套刻度已经
 * 建立好了**，于是新代码照着名字用 `var(--space-5)`，而它其实只是个
 * 没人维护的孤岛值（改了不会影响任何地方，不改也不会有任何地方坏）。
 *
 * 这类"假抽象"比没有抽象更糟：它会让人花时间去找根本不存在的约束。
 */

/**
 * 允许「定义了但零引用」的令牌。
 *
 * 白名单分两类，都写清楚了理由 —— 白名单必须是**穷举且有据**的，
 * 否则它就会变成"新加死 token 的通行证"。
 */
const ALLOWED_UNREFERENCED = new Map<string, string>([
  // ① 主题令牌：由设计意图保留，且会被下面这些方式引用：
  //    - 通过 CSS 变量在其它样式表里间接使用（admin.css / friends.css）
  //    - 供用户在 DevTools 里调参
  //    - 暗色块里重新赋值（`:root[data-theme=dark] { --bg: … }`），
  //      这种"定义"本身就是引用链的一环
  ["--bg", "主题基色，暗色块重新赋值"],
  ["--bg-subtle", "主题基色"],
  ["--bg-warm", "主题基色"],
  ["--bg-tint", "主题基色"],
  ["--text-p0", "文字层级"],
  ["--text-p1", "文字层级"],
  ["--text-p2", "文字层级"],
  ["--text-p3", "文字层级"],
  ["--text-p4", "文字层级"],
  ["--border", "边框"],
  ["--border-strong", "边框"],
  ["--link", "主色"],
  ["--link-hover", "主色"],
  ["--accent", "强调色"],
  ["--accent-soft", "强调色"],
  ["--code-bg", "代码底色"],
  ["--card-bg", "卡片底色"],
  ["--danger", "语义色"],
  ["--danger-bg", "语义色"],
  ["--danger-border", "语义色"],
  ["--ok", "语义色"],
  ["--ok-bg", "语义色"],
  ["--ok-border", "语义色"],
  ["--warn", "语义色"],
  ["--warn-bg", "语义色"],
  ["--warn-border", "语义色"],
  ["--info", "语义色"],
  ["--info-bg", "语义色"],
  ["--info-border", "语义色"],
  ["--surface-2", "浮层底色"],
  ["--lift-1", "阴影"],
  ["--lift-2", "阴影"],
  ["--radius", "圆角（历史名，已被大量使用）"],
  ["--fs", "根字号"],
  ["--fw-body", "正文字重"],
  ["--font-sans", "字体"],
  ["--font-serif", "字体"],
  ["--font-mono", "字体"],
  ["--ease", "动效曲线"],
  ["--spring-snap", "动效曲线"],
  ["--spring-pop", "动效曲线"],
  ["--tap", "触控热区"],
  ["--tap-lg", "触控热区"],
  ["--safe-bottom", "安全区"],
  ["--safe-top", "安全区"],
  ["--w-main", "布局"],
  ["--w-side", "布局"],
  ["--w-toc", "布局"],
  ["--w-read", "布局（B-2 新增）"],
  ["--w-shell", "布局（B-2 新增）"],
  ["--w-shell-narrow", "布局（B-2 新增）"],
  ["--w-shell-read", "布局（B-2 新增）"],
  ["--gap-col", "布局"],
  ["--sticky-top", "布局（A-4 新增）"],
  // ② 分类色：由 categoryColor() 在运行时读（见 lib/posts.ts）
  ["--cat-1", "分类色"], ["--cat-1-bg", "分类色"],
  ["--cat-2", "分类色"], ["--cat-2-bg", "分类色"],
  ["--cat-3", "分类色"], ["--cat-3-bg", "分类色"],
  ["--cat-4", "分类色"], ["--cat-4-bg", "分类色"],
  ["--cat-5", "分类色"], ["--cat-5-bg", "分类色"],
  ["--cat-6", "分类色"], ["--cat-6-bg", "分类色"],
  ["--cat-7", "分类色"], ["--cat-7-bg", "分类色"],
  // ③ 后台专用（admin.css）：同样零引用，但**不在 C-1 范围**
  //    （C-1 只清 globals.css 的 58 个）。登记在此以免测试长期红着，
  //    待后台样式治理时一并处理。见下方"已知遗留"。
  ["--fx-line-ink", "后台：零引用，待后台样式治理时清理"],
]);

/** 只在暗色块里被重新赋值、从未被 var() 读取的 token 名 */
function assignedInThemeBlocks(cssText: string): Set<string> {
  const out = new Set<string>();
  // 粗略但够用：在 :root[data-theme=dark] 与 @media (prefers-color-scheme: dark) 之后的名字
  for (const m of cssText.matchAll(/--([\w-]+)\s*:/g)) out.add("--" + m[1]);
  return out;
}

test("C-1 每个被定义的令牌都必须真的有人用（防止假抽象）", () => {
  const cssText = allCss();
  const defined = [...definedTokens(cssText)];
  const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components")), ...walk(path.join(ROOT, "lib"))];

  // 收集全项目的 var(--x) 引用
  const referenced = new Set<string>();
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/var\((--[\w-]+)/g)) referenced.add(m[1]);
  }

  const dead: string[] = [];
  for (const t of defined) {
    if (referenced.has(t)) continue;
    if (ALLOWED_UNREFERENCED.has(t)) continue;
    dead.push(t);
  }

  assert.deepEqual(
    dead,
    [],
    "以下令牌定义了但从未被 var() 引用 —— 属于「假抽象」：名字看起来像设计系统，" +
      "实际改了不影响任何地方。要么用起来，要么删掉；确需保留请加进 ALLOWED_UNREFERENCED 并写清理由。\n  " +
      dead.join("\n  ")
  );
});

test("C-1 白名单里的令牌必须真的存在（防止白名单腐烂）", () => {
  /**
   * 反例守卫：白名单只增不减会慢慢变成"死 token 的收容所"。
   * 每一条都必须对应一个真实存在的定义 —— 删了令牌就得从白名单里删掉名字。
   */
  const defined = definedTokens(allCss());
  const missing = [...ALLOWED_UNREFERENCED.keys()].filter((t) => !defined.has(t));
  assert.deepEqual(
    missing,
    [],
    "白名单里有令牌已经不存在了（应同步删除白名单条目）：\n  " + missing.join("\n  ")
  );
});
