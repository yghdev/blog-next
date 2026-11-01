import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 抽 `PageHeader` / `EmptyState`（C-8，2026-11-01）。
 *
 * ## 问题
 *
 * `<h1 className="page-title">` 在 4 个页面各写一次；`.empty-block` 那套
 * 三层结构（title / hint / actions）在前台 5 个位置重复，只有文案不同。
 *
 * 重复本身不算大问题，但它让"改一处文案结构"变成"改 5 个文件"：
 * 比如想在空状态里统一加一个图标，得改 5 处 JSX。
 *
 * ## 重要约束：不要动 CSS
 *
 * 后台 `components/admin/ui.tsx:89` 也有一个 `Empty` 组件，用的**同一套
 * `.empty-block` 类**。所以 `EmptyState` 只是把前台 5 处 JSX 收成一个组件，
 * **不新增也不改任何 CSS**，后台零影响。
 *
 * 反过来说：若将来要改 `.empty-block` 的样式，前台和后台会一起变 ——
 * 这是一条要写进文档的红线，不是可以随手改的。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("C-8 两个组件都存在且是服务端组件", () => {
  for (const f of ["components/PageHeader.tsx", "components/EmptyState.tsx"]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), "应存在 " + f);
    const src = read(f);
    assert.doesNotMatch(src, /^"use client"/m, f + " 不需要 use client（纯展示）");
  }
});

test("C-8 EmptyState 的 props 与后台 Empty 对齐（title / hint / actions）", () => {
  /**
   * 前台与后台用同一个 `.empty-block` 类，接口也应当一致 ——
   * 否则改样式的人要记两套参数名。
   */
  const fe = read("components/EmptyState.tsx");
  for (const prop of ["title", "hint", "actions"]) {
    assert.ok(new RegExp("\\b" + prop + "\\b").test(fe), "EmptyState 应支持 " + prop);
  }
  const be = read("components/admin/ui.tsx");
  assert.match(be, /export function Empty\(/, "后台应有 Empty 组件（不应被误改）");
});

test("C-8 前台 empty-block 从 5 处降到 1 处（在 EmptyState 内）", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "dist", ".git"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "admin" || e.name === "ui") continue;
        walk(p);
      } else if (/\.tsx$/.test(e.name)) {
        files.push(p);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "components"));

  const hits: string[] = [];
  for (const f of files) {
    const n = (read(path.relative(ROOT, f)).match(/className="empty-block"/g) || []).length;
    if (n > 0) hits.push(path.relative(ROOT, f).replace(/\\/g, "/") + " (" + n + ")");
  }
  assert.deepEqual(
    hits,
    ["components/EmptyState.tsx (1)"],
    "前台 empty-block 只应出现在 EmptyState 里，实际：" + JSON.stringify(hits)
  );
});

test("C-8 后台的 empty-block 不受影响（仍为 1 处）", () => {
  const be = read("components/admin/ui.tsx");
  assert.equal(
    (be.match(/className="empty-block"/g) || []).length,
    1,
    "后台 admin/ui.tsx 的 empty-block 必须仍是 1 处（本任务不碰后台）"
  );
  // 后台页面里不应出现 EmptyState（那是前台组件）
  const adminFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (/\.tsx$/.test(e.name)) adminFiles.push(path.join(dir, e.name));
    }
  };
  walk(path.join(ROOT, "app", "admin"));
  const used = adminFiles.filter((f) => /EmptyState/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(used, [], "后台不应引用前台 EmptyState：" + used.join(", "));
});

test("C-8 四个页面标题都改用 PageHeader，不得再手写 page-title", () => {
  const pages = [
    "app/search/page.tsx",
    "app/shuoshuo/page.tsx",
    "app/archives/page.tsx",
    "app/tags/[tag]/page.tsx",
  ];
  const problems: string[] = [];
  for (const f of pages) {
    const src = read(f);
    if (!src.includes("<PageHeader")) problems.push(f + " 未使用 PageHeader");
    if (/className="page-title"/.test(src)) problems.push(f + " 仍手写 className=\"page-title\"");
  }
  assert.deepEqual(problems, [], "页面标题未收敛：\n  " + problems.join("\n  "));
});

test("C-8 PageHeader 支持可选的副标题（sub）", () => {
  const src = read("components/PageHeader.tsx");
  assert.match(src, /\bsub\b/, "PageHeader 应支持 sub 参数（副标题）");
});

test("C-8 本任务不得新增或修改 empty-block 相关 CSS", () => {
  /**
   * 反例守卫：`EmptyState` 只是把 JSX 收成一个组件。如果顺手"优化"了
   * `.empty-block` 的样式，后台会跟着变 —— 而本任务明确不碰后台。
   *
   * 判据：`.empty-block` / `.empty-title` / `.empty-hint` / `.empty-actions`
   * 的定义数量与 C-5 结束时相同（各 1 处）。
   */
  // 注意：后台 `.fx-scope .empty-block` 有一整套覆盖（既有设计，不是本任务引入）。
  // 所以判据是"globals 里这几条还是原样"，而不是"全项目只有 1 处"。
  const globals = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
  const EXPECTED = {
    "empty-block": 1,
    "empty-title": 1,
    "empty-hint": 2,   // .empty-hint 本体 + .empty-block .empty-hint
    "empty-actions": 1,
  };
  for (const [cls, want] of Object.entries(EXPECTED)) {
    const n = (globals.match(new RegExp("\\." + cls + "\\s*\\{", "g")) || []).length;
    assert.equal(n, want, "globals 里 ." + cls + " 定义数应为 " + want + "（本任务不动 CSS），实际 " + n);
  }
  // 后台的 fx-scope 覆盖必须还在（不该被本任务碰）
  const admin = fs.readFileSync(path.join(ROOT, "app/admin/admin.css"), "utf8");
  assert.match(admin, /\.fx-scope \.empty-block\s*\{/, "后台的 .fx-scope .empty-block 覆盖应保持原样");
});
