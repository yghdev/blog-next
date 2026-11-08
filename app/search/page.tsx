import { Animations } from "@/components/Animations";
import { SiteShell } from "@/components/SiteShell";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { SearchBox } from "@/components/SearchBox";
import { PostCard } from "@/components/PostCard";
import { searchPosts, searchFacets } from "@/lib/search";
import { highlightTerms } from "@/lib/highlight";
import Link from "next/link";

export const dynamic = "force-dynamic";
// 搜索结果页没有独立内容，进索引只会稀释权重（Baidu/Google 的站内搜索页常见问题）
export const metadata = { title: "搜索", robots: { index: false, follow: true } };

/** 每页条数（C2）。10 条一页：一屏能看完，分页也真的会被用到 */
const PAGE_SIZE = 10;

type Params = { q?: string; page?: string; tag?: string; year?: string };

/**
 * 拼搜索页地址。所有筛选/分页链接都走这里，避免各处手拼 URL 时漏参数。
 *
 * 约定：`page=1` 不写进 URL（保持地址干净，也避免同一内容两个地址）。
 */
function searchHref(p: { q?: string; tag?: string; year?: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (p.q) sp.set("q", p.q);
  if (p.tag) sp.set("tag", p.tag);
  if (p.year) sp.set("year", p.year);
  if (p.page && p.page > 1) sp.set("page", String(p.page));
  const s = sp.toString();
  return "/search" + (s ? "?" + s : "");
}

/**
 * 搜索结果页。
 *
 * 两处修正：
 *  1) 结果卡片此前是手写的 <Link className="post-card"><p>{excerpt}</p></Link>，
 *     没有 .excerpt 类，导致摘要占满行宽、行高错乱，和首页卡片不是一套排版。
 *     现在统一复用 PostCard。
 *  2) 没结果时只有一句「没有找到相关文章」，没有出口。补上可执行建议。
 *
 * P0-6（2026-11-07）三件事：
 *  · 计数：此前把 `hits.length`（最多 30，被 limit 截断）当成"共 N 篇"。
 *    现在用 searchPosts 的 total，被候选上限截断时写 "N+"；
 *  · 高亮：标题与摘要里的命中词用 <mark> 标出，规则与排序/摘要同源；
 *  · 2 字词：不再"降级后只按时间倒序"，排序、摘要、计数都跟 3 字以上一致。
 *
 * C2（2026-11-08）：分页 + 标签/年份筛选。
 *  · 分页：`?page=N`，每页 10 条；越界页码由 searchPosts 夹回有效范围；
 *  · 筛选：`?tag=` 同时匹配分类与标签（读者眼里都是"标签"），`?year=` 按年份；
 *  · 筛选条用**链接**而不是下拉：SSR 优先，不依赖 JS，也能被浏览器前进/后退正确还原。
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const tag = (sp.tag ?? "").trim();
  const year = (sp.year ?? "").trim();
  const pageParam = Number(sp.page ?? "1");

  const result = q
    ? searchPosts(q, { limit: PAGE_SIZE, page: pageParam, tag, year })
    : {
        hits: [], mode: "like" as const, total: 0, capped: false, titleOnly: false,
        page: 1, pageCount: 1,
      };
  const { hits, mode, total, capped, titleOnly, page, pageCount } = result;

  // 筛选分面只在有查询词时算：没有查询词时筛选条没有意义
  const facets = q ? searchFacets() : { tags: [], years: [] };
  const hasFilter = Boolean(tag || year);

  // 高亮词与搜索用的是同一套拆分规则（lib/highlight.ts）
  const terms = q ? highlightTerms(q) : [];
  const modeLabel = mode === "fts" ? "全文索引" : "关键词匹配";
  const countText = total > 0
    ? "找到 " + total + (capped ? "+" : "") + " 篇" +
      (pageCount > 1 ? " · 第 " + page + " / " + pageCount + " 页" : "") +
      " · " + modeLabel
    : "没有匹配结果 · " + modeLabel;

  return (
    <>
      <Animations />
      <SiteShell variant="wide">
        <PageHeader title="搜索" />
        {/*
          复用 SearchBox，而不是手写第二份表单（B-6）。
          手写那份用了 `content-search` 类名，被 820px 的
          `.content-search { display:none }` 命中 —— 移动端搜索页
          一个输入框都没有。换类名 + 复用组件后两个问题一起消失。
        */}
        <div className="search-page-form">
          <SearchBox initial={q} variant="dashed" />
        </div>

        {q ? <p className="search-meta">{countText}</p> : null}

        {/*
          筛选条（C2）。用链接而不是 <select>：SSR 优先、不依赖 JS，
          浏览器前进/后退也能正确还原筛选状态。
          点已选中的标签 = 取消该筛选（链接指向不带该参数的地址）。
        */}
        {q && (facets.tags.length > 0 || facets.years.length > 0) ? (
          <div className="search-filters">
            {facets.tags.length > 0 ? (
              <div className="search-filter-row">
                <span className="search-filter-label">标签</span>
                <Link
                  href={searchHref({ q, year })}
                  className={"search-chip" + (tag ? "" : " is-active")}
                >
                  全部
                </Link>
                {facets.tags.slice(0, 10).map((t) => (
                  <Link
                    key={t.name}
                    href={searchHref({ q, year, tag: tag === t.name ? "" : t.name })}
                    className={"search-chip" + (tag === t.name ? " is-active" : "")}
                  >
                    {t.name}
                    <span className="search-chip-num">{t.count}</span>
                  </Link>
                ))}
              </div>
            ) : null}
            {facets.years.length > 0 ? (
              <div className="search-filter-row">
                <span className="search-filter-label">年份</span>
                <Link
                  href={searchHref({ q, tag })}
                  className={"search-chip" + (year ? "" : " is-active")}
                >
                  全部
                </Link>
                {facets.years.map((y) => (
                  <Link
                    key={y.year}
                    href={searchHref({ q, tag, year: year === y.year ? "" : y.year })}
                    className={"search-chip" + (year === y.year ? " is-active" : "")}
                  >
                    {y.year}
                    <span className="search-chip-num">{y.count}</span>
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/*
          单字查询提示（2026-11-07）。
          单字在正文里几乎每篇都有（`的` 命中全部 25 篇、高亮几十处），
          所以 searchPosts 对单字只匹配标题。这里必须说明，否则用户会以为
          "明明正文里有，怎么搜不到"。
        */}
        {titleOnly ? (
          <p className="search-hint">
            「{q}」是单字，只在<strong>标题</strong>里匹配 —— 单字在正文里几乎每篇都有，
            全量命中反而找不到东西。试试加一个字，或换个更具体的词。
          </p>
        ) : null}

        {q && hits.length === 0 ? (
          <EmptyState
            title={"没有找到「" + q + "」"}
            hint={
              hasFilter
                ? "当前带着筛选条件（" +
                  [tag ? "标签：" + tag : "", year ? "年份：" + year : ""].filter(Boolean).join(" · ") +
                  "）。去掉筛选可能就有结果了。"
                : titleOnly
                  ? "单字只在标题里匹配，没有标题含这个字。加一个字组成更具体的词，命中会准很多。"
                  : "三个字以上走全文索引；一两个字按关键词匹配，标题命中会排在前面。换个关键词，或者直接从归档里翻也行。"
            }
            actions={
              <>
                {hasFilter ? (
                  <Link className="btn btn-sm" href={searchHref({ q })}>清除筛选</Link>
                ) : null}
                <Link className="btn btn-sm" href="/archives">看归档</Link>
                <Link className="btn btn-sm btn-ghost" href="/">回首页</Link>
              </>
            }
          />
        ) : (
          <div className="post-list">
            {hits.map((h) => (
              <PostCard
                key={h.id}
                href={"/p/" + h.id}
                title={h.title}
                excerpt={h.excerpt}
                date={h.date}
                highlight={terms}
              />
            ))}
          </div>
        )}

        {/* 分页（C2）：只有一页时不渲染，避免"第 1 / 1 页"这种噪音 */}
        {pageCount > 1 ? (
          <nav className="pager" aria-label="搜索结果分页">
            {page > 1 ? (
              <Link className="btn btn-sm" href={searchHref({ q, tag, year, page: page - 1 })}>
                上一页
              </Link>
            ) : null}
            <span className="pager-current" aria-current="page">
              第 {page} / {pageCount} 页
            </span>
            {page < pageCount ? (
              <Link className="btn btn-sm" href={searchHref({ q, tag, year, page: page + 1 })}>
                下一页
              </Link>
            ) : null}
          </nav>
        ) : null}

        {!q ? (
          <EmptyState
            title="想找点什么？"
            hint="输入标题或正文里的关键词，回车即可。三个字以上走全文索引，一两个字按关键词匹配。"
          />
        ) : null}
      </SiteShell>
    </>
  );
}
