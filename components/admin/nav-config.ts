/**
 * 后台导航的分组定义（唯一事实来源）。
 *
 * 单独成文件是因为它同时被两处读取：
 *   - components/admin/AdminShell.tsx（客户端，渲染侧栏与抽屉）
 *   - app/admin/layout.tsx（服务端，校验 cookie 里的折叠组 key）
 * 放进任意一边都会让另一边变成"引用客户端组件"或"复制一份常量"。
 */
export type NavItem = { href: string; label: string; key: string };
export type NavGroup = { key: string; title: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "workbench",
    title: "工作台",
    items: [
      { href: "/admin/overview", label: "概览", key: "overview" },
    ],
  },
  {
    key: "content",
    title: "内容",
    items: [
      { href: "/admin", label: "文章与说说", key: "posts" },
      { href: "/admin/comments", label: "评论", key: "comments" },
      { href: "/admin?trash=1", label: "回收站", key: "trash" },
    ],
  },
  {
    key: "assets",
    title: "资源",
    items: [
      { href: "/admin/media", label: "媒体", key: "media" },
      { href: "/admin/links", label: "外链", key: "links" },
    ],
  },
  {
    key: "system",
    title: "系统",
    items: [
      { href: "/admin/audit", label: "日志", key: "audit" },
      { href: "/admin/settings", label: "设置", key: "settings" },
    ],
  },
];

/** 折叠偏好存 cookie（不是 localStorage）：布局在服务端就能读到，
    首帧的 aria-expanded 与视觉状态一致，不出现「先展开再自己合上」。 */
export const NAV_COLLAPSE_COOKIE = "admin_nav_collapsed";

const GROUP_KEYS = new Set(NAV_GROUPS.map((g) => g.key));

/** 把 cookie 值解析成受控的组 key 列表：非法值一律忽略，未知组不产生副作用 */
export function parseCollapsed(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((k) => GROUP_KEYS.has(k)))];
}

/**
 * 在浏览器里同步读折叠 cookie。
 *
 * 为什么服务端已经给过初值还要读一次：**客户端路由切换不会重新渲染布局**，
 * Context 里仍是首屏那次请求的值。如果新页面挂载的 AdminShell 只认 Context，
 * 它就会按「全部展开」渲染一帧，然后才被纠正 —— 实测 76ms 的展开闪烁。
 * document.cookie 在客户端渲染时同步可读，因此初值可以直接取到最新值。
 * SSR 阶段没有 document，返回 null，由调用方退回 Context。
 */
export function readCollapsedCookie(): string[] | null {
  if (typeof document === "undefined") return null;
  const hit = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(NAV_COLLAPSE_COOKIE + "="));
  if (!hit) return [];
  return parseCollapsed(decodeURIComponent(hit.slice(NAV_COLLAPSE_COOKIE.length + 1)));
}
