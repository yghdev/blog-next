"use client";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./LogoutButton";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * 后台导航（方案 §9.1：四组任务导航，「写文章」常驻）。
 *
 * 布局分两套，不是"同一套挤一挤"：
 *   桌面（>820px）：**左侧侧栏**。四组纵向排列，组标题可见。
 *   手机（≤820px）：顶栏只留站点名 + 菜单键，导航进底部抽屉，每项 48dp。
 *
 * 为什么桌面必须是侧栏而不是顶栏：
 *   四组共 9 项（设置拆页后还会更多），排在顶栏一行里 920px 装不下，
 *   只能横向滚动 —— 而"需要滚动才能看到全部导航"本身就是导航失败。
 *   侧栏纵向有无限空间，分组标题才能真的呈现出层次。
 *
 * 上一版这里写的是"侧栏分组导航"，但实际实现是顶部栏单行、分组标题只在
 * 抽屉里出现 —— 名不副实，已在本版纠正为真正的侧栏。
 *
 * 「写文章」不做进任何一组：它是后台唯一高频主操作，埋在分组里每次多两跳。
 * 桌面在侧栏顶部；手机在抽屉顶部（整行 48dp）。
 *
 * key 与既有页面 active 值保持兼容：内容列表仍叫 posts，避免为导航改名
 * 去动一堆页面传参。
 */
type NavItem = { href: string; label: string; key: string };

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "工作",
    items: [{ href: "/admin/overview", label: "概览", key: "overview" },
      { href: "/admin", label: "内容", key: "posts" }],
  },
  {
    title: "内容",
    items: [

      { href: "/admin/comments", label: "评论", key: "comments" },
      { href: "/admin?trash=1", label: "回收站", key: "trash" },
    ],
  },
  {
    title: "资源",
    items: [
      { href: "/admin/media", label: "媒体", key: "media" },
      { href: "/admin/links", label: "外链", key: "links" },
      { href: "/admin/storage", label: "存储", key: "storage" },
      { href: "/admin/audit", label: "日志", key: "audit" },
    ],
  },
  {
    title: "系统",
    items: [{ href: "/admin/settings", label: "设置", key: "settings" }],
  },
];

export function AdminShell({ children, active, username }: {
  children: React.ReactNode; active: string; username: string;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const isActive = (key: string) => active === key;

  return (
    <div className="admin-shell">
      {/* ── 桌面侧栏（≤820px 由 CSS 隐藏，改用顶栏 + 抽屉）── */}
      <aside className="admin-sidebar">
        <Link href="/" className="admin-brand admin-sidebar-brand">flechazo</Link>

        <Link href="/admin/new" className="btn btn-primary admin-side-compose">
          写文章
        </Link>

        <nav className="admin-side-nav" aria-label="后台导航">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="admin-side-group">
              {/* 分组标题只做视觉层次，不参与导航语义，所以 aria-hidden */}
              <div className="admin-side-title" aria-hidden="true">{group.title}</div>
              {group.items.map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  className={isActive(n.key) ? "is-active" : undefined}
                  aria-current={isActive(n.key) ? "page" : undefined}
                >{n.label}</Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="admin-sidebar-foot">
          <div className="admin-foot-cluster">
            <ThemeToggle />
            <LogoutButton username={username} />
          </div>
        </div>
      </aside>

      <div className="admin-body">
        {/* ── 手机顶栏（>820px 由 CSS 隐藏）── */}
        <header className="admin-topbar">
          <div className="admin-topbar-inner">
            <Link href="/" className="admin-brand">flechazo</Link>
            <span className="admin-topbar-fill" />
            <ThemeToggle />
            <button
              className="admin-menu-btn"
              aria-label="打开后台菜单"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden>
                <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor"
                      strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <LogoutButton username={username} />
          </div>
        </header>

        <main className="admin-main">{children}</main>
      </div>

      {/* 手机上没有任何可录入内容，点遮罩关闭是安全结果，所以 maskClosable 默认 true */}
      <BottomSheet open={navOpen} title="后台菜单" onClose={() => setNavOpen(false)}>
        <Link
          href="/admin/new"
          className="btn btn-primary admin-sheet-compose"
          onClick={() => setNavOpen(false)}
        >
          写文章
        </Link>
        <nav className="sheet-nav" aria-label="后台导航">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="sheet-nav-group">
              <div className="sheet-nav-title" aria-hidden="true">{group.title}</div>
              {group.items.map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  className={isActive(n.key) ? "is-active" : undefined}
                  aria-current={isActive(n.key) ? "page" : undefined}
                  onClick={() => setNavOpen(false)}
                >
                  <span>{n.label}</span>
                  {isActive(n.key) ? <span aria-hidden>·</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </BottomSheet>
    </div>
  );
}
