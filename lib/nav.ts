/**
 * 站点导航的唯一事实来源（B-7，2026-11-01）。
 *
 * ## 为什么单独成文件
 *
 * 之前有两份 `NAV` 数组：`components/Sidebar.tsx`（桌面）与
 * `components/MobileNav.tsx`（移动抽屉）。不只是重复，两边的
 * **标签、顺序、图标全都不一样**：
 *
 *   桌面：文章 / 说说 / 归档 / 友链 / 关于
 *   移动：首页 / 归档 / 说说 / 朋友 / 关于
 *
 * 同一站点的导航在两处不一致，用户换个设备就找不到同一个入口。
 * 现在两边都读 `NAV_ITEMS`，改一处即全站生效。
 *
 * ## 为什么 active 不再靠传参
 *
 * 原来每个页面自己写 `<Sidebar active="/archives" />`。漏写不报错，
 * 只是那个页面没有选中态 —— 实测已经漏了 3 个：`/about`、`/tags/*`、
 * `/search`。改成按路径自判后，"忘写"在类型上就不可能发生。
 *
 * 这个文件是**纯数据 + 纯函数**，不 import 任何 React/Next 模块，
 * 因此服务端组件和客户端组件都能安全使用。
 */

export type NavItem = {
  /** 目标路径；`/` 同时代表「文章」这一栏（文章详情都是 `/p/<id>`） */
  href: string;
  /** 显示文案。桌面与移动共用同一套，不允许各自改词。 */
  label: string;
  /** 图标名（components/ui/Icon.tsx 的 IconName）。桌面渲染在 `.nav-ico`，移动渲染在 `.mi`。
   *  这里只存名字不存 SVG：本文件保持「纯数据」，服务端/客户端组件都能 import。 */
  icon: "post" | "chat" | "archive" | "link" | "user";
};

/**
 * 导航项。顺序即展示顺序，与需求文档 2.1 的列表一致。
 *
 * 新增页面时只需在这里加一项 —— `Sidebar` 与 `MobileNav` 都会自动跟上。
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "文章", icon: "post" },
  { href: "/shuoshuo", label: "说说", icon: "chat" },
  { href: "/archives", label: "归档", icon: "archive" },
  { href: "/friend-links", label: "友链", icon: "link" },
  { href: "/about", label: "关于", icon: "user" },
];

/**
 * 把当前路径映射成"应高亮哪个导航项"，没有匹配则返回 `null`。
 *
 * 规则：
 *   • 精确匹配优先（`/archives` → `/archives`）
 *   • 文章详情 `/p/<id>` 与标签页 `/tags/*` 都归到「文章」(`/`)
 *   • `/search` 不是导航项 → `null`（搜索是从侧栏搜索框进的，没有独立入口）
 *   • **只做整段匹配**，不做前缀匹配：`/archives-old` 不能点亮 `/archives`
 *
 * 尾部斜杠与查询串会被忽略（`/archives/` `/archives/` 等价）。
 */
export function activeHref(pathname: string): string | null {
  // 去掉查询串/hash，再去掉尾部斜杠（根路径 "/" 保持原样）
  let p = pathname.split("?")[0].split("#")[0];
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (!p) p = "/";

  // 文章详情 `/p/<id>` 与标签页 `/tags/<tag>` 都属于「文章」这一栏。
  // 注意只认**带段**的形态：`/p`、`/tags` 本身没有对应页面（404），
  // 不该点亮任何一项 —— 否则用户停在 404 页会看到「文章」是选中的。
  if (p.startsWith("/p/")) return "/";
  if (p.startsWith("/tags/")) return "/";

  // 其余按整段精确匹配
  const hit = NAV_ITEMS.find((n) => n.href === p);
  return hit ? hit.href : null;
}
