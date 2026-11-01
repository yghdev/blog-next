import { Sidebar } from "./Sidebar";
import { RightBar } from "./RightBar";

/**
 * 站点骨架（B-1，2026-11-01）。
 *
 * ## 为什么要有这个组件
 *
 * 7 个页面此前各自拼同样的四行结构：
 *
 *     <div className="site-shell">
 *       <Sidebar />
 *       <main className="content">…</main>
 *       <div className="toc-col"><RightBar /></div>   ← 有的页面有、有的没有
 *     </div>
 *
 * 「要不要右栏」完全靠人记。实测已经错配了一次：搜索页拼的是三列网格，
 * 却没有写第三个子元素 —— 1440px 下右侧空出 320px 的白，而且没人发现，
 * 因为"看起来只是有点空"。
 *
 * 收敛之后，这个问题在类型上就不可能发生：写 `variant="wide"` 就没有右栏，
 * 写 `three-col` 就有；想漏写第三列也没机会（由组件内部渲染）。
 *
 * ## variant 怎么选
 *
 *   three-col —— 左导航 + 正文 + 右栏。用于内容型页面：
 *                首页 / 归档 / 说说 / 标签 / 文章
 *   wide      —— 左导航 + 更宽的正文，无右栏。用于列表/专题型页面：
 *                搜索 / 友链
 *
 * 宽度全部来自 CSS 令牌（`--w-shell` / `--w-shell-read` / `--w-read`），
 * 组件本身不参与任何加法运算 —— 改宽度只需要改 globals 的 :root。
 *
 * ## 为什么是服务端组件
 *
 * 它不持有任何状态，只是把三个子块摆好。`Sidebar` 自己是客户端组件
 * （需要 `usePathname` 判断选中态），但服务端组件可以渲染客户端组件，
 * 反过来不行 —— 所以这里不能加 "use client"，否则会把它变成客户端边界，
 * `RightBar`（async 服务端组件，要查库）就没法用了。
 */
type Variant = "three-col" | "wide";

type Toc = { level: number; text: string; id: string }[];

export function SiteShell({
  variant = "three-col",
  toc,
  className,
  children,
}: {
  /** 骨架形态：三栏（带右栏）或宽版（无右栏）。默认三栏。 */
  variant?: Variant;
  /** 文章目录。只有文章页需要传；其余页面不传，右栏会渲染成不带目录的版本。 */
  toc?: Toc;
  /** 附加到 `<main>` 上的类名。目前没有页面在用（友链页的 fr-main 已随 B-4 移除）。 */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={"site-shell site-shell--" + variant}>
      <Sidebar />
      <main className={"content" + (className ? " " + className : "")}>{children}</main>
      {variant === "three-col" ? (
        <div className="toc-col">
          <RightBar toc={toc} />
        </div>
      ) : null}
    </div>
  );
}
