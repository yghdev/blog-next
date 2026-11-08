import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 栅格系统（2026-11-08）。
 *
 * ## 为什么栅格化要配一个测试文件
 *
 * 栅格化最容易退化成两种东西：
 *   1. **一份文档** —— 写了 12 列、8px 节奏，但代码里没人遵守；
 *   2. **一堆令牌** —— 名字看起来像设计系统，实际零引用（C-1 清理过的
 *      「假抽象」，`--space-0…10` 当时正是被删的那批）。
 *
 * 所以这个文件只守**在代码里成立的事实**：
 *   · 间距刻度真的存在，且 `--space-N === N×4px`（前台）；
 *   · 后台的 9 档 `--fx-s*` 真的是前台刻度的别名，映射逐档正确，
 *     且后台没有再手写一遍像素值（那正是要消灭的第二份事实来源）；
 *   · 前后台共用一套 12 列契约，并且**确实有块在用**（不是只写在文档里）；
 *   · 叠加层只在 `html[data-grid="1"]` 下生效，且不挡点击；
 *   · 文档存在 —— 否则下一个人只能靠读 CSS 猜约定。
 *
 * 浏览器层面的验证（真的对齐了没有、开了叠加层会不会位移）在
 * tests/grid-alignment.mjs，那里需要真实 Chromium。
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const GLOBALS = read("app/globals.css");
const FRIENDS = read("app/friend-links/friends.css");
const ADMIN = read("app/admin/admin.css");

/** 去掉注释，避免把「解释这个 bug」的注释本身当成 bug（与其它测试同一口径） */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

const CSS_GLOBALS = strip(GLOBALS);
const CSS_FRIENDS = strip(FRIENDS);
const CSS_ADMIN = strip(ADMIN);

/** 取 :root { … } 主令牌块（按大括号配平，避免被嵌套块截断） */
function rootBlock(src: string): string {
  const start = src.indexOf(":root {");
  assert.ok(start >= 0, "找不到 :root 令牌块");
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(":root 块未闭合");
}

const ROOT_BLOCK = rootBlock(CSS_GLOBALS);

/* ────────────────────────── 间距刻度 ────────────────────────── */

test("栅格化：--space-N 的值必须等于 N×4px（4px 基准刻度）", () => {
  /**
   * 命名规则就是约定本身：`--space-7` 是 28px 而不是 7px。
   * 一旦有人写成 `--space-7: 32px`，后台 28px 的档位（--fx-s6）会连带错位，
   * 而且错得"看起来很正常"—— 所以逐档算一遍。
   */
  const SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 18, 24];
  const bad: string[] = [];
  for (const n of SIZES) {
    const m = ROOT_BLOCK.match(new RegExp("--space-" + n + ":\\s*([0-9.]+)px"));
    if (!m) { bad.push("--space-" + n + " 未定义"); continue; }
    if (Number(m[1]) !== n * 4) bad.push("--space-" + n + " = " + m[1] + "px，应为 " + n * 4 + "px");
  }
  assert.deepEqual(bad, [], "间距刻度与 4px 基准不一致：\n  " + bad.join("\n  "));
});

test("栅格化：--grid-gutter / --grid-ruler 存在且语义正确", () => {
  // 骨架栅距是 --gap-col(40)，内容栅距是 --grid-gutter(24)：两件事，别混用
  assert.match(ROOT_BLOCK, /--grid-gutter:\s*24px/, "内容栅格栅距应为 24px（与骨架 --gap-col:40px 分开）");
  assert.match(ROOT_BLOCK, /--grid-ruler:\s*8px/, "叠加层纵向刻度应为 8px");
});

