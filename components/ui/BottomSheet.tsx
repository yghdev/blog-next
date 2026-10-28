"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useScrollLock } from "./useScrollLock";

/**
 * 移动端底部半屏抽屉（移动端设计系统 · 参考 05）。
 *
 * 关键点：
 *   - 高度用 dvh 而不是 vh：iOS 地址栏收缩时 vh 不会跟着变，底部会顶出屏幕；
 *   - 底部内边距写 max(16px, env(safe-area-inset-bottom))，主按钮不被 Home Bar 盖住；
 *   - 用 useScrollLock 钉住 body，滑抽屉时底层页面纹丝不动；
 *   - 遮罩点击是否关闭由调用方决定：含录入字段时必须传 maskClosable={false}；
 *   - 顶部一条拖拽把手，视觉上明确「这层可以往下收」。
 *
 * 用 Portal 挂到 body：父级若有 backdrop-filter / transform 会创建新的
 * 包含块，position:fixed 会被困在父容器里（本项目踩过一次）。
 */
export function BottomSheet({
  open, title, onClose, maskClosable = true, children, labelledBy,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  maskClosable?: boolean;
  children: ReactNode;
  labelledBy?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open && mounted);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="sheet-mask fx-scope"
      onClick={() => { if (maskClosable) onClose(); }}
    >
      <div
        ref={panelRef}
        className="sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <span className="sheet-title">{title}</span>
          <button className="sheet-close" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}
