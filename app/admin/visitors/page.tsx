import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader, SectionHead, Empty, Badge } from "@/components/admin/ui";
import { SparkBars } from "@/components/admin/SparkBars";
import {
  getSummary, getDailySeries, getTopPages, getTopSources,
  parseRange, RANGE_LABEL, type Range,
} from "@/lib/visitor-stats";

export const dynamic = "force-dynamic";
export const metadata = { title: "访客" };

/**
 * 访客统计（2026-10-30）。
 *
 * ## 为什么这一页不在概览里
 *
 * docs/admin-redesign-implementation.md 明确写过「概览不做装饰性访问量大屏」——
 * 概览回答的是「我该做什么」，而访问量不改变任何决定。所以它是**查看型**页面，
 * 放在「系统」组里与「日志」相邻。
 *
 * ## 四个数字的口径（页面上必须写清楚，否则半年后没人说得清）
 *
 *   访问量 PV   —— 每次浏览记 1（含从 Umami 导入的历史事件）
 *   访客 UV     —— 去重后的访客数，近似值
 *   访问次数    —— 30 分钟无活动切一次
 *   页面数      —— 被访问过的不同路径数
 *
 * 注意 UV 是**近似值**：无 Cookie 方案下，换浏览器、清缓存、手机切网络
 * 都会算成新访客。这个不精确必须明说，不能让读者以为是精确人数。
 */
export default async function VisitorsPage({ searchParams }: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const range = parseRange(sp.range);

  const summary = getSummary(range);
  const series = getDailySeries(14);
  const topPages = getTopPages(10, range);
  const sources = getTopSources(8, range);

  const RANGES: Range[] = ["today", "7d", "30d", "all"];

  return (
    <AdminShell active="visitors" username={user.username}>
      <PageHeader
        eyebrow="系统 · 观察"
        title="访客"
        sub="自建埋点，数据存在博客自己的库里（随每日备份一起走）。不含爬虫，也不含你自己的访问。"
      />

      {/* 时间范围：链接 + aria-current，与日志页的分组筛选同一套模式 */}
      <nav className="seg-tabs" aria-label="时间范围">
        {RANGES.map((r) => (
          <Link
            key={r}
            href={r === "7d" ? "/admin/visitors" : "/admin/visitors?range=" + r}
            className={range === r ? "is-active" : undefined}
            aria-current={range === r ? "page" : undefined}
          >
            {RANGE_LABEL[r]}
          </Link>
        ))}
      </nav>

      {/* 一行数字 + 上下细线（不铺卡片底） */}
      <div className="fx-figure-row" role="group" aria-label={RANGE_LABEL[range] + "的访问概况"}>
        <div className="fx-figure">
          <span className="fx-figure-value">{summary.pv}</span>
          <span className="fx-figure-label">访问量（PV）</span>
        </div>
        <div className="fx-figure">
          <span className="fx-figure-value">{summary.uv}</span>
          <span className="fx-figure-label">访客（UV，近似）</span>
        </div>
        <div className="fx-figure">
          <span className="fx-figure-value">{summary.visits}</span>
          <span className="fx-figure-label">访问次数</span>
        </div>
        <div className="fx-figure">
          <span className="fx-figure-value">{topPages.length ? topPages[0].views : 0}</span>
          <span className="fx-figure-label">单页最高</span>
        </div>
      </div>

      {summary.pvLocal === 0 && summary.pv === 0 ? (
        <div style={{ marginTop: "var(--fx-s6)" }}>
          <Empty
            title="还没有记录到访问"
            hint="埋点已经就位。打开前台任意页面（记得用无痕窗口，登录状态下的访问会被排除），几秒后回来看这里。"
            actions={<a className="btn btn-sm" href="/" target="_blank" rel="noopener noreferrer">去前台看看</a>}
          />
        </div>
      ) : null}

      {/* 14 天趋势 */}
      <section style={{ marginTop: "var(--fx-s7)" }}>
        <SectionHead
          title="最近 14 天"
          action={<span className="fx-section-more">柱子高度 = 每日 PV</span>}
        />
        <SparkBars points={series} />
      </section>

      {/* 两个榜并排：宽屏两栏、窄屏单栏 */}
      <div className="visit-cols">
        <section>
          <SectionHead title="页面 Top 10" action={<span className="fx-section-more">{RANGE_LABEL[range]}</span>} />
          {topPages.length === 0 ? (
            <Empty title="这个区间没有数据" hint="换个时间范围，或等有真实访问之后再来看。" />
          ) : (
            <div className="data-panel">
              {topPages.map((p, i) => (
                <div className="data-row" key={p.path}>
                  <span className="data-row-meta" style={{ width: 22, flex: "none" }}>{i + 1}</span>
                  <span className="data-row-title">
                    {p.postId ? (
                      <a href={"/p/" + p.postId} target="_blank" rel="noopener noreferrer">
                        {p.title || p.path}
                      </a>
                    ) : (
                      p.path
                    )}
                  </span>
                  <span className="data-row-meta">{p.views}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHead
            title="来源"
            action={<span className="fx-section-more">按会话入口计</span>}
          />
          {sources.length === 0 ? (
            <Empty title="这个区间没有数据" hint="来源只在一次访问的落地页上记一次，所以总量会小于 PV。" />
          ) : (
            <div className="data-panel">
              {sources.map((s) => (
                <div className="data-row" key={s.kind + "|" + s.host}>
                  <span className="data-row-title">
                    {s.kind === "direct" ? "直接访问 / 书签"
                      : s.kind === "site" ? "站内跳转"
                      : s.host || KIND_LABEL[s.kind]}
                    {s.host && s.kind !== "site" ? (
                      <span className="visit-kind">{KIND_LABEL[s.kind]}</span>
                    ) : null}
                  </span>
                  <span className="data-row-meta">{s.hits}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 口径说明：不放脚注就会被当成精确值 */}
      <section style={{ marginTop: "var(--fx-s7)" }}>
        <SectionHead title="这些数字是怎么算的" />
        <div className="visit-notes">
          <p>
            <b>访问量（PV）</b>：页面每被浏览一次记 1。同一篇文章刷新一次算 1 次，
            进站后连看三篇算 3 次。
          </p>
          <p>
            <b>访客（UV）</b>：按「IP + 浏览器标识」去重后的数量，<b>是近似值</b>。
            换浏览器、清缓存、手机在 WiFi 与流量之间切换、浏览器大版本升级，
            都会被算成新访客。我们不种追踪 Cookie，所以无法做到更精确 ——
            这是隐私与准确之间的取舍，不是 bug。
          </p>
          <p>
            <b>访问次数</b>：同一个访客 30 分钟内连续浏览算 1 次；超过 30 分钟再回来算新的一次。
          </p>
          <p>
            <b>来源</b>：只记每次访问<b>落地那一页</b>的来源域名，不记完整网址，
            所以不会把别人的搜索词存下来。站内跳转不计入外部来源。
          </p>
          <p>
            <b>历史数据</b>：2026-10-21 至 10-30 的访问是从 Umami 导入的真实事件
            （已排除当时记录的后台访问），所以趋势、页面榜、来源都能看到那段历史。
            更早的数据 Umami 里没有，无法补。
          </p>
          <p>
            <b>基线</b>：Umami 的汇总总数与事件表对不上（汇总少了约 400 次），
            导入事件后基线已归零 —— 否则同一批访问会被算两次。
          </p>
        </div>
      </section>
    </AdminShell>
  );
}

const KIND_LABEL: Record<string, string> = {
  direct: "直接访问",
  site: "站内",
  search: "搜索",
  social: "社交",
  referral: "外链",
};
