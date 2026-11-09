import { Animations } from "@/components/Animations";
import { SiteShell } from "@/components/SiteShell";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { listShuoshuoCached } from "@/lib/cached";
import { dateKeyIn, formatIn, toUtcIso } from "@/lib/time";
import { renderMarkdown } from "@/lib/markdown";

export const dynamic = "force-dynamic";
export const metadata = { title: "说说" };

/**
 * 说说页（D-4，2026-11-01）。
 *
 * 需求文档第五章。定位是「轻量的个人动态记录页面」——
 * 与文章列表刻意不同：没有卡片、没有摘要、没有一排元信息徽章。
 *
 * ## 轻量时间线（需求 5.3）
 *
 * 两列结构：左侧日期（日号 + 年月），右侧正文 + 时分。
 *
 *      ┌─────────┬──────────────────────────────┐
 *      │   02    │ 今天把访问统计换成自建之后……   │
 *      │2026年11月│ 18:20                        │
 *      ├─────────┼──────────────────────────────┤
 *      │   01    │ 引用格式的说说……              │
 *      └─────────┴──────────────────────────────┘
 *
 * 为什么用 `<ol>` 而不是一堆 `<div>`：这是一串**按时间排列**的条目，
 * 有序列表让读屏能播报「第 1 项，共 5 项」，语义上也表达时间顺序。
 *
 * ## 日期为什么拆开写（需求 5.4）
 *
 * 5.4 说「日期格式保持统一，建议 2026年10月29日；**也可以采用日期拆分
 * 样式**，但必须保证移动端显示正常」。这里取拆分：日号大字做时间轴
 * 锚点、年月做小字说明 —— 合起来仍是完整的「2026年11月02日 18:20」。
 *
 * 拆分用 `dateKeyIn()`（**补零**的 YYYY-MM-DD），而不是 `formatIn()`
 * 的年月日：后者对 1–9 月只给一位（"2026年8月5日"），放进窄日期栏会
 * 左右跳动。这是 B1「归档 NaN」那套坑的同源问题。
 */
export default async function ShuoshuoPage() {
  const items = await listShuoshuoCached(100);
  return (
    <>
      <Animations />
      <SiteShell variant="three-col">
        <div className="page-card">
        <PageHeader
          title="说说"
          en="MOMENTS / DAILY NOTES"
          sub="记录一些不一定值得写成文章，但值得留下的瞬间。"
        />
        {items.length === 0 ? (
          <EmptyState
            title="还没有说说"
            hint="说说适合发短句和碎片想法。在后台新建内容时把类型选成「说说」就会出现在这里。"
            actions={<a className="btn btn-sm" href="/admin/new">去写一条</a>}
          />
        ) : (
          <ol className="shuo-list">
            {items.map((s) => {
              const at = s.published_at || s.created_at;
              const [y, m, d] = dateKeyIn(at).split("-");
              return (
                <li key={s.id} className="shuo-item slide-up">
                  <time className="shuo-stamp" dateTime={toUtcIso(at) ?? undefined}>
                    <span className="shuo-day">{d}</span>
                    <span className="shuo-ym">{y}年{m}月</span>
                  </time>
                  <div className="shuo-body">
                    <div
                      className="shuo-content"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(s.content).html }}
                    />
                    <span className="shuo-time">{formatIn(at, "time")}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        </div>
      </SiteShell>
    </>
  );
}
