import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPageBySlugCached } from "@/lib/cached";
import { AboutView } from "@/components/AboutView";
import { articleMetadata } from "@/components/ArticleView";

export const dynamic = "force-dynamic";

/**
 * 关于页（D-2，2026-11-01）。
 *
 * ## 为什么从 `app/[slug]` 独立出来
 *
 * 需求文档 7.1–7.7 要求关于页有自己的视觉特色：顶部个人介绍（头像 +
 * 名字 + 一句介绍 + 兴趣标签）、关注方向、正在做的事、本站、联系。
 * 这些是**结构化的版面**，不是一篇普通 Markdown 能表达的。
 *
 * 但内容必须仍然来自 `content/pages/about.md`（D.4 红线：结构化区块的
 * 内容不允许写死在组件里）。所以：
 *
 *   - `about.md` 提供全部**文案**（含各节标题与列表）
 *   - `AboutView` 提供**版式**（把 md 渲染出的 HTML 放进带样式的容器，
 *     并把顶部的问候语与头像单独提出来做 hero）
 *
 * ## 路由优先级
 *
 * Next 里静态路由优先于动态路由，所以 `/about` 会走这里，
 * `app/[slug]` 不再接管。旧的 `/about` 链接与搜索引擎索引不受影响
 * （URL 没变，只是渲染方式变了）。
 *
 * ## 与 ArticleView 的差异
 *
 * 不显示发布日期、阅读时长、浏览量 —— 关于页不是文章，那些元信息没有意义。
 * 保留右栏目录（需求 7.7）。
 */
export async function generateMetadata(): Promise<Metadata> {
  const doc = await getPageBySlugCached("about");
  if (!doc) return { title: "关于" };
  return articleMetadata(doc);
}

export default async function AboutPage() {
  const doc = await getPageBySlugCached("about");
  if (!doc) notFound();
  return <AboutView doc={doc} />;
}
