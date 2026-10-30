"use client";
import { useCallback, useEffect, useRef } from "react";

/**
 * 「提交友链申请 ↓」的滚动入口。
 *
 * 为什么不用一个普通的 `<a href="#comments">`：
 *
 *   - 评论是 Artalk 在客户端挂载的，锚点目标在首帧还不存在，原生锚点会
 *     直接跳到页底或原地不动；这里改为先找到节点再滚。
 *   - 本站 `html { scroll-behavior: auto }`（见 globals.css 的说明：关闭平滑
 *     滚动是为了不让前进/后退时逐帧滚动）。所以平滑滚动只能由这次点击显式发起。
 *   - `prefers-reduced-motion: reduce` 时必须走瞬时跳转 —— 用户明确要求少动效。
 *   - 顶部有 sticky 顶栏，滚动位置要扣掉它的高度，否则标题会被压在栏下面。
 *
 * 另一个细节：评论区未渲染时（全站评论关闭 / 本页关闭），按钮降级成一句提示，
 * 不把用户送到一个不存在的锚点。
 */
export function JumpToComments({
  targetId = "comments",
  enabled,
  compact = false,
}: {
  targetId?: string;
  enabled: boolean;
  /** 空状态里用的小号链接：不占整行，不重复主 CTA 的重量 */
  compact?: boolean;
}) {
  const linkRef = useRef<HTMLAnchorElement>(null);

  const jump = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!enabled) return;
      const el = document.getElementById(targetId);
      if (!el) return; // 让浏览器按 href 的降级行为处理
      e.preventDefault();

      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const bar = document.querySelector(".mobile-topbar");
      // 顶栏只在手机上显示；桌面端它的 computed display 是 none，高度按 0 算
      const barH = bar instanceof HTMLElement && getComputedStyle(bar).display !== "none"
        ? bar.getBoundingClientRect().height
        : 0;
      const top = el.getBoundingClientRect().top + window.scrollY - barH - 16;

      window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });

      // 焦点跟着过去：键盘/读屏用户点完后 Tab 应该从评论区继续，
      // 而不是从页首重新数一遍。目标区块本身是 tabIndex={-1} 的。
      // preventScroll 避免和上面的平滑滚动抢位置。
      window.setTimeout(() => el.focus({ preventScroll: true }), reduce ? 0 : 320);

      // 地址栏同步 hash，刷新/分享仍能回到评论区；用 replaceState 不新增历史记录
      if (history.replaceState) history.replaceState(null, "", "#" + targetId);
    },
    [enabled, targetId]
  );

  useEffect(() => {
    if (!enabled) return;
    // 带 hash 直接进入本页（从别处分享的链接）时，等评论区挂载后再滚一次
    if (window.location.hash !== "#" + targetId) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(targetId);
      if (!el) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const bar = document.querySelector(".mobile-topbar");
      const barH = bar instanceof HTMLElement && getComputedStyle(bar).display !== "none"
        ? bar.getBoundingClientRect().height
        : 0;
      window.scrollTo({
        top: el.getBoundingClientRect().top + window.scrollY - barH - 16,
        behavior: reduce ? "auto" : "smooth",
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [enabled, targetId]);

  if (!enabled) {
    return (
      <p className={compact ? "fr-apply-off fr-apply-off-sm" : "fr-apply-off"}>
        本站评论暂时关闭，可以通过「关于」页里的联系方式提交申请。
      </p>
    );
  }

  return (
    <a
      ref={linkRef}
      className={"fr-apply-link" + (compact ? " fr-apply-link-sm" : "")}
      href={"#" + targetId}
      onClick={jump}
    >
      提交友链申请
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
        <path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}
