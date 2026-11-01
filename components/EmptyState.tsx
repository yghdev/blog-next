import type { ReactNode } from "react";

/**
 * 空状态（C-8，2026-11-01）。
 *
 * ## 问题
 *
 * 这套三层结构（title / hint / actions）在前台 5 个位置重复：
 * 首页、归档、说说、搜索（两个：无结果 / 未输入）。
 *
 * ## 与后台的关系（重要）
 *
 * 后台 `components/admin/ui.tsx:89` 也有一个 `Empty` 组件，用的是**同一套
 * `.empty-block` 类**。所以这个组件**只收 JSX，不新增也不改任何 CSS** ——
 * 后台零影响。
 *
 * 反过来说：若将来要改 `.empty-block` 的样式，前台和后台会一起变。
 * 这是设计上的共享，不是 bug，但改之前要知道。
 *
 * ## 参数与后台对齐
 *
 * `title` / `hint` / `actions` 三个名字与后台的 `Empty` 完全一致 ——
 * 同一个视觉组件在两处用同样的参数名，改样式的人不用记两套。
 */
export function EmptyState({
  title,
  hint,
  actions,
}: {
  /** 主文案，渲染为 `.empty-title` */
  title: ReactNode;
  /** 说明文字，渲染为 `.empty-hint`；不传则不渲染该层 */
  hint?: ReactNode;
  /** 操作按钮组，渲染为 `.empty-actions`；不传则不渲染该层 */
  actions?: ReactNode;
}) {
  return (
    <div className="empty-block">
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}
