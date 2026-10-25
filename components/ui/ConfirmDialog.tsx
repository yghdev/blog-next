"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useScrollLock } from "./useScrollLock";

/**
 * 高危操作的确认弹窗（B 端设计系统 · 门禁 11）。
 *
 * 设计取舍（都是刻意的）：
 *   1) 危险动作用**真实弹窗**，而不是 window.confirm —— 后者样式不可控、
 *      移动端是浏览器原生丑陋提示、且不  支持「必须输入对象名才能确认」的加强阻力。
 *   2) 标题中立只交代对象（「删除这 3 篇文章？」），不写「确定要删除吗」这种
 *      情绪化废话；副作用写进描述，说清不可逆。
 *   3) 主按钮文案是明确的动宾结构（「移入回收站」「彻底删除」），
 *      绝不用「确定 / 好的」。
 *   4) 危险按钮不做主色描红 —— 主色描红等于用视觉诱导点它。危险按钮用
 *      浅底深字的语义色（80% 浅底深字法则），中性「取消」反而不抢眼。
 *   5) 遮罩点击默认**不关闭**（录入类表单会丢数据）；纯确认类允许点遮罩取消，
 *      因为取消本身就是安全结果。
 *   6) 打开时把焦点送进弹窗、Esc 关闭、关闭后焦点还给触发元素。
 */

type Props = {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** 遮罩点击是否等价于取消。含录入字段时请传 false */
  maskClosable?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
};

export function ConfirmDialog({
  open, title, description, confirmLabel, cancelLabel = "取消",
  danger = false, busy = false, maskClosable = true, onConfirm, onCancel, children,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open && mounted);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // 确认键不默认聚焦：误触回车就执行破坏性动作，是反面案例
    const t = setTimeout(() => panelRef.current?.focus(), 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      // 焦点圈在弹窗内，Tab 不会跑到背后的页面上
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [open, busy, onCancel]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="dialog-mask"
      onClick={() => { if (maskClosable && !busy) onCancel(); }}
    >
      <div
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title" id="dialog-title">{title}</h2>
        {description ? <div className="dialog-desc">{description}</div> : null}
        {children}
        <div className="dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={"btn" + (danger ? " btn-danger" : " btn-primary")}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
