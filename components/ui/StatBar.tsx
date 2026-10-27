import type { ReactNode } from "react";

/**
 * StatBar（阶段 01-A）。
 *
 * 用于"构成"类指标（草稿/已发布占比、存储分层、评论状态分布）。
 * 刻意不提供无标签的纯色条：每一段必须有 label，否则读屏用户只能听到
 * 一串数字，看不出各段代表什么。
 *
 * 颜色只用语义色（ok/warn/danger/info）与中性色，不引入彩虹配色 ——
 * 与 Badge 的规则一致，避免同一页面出现两套状态色彩语言。
 */

export type StatSegment = {
  label: string;
  value: number;
  /** 语义色；不传则用中性色，表示"其它/未分类" */
  tone?: "ok" | "warn" | "danger" | "info" | "neutral";
};

const TONE_COLOR: Record<NonNullable<StatSegment["tone"]>, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  info: "var(--info)",
  neutral: "var(--text-p4)",
};

export function StatBar({
  segments,
  ariaLabel,
  showLegend = true,
  formatValue,
}: {
  segments: StatSegment[];
  ariaLabel: string;
  showLegend?: boolean;
  formatValue?: (n: number) => ReactNode;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);

  return (
    <div className="ui-statbar">
      <div
        className="ui-statbar-track"
        role="img"
        // 整条读成一句话，比让读屏逐个进 8 个空 div 好得多
        aria-label={ariaLabel + "：" + segments.map((s) => s.label + " " + s.value).join("，")}
      >
        {total > 0
          ? segments.filter((s) => s.value > 0).map((s) => (
              <span
                key={s.label}
                className="ui-statbar-seg"
                style={{
                  width: (Math.max(0, s.value) / total) * 100 + "%",
                  background: TONE_COLOR[s.tone ?? "neutral"],
                }}
              />
            ))
          : null}
      </div>

      {showLegend ? (
        <div className="ui-statbar-legend">
          {segments.map((s) => (
            <span key={s.label} className="ui-statbar-legend-item">
              <span
                className="ui-statbar-swatch"
                style={{ background: TONE_COLOR[s.tone ?? "neutral"] }}
                aria-hidden="true"
              />
              {s.label}
              <span className="ui-statbar-value">{formatValue ? formatValue(s.value) : s.value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
