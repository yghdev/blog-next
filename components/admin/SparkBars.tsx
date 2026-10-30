/**
 * 14 天柱状图（内联 SVG）。
 *
 * 为什么不用 ECharts / Chart.js：整个项目目前**零图表依赖**，
 * 为一张 14 根的柱状图加 200KB 的库不值当 —— 而且图表库的主题适配
 * （暗色下网格线、文字、tooltip 配色）要单独调一遍，代价比手写高。
 *
 * 这里只画三种元素：柱、基线、x 轴标签。全部用 `currentColor` 与
 * `--fx-brand`，切换主题自动跟随，不需要第二套配色。
 *
 * 无障碍：图本身 aria-hidden，旁边用一个视觉隐藏的表格给读屏用户 ——
 * 一串 <rect> 对屏幕阅读器没有意义，直接念数字反而更好。
 */
import type { DayPoint } from "@/lib/visitor-stats";

export function SparkBars({ points }: { points: DayPoint[] }) {
  if (points.length === 0) return null;

  const W = 100;          // viewBox 宽度（百分比语义，实际宽度由容器决定）
  const H = 34;
  const gap = 1.2;
  const barW = (W - gap * (points.length - 1)) / points.length;
  const max = Math.max(1, ...points.map((p) => p.pv));

  return (
    <div className="visit-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden focusable="false">
        {points.map((p, i) => {
          // 高度至少 0.6：全 0 的日子也要有一条可见的基线，
          // 否则「这天没人来」和「这天数据缺失」在视觉上无法区分
          const h = p.pv === 0 ? 0.6 : Math.max(0.6, (p.pv / max) * (H - 4));
          return (
            <rect
              key={p.day}
              x={i * (barW + gap)}
              y={H - h}
              width={barW}
              height={h}
              rx={0.5}
              className={p.pv === 0 ? "bar is-empty" : "bar"}
            />
          );
        })}
      </svg>
      <div className="visit-chart-axis" aria-hidden>
        <span>{points[0].day.slice(5)}</span>
        <span>{points[points.length - 1].day.slice(5)}</span>
      </div>

      {/* 读屏用户拿到的是表格语义，不是一串矩形 */}
      <table className="sr-only">
        <caption>最近 {points.length} 天每日访问量</caption>
        <thead><tr><th scope="col">日期</th><th scope="col">访问量</th><th scope="col">访客</th></tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}>
              <th scope="row">{p.day}</th>
              <td>{p.pv}</td>
              <td>{p.uv}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
