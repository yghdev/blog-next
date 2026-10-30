"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * 访客埋点（2026-10-30）。
 *
 * 只上报「看了哪个路径」和一个来源域名。身份在服务端算（IP + UA 的 HMAC），
 * 这里**拿不到也改不了** visitor —— 也就没有可以被客户端伪造的访客身份。
 *
 * ## 三个必须处理好的细节
 *
 * 1) **SPA 的 `document.referrer` 是陈旧的**
 *    它记录的是「本文档加载时」的来源，客户端路由切换不会更新它。
 *    如果每条上报都带 referrer，那么一次从 Google 进来的访问会把后续
 *    所有 PV 都记成 Google —— 来源报表会系统性高估外部渠道。
 *    所以只有**首次上报**才带 referrer，服务端也只对 is_entry 归因；
 *    两处一致，会话入口才是唯一的来源。
 *
 * 2) **bfcache 恢复不算新访问**
 *    浏览器后退回来时 `pageshow.persisted === true`，页面没有重新加载。
 *
 * 3) **统计失败绝不影响页面**
 *    `keepalive` 让请求能在页面卸载时发完；失败静默，不重试、不提示。
 */

/** 模块级去重：StrictMode 会双调用 effect，同一次导航只该报一次 */
let lastReported = "";

/** 来源只在页面生命周期内第一次上报时发送 */
let referrerSent = false;

export function VisitorBeacon() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;

    // 后台与接口不该被统计（服务端也会拦一次，这里是双保险）
    if (/^\/(admin|api|_next|preview)(\/|$)/.test(pathname)) return;

    // 同一次导航不重复上报（StrictMode / 快速重复渲染）
    if (lastReported === pathname) return;
    lastReported = pathname;

    const referrer = referrerSent ? "" : (typeof document !== "undefined" ? document.referrer : "");
    referrerSent = true;

    try {
      void fetch("/api/hit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: pathname, referrer }),
        // keepalive：允许在页面卸载/跳转中把请求发完（上限 64KB，这里只有几十字节）
        keepalive: true,
        // 必须带上 cookie：服务端要靠 blog_session 排除管理员，
        // 而该 cookie 是 httpOnly，前端读不到内容，只能让浏览器自动带
        credentials: "same-origin",
      }).catch(() => { /* 统计失败不影响任何功能 */ });
    } catch {
      /* 极端情况下 fetch 同步抛错（如被 CSP 拦），同样吞掉 */
    }
  }, [pathname]);

  // bfcache 恢复：浏览器后退回来时页面没有重新加载，不应再算一次访问
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        // 恢复的页面不该重复计入，把去重标记对齐到当前路径
        lastReported = window.location.pathname;
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return null;
}
