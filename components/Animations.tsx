"use client";
import { useEffect } from "react";

/**
 * 进场动画 + 卡片光斑跟随（F12，2026-11-07）。
 *
 * 三条约束，缺一条就会在低端设备或无障碍场景下变成负担：
 *
 *   1. **`prefers-reduced-motion: reduce` 时完全不做**：不挂
 *      IntersectionObserver、不监听 mousemove。CSS 那边虽然已经把
 *      `.slide-up` 直接设为可见，但 JS 仍会每帧算 getBoundingClientRect ——
 *      那是纯浪费，而且光斑本身也是"动效"，用户明确说了不要。
 *
 *   2. **光斑只在 `(pointer: fine)` 上启用**：触屏没有 hover，mousemove
 *      在移动端要么不触发、要么在触摸时触发一次，纯属噪音。
 *
 *   3. **mousemove 用 requestAnimationFrame 节流**：原实现每次 mousemove
 *      都同步调 getBoundingClientRect（强制同步布局），一帧内多次触发就会
 *      反复 reflow。现在一帧最多算一次，且只算最后一次的位置。
 */
export function Animations() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;

    let io: IntersectionObserver | null = null;
    if (!reduce) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              e.target.classList.add("in");
              io?.unobserve(e.target);
            }
          });
        },
        { rootMargin: "0px 0px -40px 0px" }
      );
      document.querySelectorAll(".slide-up").forEach((el) => io?.observe(el));
    }

    // 光斑：只在"精细指针 + 未要求减弱动效"时启用
    const spotlight = !reduce && finePointer;
    let raf = 0;
    let pending: MouseEvent | null = null;

    const apply = () => {
      raf = 0;
      const ev = pending;
      pending = null;
      if (!ev) return;
      const el = ev.target as Element | null;
      const target = el?.closest?.(".post-card") as HTMLElement | null;
      if (!target) return;
      const r = target.getBoundingClientRect();
      target.style.setProperty("--mx", `${ev.clientX - r.left}px`);
      target.style.setProperty("--my", `${ev.clientY - r.top}px`);
    };

    const onMove = (ev: MouseEvent) => {
      pending = ev;
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };

    if (spotlight) document.addEventListener("mousemove", onMove, { passive: true });

    return () => {
      io?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (spotlight) document.removeEventListener("mousemove", onMove);
    };
  }, []);
  return null;
}
