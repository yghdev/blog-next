import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 站点骨架单源（B-1，2026-11-01）。
 *
 * ## 为什么
 *
 * 7 个页面各自拼同样的四行结构：
 *
 *     <div className="site-shell">
 *       <Sidebar />
 *       <main className="content">…</main>
 *       <div className="toc-col"><RightBar /></div>   ← 有的页面有、有的没有
 *     </div>
 *
 * 于是出现两类错配：
 *   • **搜索页**拼了三列网格却没写第三列 → 1440px 下右侧空出 320px；
 *   • 将来新增页面时，"要不要右栏"靠人记，忘了就错配。
 *
 * 收敛到 `<SiteShell variant="…">` 之后，"有没有右栏"由 variant 决定，
 * 结构错配在类型上就不可能发生。
 *
 * ## 这个文件守什么
 *
 * 静态检查（读源码），比"页面 200 了就算过"严格：
 *   ① 7 个调用点都不许再手写 site-shell / toc-col；
 *   ② variant 用法必须与"该页有没有右栏"一致；
 *   ③ 只有文章页传 toc。
 *
 * 渲染结果由 `tests/layout-regression.mjs` 断言（搜索页不再空 320 等）。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** 七个骨架调用点，及其应有的 variant 与是否传 toc */
const CALL_SITES: { file: string; variant: "three-col" | "wide"; toc: boolean; note: string }[] = [
  { file: "app/page.tsx", variant: "three-col", toc: false, note: "首页" },
  { file: "app/archives/page.tsx", variant: "three-col", toc: false, note: "归档" },
  { file: "app/shuoshuo/page.tsx", variant: "three-col", toc: false, note: "说说" },
  { file: "app/tags/[tag]/page.tsx", variant: "three-col", toc: false, note: "标签" },
  { file: "components/ArticleView.tsx", variant: "three-col", toc: true, note: "文章（唯一传 toc 的）" },
  { file: "app/search/page.tsx", variant: "wide", toc: false, note: "搜索（原来三列却空着右栏）" },
  { file: "app/friend-links/page.tsx", variant: "wide", toc: false, note: "友链（宽版）" },
];

test("B-1 组件存在且是服务端组件（无 use client）", () => {
  const src = read("components/SiteShell.tsx");
  // C-9 起 SiteShell 是 async（要 await getSettingsCached 取品牌信息）
  assert.match(src, /export (async )?function SiteShell/, "应导出 SiteShell（async 或同步均可）");
  assert.doesNotMatch(src, /^"use client"/m, "SiteShell 应是服务端组件，不加 use client");
  for (const prop of ["variant", "toc", "className", "children"]) {
    assert.ok(src.includes(prop), "SiteShell 应支持 " + prop + " 参数");
  }
});

test("B-1 七个调用点都改用 SiteShell，不再手写骨架", () => {
  const problems: string[] = [];
  for (const site of CALL_SITES) {
    const src = read(site.file);
    if (!src.includes("<SiteShell")) {
      problems.push(site.file + "（" + site.note + "）没有使用 <SiteShell>");
      continue;
    }
    // 不许再手写这两个类（SiteShell 内部才写）
    if (/className="site-shell/.test(src)) {
      problems.push(site.file + " 仍然手写 className=\"site-shell…\"");
    }
    if (/className="toc-col"/.test(src)) {
      problems.push(site.file + " 仍然手写 <div className=\"toc-col\">");
    }
  }
  assert.deepEqual(problems, [], "骨架未收敛：\n  " + problems.join("\n  "));
});

test("B-1 variant 用法与「该页有没有右栏」一致", () => {
  const problems: string[] = [];
  for (const site of CALL_SITES) {
    const src = read(site.file);
    const m = src.match(/<SiteShell([^>]*)>/s);
    if (!m) continue;
    const attrs = m[1];
    const vm = attrs.match(/variant="([^"]+)"/);
    const variant = vm ? vm[1] : "three-col"; // 默认 three-col
    if (variant !== site.variant) {
      problems.push(site.file + "（" + site.note + "）variant 应为 " + site.variant + "，实际 " + variant);
    }
  }
  assert.deepEqual(problems, [], "variant 用法有误：\n  " + problems.join("\n  "));
});

test("B-1 只有文章页传 toc，其他页面不得传", () => {
  const problems: string[] = [];
  for (const site of CALL_SITES) {
    const src = read(site.file);
    const m = src.match(/<SiteShell([^>]*)>/s);
    if (!m) continue;
    const hasToc = /\btoc=\{/.test(m[1]);
    if (hasToc !== site.toc) {
      problems.push(site.file + "（" + site.note + "）toc 应为 " + (site.toc ? "传" : "不传") + "，实际 " + (hasToc ? "传了" : "没传"));
    }
  }
  assert.deepEqual(problems, [], "toc 传参有误：\n  " + problems.join("\n  "));
});

test("B-1/B-4 友链页不再需要 fr-main（B-4 移除所有相关样式后成为死类）", () => {
  /**
   * B-1 时友链页还传 `className="fr-main"`，因为 friends.css 用它写
   * `max-width: 960px`。B-4 把几何全部交给全局令牌后，这个类没有任何
   * 样式了 —— 留着既误导人，也会让 design-tokens 的「类名必须有样式」
   * 检查报红。所以 B-4 把它一并删掉。
   */
  const page = read("app/friend-links/page.tsx");
  const css = read("app/friend-links/friends.css");
  assert.doesNotMatch(page, /className="fr-main"/, "友链页不应再传 fr-main");
  assert.doesNotMatch(css, /\.fr-main\s*\{/, "friends.css 不应再有 .fr-main 规则");
});

test("B-1 SearchBox 已支持 initial（搜索页要复用它）", () => {
  const src = read("components/SearchBox.tsx");
  assert.match(src, /initial/, "SearchBox 应支持 initial 参数");
});
