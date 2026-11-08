import { SidebarBlock } from "./Blocks";
import { Icon, type IconName } from "../ui/Icon";

/**
 * 站点统计九宫格（B-8，2026-11-01）。
 *
 * 原先 `RightBar.tsx:31-44` 与 `MobileSidebar.tsx:28-41` 各写一遍，
 * 连 `stat-ico` / `stat-num` / `stat-name` 三层结构都一字不差。
 *
 * 数据由调用方查好传进来（`getSiteStatsCached()` 的结果），
 * 这样桌面与移动用的是**同一份**数据，不会出现"桌面 5 篇、手机 4 篇"。
 */
export type StatItem = { label: string; value: string; icon: IconName };

export function StatsBlock({ stats }: { stats: StatItem[] }) {
  return (
    <SidebarBlock title="站点统计">
      <div className="stat-grid">
        {stats.map((s) => (
          <div key={s.label} className="stat-cell">
            <span className="stat-ico" aria-hidden><Icon name={s.icon} size={14} /></span>
            <b className="stat-num">{s.value}</b>
            <span className="stat-name">{s.label}</span>
          </div>
        ))}
      </div>
    </SidebarBlock>
  );
}
