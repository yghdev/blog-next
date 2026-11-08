"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SidebarTrigger } from "./SidebarSheet";
import { ThemeToggle } from "./ThemeToggle";
import { useScrollLock } from "./ui/useScrollLock";
import { NAV_ITEMS, activeHref } from "@/lib/nav";
import { Icon } from "./ui/Icon";
import { SideBottomActions } from "./SideBottomActions";
import { HubAvatar } from "./HubAvatar";

/**
 * 导航项来自 `@/lib/nav`（单一事实来源）。
 *
 * 这里原来自己写了一份 NAV，标签与顺序都和桌面的 `Sidebar` 不一样
 * （首页/归档/说说/朋友/关于 vs 文章/说说/归档/友链/关于）。同一站点
 * 两套导航，用户换设备就找不到同一个入口。B-7 起两边共用 `NAV_ITEMS`。
 */

/**
 * 手机端顶部栏：左侧 Logo + 站名，右侧主题切换与搜索。
 *
 * 打开抽屉的两个入口（2026-11-06 起）不在顶栏里，改成右侧的**悬浮按钮组**
 * （`.mobile-dock`）：导航抽屉 + 右侧栏抽屉 + 回到顶部（滚过 400px 才出现）。
 *
 * 这组按钮**所有宽度都渲染**（PC 只显示回到顶部那一枚）—— 用户要的是
 * "回到顶部在任意比例页面都存在，且和侧栏悬浮按钮放在同一处"，
 * 而不是两个分开的浮钮。断点之间的差异由 CSS 的 data-dock 规则控制。
 */
type DrawerLink = { id: number; name: string; url: string; desc: string; kind: string };

export function MobileNav({
  links = [],
  siteName = "flechazo",
}: {
  links?: DrawerLink[];
  /** 站点名称（来自 settings.siteTitle，由 layout 取并传入） */
  siteName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  /**
   * 「回到顶部」是否该出现（2026-11-06）。
   * 滚过 400px 才出现 —— 已经在顶部时不该有个点了没反应的按钮。
   * rAF 合并滚动事件，避免每帧 setState。
   */
  const [showTop, setShowTop] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const [kw, setKw] = useState("");

  // 切换路由时自动关闭
  useEffect(() => { setOpen(false); }, [pathname]);

  // 滚动位置 → 是否显示"回到顶部"（它和菜单/侧栏按钮放在同一个悬浮胶囊里）
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      setShowTop(window.scrollY > 400);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const backToTop = () => {
    const reduce = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  /**
   * 打开时锁死背景滚动。
   *
   * 原来这里写的是 document.body.style.overflow = "hidden" —— iOS Safari
   * 会直接忽略它，用户在抽屉里上下滑，底下的文章列表跟着滚（滚动穿透）。
   * 现在走统一的 useScrollLock（position:fixed + 还原 scrollY），
   * 并且与右侧栏抽屉共用同一把计数锁，两层浮层不会互相提前解锁。
   */
  useScrollLock(open);

  // 左抽屉：Esc 关闭（与右侧侧栏一致）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {searching ? (
        <header className="mobile-topbar mobile-searchbar">
          <form
            className="mobile-search-form"
            onSubmit={(e) => {
              e.preventDefault();
              const q = kw.trim();
              if (q) {
                router.push("/search?q=" + encodeURIComponent(q));
                setSearching(false);
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden className="msi">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              autoFocus
              type="search"
              enterKeyHint="search"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜索文章…"
              aria-label="搜索文章"
            />
            <button type="button" aria-label="取消" onClick={() => { setSearching(false); setKw(""); }}>
              取消
            </button>
          </form>
        </header>
      ) : (
      <header className="mobile-topbar">
        <Link href="/" className="mobile-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/avatar.jpg" alt="" width={28} height={28} onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }} />
          <span>{siteName}</span>
        </Link>
        <div className="mobile-topbar-actions">
          <ThemeToggle />
          <button className="mobile-icon-btn" aria-label="搜索" onClick={() => setSearching(true)}>
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden>
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>
      )}

      {/* 悬浮按钮组：导航菜单 + 右侧栏（2026-11-06 取代顶栏的汉堡/侧栏按钮）。
          桌面隐藏（CSS 断点），层级在抽屉之下，抽屉弹出时自然被盖住。 */}
      <div className={"mobile-dock" + (showTop ? " is-scrolled" : "")}>
        {/* 回到顶部：滚过 400px 才出现；与菜单/侧栏同处一个胶囊 */}
        {showTop ? (
          <>
            <button
              type="button"
              className="mobile-dock-btn"
              data-dock="top"
              aria-label="回到顶部"
              title="回到顶部"
              onClick={backToTop}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                <path d="M12 19.5V6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M6 11.5 12 5.5l6 6" fill="none" stroke="currentColor"
                      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="mobile-dock-sep" aria-hidden />
          </>
        ) : null}
        <button
          type="button"
          className="mobile-dock-btn"
          data-dock="menu"
          aria-label="打开菜单"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            <circle cx="5" cy="7" r="1.3" fill="currentColor" />
            <path d="M9.5 7H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="5" cy="12" r="1.3" fill="currentColor" />
            <path d="M9.5 12H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="5" cy="17" r="1.3" fill="currentColor" />
            <path d="M9.5 17H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <SidebarTrigger className="mobile-dock-btn" dataDock="sidebar" />
      </div>

      {open ? (
        <div className="mobile-drawer-mask" onClick={() => setOpen(false)}>
          <nav
            className="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-drawer-head">
              <span>导航</span>
              <button aria-label="关闭" onClick={() => setOpen(false)}>×</button>
            </div>
            {/* 内容区独立滚动：头部与底栏固定，底栏图标才能始终停在抽屉底部
                （2026-11-06：友链多时整张抽屉原本会连底栏一起滚走） */}
            <div className="mobile-drawer-body">
              {NAV_ITEMS.map((n) => {
                // 与桌面左栏同一套语义（C-10）：视觉上是填充色，读屏上是 aria-current
                const isActive = activeHref(pathname) === n.href;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={"mobile-drawer-item" + (isActive ? " active" : "")}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span className="mi" aria-hidden><Icon name={n.icon} size={18} /></span>
                    {n.label}
                  </Link>
                );
              })}
              {links.length > 0 ? (
                <div className="mobile-drawer-links">
                  <div className="mobile-drawer-links-title">聚合 / 友链</div>
                  {links.map((l) => (
                    <a
                      key={l.id}
                      className="mobile-drawer-link"
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={l.desc || l.name}
                    >
                      {l.kind === "hub"
                        ? <HubAvatar name={l.name} url={l.url} />
                        : <span className="mi" aria-hidden><Icon name="link" size={18} /></span>}
                      <span className="mobile-drawer-link-name">{l.name}</span>
                      <span className="mobile-drawer-link-out" aria-hidden>↗</span>
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
            {/* 与桌面左栏底栏同一组图标按钮（2026-11-06 需求：移动端同步） */}
            <div className="mobile-drawer-foot">
              <SideBottomActions />
            </div>
          </nav>
        </div>
      ) : null}

    </>
  );
}
