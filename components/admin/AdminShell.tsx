"use client";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./LogoutButton";
import { BottomSheet } from "@/components/ui/BottomSheet";

/**
 * 后台导航（方案 §9.1：四组任务导航，「写文章」常驻）。
 *
 * 为什么改分组：原来 8 个平铺词条没有层次，"内容"和"存储""设置"混在一排，
 * 新用户要先读一遍才知道后台能干什么。按任务分组后，每组回答一个问题：
 *   工作 —— 今天要处理什么
 *   内容 —— 我写了什么
 *   资源 —— 素材和文件在哪
 *   系统 —— 站点本身怎么配
 *
 * 「写文章」不做进任何一组，而是常驻在主操作位（顶栏右侧 / 抽屉顶部），
 * 因为它是后台唯一的高频主操作，埋在分组里每次多两跳。
 *
 * key 与既有页面 active 值保持兼容：内容列表仍叫 posts，避免为了导航改名
 * 而去改一堆页面传参（那属于无收益的连带改动）。
 */
type NavItem = { href: string; label: string; key: string; hint?: string };

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "工作",
    items: [
      { href: "/admin/overview", label: "概览", key: "overview", hint: "待办与最近编辑" },
    ],
  },
  {
    title: "内容",
    items: [
      { href: "/admin", label: "文章", key: "posts" },
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
    items: [
      { href: "/admin/settings", label: "设置", key: "settings" },
    ],
  },
];

/** 扁平化，供手机抽屉与顶栏复用（两处必须同源，否则迟早不一致） */
const NAV_FLAT = NAV_GROUPS.flatMap((g) => g.items);

/**
 * 后台外壳（B 端设计系统 · 页面骨架）。
 *
 * 三处刻意改动：
 *  1) 顶部导航在手机上横向溢出、七个词挤成一排基本点不准。改成
 *     「顶栏只留站点名 + 主操作 + 菜单键，导航进底部抽屉」，每项 48dp。
 *  2) 顶栏与主体都加了安全区内边距，PWA / 全面屏下不被状态栏与 Home Bar 咬掉。
 *  3) 全部样式走 .admin-* 类，页面里不再写行内魔法数字 —— 否则每个页面
 *     各写一套 padding，永远对不齐。
 *
 * 桌面顶栏容量是真问题：8 个平铺词条在 920px 宽度里已经接近上限，
 * 再加分组标题必然挤爆。所以桌面端**保持单行紧凑导航**（只显示分组内的项，
 * 不显示分组标题），分组层次只在抽屉里以标题形式出现。
 * 这不是妥协：桌面有足够横向空间形成扫读节奏，手机没有。
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
            {NAV_FLAT.map((n) => (
              <Link
                key={n.key}
                href={n.href}
                className={active === n.key ? "is-active" : undefined}
                aria-current={active === n.key ? "page" : undefined}
              >{n.label}</Link>
            ))}
          </nav>
          {/* 主操作常驻：写文章是后台唯一高频动作，不该藏进分组 */}
          <Link href="/admin/new" className="btn btn-primary btn-sm admin-compose">写文章</Link>
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
              {/* 分组标题只是视觉层次，不参与导航语义，所以不是 listitem/link */}
              <div className="sheet-nav-title" aria-hidden="true">{group.title}</div>
              {group.items.map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  className={active === n.key ? "is-active" : undefined}
                  aria-current={active === n.key ? "page" : undefined}
                  onClick={() => setNavOpen(false)}
                >
                  <span>{n.label}</span>
                  {active === n.key ? <span aria-hidden>·</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </BottomSheet>
    </div>
  );
}
