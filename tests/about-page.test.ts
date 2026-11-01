import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 关于页独立路由（D-2，2026-11-01）。
 *
 * ## 为什么新增 `app/about/page.tsx`
 *
 * 需求文档 7.1–7.7 要求关于页有自己的视觉特色：顶部个人介绍、关注方向、
 * 正在做的事、本站、联系。这些是**结构化版面**，普通 Markdown 文章表达不了。
 *
 * 但内容必须仍来自 `content/pages/about.md`（D.4 红线：结构化区块的内容
 * 不允许写死在组件里）。所以拆成：
 *
 *   `app/about/page.tsx`   —— 路由 + metadata（取数）
 *   `components/AboutView.tsx` —— 版式（把 md 渲染成 hero + 正文）
 *
 * ## 路由优先级
 *
 * Next 里静态路由优先于动态路由，所以 `/about` 会走新路由，`app/[slug]`
 * 不再接管。URL 没变，旧链接与搜索引擎索引不受影响。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("D-2 存在独立的 app/about/page.tsx 路由", () => {
  const f = path.join(ROOT, "app/about/page.tsx");
  assert.ok(fs.existsSync(f), "应有 app/about/page.tsx");
  const src = read("app/about/page.tsx");
  assert.match(src, /export const dynamic = "force-dynamic"/, "应与其它前台页面一致，按请求实时渲染");
  assert.match(src, /getPageBySlugCached\("about"\)/, "应仍从数据库读 about 页面（不是硬编码内容）");
  assert.match(src, /generateMetadata/, "应有 generateMetadata（SEO）");
});

test("D-2 内容必须来自 about.md，组件里不得写死文案", () => {
  /**
   * 这是 D.4 红线的直接检查：结构化区块的**内容**必须来自 md 或 settings。
   * 组件里只允许出现"版式"相关的类名与结构性文字（如 aria-label）。
   */
  // 去掉注释再查 —— 注释里举例说明 md 结构是允许的，那不是"写死文案"
  const src = read("components/AboutView.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const forbidden = [
    "一个喜欢折腾技术、探索新事物的学生",
    "AI & Artificial Intelligence",
    "Development & Programming",
    "Self-hosting",
    "Open Source",
    "折腾各种自托管服务",
    "用 AI 结对开发一些小工具",
  ];
  const leaked = forbidden.filter((t) => src.includes(t));
  assert.deepEqual(
    leaked,
    [],
    "AboutView 里写死了本应来自 about.md 的文案：" + leaked.join(", ")
  );
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

test("D-2 AboutView 必须给页面一个 h1（可访问性）", () => {
  /**
   * 关于页不是文章，没有 .article-title，所以最容易漏掉 h1 ——
   * 第一次实现时实测 h1Count 就是 0。读屏用户靠 h1 判断"这是什么页"，
   * 搜索引擎也靠它，不能没有。
   */
  const src = read("components/AboutView.tsx");
  assert.match(src, /<h1\b/, "应有 h1");
  assert.match(src, /className="sr-only"/, "h1 应视觉隐藏（sr-only），不能重复显示标题");
});

test("D-2 目录必须与正文实际章节一致（不能留死锚点）", () => {
  /**
   * `toc` 是按**完整 md** 生成的，而 AboutView 会把「我在关注什么」那一节
   * 从正文里移除（顶部已做成标签，避免重复）。若不同步剔除 toc，
   * 目录里会留一个指向不存在锚点的链接。
   */
  const src = read("components/AboutView.tsx");
  assert.match(src, /visibleToc/, "应过滤 toc 以匹配正文实际章节");
  assert.match(src, /toc=\{visibleToc\}/, "应把过滤后的 toc 传给 SiteShell");
});
