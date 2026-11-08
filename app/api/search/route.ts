import { NextRequest, NextResponse } from "next/server";
import { searchPosts } from "@/lib/search";
import { highlightTerms } from "@/lib/highlight";

export const dynamic = "force-dynamic";

/**
 * C10：FTS5 + LIKE 混合；只回摘要，不回整篇正文。
 *
 * P0-6（2026-11-07）：额外回 `total`（命中总数，不是本页条数）与 `capped`
 * （是否被候选上限截断）。调用方要判断"还有没有更多"时不能再看 hits.length ——
 * 它只是 limit（20）条一页的长度。
 *
 * 单字查询（2026-11-07）：额外回 `titleOnly`。单字只在标题里匹配，
 * 调用方据此提示用户"结果变少是规则，不是搜索坏了"。
 *
 * C2（2026-11-08）：支持 `page` / `tag` / `year`，并回 `page` / `pageSize` /
 * `pageCount`。分页参数与搜索页完全同一套（都走 lib/search.ts），
 * 不会出现"页面第 2 页、接口第 1 页"这种漂移。
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim();
  const tag = (sp.get("tag") || "").trim();
  const year = (sp.get("year") || "").trim();
  const page = Number(sp.get("page") || "1");

  if (!q) {
    return NextResponse.json({
      hits: [], mode: "like", total: 0, capped: false, titleOnly: false,
      page: 1, pageSize: 20, pageCount: 1, terms: [],
    });
  }

  const { hits, mode, total, capped, titleOnly, page: cur, pageSize, pageCount } =
    searchPosts(q, { limit: 20, page, tag, year });

  return NextResponse.json(
    { hits, mode, total, capped, titleOnly, page: cur, pageSize, pageCount, terms: highlightTerms(q) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
