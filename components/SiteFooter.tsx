import { getSettings } from "@/lib/settings";

/**
 * 全站页脚（2026-10-23 新增）。
 *
 * 背景：settings 里的 `icp`（备案号）和 `footerText`（页脚文字）一直只能
 * 在后台填、**前台没有任何地方渲染** —— 属于「死配置」。
 * 备案号在国内是硬性要求（赣ICP备...），必须在页面上可见。
 *
 * 放在 layout 里，六个页面（首页/归档/说说/标签/搜索/文章）一次覆盖。
 * 两项都为空时整块不渲染，不占位。
 */
export async function SiteFooter() {
  const s = getSettings();
  const icp = (s.icp || "").trim();
  const text = (s.footerText || "").trim();

  if (!icp && !text) return null;

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        {text ? <div className="site-footer-text">{text}</div> : null}

        {icp ? (
          <div className="site-footer-icp">
            <a
              href="https://beian.miit.gov.cn/"
              target="_blank"
              rel="noopener noreferrer nofollow"
              title="工业和信息化部政务服务平台"
            >
              {icp}
            </a>
          </div>
        ) : null}
      </div>
    </footer>
  );
}
