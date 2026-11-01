"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SidebarTrigger } from "./SidebarSheet";
import { ThemeToggle } from "./ThemeToggle";
import { NAV_ITEMS, activeHref } from "@/lib/nav";

/**
 * 桌面端左侧栏 —— 参照 xaoxuu.com：居中大头像 + 衬线站名 + 虚线搜索框 + 图标导航
 *
 * ## 为什么是客户端组件（B-7）
 *
 * `active` 原来是**页面传进来的字符串**：`<Sidebar active="/archives" />`。
 * 漏写或写错不会报错，只是那个页面没有选中态 —— 实测漏了 3 个
 * （`/about`、`/tags/*`、`/search`）。改成 `usePathname()` 自判之后，
 * 「忘写」这个错误在类型上就不可能发生：`Sidebar` 不再接受 `active`。
 *
 * 代价是多带一点 JS，但它本来就 import 了两个客户端组件
 * （`SidebarTrigger` / `ThemeToggle`），并非纯静态。
 */
export function Sidebar({
  siteName = "flechazo",
  siteDesc = "记录 AI、开发与折腾的日常",
}: {
  /** 站点名称（来自 settings.siteTitle，由 SiteShell 取并传入） */
  siteName?: string;
  /** 站点简介（来自 settings.siteDescription） */
  siteDesc?: string;
} = {}) {
  const pathname = usePathname();
  const current = activeHref(pathname);

  return (
    <aside className="sidebar">
      {/* 品牌区：居中大头像 + 名字 + 标语 */}
      <Link href="/" className="brand-block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/avatar.jpg" alt={siteName} className="brand-photo" />
        <div className="brand-title">{siteName}</div>
        <div className="brand-desc">{siteDesc}</div>
      </Link>

      {/* 虚线边框的搜索框 */}

      {/* 图标导航 */}
      <nav className="nav">
        {NAV_ITEMS.map((n) => {
          const isActive = current === n.href;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={"nav-item" + (isActive ? " is-active" : "")}
            >
              <span className="nav-ico">{n.icon}</span>
              <span className="nav-txt">{n.label}</span>
              {isActive ? <span className="nav-dot" /> : null}
            </Link>
          );
        })}
      </nav>


      {/* 平板（821~1391px，B-3 起）：右栏已隐藏但顶栏还没出现，
          这里补一个侧栏入口，避免这一区间完全看不到统计/外链/标签。
          ≤820px 时左栏整体隐藏，此按钮自然不可见。 */}
      <div className="side-sheet-entry">
        <SidebarTrigger className="side-sheet-btn" />
        <span>侧栏</span>
      </div>

      {/* 亮/暗主题切换：桌面放在左栏底部，手机在顶栏（见 MobileNav） */}
      <div className="side-theme">
        <ThemeToggle />
      </div>

      <div className="side-bottom">
        <a href="/rss.xml" title="RSS">RSS</a>
        <a href="/admin" title="管理后台">设置</a>
      </div>
    </aside>
  );
}
