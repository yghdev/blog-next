"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * 栅格叠加层开关（?grid=1，2026-11-08 栅格化）。
 *
 * ## 它做什么
 *
 * 在 <html> 上打 `data-grid="1"`，剩下的事全在 CSS 里：
 *   · app/globals.css 的 `html[data-grid="1"] .content::before` —— 前台的
 *     12 列内容栅格 + 8px 纵向刻度；
 *   · app/admin/admin.css 的 `html[data-grid="1"] .admin-main::before` ——
 *     后台同一套，只是画在内容盒里。
 *
 * ## 为什么是客户端属性，而不是服务端渲染一个覆盖层
 *
 * 1. **零成本**：不带参数时组件返回 `null`，DOM 里什么都没有；服务端 HTML
 *    与不开栅格时逐字节相同，因此 nginx 的 30s 微缓存、SEO、分享卡都不受影响。
 * 2. **不碰 CSP**：不注入 <script>、不写内联 style（主题防闪烁脚本那种
 *    内联脚本要额外维护 CSP 白名单，这里没有理由付那个代价）。
 * 3. **不进构建产物分支**：没有 `process.env.NODE_ENV` 门禁 —— 线上也能用
 *    它核对对齐（这正是它的用途之一）。
 *
 * ## 为什么不用 useSearchParams
 *
 * `useSearchParams()` 会让所在的那棵树在构建期被判成"需要 Suspense 边界"，
 * 而本组件挂在根布局上 —— 一旦某个页面是静态预渲染，构建就会报
 * 「useSearchParams() should be wrapped in a suspense boundary」。
 * 这里只需要"读一次 location.search"，用 `usePathname()` 触发重新同步
 * 就够了：客户端路由跳转一定会换 pathname。
 *
 * 同路径只改 query 的跳转（例如首页翻页 `/?page=2`）不会重新同步 ——
 * 那种情况下先滚动一下或刷新一次即可，对调试工具来说可以接受。
 */
const ATTR = "data-grid";

export function GridOverlay() {
  const pathname = usePathname();

  useEffect(() => {
    const root = document.documentElement;

    const sync = () => {
      /*
       * 只认 `grid=1`：`?grid`、`?grid=0`、`?grid=true` 都视为关闭。
       * 调试开关不该有模糊语义 —— 「怎么关」必须是一个确定的事实。
       */
      const on = new URLSearchParams(window.location.search).get("grid") === "1";
      if (on) root.setAttribute(ATTR, "1");
      else root.removeAttribute(ATTR);
    };

    sync();

    /*
     * 浏览器前进/后退会换掉 query 却不触发 React 路由更新（同 pathname），
     * 所以在 /?grid=1 ↔ / 之间来回时得靠 popstate 补一次。
     */
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      // 卸载（例如整棵树被替换）时别把属性留在 <html> 上
      root.removeAttribute(ATTR);
    };
  }, [pathname]);

  return null;
}
