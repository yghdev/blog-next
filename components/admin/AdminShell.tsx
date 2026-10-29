"use client";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./LogoutButton";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CommandPalette } from "./CommandPalette";
import { NAV_COLLAPSE_COOKIE, NAV_GROUPS, readCollapsedCookie } from "./nav-config";
import { useInitialCollapsed } from "./AdminNavContext";

/**
 * 后台导航（四组任务导航，「写文章」常驻）。
 *
 * 布局分两套，不是"同一套挤一挤"：
 *   桌面（>820px）：**左侧侧栏** 224px。四组纵向排列，组头可折叠。
 *   手机（≤820px）：顶栏只留品牌 + 菜单键，导航进底部抽屉，每组可折叠。
 *
 * 为什么桌面必须是侧栏而不是顶栏：四组共 8 项，排在顶栏一行里装不下，
 * 只能横向滚动 —— 而"需要滚动才能看到全部导航"本身就是导航失败。
 *
 * 层级靠三件事区分，不靠多加装饰：
 *   1. 组头是**按钮**（12px / 600 / 0.08em 字距 + 一条细线 + 折叠箭头），
 *      比旧版 11px 的「不可交互小字」大一档、深一档，像章节标签而不是导航项；
 *   2. 子项缩进 13px，左侧一条 1px 导轨把它们收进组里；
 *   3. 选中项品牌浅底 + 2px 竖条，所在组的组头同步提亮、细线与导轨换成品牌色。
 * 这样即使整组折叠，用户也能从组头看出"当前在哪一组"。
 *
 * 折叠状态由**服务端**从 cookie（NAV_COLLAPSE_COOKIE）读出后传入，
 * 客户端点击时同时写 cookie 与本地 state。为什么不放 localStorage：
 * localStorage 只能等 hydration 之后才读到，导航瞬间会先按"全展开"渲染
 * 再自己合上 —— 实测有 80–90ms 的闪烁。cookie 让首帧就是最终状态。
 * 点击立即改本地 state（不等下一次渲染），cookie 只是给下一次导航用。
 *
 * 两条防「失踪」规则：
 *   - 进入页面时当前组由服务端强制展开（本地偏好里它是收起的也不作数）；
 *   - 用户手动收起当前组也允许（他想腾地方），此时组头保留品牌竖条，
 *     「我在哪一组」仍有线索。
 * 组头是 <button aria-expanded>，收起时内容加 inert，读屏与 Tab 都不会
 * 进入不可见区域。
 *
 * 「写文章」不做进任何一组：它是后台唯一高频主操作，埋在分组里每次多两跳。
 * 桌面在侧栏顶部（带 Cmd/Ctrl+K 提示，因为命令面板也能新建），
 * 手机在抽屉顶部（整行 48dp）。
 *
 * 分组与名称严格对齐现有路由与真实功能：
 *   - 2026-10-29 起文章 / 说说 / 页面各自独立成页（/admin、/admin/shuoshuo、
 *     /admin/pages）：说说没有标题，和文章挤在一个列表里只能显示「无标题」
 *   - 回收站独立成 /admin/trash（操作集与正常列表不同）
 *   - 存储配置已在阶段 02-5 并入设置，仍不在导航里单列
 * key 与既有页面 active 值保持兼容：文章列表仍叫 posts。
 */
