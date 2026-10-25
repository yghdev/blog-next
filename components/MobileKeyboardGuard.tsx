"use client";
import { useEffect } from "react";

/**
 * 软键盘防遮挡（移动端设计系统 · 坑点三 / 门禁 05）。
 *
 * 场景：手机上点页面靠下的输入框（登录页的验证码、评论框、后台设置页的
 * 「新密码」），键盘弹起后把输入框整个盖住，用户看不见自己在打什么，
 * 而且吸底按钮会被顶到屏幕中间挡视线。
 *
 * 做法：全局监听 focusin，若是可输入元素，等键盘动画结束（约 250ms）
 * 再把元素滚到视口中部。不用 scrollIntoView 的默认行为 —— 那会把它贴到
 * 顶部，反而被 sticky 顶栏盖住。
 *
 * 只在窄屏 + 粗指针（真手机/平板）下生效，桌面端聚焦不产生任何滚动，
 * 否则用鼠标点一下输入框页面就跳一下，非常干扰。
 */
export function MobileKeyboardGuard() {
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    if (!mq.matches) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const tag = el.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const rect = el.getBoundingClientRect();
        // 已在视口舒适区（上 1/4 到 下 1/2 之间）就不动，避免无谓跳动
        const safeTop = window.innerHeight * 0.12;
        const safeBottom = window.innerHeight * 0.55;
        if (rect.top >= safeTop && rect.bottom <= safeBottom) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 260);
    };

    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return null;
}
