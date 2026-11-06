import { ThemeToggle } from "./ThemeToggle";

/**
 * 左栏 / 手机抽屉底部的三个动作按钮：主题切换 · RSS · 管理后台（2026-11-06）。
 *
 * ## 为什么单独成组件
 *
 * 桌面左栏底栏与手机抽屉底栏要显示**同一组、同一顺序、同一套图标**的按钮。
 * 之前两处各写一份（桌面是「主题图标 + RSS/设置 文字」，抽屉是「RSS/管理 文字」），
 * 结果一端改了另一端没跟上。现在两处都渲染这个组件，差异只剩外层容器的排版类。
 *
 * ## 只图标的可访问性
 *
 * 三个控件都没有可见文字，所以 `aria-label` 是唯一的可读名；`title` 负责
 * 鼠标悬停提示。缺一个，读屏用户听到的就是空白按钮。
 *
 * ## 图标口径
 *
 * 统一 18×18、`currentColor`、描边 1.55~1.8（与主题按钮的月亮/太阳同一套
 * 线性风格）。RSS 用「实心点 + 两段圆弧」的经典字形；管理后台用齿轮。
 * 不用 emoji —— emoji 在不同平台配色/字形差异很大，且无法跟随 currentColor。
 */
export function SideBottomActions() {
  return (
    <>
      <ThemeToggle />
      <a className="side-icon-btn" href="/rss.xml" title="RSS 订阅" aria-label="RSS 订阅">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <circle cx="6.2" cy="17.8" r="1.9" fill="currentColor" stroke="none" />
          <path d="M5 11.4a7.6 7.6 0 0 1 7.6 7.6" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" />
          <path d="M5 4.9a14.1 14.1 0 0 1 14.1 14.1" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </a>
      <a className="side-icon-btn" href="/admin" title="管理后台" aria-label="管理后台">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M19.1 14.4a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.98 1.47V20a1.94 1.94 0 0 1-3.88 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.98H4a1.94 1.94 0 0 1 0-3.88h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .98-1.47V4a1.94 1.94 0 0 1 3.88 0v.09a1.6 1.6 0 0 0 .98 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.47.98H20a1.94 1.94 0 0 1 0 3.88h-.09a1.6 1.6 0 0 0-1.47.98z"
            fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    </>
  );
}
