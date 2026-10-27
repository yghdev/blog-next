import type { CSSProperties } from "react";

/**
 * 骨架屏（阶段 01-A）。
 *
 * 原则：形状要贴合最终内容。随便给几根等长灰条，内容到达时会发生二次跳动，
 * 那比直接空白更让人不适。所以暴露 width/height 由调用方按真实布局给值。
 *
 * 无障碍：骨架本身 aria-hidden，避免读屏念一串空 div；
 * "正在加载"的语义由外层 role=status + aria-live 承担一次即可。
 */

export function Skeleton({
  width = "100%",
  height = 14,
  radius,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={["ui-skeleton", className].filter(Boolean).join(" ")}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/** 多行骨架：最后一行收窄，模拟真实段落 */
export function SkeletonText({ lines = 3, gap }: { lines?: number; gap?: number }) {
  return (
    <span className="ui-skeleton-stack" aria-hidden="true" style={gap === undefined ? undefined : { gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? "62%" : "100%"} />
      ))}
    </span>
  );
}

/** 列表骨架：与 .ui-table-row 同高同 padding，切换时不跳动 */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="ui-table" role="status" aria-live="polite">
      <span
        style={{
          position: "absolute", width: 1, height: 1, overflow: "hidden",
          clip: "rect(0 0 0 0)", whiteSpace: "nowrap",
        }}
      >
        正在加载
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ui-table-row" aria-hidden="true">
          <Skeleton width="55%" height={13} />
          <span style={{ flex: 1 }} />
          <Skeleton width={64} height={13} />
        </div>
      ))}
    </div>
  );
}
