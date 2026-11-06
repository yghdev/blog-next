import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 关于页（D-2 起；2026-11-06 改为**静态页**）。
 *
 * ## 为什么从"数据库 page 记录"改成"仓库里的 md"
 *
 * 之前 `/about` 读 `posts` 表里 `type=page, slug=about` 的记录。带来的问题：
 *
 *   1. 全新安装 / 演示库没有这条记录时整页 404（实测预览环境就是 404）；
 *   2. 它是导航里唯一依赖库内容的页面，和归档 / 说说 / 友链这些静态页
 *      不是同一种东西，版式也因此分叉（专属 hero vs 标准页面标题）。
 *
 * 现在与它们同构：内容来自 `content/pages/about.md`（不查库），
 * 版式是 `PageHeader + .prose`，右栏是标准完整版。
 *
 * ## 仍然保留的约束（D.4 红线）
 *
 * 「关于页的文案必须来自 `content/pages/about.md`，不允许写死在组件里」——
 * 这条现在更严格了：页面根本不再有"组件里写文案"的可能，它只负责读文件、
 * 渲染 Markdown。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("D-2 关于页是独立路由，且不再查库", () => {
  const f = path.join(ROOT, "app/about/page.tsx");
  assert.ok(fs.existsSync(f), "应有 app/about/page.tsx");
  const src = read("app/about/page.tsx");
  assert.match(src, /export const dynamic = "force-dynamic"/, "应与其它前台页面一致，按请求实时渲染");
  assert.match(src, /content",\s*"pages",\s*"about\.md"/, "应从 content/pages/about.md 读取内容");
  assert.doesNotMatch(
    src,
    /getPageBySlugCached|getPageBySlug\b/,
    "不应再依赖 posts 表里的 page 记录（演示库/全新安装没有这条记录）"
  );
});

test("D-2 版式与其它静态页一致（PageHeader + prose，无专属 hero）", () => {
  const src = read("app/about/page.tsx");
  assert.match(src, /<PageHeader title="关于"/, "应使用统一的 PageHeader");
  assert.match(src, /className="prose"/, "正文应走 .prose（与归档/说说的正文同一套排版）");
  assert.doesNotMatch(src, /about-hero|AboutView/, "不应再有专属 hero 版式");
});

test("D-2 PageHeader 渲染的是 h1（可访问性）", () => {
  /**
   * 关于页没有文章标题，h1 由 PageHeader 提供。
   * 页面没有 h1 是明确的可访问性缺陷 —— 读屏用户靠它判断"这是什么页"。
   */
  const src = read("components/PageHeader.tsx");
  assert.match(src, /<h1\b/, "PageHeader 应输出 h1");
});

test("D-2 about.md 的章节结构与需求对应", () => {
  const md = read("content/pages/about.md");
  // 7.2 个人介绍（开头两段）
  assert.match(md, /^你好，我是 flechazo。/m, "7.2 应有问候语");
  assert.match(md, /喜欢折腾技术、探索新事物/, "7.2 应有一句个人介绍");
  // 7.3 关注方向
  assert.match(md, /## 我在关注什么/, "7.3 应有「我在关注什么」一节");
  for (const dir of ["AI & Artificial Intelligence", "Development & Programming", "Self-hosting", "Open Source"]) {
    assert.ok(md.includes(dir), "7.3 应有方向：" + dir);
  }
  // 7.4 正在做的事
  assert.match(md, /## 我在做什么/, "7.4 应有「我在做什么」一节");
  // 7.5 本站
  assert.match(md, /## 本站/, "7.5 应有「本站」一节");
  // 7.6 联系
  assert.match(md, /## 联系/, "7.6 应有「联系」一节");
});

test("D-2 技术架构描述必须与代码事实一致（需求 7.5 硬要求）", () => {
  /**
   * 需求写着「当前项目架构必须通过实际代码确认，不要继续展示已经过时的
   * 技术架构介绍」。所以这里拿 md 里写的东西去对 package.json
   * 与实际实现，防止文案与代码漂移。
   */
  const md = read("content/pages/about.md");
  const pkg = JSON.parse(read("package.json"));

  assert.ok(md.includes("Next.js"), "应写明 Next.js（实际依赖：" + pkg.dependencies.next + "）");
  assert.ok(md.includes("SQLite"), "应写明 SQLite（实际依赖：better-sqlite3 " + pkg.dependencies["better-sqlite3"] + "）");
  assert.ok(md.includes("marked"), "应写明 marked（实际依赖：" + pkg.dependencies.marked + "）");
  assert.ok(md.includes("Artalk"), "应写明 Artalk（实际评论系统）");
  assert.ok(md.includes("standalone"), "应写明 standalone 部署（next.config 里 output: standalone）");

  // 不得再出现已废弃的架构描述
  assert.ok(!/WordPress\s*(为主|驱动|搭建)/.test(md), "不应再宣称由 WordPress 驱动（早已迁走）");
  assert.ok(!md.includes("Halo"), "本项目从未用过 Halo，不应出现");
});

test("D-2 联系方式必须真实存在（不得凭空生成）", () => {
  const md = read("content/pages/about.md");
  // settings 里没有 email / github 字段，所以不应出现具体邮箱或 GitHub 用户名
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(md), "不应凭空写邮箱地址（settings 里没有该字段）");
  assert.ok(!/github\.com\/\w+/i.test(md), "不应凭空写 GitHub 地址");
  // 真实存在的渠道：评论区 + 友链页
  assert.ok(md.includes("留言") || md.includes("评论"), "应保留「在文章下方留言」");
  assert.ok(md.includes("/friend-links"), "应保留友链页链接");
});
