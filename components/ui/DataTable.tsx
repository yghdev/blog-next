import type { ReactNode } from "react";

/**
 * DataTable（阶段 01-A）。
 *
 * 刻意不用原生 <table>：后台列表在 ≤820px 必须变成两行卡片，而原生表格
 * 改布局要 display:block 覆盖一堆默认行为，反而更难维护。这里用 div + ARIA
 * role 保留表格语义 —— 读屏仍能按表格导航（role=row/columnheader/cell），
 * 视觉走 .ui-table-* 类。
 *
 * 分工：本组件只负责"结构 + 语义 + 三态外壳"，
 * 具体单元格内容与交互由调用方通过 render 传入，避免这里长成万能组件。
 */

export type Column = {
  key: string;
  header: ReactNode;
  /** 数值列右对齐 + 等宽数字（B 端门禁：数值列必须纵向对齐） */
  numeric?: boolean;
  /** 占比：主信息列给 1（flex:1），其它列不传则按内容宽度 */
  grow?: boolean;
  width?: number | string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  render,
  empty,
  loading,
  loadingRows = 5,
  footer,
}: {
  columns: Column[];
  rows: T[];
  rowKey: (row: T) => string | number;
  render: (row: T, column: Column) => ReactNode;
  empty?: ReactNode;
  loading?: boolean;
  loadingRows?: number;
  footer?: ReactNode;
}) {
  return (
    <div className="ui-table" role="table" aria-busy={loading || undefined}>
      <div className="ui-table-head" role="row">
        {columns.map((c) => (
          <span
            key={c.key}
            role="columnheader"
            className={[
              "ui-table-cell",
              c.grow ? "ui-table-cell--grow" : "",
              c.numeric ? "ui-table-cell--num" : "",
            ].filter(Boolean).join(" ")}
            style={c.width === undefined ? undefined : { width: c.width, flexShrink: 0 }}
          >
            {c.header}
          </span>
        ))}
      </div>

      {loading ? (
        Array.from({ length: loadingRows }, (_, i) => (
          <div key={"sk" + i} className="ui-table-row" aria-hidden="true">
            {columns.map((c) => (
              <span
                key={c.key}
                className={["ui-table-cell", c.grow ? "ui-table-cell--grow" : "", c.numeric ? "ui-table-cell--num" : ""].filter(Boolean).join(" ")}
              >
                <span className="ui-skeleton" style={{ display: "block", width: c.numeric ? 48 : "70%", height: 12 }} />
              </span>
            ))}
          </div>
        ))
      ) : rows.length === 0 ? (
        // 空状态必须有解释与出口，这里只留槽位，文案由调用方给
        <div className="ui-table-row" role="row">
          <span className="ui-table-cell ui-table-cell--grow" role="cell">{empty ?? "没有数据"}</span>
        </div>
      ) : (
        rows.map((r) => (
          <div key={rowKey(r)} className="ui-table-row" role="row">
            {columns.map((c) => (
              <span
                key={c.key}
                role="cell"
                className={[
                  "ui-table-cell",
                  c.grow ? "ui-table-cell--grow" : "",
                  c.numeric ? "ui-table-cell--num" : "",
                ].filter(Boolean).join(" ")}
              >
                {render(r, c)}
              </span>
            ))}
          </div>
        ))
      )}

      {footer ? <div className="ui-table-foot">{footer}</div> : null}
    </div>
  );
}
