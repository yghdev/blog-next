import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { SiteShell } from "@/components/SiteShell";
import { PageHeader } from "@/components/PageHeader";
import { renderMarkdown } from "@/lib/markdown";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "关于" };

/**
 * 关于页（2026-11-06 改为**静态页**）。
 *
 * ## 为什么不再从数据库取
 *
 * 之前它读 `posts` 表里 `type=page, slug=about` 的记录（D-2），于是：
 *   · 全新安装 / 演示库没有这条记录时整页 404；
 *   · 它是导航里唯一"内容存在数据库"的页面，和归档 / 说说 / 友链这类
 *     静态页不是同一种东西，版式也因此分叉（hero vs 普通页面标题）。
 *
 * 现在与它们一致：**内容来自仓库里的 `content/pages/about.md`**（不查库），
 * 版式走 `PageHeader + .prose` 的标准页面结构，右栏回到完整版
 * （统计 / 聚合 / 友链 / 标签云），和归档、说说页完全同构。
 *
 * ## 文件怎么找
 *
 * 与 `lib/friend-links-page-source.ts` 同一套策略：standalone 产物的
 * 运行目录是 `.next/standalone`，而 `content/` 在 dist 根，最多上溯 4 层。
 * 打包脚本会把 `content/` 复制进 dist，所以线上也能读到。
 */
function readAboutMarkdown(): string {
  const rel = path.join("content", "pages", "about.md");
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) {
      try {
        return fs.readFileSync(candidate, "utf8");
      } catch {
        return "";
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/** 去掉 front matter（title/date/slug 这些元数据在这个页面上用不到） */
function stripFrontMatter(md: string): string {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return m ? md.slice(m[0].length) : md;
}

export default async function AboutPage() {
  const { html } = renderMarkdown(stripFrontMatter(readAboutMarkdown()));

  return (
    <SiteShell variant="three-col">
      <div className="page-card">
        <PageHeader title="关于" />
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </SiteShell>
  );
}
