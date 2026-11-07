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
 */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ hits: [], mode: "like", total: 0, capped: false, titleOnly: false, terms: [] });
  const { hits, mode, total, capped, titleOnly } = searchPosts(q, { limit: 20 });
  return NextResponse.json(
    { hits, mode, total, capped, titleOnly, terms: highlightTerms(q) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
