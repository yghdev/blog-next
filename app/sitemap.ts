import type { MetadataRoute } from "next";
import { listPosts, postHref } from "@/lib/posts";
import { toUtcIso } from "@/lib/time";
import { SITE_URL as SITE } from "@/lib/seo";

/**
 * P0-5（2026-11-07）：**必须请求期渲染**。
 *
 * 此前这里是 `export const revalidate = 3600`，Next 于是在 `next build` 时
 * 预渲染 sitemap（构建输出 `○ /sitemap.xml 1h`）。而构建机读的是**本地库**
 * （data/blog.db，0~31 篇的旧数据），产物里就冻住一份与线上不一致的 sitemap，
 * 且要等 ISR 到期才会自愈 —— 期间搜索引擎抓到的是一份错误清单。
 *
 * 改成动态后每次请求直读线上库；代价是一次 SQLite 查询（<1ms），
 * 换来的是"发布即出现在 sitemap"，与 rss.xml（也是 force-dynamic）口径一致。
 */
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = listPosts({ limit: 1000 });
  const entries: MetadataRoute.Sitemap = [
    { url: SITE, lastModified: new Date(), priority: 1 },
    { url: SITE + "/shuoshuo", lastModified: new Date(), priority: 0.6 },
    { url: SITE + "/archives", lastModified: new Date(), priority: 0.6 },
    // 友链专题页（2026-10-30 起是独立路由，不再是 posts 里的普通 page）
    { url: SITE + "/friend-links", lastModified: new Date(), priority: 0.5 },
    { url: SITE + "/about", lastModified: new Date(), priority: 0.5 },
  ];
  for (const p of posts) {
    entries.push({
      url: SITE + postHref(p),
      lastModified: toUtcIso(p.updated_at) ? new Date(toUtcIso(p.updated_at)!) : new Date(),
      priority: 0.8,
    });
  }
  return entries;
}
