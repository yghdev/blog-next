import type { MetadataRoute } from "next";
import { listPosts } from "@/lib/posts";
import { toUtcIso } from "@/lib/time";

const SITE = process.env.SITE_URL || "https://blog.yghsite.cn";

export const revalidate = 3600;

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
      url: SITE + "/" + encodeURIComponent(p.slug),
      lastModified: toUtcIso(p.updated_at) ? new Date(toUtcIso(p.updated_at)!) : new Date(),
      priority: 0.8,
    });
  }
  return entries;
}
