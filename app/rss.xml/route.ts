import { listPosts, parseJsonArray, makeExcerpt, postHref, legacySlugPath } from "@/lib/posts";
import { getSettings } from "@/lib/settings";
import { toUtcIso } from "@/lib/time";

export const dynamic = "force-dynamic";

const SITE = process.env.SITE_URL || "https://blog.yghsite.cn";

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export async function GET() {
  const s = getSettings();
  if (!s.rssEnabled) return new Response("RSS 已关闭", { status: 404 });

  const posts = listPosts({ limit: 30 });
  const items = posts.map((p) => {
    const iso = toUtcIso(p.published_at || p.created_at);
    return "\n    <item>" +
      "<title>" + esc(p.title) + "</title>" +
      "<link>" + SITE + postHref(p) + "</link>" +
      /**
       * guid 必须**保持旧值**（旧的 slug 地址），即使它现在只是 308 跳转。
       *
       * RSS 阅读器用 guid 判断「这条我见过没有」。2026-10-30 把文章地址
       * 从 /中文slug 换成 /p/<id> 时，如果顺手把 guid 也换掉，
       * 所有订阅者下次刷新会看到**全部历史文章重新变成未读**。
       * link 换成新地址即可，guid 一旦发布就必须永久稳定。
       */
      '<guid isPermaLink="true">' + SITE + legacySlugPath(p) + "</guid>" +
      "<pubDate>" + (iso ? new Date(iso).toUTCString() : "") + "</pubDate>" +
      "<description>" + esc(p.excerpt || makeExcerpt(p.content)) + "</description>" +
      parseJsonArray(p.categories).map((c) => "<category>" + esc(c) + "</category>").join("") +
      "</item>";
  }).join("");

  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0"><channel>' +
    "<title>" + esc(s.siteTitle) + "</title>" +
    "<link>" + SITE + "</link>" +
    "<description>" + esc(s.siteDescription) + "</description>" +
    "<language>zh-CN</language>" +
    "<lastBuildDate>" + new Date().toUTCString() + "</lastBuildDate>" +
    items +
    "\n</channel></rss>";

  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
