"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useScrollLock } from "./ui/useScrollLock";

/**
 * 侧栏的开合状态容器（2026-10-23）。
 *
 * 为什么要把状态提到这里：
 *   桌面右栏容器 .toc-col 在 **≤1200px 就 display:none**，但顶部栏要到
 *   ≤820px 才出现。于是 821~1200px（iPad 横屏就是 1024）出现一个空洞：
 *   右栏没了、顶栏也没有，侧栏入口完全不可见。
 *
 * 解决：状态放在 context 里，两个位置各放一个触发按钮 ——
 *   - 顶栏（手机，≤820px 可见）
 *   - 左侧栏底部（平板，821~1200px 可见）
 *   两个按钮的可见性由 CSS 断点保证互斥，不会同时出现。
 *
 * 面板用 Portal 挂到 body：顶部栏有 backdrop-filter，会给 position:fixed
 * 创建新的包含块，抽屉会被困在 54px 高的头部里。
 */
type Ctx = { open: () => void };

const SidebarCtx = createContext<Ctx | null>(null);

export function SidebarSheetProvider({ panel, children }: { panel: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Portal 需要真实 DOM
  useEffect(() => { setMounted(true); }, []);

  /**
   * 滚动锁走 useScrollLock（position:fixed + 记录 scrollY）。
   * 之前这里只写 body.style.overflow = "hidden"，iOS Safari 直接忽略，
   * 于是抽屉里上下滑会把底层文章列表带着一起滚 —— 典型的滚动穿透。
   */
  useScrollLock(open && mounted);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const sheet = open && mounted ? createPortal(
    <div className="mobile-sidebar-mask" onClick={() => setOpen(false)}>
      <aside
        className="mobile-sidebar"
        role="dialog"
        aria-modal="true"
        aria-label="侧栏"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mobile-sidebar-head">
          <span>侧栏</span>
          <button aria-label="关闭侧栏" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="mobile-sidebar-body">{panel}</div>
      </aside>
    </div>,
    document.body
  ) : null;

  return (
    <SidebarCtx.Provider value={{ open: () => setOpen(true) }}>
      {children}
      {sheet}
    </SidebarCtx.Provider>
  );
}

/** 触发按钮：面板图标（区别于汉堡导航菜单与搜索） */
export function SidebarTrigger({ className = "mobile-icon-btn" }: { className?: string }) {
  const ctx = useContext(SidebarCtx);
  if (!ctx) return null;
  return (
    <button
      type="button"
      className={className}
      aria-label="打开侧栏"
      title="侧栏"
      onClick={ctx.open}
    >
      <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden>
        <rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M14.5 5v14" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    </button>
  );
}
