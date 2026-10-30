"use client";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./LogoutButton";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CommandPalette } from "./CommandPalette";
import { NAV_COLLAPSE_COOKIE, NAV_GROUPS, readCollapsedCookie } from "./nav-config";
import { useInitialCollapsed } from "./AdminNavContext";
import {
  IconArchive, IconChat, IconComment, IconExternal, IconGrid, IconLog,
  IconMedia, IconNote, IconPage, IconPen, IconSliders,
} from "./editor-icons";

/**
 * 后台导航（四组任务导航，「写文章」常驻）。
 *
 * 布局分两套，不是"同一套挤一挤"：
 *   桌面（>820px）：**左侧侧栏** 232px。四组纵向排列，组头可折叠。
 *   手机（≤820px）：顶栏只留品牌 + 菜单键，导航进底部抽屉，每组可折叠。
 *
 * 为什么桌面必须是侧栏而不是顶栏：四组共 10 项，排在顶栏一行里装不下，
 * 只能横向滚动 —— 而"需要滚动才能看到全部导航"本身就是导航失败。
 *
 * 层级只靠三件事，不靠装饰（2026-10-30 改版）：
 *   1. 分组标题：12px / 600 / 0.1em 字距、低对比灰 —— 是"章节名"，不是菜单项，
 *      也不再拖一条横线假装表头；箭头与标题同一基线，整行可点但很轻。
 *   2. 菜单项：统一的左缩进 + 16px 线性图标 + 13px 文字，高 34px；
 *      不再画贯穿整组 1px 竖导轨 —— 缩进本身已经说明了层级。
 *   3. 选中态：浅品牌底 + 深品牌字 + 500 字重，**不再叠 2px 竖条**；
 *      与顶部实心墨绿「写文章」形成"主操作"和"当前位置"的明确区分。
 *
 * 折叠状态由**服务端**从 cookie（NAV_COLLAPSE_COOKIE）读出后传入，
 * 客户端点击时同时写 cookie 与本地 state。为什么不放 localStorage：
 * localStorage 只能等 hydration 之后才读到，导航瞬间会先按"全展开"渲染
 * 再自己合上 —— 实测有 80–90ms 的闪烁。cookie 让首帧就是最终状态。
 * 点击立即改本地 state（不等下一次渲染），cookie 只是给下一次导航用。
 *
 * 两条防「失踪」规则：
 *   - 进入页面时当前组由服务端强制展开（本地偏好里它是收起的也不作数）；
 *   - 用户手动收起当前组也允许（他想腾地方），此时组头保留品牌色，
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
 *
 * 图标：沿用 editor-icons 那一套内联 SVG（20×20 / 1.6 描边 / currentColor），
 * 不引入图标依赖，也不混 emoji —— 彩色 emoji 会在十项菜单里制造十种字重。
 */
function Chevron() {
  return (
    <svg className="fx-nav-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden>
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor"
            strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 图标键 → 组件。集中在一处映射，nav-config 才能保持纯数据（服务端也能读）。 */
const NAV_ICONS: Record<string, (p: { size?: number; className?: string }) => React.ReactElement> = {
  grid: IconGrid,
  note: IconNote,
  chat: IconChat,
  page: IconPage,
  comment: IconComment,
  archive: IconArchive,
  media: IconMedia,
  external: IconExternal,
  log: IconLog,
  settings: IconSliders,
};

function NavIcon({ name }: { name: string }) {
  const Icon = NAV_ICONS[name];
  return Icon ? <Icon size={16} className="fx-nav-icon" /> : null;
}

/** 页面属于哪一项：/admin/new 是「文章」下的写作页，选中态应落在「文章」，
    否则新建页会出现「一组都没选中」的空档，用户不知道自己在哪。 */
const ACTIVE_ALIAS: Record<string, string> = { new: "posts" };

export function AdminShell({ children, active, username }: {
  children: React.ReactNode; active: string; username: string;
}) {
  const collapsedGroups = useInitialCollapsed();
  const [navOpen, setNavOpen] = useState(false);
  const activeKey = ACTIVE_ALIAS[active] ?? active;
  const isActive = (key: string) => activeKey === key;
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
        {/* 品牌 + 主操作固定在顶部：导航再长，入口也不会滚走 */}
        <div className="admin-side-head">
          <div className="admin-sidebar-brand">
            <Link href="/" className="fx-brandmark">flechazo</Link>
            {/* 品牌注脚：说明这是哪个站点的后台，而不是一个通用工作台 */}
            <span className="fx-brand-sub">妄司逸的小世界</span>
          </div>

          <Link href="/admin/new" className="admin-side-compose">
            <IconPen size={15} className="admin-side-compose-icon" />
            <span>写文章</span>
            <kbd aria-hidden="true">⌘K</kbd>
          </Link>
        </div>

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
                        >
                          <NavIcon name={n.icon} />
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

        <div className="admin-sidebar-foot">
          <div className="admin-foot-cluster">
            <ThemeToggle />
            <LogoutButton username={username} variant="footer" />
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
          <IconPen size={16} />
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
                          <NavIcon name={n.icon} />
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
