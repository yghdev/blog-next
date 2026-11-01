import type { ReactNode } from "react";

/**
 * 右栏区块的外壳（B-8，2026-11-01）。
 *
 * 桌面右栏与手机抽屉里，光是 `<section class="rb-block"> + header + title
 * + 可选徽标` 这套骨架就抄了 9 遍。改标题样式要改 9 个地方，漏一个就出现
 * "桌面标题粗一点、手机细一点"这种没人会同时对照着看出来的差异。
 *
 * ## 为什么是纯展示
 *
 * 这个组件（以及同目录的 StatsBlock / TagCloudBlock、FriendLinks 里的
 * FriendLinkBlocks）**只接收数据，不自己查库**。理由是：
 *
 *   • 数据源已经在 `lib/cached.ts` 里统一了，展示层再查一次只是多一个
 *     缓存调用点，没有好处；
 *   • 纯展示组件既能被服务端组件用，也能被客户端组件用，不会被 `async`
 *     绑死在某一侧；
 *   • 想给某个区块换布局（比如把标签云改成折叠）只需要传不同的 children。
 *
 * ## 参数
 *
 *   title  —— 区块标题
 *   count  —— 右上角的计数徽标；传 undefined 就不显示（统计块没有数量概念）
 *   children —— 区块正文
 */
export function SidebarBlock({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="rb-block">
      <header className="rb-head">
        <span className="rb-title">{title}</span>
        {typeof count === "number" ? <span className="rb-badge">{count}</span> : null}
      </header>
      {children}
    </section>
  );
}
