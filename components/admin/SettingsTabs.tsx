import Link from "next/link";

/**
 * 设置区子导航（阶段 02-5 · 设置拆页）。
 *
 * 拆分理由不是"页面太长"，而是**保存语义不同**：
 *   站点   —— 改的是前台可见文案（siteTitle / 页脚 / ICP），有自己的保存按钮
 *   账号安全 —— TOTP、恢复码、会话、改密，每个动作都要验证码与确认弹窗
 *   图片存储 —— 七牛 AK/SK，保存后新上传才生效，且要先测连接
 * 三块塞在一页时，最长的那块（账号安全）把另外两块推到很远，
 * 而它们的失败后果完全不同 —— 平铺会让人以为"保存设置"能一把改完。
 *
 * 用链接 + aria-current（方案 §9.3：筛选/切换用 aria-current，不把
 * aria-selected 挂到普通链接上）。
 */
export type SettingsTab = "site" | "security" | "storage";

const TABS: { key: SettingsTab; href: string; label: string; desc: string }[] = [
  { key: "site", href: "/admin/settings", label: "站点", desc: "前台可见的文案" },
  { key: "security", href: "/admin/settings/security", label: "账号安全", desc: "两步验证、设备、密码" },
  { key: "storage", href: "/admin/settings/storage", label: "图片存储", desc: "七牛空间与 CDN" },
];

export function SettingsTabs({ active }: { active: SettingsTab }) {
  return (
    <nav className="seg-tabs" aria-label="设置分区">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={active === t.key ? "is-active" : undefined}
          aria-current={active === t.key ? "page" : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
