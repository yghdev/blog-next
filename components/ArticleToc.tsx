type Toc = { level: number; text: string; id: string }[];

/**
 * 文章目录（移动 / 平板，P0-3，2026-11-07）。
 *
 * 为什么需要它：右栏 `.toc-col` 在 ≤1391px 就 `display:none`，而手机抽屉
 * （`MobileSidebarContent`）里只有统计 / 友链 / 标签云，没有目录 ——
 * 也就是说 1391px 以下**完全无法跳章节**，长文只能一路滚。
 *
 * 形态选择 `<details>` 而不是自绘折叠：
 *   · 原生支持键盘（Enter/Space 展开）与读屏（展开状态可播报）；
 *   · 不引入任何客户端 JS，服务端直出即可用；
 *   · 默认收起，不抢正文首屏。
 *
 * 类名刻意与右栏的 `.toc-list` 区分开：布局回归测试用
 * `document.querySelector(".toc-list")` 定位右栏目录，复用同名类会让它
 * 选中这个隐藏的移动端目录，测试与实现一起失真。
 */
export function ArticleToc({ toc }: { toc: Toc }) {
  if (toc.length === 0) return null;

  return (
    <details className="article-toc">
      <summary className="article-toc-summary">
        <span>本文目录</span>
        <span className="article-toc-count">{toc.length}</span>
      </summary>
      <nav aria-label="本文目录">
        <ul className="article-toc-list">
          {toc.map((t, i) => (
            <li key={i} className={t.level === 3 ? "lv3" : undefined}>
              <a href={"#" + t.id}>{t.text}</a>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}
