"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { DARK_BG, LIGHT_BG, THEME_STORAGE_KEY as STORAGE_KEY } from "@/lib/theme-colors";

/**
 * 亮/暗主题切换（2026-10-23，C-4 重构）。
 *
 * ## 三种状态
 *
 *   system —— 跟随系统（首次访问的默认值，不写 localStorage）
 *   light  —— 手动白天
 *   dark   —— 手动夜间
 *
 * 存储：`localStorage["blog-theme"]`，只存 light/dark。
 * 没有这个键 = 跟随系统，由 CSS 的 `prefers-color-scheme` 兜底。
 *
 * ## 为什么不再用 useState（C-4）
 *
 * 这个组件在项目里有 **4 个实例**：
 *   Sidebar（桌面左栏底部）、MobileNav（手机顶栏）、
 *   AdminShell 侧栏、AdminShell 顶栏
 *
 * 原来每个实例各持一份 `useState`，只在自己被点时更新自己。于是在桌面
 * 点侧栏那个按钮 → 手机顶栏那个的 `aria-label` 仍是旧值。读屏用户会被告知
 * 「切换到夜间模式」，而实际已经在夜间了 —— 点了反而切回白天。
 *
 * 现在改成 `useSyncExternalStore`：**真相只有一份**（`documentElement`
 * 上的 `data-theme` 属性），所有实例订阅它。任一实例写入 → 所有实例同步。
 * 这也顺带让「跟随系统时系统变了」自动生效，不需要额外维护状态。
 *
 * ## 防闪烁
 *
 * `ThemeScript`（layout 里的内联脚本）在首屏绘制前就把 data-theme 打上，
 * 这里只负责后续交互与图标同步。`getServerSnapshot` 返回 `null` 让 SSR
 * 与首帧都渲染占位（避免图标跳变与 hydration mismatch）。
 */

type Theme = "light" | "dark";

/* ────────────────────────── 外部 store ────────────────────────── */

/**
 * 当前生效的主题。
 *
 * 优先读 `data-theme` 属性；没有的话看系统偏好（不写回属性 —— 跟随系统
 * 时故意不落 data-theme，好让 CSS 的媒体查询继续生效）。
 */
function readTheme(): Theme | null {
  if (typeof document === "undefined") return null;
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * 订阅主题变化。两个来源：
 *   1. 其它实例改 `data-theme` → MutationObserver
 *   2. 跟随系统时系统偏好变了 → matchMedia change
 *
 * 返回取消订阅函数（useSyncExternalStore 会在卸载时调用）。
 */
function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};

  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  const mq = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  const onMediaChange = () => {
    // 只有"没手动选过"时才跟随系统；手动选过就忽略
    if (localStorage.getItem(STORAGE_KEY)) return;
    onChange();
  };
  mq?.addEventListener("change", onMediaChange);

  return () => {
    observer.disconnect();
    mq?.removeEventListener("change", onMediaChange);
  };
}

/** 服务端与首帧：返回 null，渲染占位，避免图标跳变 */
const getServerSnapshot = () => null;

/* ────────────────────────── 写入 ────────────────────────── */

/**
 * 应用主题。
 *
 * 只改 `data-theme` 与 `<meta name="theme-color">` —— 改属性会触发
 * MutationObserver，所有订阅的实例（包括调用者自己）自动重渲染，
 * 不需要 setState。
 */
function apply(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? DARK_BG : LIGHT_BG);
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, getServerSnapshot);

  /**
   * 跟随系统模式下，CSS 的 `prefers-color-scheme` 已经在起作用，
   * 但 `<meta name="theme-color">` 还是首屏脚本设的那个值。系统切换时要
   * 跟着更新地址栏配色 —— 这里补一次同步（不写 localStorage）。
   */
  useEffect(() => {
    if (theme === null) return;
    if (localStorage.getItem(STORAGE_KEY)) return; // 手动选过，以用户为准
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? DARK_BG : LIGHT_BG);
  }, [theme]);

  const toggle = useCallback(() => {
    const current = readTheme();
    const next: Theme = current === "dark" ? "light" : "dark";
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* 隐私模式忽略 */ }
    apply(next);
  }, []);

  // 首帧未确定主题时占位，保持布局稳定
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={isDark ? "切换到白天模式" : "切换到夜间模式"}
      title={isDark ? "切换到白天模式" : "切换到夜间模式"}
      onClick={toggle}
      // 供测试与读屏判断当前状态；也让"两个实例是否同步"变成可断言的事实
      data-theme-state={theme ?? "pending"}
    >
      {theme === null ? (
        <span className="theme-toggle-ph" aria-hidden />
      ) : isDark ? (
        // 太阳：点击回到白天
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"
                fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : (
        // 月亮：点击进入夜间
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <path d="M20.5 14.3A8.6 8.6 0 1 1 9.7 3.5a6.9 6.9 0 0 0 10.8 10.8z"
                fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
