"use client";
import { useEffect } from "react";

/**
 * 浮层打开时锁死底层页面滚动（移动端设计系统 · 坑点二）。
 *
 * 为什么不能只写 body.style.overflow = "hidden"：
 *   iOS Safari 忽略 body 上的 overflow:hidden，手指照样能滚动底层页面，
 *   于是抽屉里上下滑，结果底下文章列表在动 —— 这就是「滚动穿透」。
 *
 * 正解：把 body 钉成 position:fixed 并记录当前 scrollY，关闭时原样还原。
 * 注意 top 必须取负的 scrollY，否则页面会瞬间跳到顶部。
 *
 * 计数器：抽屉里可能再叠一个对话框，二者会先后调用本 hook。
 * 用模块级计数保证「最后一个关闭的人」才真正解锁，避免内层浮层一关
 * 外层抽屉就跟着解锁穿透。
 */
let lockCount = 0;
let savedY = 0;
let savedStyles: { position: string; top: string; width: string; overflow: string } | null = null;

function lock() {
  if (lockCount === 0) {
    const body = document.body;
    savedY = window.scrollY;
    savedStyles = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = "fixed";
    body.style.top = -savedY + "px";
    body.style.width = "100%";
    body.style.overflow = "hidden";
  }
  lockCount += 1;
}

function unlock() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0) return;
  const body = document.body;
  if (savedStyles) {
    body.style.position = savedStyles.position;
    body.style.top = savedStyles.top;
    body.style.width = savedStyles.width;
    body.style.overflow = savedStyles.overflow;
    savedStyles = null;
  } else {
    body.style.position = "";
    body.style.top = "";
    body.style.width = "";
    body.style.overflow = "";
  }
  window.scrollTo(0, savedY);
}

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    lock();
    return unlock;
  }, [active]);
}
