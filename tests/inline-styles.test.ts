import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 前台内联样式改语义类（C-5，2026-11-01）。
 *
 * ## 为什么内联样式值得治理
 *
 * 前台有 13 处 `style={{…}}`。其中绝大多数写的是：
 *
 *     style={{ fontSize: ".78rem", color: "var(--text-p4)", margin: "6px 0 4px" }}
 *
 * 这有两个问题：
 *   1. **改版时无法统一调** —— 想把归档页的月份标签从 .78rem 调到 .8rem，
 *      要在 JSX 里找字符串，而不是改一处 CSS；
 *   2. **优先级过高** —— 内联样式的特异性高于任何类，以后想用媒体查询
 *      在移动端覆盖它都做不到（除非再写 !important）。
 *
 * ## 口径（与路线图一致）
 *
 * 13 = `app/`（非 `app/admin/`）+ `components/`（非 `components/admin/`、
 * 非 `components/ui/`）里的 `style={{` 计数。后台 28 处与 ui 7 处不在本次范围。
 *
 * ## 保留 2 处：分类色
 *
 * `categoryColor()` 返回的 `fg`/`bg` 是**运行时数据驱动**的（7 个分类，
 * 颜色来自数据）。改成 class 需要在渲染期动态生成 CSS 或用 7 个静态类 ——
 * 前者要注入 style 标签，后者把颜色绑死在代码里。保留内联是更合理的选择
 * （Q5 默认方案）。
 */

const ROOT = process.cwd();

/** 前台文件（排除 admin / ui） */
function frontendFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "dist", ".git"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "admin" || e.name === "ui") continue;
        walk(p);
      } else if (/\.tsx$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "components"));
  return out;
}

/** 数一个文件里的 style={{ 出现次数 */
function countInline(file: string): number {
  const text = fs.readFileSync(file, "utf8");
  return (text.match(/style=\{\{/g) || []).length;
}

test("C-5 前台内联样式从 13 处降到 2 处", () => {
  const offenders: string[] = [];
  let total = 0;
  for (const f of frontendFiles()) {
    const n = countInline(f);
    if (n > 0) {
      total += n;
      offenders.push(path.relative(ROOT, f).replace(/\\/g, "/") + " (" + n + ")");
    }
  }
  assert.equal(
    total,
    2,
    "前台内联样式应只剩 2 处（ArticleView 与 PostCard 的分类色），实际 " + total + " 处：\n  " +
      offenders.join("\n  ")
  );
  assert.equal(offenders.length, 2, "这两处应分别在 ArticleView 与 PostCard，实际分布在：" + offenders.join(", "));
});

test("C-5 剩下的两处必须都是分类色（数据驱动，允许内联）", () => {
  /**
   * 反例守卫：如果有人为了"凑够 2 处"随便留两个别的内联样式，这条会红。
   */
  const allowed = ["components/ArticleView.tsx", "components/PostCard.tsx"];
  for (const rel of allowed) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const matches = [...text.matchAll(/style=\{\{([^}]*)\}\}/g)].map((m) => m[1]);
    assert.equal(matches.length, 1, rel + " 应恰好有 1 处内联样式，实际 " + matches.length);
    const body = matches[0];
    assert.match(body, /col\.fg/, rel + " 的内联样式应是 categoryColor 的 fg");
    assert.match(body, /col\.bg/, rel + " 的内联样式应是 categoryColor 的 bg");
  }
});

test("C-5 新语义类必须都有对应样式", () => {
  /**
   * 抽出来的类不能是"光有名字没有样式"—— 那等于把内联样式删了却没补上，
   * 视觉会直接塌掉（而且不会报错）。
   */
  const css = ["app/globals.css", "app/friend-links/friends.css"]
    .map((p) => fs.readFileSync(path.join(ROOT, p), "utf8"))
    .join("\n");

  const NEW_CLASSES = [
    "notfound", "notfound-title", "notfound-text",
    "search-meta",
    "archive-year-count", "archive-month-group", "archive-month",
    "pager-current",
    "page-sub",   // C-8：标签页的计数改用 <PageHeader sub> 后，排版语义并入这里
    "article-cover",
    "comment-error",
  ];
  const missing = NEW_CLASSES.filter((c) => !new RegExp("\\." + c + "\\b").test(css));
  assert.deepEqual(missing, [], "这些语义类没有对应样式：" + missing.join(", "));
});

test("C-5 归档页不得再写 fontSize 内联（三个位置全部改为类）", () => {
  const text = fs.readFileSync(path.join(ROOT, "app/archives/page.tsx"), "utf8");
  assert.doesNotMatch(text, /style=\{\{/, "归档页不应再有内联样式");
  for (const cls of ["archive-year-count", "archive-month-group", "archive-month"]) {
    assert.match(text, new RegExp('className="' + cls + '"'), "归档页应使用 ." + cls);
  }
});

test("C-5 分页当前页不得再用 pointerEvents 内联禁用点击", () => {
  /**
   * 原来写的是 `<span className="btn btn-sm" style={{ pointerEvents: "none", opacity: .6 }}>`。
   * 用样式禁用点击是**语义错误**：它是当前页，本来就该是 `<span>` 而不是
   * 被"伪装成按钮的禁用元素"。改成 `.pager-current` 类。
   */
  const text = fs.readFileSync(path.join(ROOT, "app/page.tsx"), "utf8");
  assert.doesNotMatch(text, /pointerEvents/, "分页不应再用 pointerEvents 内联");
  assert.match(text, /className="pager-current"/, "分页当前页应使用 .pager-current");
});