function Chevron() {
  return (
    <svg className="fx-nav-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden>
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor"
            strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AdminShell({ children, active, username }: {
  children: React.ReactNode; active: string; username: string;
}) {
  const collapsedGroups = useInitialCollapsed();
  const [navOpen, setNavOpen] = useState(false);
  const isActive = (key: string) => active === key;
  const currentGroup = NAV_GROUPS.find((g) => g.items.some((n) => isActive(n.key)))?.key;

  /**
   * 首帧即最终状态：初值来自服务端 cookie。
   * 当前组一律展开 —— 打开页面看不见自己在哪，比省 80px 更糟。
   */
  const initialCollapsed = () => {
    const next: Record<string, boolean> = {};
    // 客户端路由不重渲染布局，Context 可能落后；cookie 是最新值
    const keys = readCollapsedCookie() ?? collapsedGroups;
    for (const key of keys) {
      if (key !== currentGroup && NAV_GROUPS.some((g) => g.key === key)) next[key] = true;
    }
    return next;
  };
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(initialCollapsed);

  /**
   * 写 cookie：只存组 key 列表，path 限定在后台。
   * document.cookie 是同步的，写失败（隐私模式）不影响本次会话的 state。
   */
  const persist = (next: Record<string, boolean>) => {
    const value = Object.keys(next).filter((k) => next[k]).join(",");
    try {
      document.cookie = NAV_COLLAPSE_COOKIE + "=" + value + "; path=/admin; max-age=31536000; SameSite=Lax";
    } catch { /* 存不了只是不记偏好，不阻断导航 */ }
  };

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      persist(next);
      return next;
    });
  };

  return (
    <div className="admin-shell fx-scope">
      {/* ── 桌面侧栏（≤820px 由 CSS 隐藏，改用顶栏 + 抽屉）── */}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand">
          <Link href="/" className="fx-brandmark">flechazo</Link>
          {/* 品牌注脚：说明这是哪个站点的后台，而不是一个通用工作台 */}
          <span className="fx-brand-sub">妄司逸的小世界</span>
        </div>

        <Link href="/admin/new" className="admin-side-compose">
          写文章
          <kbd aria-hidden="true">⌘K</kbd>
        </Link>

        <nav className="admin-side-nav" aria-label="后台导航">
          {NAV_GROUPS.map((group) => {
            const isCollapsed = !!collapsed[group.key];
            const isCurrent = currentGroup === group.key;
            const panelId = "admin-nav-panel-" + group.key;
            return (
              <div
                key={group.key}
                className="admin-side-group"
                data-key={group.key}
                data-collapsed={isCollapsed}
                data-current={isCurrent}
              >
                <button
                  type="button"
                  className="admin-side-group-toggle"
                  aria-expanded={!isCollapsed}
                  aria-controls={panelId}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span className="admin-side-title">{group.title}</span>
                  <span className="admin-side-rule" aria-hidden="true" />
                  <Chevron />
                </button>
                <div id={panelId} className="admin-side-group-body" inert={isCollapsed || undefined}>
                  <div className="admin-side-group-clip">
                    <div className="admin-side-group-links">
                      {group.items.map((n) => (
                        <Link
                          key={n.key}
                          href={n.href}
                          className={isActive(n.key) ? "is-active" : undefined}
                          aria-current={isActive(n.key) ? "page" : undefined}
                        >{n.label}</Link>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
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
            <Link href="/" className="fx-brandmark">flechazo</Link>
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
          {NAV_GROUPS.map((group) => {
            const isCollapsed = !!collapsed[group.key];
            const isCurrent = currentGroup === group.key;
            const panelId = "sheet-nav-panel-" + group.key;
            return (
              <div
                key={group.key}
                className="sheet-nav-group"
                data-key={group.key}
                data-collapsed={isCollapsed}
                data-current={isCurrent}
              >
                <button
                  type="button"
                  className="sheet-nav-toggle"
                  aria-expanded={!isCollapsed}
                  aria-controls={panelId}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span className="sheet-nav-title">{group.title}</span>
                  <span className="sheet-nav-rule" aria-hidden="true" />
                  <Chevron />
                </button>
                <div id={panelId} className="sheet-nav-body" inert={isCollapsed || undefined}>
                  <div className="sheet-nav-clip">
                    <div className="sheet-nav-links">
                      {group.items.map((n) => (
                        <Link
                          key={n.key}
                          href={n.href}
                          className={isActive(n.key) ? "is-active" : undefined}
                          aria-current={isActive(n.key) ? "page" : undefined}
                          onClick={() => setNavOpen(false)}
                        >
                          <span>{n.label}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </nav>
      </BottomSheet>

      {/* 命令面板挂在壳里：所有后台页面都能 Ctrl/Cmd+K 唤起 */}
      <CommandPalette />
    </div>
  );
}
