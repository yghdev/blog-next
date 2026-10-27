"use client";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./LogoutButton";
import { BottomSheet } from "@/components/ui/BottomSheet";

const NAV = [
  { href: "/admin", label: "内容", key: "posts" },
  { href: "/admin/new", label: "写文章", key: "new" },
  { href: "/admin/comments", label: "评论", key: "comments" },
  { href: "/admin/media", label: "图片", key: "media" },
  { href: "/admin/links", label: "外链", key: "links" },
  { href: "/admin/audit", label: "日志", key: "audit" },
  { href: "/admin/storage", label: "存储", key: "storage" },
  { href: "/admin/settings", label: "设置", key: "settings" },
];

/**
 * 后台外壳（B 端设计系统 · 页面骨架）。
 *
 * 三处刻意改动：
 *  1) 顶部导航在手机上横向溢出、七个词挤成一排基本点不准。改成
 *     「顶栏只留站点名 + 菜单键，导航进底部抽屉」，每项 48dp。
 *  2) 顶栏与主体都加了安全区内边距，PWA / 全面屏下不被状态栏与 Home Bar 咬掉。
 *  3) 全部样式走 .admin-* 类，页面里不再写行内魔法数字 —— 否则每个页面
 *     各写一套 padding，永远对不齐。
 */
export function AdminShell({ children, active, username }: {
  children: React.ReactNode; active: string; username: string;
}) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-topbar-inner">
          <Link href="/" className="admin-brand">flechazo</Link>
          <nav className="admin-nav" aria-label="后台导航">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={active === n.key ? "is-active" : undefined}
                aria-current={active === n.key ? "page" : undefined}
              >{n.label}</Link>
            ))}
          </nav>
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

      {/* 手机上没有任何可录入内容，点遮罩关闭是安全结果，所以 maskClosable 默认 true */}
      <BottomSheet open={navOpen} title="后台菜单" onClose={() => setNavOpen(false)}>
        <nav className="sheet-nav">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={active === n.key ? "is-active" : undefined}
              onClick={() => setNavOpen(false)}
            >
              <span>{n.label}</span>
              {active === n.key ? <span aria-hidden>·</span> : null}
            </Link>
          ))}
        </nav>
      </BottomSheet>
    </div>
  );
}
