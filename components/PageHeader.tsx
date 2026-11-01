import type { ReactNode } from "react";

/**
 * 页面标题（C-8，2026-11-01）。
 *
 * ## 问题
 *
 * `<h1 className="page-title">` 在 4 个页面各写一次（搜索/说说/归档/标签），
 * 其中标签页还要在标题下补一行「共 N 篇文章」—— 那行原来用内联样式
 * （C-5 已改成 `.tag-count` 类），但结构仍然是各页自己拼的。
 *
 * 收敛之后，"页面标题长什么样"只有一处定义：以后想加个图标、调间距、
 * 或者让副标题在移动端换行，都改这里。
 *
 * ## 为什么是服务端组件
 *
 * 纯展示，不持有状态。`sub` 收 ReactNode 而不是 string，因为有的页面
 * 要放链接或带样式的文本（比如标签页的计数）。
 */
export function PageHeader({
  title,
  sub,
}: {
  /** 页面标题文字 */
  title: ReactNode;
  /** 可选副标题，渲染为 `.page-sub` */
  sub?: ReactNode;
}) {
  return (
    <header className="page-head">
      <h1 className="page-title">{title}</h1>
      {sub ? <p className="page-sub">{sub}</p> : null}
    </header>
  );
}
