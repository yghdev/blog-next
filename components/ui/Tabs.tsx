"use client";
import { useRef, type ReactNode } from "react";

/**
 * Tabs（阶段 01-A）。
 *
 * 什么时候不该用这个组件（重要，挂错 ARIA 比不用更难查）：
 *   - **筛选**一组列表结果 -> 用 aria-pressed 的按钮，或 aria-current 的链接。
 *     筛选并不切换"面板"，挂 role=tab 会让读屏念出"选项卡 1/3"，
 *     但界面上根本没有对应面板。
 *   - 页面间跳转 -> 用 Link + aria-current="page"。
 * 只有"同一上下文里切换不同面板内容"才用这里。
 *
 * 键盘行为按 WAI-ARIA 实现：左右箭头切换、Home/End 到首尾、Tab 键只停在
 * 当前选中的那一项（roving tabindex），这是 tablist 的标准模式。
 */

export type TabItem = { id: string; label: ReactNode; disabled?: boolean };

export function Tabs({
  items, value, onChange, ariaLabel,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const enabled = items.filter((t) => !t.disabled);
  const move = (delta: number) => {
    if (!enabled.length) return;
    const idx = enabled.findIndex((t) => t.id === value);
    const next = enabled[(idx + delta + enabled.length) % enabled.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  const jump = (pos: "first" | "last") => {
    if (!enabled.length) return;
    const next = pos === "first" ? enabled[0] : enabled[enabled.length - 1];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div className="ui-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[t.id] = el; }}
            type="button"
            role="tab"
            id={"tab-" + t.id}
            aria-selected={selected}
            aria-controls={"panel-" + t.id}
            // roving tabindex：整组只留一个可 Tab 进入的点
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className="ui-tab"
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
              else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
              else if (e.key === "Home") { e.preventDefault(); jump("first"); }
              else if (e.key === "End") { e.preventDefault(); jump("last"); }
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** 对应的面板容器。没有它，role=tab 的 aria-controls 会指向不存在的节点 */
export function TabPanel({ id, value, children }: { id: string; value: string; children: ReactNode }) {
  if (id !== value) return null;
  return (
    <div role="tabpanel" id={"panel-" + id} aria-labelledby={"tab-" + id} tabIndex={0}>
      {children}
    </div>
  );
}