test("栅格化：每个 --space-* 都必须真的有人用（防假抽象）", () => {
  /**
   * 与 design-tokens.test.ts 的 C-1 同源：定义了没人用 = 假装有设计系统。
   * 这里只盯刻度，因为它们是本轮新增的；任何一个零引用都说明
   * 「计划里说要替换，实际没替换」。
   */
  const defined = [...ROOT_BLOCK.matchAll(/(--space-[0-9]+)\s*:/g)].map((m) => m[1]);
  assert.ok(defined.length >= 10, "刻度数量异常，实际 " + defined.length + " 个");
  const all = CSS_GLOBALS + CSS_FRIENDS + CSS_ADMIN;
  const dead = defined.filter((t) => !all.includes("var(" + t + ")"));
  assert.deepEqual(dead, [], "以下刻度定义了但零引用（要么用起来，要么删掉）：" + dead.join(", "));
});

test("栅格化：前台被锁定的布局值必须走令牌（同源而非手抄）", () => {
  /**
   * --sticky-top 与 .site-shell 的 padding-top 在注释里写着「必须相等」。
   * 两处手抄 48 的时候，这条约定只能靠人记住；改成同一个令牌之后
   * 它变成结构性事实 —— 这条断言就是为了不让它退回手抄。
   */
  assert.match(ROOT_BLOCK, /--sticky-top:\s*var\(--space-12\)/, "--sticky-top 应引用 --space-12（48px）");
  assert.match(
    CSS_GLOBALS,
    /\.site-shell\s*\{[^}]*padding:\s*var\(--space-12\)\s+var\(--space-8\)\s+var\(--space-24\)/s,
    ".site-shell 的 padding 应使用刻度令牌（48/32/96）"
  );
});

/* ─────────────── 前后台共用一套刻度（--fx-s* 别名） ─────────────── */

test("栅格化：后台 9 档间距是前台刻度的别名（映射逐档正确）", () => {
  /**
   * 这是「不只是前端」的核心：后台原来自己写了一套 4px 刻度（--fx-s1..s9），
   * 与前台的字面量互不相干 —— 改一处不会影响另一处。
   *
   * 现在后台的值由前台 :root 提供，后台只保留「第几档」这个名字。
   * ⚠️ 编号不对应（--fx-s6 = --space-7），所以必须逐档钉死：
   * 这是最容易抄错、且错了以后「整页都差 4px」的地方。
   */
  const MAP: [number, string][] = [
    [1, "--space-1"], [2, "--space-2"], [3, "--space-3"], [4, "--space-4"],
    [5, "--space-5"], [6, "--space-7"], [7, "--space-10"], [8, "--space-14"], [9, "--space-18"],
  ];
  const adminRoot = rootBlock(CSS_ADMIN);
  const bad: string[] = [];
  for (const [n, target] of MAP) {
    const re = new RegExp("--fx-s" + n + ":\\s*var\\(" + target + "\\)");
    if (!re.test(adminRoot)) {
      const got = adminRoot.match(new RegExp("--fx-s" + n + ":\\s*([^;]+);"));
      bad.push("--fx-s" + n + " 应为 var(" + target + ")，实际 " + (got ? got[1].trim() : "未定义"));
    }
  }
  assert.deepEqual(bad, [], "后台刻度与前台刻度的映射不对：\n  " + bad.join("\n  "));
});

test("栅格化：后台不得再手写间距像素（消灭第二份事实来源）", () => {
  /**
   * 别名做完之后，后台 :root 里任何 --fx-sN: 12px 都是旧的第二份事实来源，
   * 一旦留着就会在别人改前台刻度时"看起来没坏，其实没生效"。
   */
  const adminRoot = rootBlock(CSS_ADMIN);
  const literals = [...adminRoot.matchAll(/--fx-s[1-9]:\s*([0-9.]+)px/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], "后台 :root 仍有像素字面量（应改为 var(--space-*)）：" + literals.join(", "));
});

test("栅格化：后台骨架参数已令牌化（232 / 1320 / 1440）", () => {
  const adminRoot = rootBlock(CSS_ADMIN);
  assert.match(adminRoot, /--fx-sidebar-w:\s*232px/, "侧栏轨道应令牌化");
  assert.match(adminRoot, /--fx-content-max:\s*1320px/, "内容上限应令牌化");
  assert.match(adminRoot, /--fx-content-max-wide:\s*1440px/, "宽屏内容上限应令牌化");
  assert.match(CSS_ADMIN, /\.admin-shell\s*\{[^}]*var\(--fx-sidebar-w\)/s, ".admin-shell 应使用 --fx-sidebar-w");
  assert.match(CSS_ADMIN, /\.admin-main\s*\{[^}]*max-width:\s*var\(--fx-content-max\)/s, ".admin-main 应使用 --fx-content-max");
});

