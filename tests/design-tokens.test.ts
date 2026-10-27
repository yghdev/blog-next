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
const GLOBALS = path.join(ROOT, "app", "globals.css");

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
  const defined = definedTokens(fs.readFileSync(GLOBALS, "utf8"));
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
