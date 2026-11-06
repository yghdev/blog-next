"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SideBottomActions } from "./SideBottomActions";
import { NAV_ITEMS, activeHref } from "@/lib/nav";

/**
 * 桌面端左侧栏 —— 居中大头像 + 衬线站名 + 图标导航（C-10 重做选中态）
 *
 * ## 为什么是客户端组件（B-7）
 *
 * `active` 原来是**页面传进来的字符串**：`<Sidebar active="/archives" />`。
 * 漏写或写错不会报错，只是那个页面没有选中态 —— 实测漏了 3 个
 * （`/about`、`/tags/*`、`/search`）。改成 `usePathname()` 自判之后，
 * 「忘写」这个错误在类型上就不可能发生：`Sidebar` 不再接受 `active`。
 *
 * 代价是多带一点 JS，但它本来就 import 了两个客户端组件
 * （`SideBottomActions` 里的 `ThemeToggle`），并非纯静态。
 *
 * ## 选中态的语言（C-10）
 *
 * 只用**填充色**：不加红点、不加描边/投影、不做任何位移（理由见 globals.css
 * 的「左侧栏导航（C-10 重做）」）。同时补上 `aria-current="page"` ——
 * 视觉玩家看到的是填充，读屏用户听到的也应该是"当前页"，两者不能只有一半。
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

      {/* 图标导航：选中项只有填充色（见 globals.css） */}
      <nav className="nav">
        {NAV_ITEMS.map((n) => {
          const isActive = current === n.href;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={"nav-item" + (isActive ? " is-active" : "")}
              aria-current={isActive ? "page" : undefined}
            >
              {/* 图标 + 文字作为一组，但**文字本身**居中：图标绝对定位到文字左侧，
                  不参与居中计算（2026-11-06 用户要求「菜单文字居中」）。 */}
              <span className="nav-label">
                <span className="nav-ico" aria-hidden>{n.icon}</span>
                <span className="nav-txt">{n.label}</span>
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="side-bottom-wrap">
        <div className="side-bottom">
          <SideBottomActions />
        </div>
      </div>
    </aside>
  );
}