/* ────────────────────────── 12 列契约 ────────────────────────── */

test("栅格化：12 列契约在前后台都有真实消费者（不是只写在文档里）", () => {
  /**
   * 等宽并列块统一写成 `repeat(12, minmax(0,1fr))` + `grid-column: span K`。
   * 这些转换在视觉上是**零变化**的（span 6+6 与 1fr 1fr 数学等价），
   * 价值在于：以后要 8+4、4+4+4 时不用再发明一套列宽。
   * 若哪天有人把它们改回 repeat(N, 1fr)，这条会红。
   */
  const twelve = (css: string) => [...css.matchAll(/repeat\(12,\s*minmax\(0,\s*1fr\)\)/g)].length;

  assert.ok(twelve(CSS_GLOBALS) >= 1, "前台应至少有一处 12 列栅格（.stat-grid）");
  assert.ok(twelve(CSS_FRIENDS) >= 1, "友链页应有一处 12 列栅格（.fr-grid）");
  assert.ok(twelve(CSS_ADMIN) >= 1, "后台应至少有一处 12 列栅格（.conflict-grid）");

  assert.match(CSS_GLOBALS, /\.stat-cell\s*\{[^}]*grid-column:\s*span 6/s, ".stat-cell 应占 6 列");
  assert.match(CSS_FRIENDS, /\.fr-card\s*\{[^}]*grid-column:\s*1 \/ -1/s, ".fr-card 基底应占满 12 列");
  assert.match(
    CSS_FRIENDS,
    /@container[^{]*\{[^@]*?\.fr-grid \.fr-card\s*\{[^}]*grid-column:\s*span 6/s,
    "容器 ≥620px 时 .fr-card 应改占 6 列（且特异性要压过基底规则）"
  );
  assert.match(CSS_ADMIN, /\.conflict-col\s*\{[^}]*grid-column:\s*span 4/s, ".conflict-col 应占 4 列");
});

test("栅格化：并列块的栅距走 --grid-gutter，而不是各自写字面量", () => {
  /**
   * 12 列只是"怎么分"，栅距是"分多开"。三处的密度本来就不同
   * （统计 8 / 友链 10 / 冲突 12），所以允许局部覆盖 --grid-gutter ——
   * 但**不允许**再把 gap: 8px 直接写在栅格容器上，那会让
   * 「全局栅距」这个概念形同虚设。
   */
  for (const [file, cls] of [
    [CSS_GLOBALS, "stat-grid"],
    [CSS_FRIENDS, "fr-grid"],
    [CSS_ADMIN, "conflict-grid"],
  ] as const) {
    const idx = file.indexOf("." + cls + " {");
    assert.ok(idx >= 0, "找不到 ." + cls);
    const block = file.slice(idx, file.indexOf("}", idx) + 1);
    assert.match(block, /gap:\s*var\(--grid-gutter\)/, "." + cls + " 的 gap 应引用 --grid-gutter：" + block.replace(/\s+/g, " "));
    assert.match(block, /--grid-gutter:\s*/, "." + cls + " 应局部覆盖 --grid-gutter（保持原密度）");
  }
});

/* ────────────────────────── 叠加层 ────────────────────────── */

/** 取出所有「选择器 { … }」块，返回 { selector, body } 列表（只处理单层，够用） */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

const GUARD = 'html[data-grid="1"]';

test("栅格化：叠加层规则必须全部挂在 html[data-grid=\"1\"] 下", () => {
  /**
   * 叠加层是**调试态**：不带参数时不能有任何痕迹。
   * 如果哪条规则漏了前缀，所有人都会看到 12 条半透明色带（而且不会报错），
   * 这是最容易在重构里发生的事故。
   */
  const all = [...rules(CSS_GLOBALS), ...rules(CSS_ADMIN)];
  const overlayRules = all.filter((r) => r.selector.includes("data-grid"));
  assert.ok(overlayRules.length >= 4, "叠加层规则数量异常，实际 " + overlayRules.length);

  const unguarded = overlayRules.filter((r) => !r.selector.includes(GUARD));
  assert.deepEqual(unguarded, [], "叠加层规则必须挂 " + GUARD + "：" + unguarded.map((r) => r.selector).join(" | "));

  // 不允许存在"没有前缀的 .content::before / .admin-main::before"（那等于常驻叠加层）
  for (const [css, sel] of [
    [CSS_GLOBALS, ".content::before"],
    [CSS_ADMIN, ".admin-main::before"],
  ] as const) {
    for (const r of rules(css)) {
      if (!r.selector.includes(sel)) continue;
      assert.ok(r.selector.includes(GUARD), sel + " 存在未加 data-grid 前缀的规则：" + r.selector);
    }
  }
});

test("栅格化：叠加层不挡点击、不参与布局", () => {
  const all = [...rules(CSS_GLOBALS), ...rules(CSS_ADMIN)].filter((r) => r.selector.includes("data-grid"));
  for (const r of all) {
    if (!r.body.includes("content:")) continue; // 只检查画出来的那个伪元素
    assert.match(r.body, /position:\s*absolute/, "叠加层必须是绝对定位（不参与布局）：" + r.selector);
    assert.match(r.body, /pointer-events:\s*none/, "叠加层不能挡点击：" + r.selector);
  }
  // position: relative 也必须在调试态下才加（否则改变绝对定位包含块）
  for (const r of rules(CSS_GLOBALS)) {
    if (!/position:\s*relative/.test(r.body)) continue;
    if (!r.selector.includes(".content")) continue;
    assert.ok(r.selector.includes(GUARD), ".content 的 position:relative 只应在调试态加：" + r.selector);
  }
});

test("栅格化：叠加层小屏切 4 列（12 列在手机上不可读）", () => {
  for (const [css, label] of [[CSS_GLOBALS, "前台"], [CSS_ADMIN, "后台"]] as const) {
    assert.ok(
      css.includes("calc((100% + var(--grid-gutter)) / 4)"),
      label + "叠加层应在 ≤820px 切成 4 列"
    );
  }
});

test("栅格化：GridOverlay 组件不写内联样式、不注入脚本", () => {
  /**
   * 两条都是既有约束：
   *   · 前台内联样式只剩 2 处（tests/inline-styles.test.ts）；
   *   · 内联 script 要维护 CSP 白名单（ThemeScript 是唯一例外）。
   * 叠加层没有理由付这两个代价。
   */
  const src = read("components/GridOverlay.tsx");
  assert.ok(src.includes('"use client"'), "GridOverlay 必须是客户端组件（要读 location）");
  assert.equal((src.match(/style=\{\{/g) || []).length, 0, "GridOverlay 不应写内联样式");
  assert.equal((src.match(/dangerouslySetInnerHTML/g) || []).length, 0, "GridOverlay 不应注入内联脚本");
  assert.ok(src.includes("data-grid"), "GridOverlay 应通过 data-grid 属性开关");
  // 只认 grid=1：模糊语义会让"怎么关"变成运气
  assert.match(src, /get\("grid"\) === "1"/, "只认 ?grid=1");
});

test("栅格化：契约文档存在，且写到了前后台与验证方式", () => {
  /**
   * 文档是这个系统的一半 —— 没有它，下一个人只会看到一堆 12 和 span。
   * 只断言小节标题存在，不断言正文（正文会演进，标题是骨架）。
   */
  const docPath = path.join(ROOT, "docs/grid-system.md");
  assert.ok(fs.existsSync(docPath), "缺少 docs/grid-system.md");
  const doc = fs.readFileSync(docPath, "utf8");
  for (const heading of ["## 1. 三层模型", "## 2. 前台", "## 3. 后台", "## 4. 例外登记", "## 5. 验证"]) {
    assert.ok(doc.includes(heading), "文档缺少小节：" + heading);
  }
});
