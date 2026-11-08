import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ScrollReset } from "@/components/ScrollReset";
import { MobileNav } from "@/components/MobileNav";
import { VisitorBeacon } from "@/components/VisitorBeacon";
import { PwaRegister } from "@/components/PwaRegister";
import { GridOverlay } from "@/components/GridOverlay";
import { MobileKeyboardGuard } from "@/components/MobileKeyboardGuard";
import { getSettings } from "@/lib/settings";
import { listFriendLinksCached } from "@/lib/cached";
import { MobileSidebarContent } from "@/components/MobileSidebar";
import { SiteFooter } from "@/components/SiteFooter";
import { ThemeScript } from "@/components/ThemeScript";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SidebarSheetProvider } from "@/components/SidebarSheet";
import { FrontOnly } from "@/components/FrontOnly";
import { LIGHT_BG } from "@/lib/theme-colors";
import { absoluteUrl, DEFAULT_OG_IMAGE, ogImageFor, SITE_URL, siteAlternates } from "@/lib/seo";

/**
 * C4：站名/描述此前硬编码在这里，改一个字要重新构建。
 * 现在从 settings 表读（进程内缓存，写即失效）。
 */
export async function generateMetadata(): Promise<Metadata> {
  const s = getSettings();
  return {
    title: { default: s.siteTitle, template: "%s · " + s.author },
    description: s.siteDescription,
    // metadataBase 与 canonical/og:url 共用同一个来源（lib/seo 的 SITE_URL），
    // 否则相对路径会被补成另一个域名，canonical 与 og:url 互相矛盾
    metadataBase: new URL(SITE_URL),
    // RSS autodiscovery（P0-5）：浏览器地址栏 / 阅读器据此自动发现 /rss.xml
    alternates: siteAlternates(),
    manifest: "/manifest.webmanifest",
    applicationName: s.siteTitle,
    openGraph: {
      type: "website",
      siteName: s.siteTitle,
      title: s.siteTitle,
      description: s.siteDescription,
      locale: "zh_CN",
      // 全站兜底分享图：没有单独指定 og:image 的页面分享出去也有画面。
      // 刻意**不**在这里写 og:url —— layout 的 openGraph 会被没自带 openGraph 的
      // 页面继承，写死 "/" 会让 /archives、/about 等页面也对外声称自己是首页。
      // og:url 只在"知道自己是谁"的地方写（文章页、友链页）。
      images: [ogImageFor(null)],
    },
    twitter: {
      card: "summary_large_image",
      title: s.siteTitle,
      description: s.siteDescription,
      images: [absoluteUrl(DEFAULT_OG_IMAGE)],
    },
    appleWebApp: { capable: true, title: s.author, statusBarStyle: "default" },
    icons: {
      icon: [
        { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  themeColor: LIGHT_BG,
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 品牌信息（C-9）：站名来自 settings，与 <title> 用的是同一份数据源。
  // 在 layout 里取一次传给 MobileNav —— 它是客户端组件，不能自己查库。
  // 兜底与 SiteShell 保持一致：settings 为空时不能让顶栏空白。
  const settings = getSettings();
  const siteName = (settings.siteTitle || "").trim() || "flechazo";

  // 手机端抽屉里的聚合/友链：layout 在服务端取一次数据传下去。
  // MobileNav 是客户端组件（要管抽屉开关），不能直接塞 async server component。
  const drawerLinks = (await listFriendLinksCached()).map((l) => ({
    id: l.id,
    name: l.name,
    url: l.url,
    desc: l.desc,
    kind: l.kind,
  }));

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ThemeScript />
        <ScrollReset />
        {/* 侧栏开合状态提到 provider：顶栏（手机）与左栏（平板）各有一个入口，
            内容在服务端渲染好作为 panel 传入 */}
        <SidebarSheetProvider panel={<MobileSidebarContent />}>
          {/* 键盘用户跳过左栏导航（P0-4）：聚焦才出现，目标见 SiteShell 的 #main-content */}
          <FrontOnly>
            <a className="skip-link" href="#main-content">跳到正文</a>
          </FrontOnly>
          <FrontOnly><MobileNav links={drawerLinks} siteName={siteName} /></FrontOnly>
          {children}
          {/* 全站页脚：备案号与页脚文字此前只有后台能填、前台没渲染 */}
          <FrontOnly><SiteFooter /></FrontOnly>
        </SidebarSheetProvider>
        {/* 访客埋点：必须在 FrontOnly 内 —— 后台页面不该被统计，
            管理员自己的前台浏览由接口层按 session 排除（见 app/api/hit） */}
        <FrontOnly><VisitorBeacon /></FrontOnly>
        <PwaRegister />
        {/* 栅格叠加层（?grid=1）：无 query 时渲染 null，前后台共用同一开关。
            不包在 FrontOnly 里 —— CSS 只作用于 .content / .admin-main，登录页没有这些容器 */}
        <GridOverlay />
        {/* 软键盘弹起时把聚焦的输入框滚到视口中部，防止手机上打字看不见 */}
        <MobileKeyboardGuard />
      </body>
    </html>
  );
}
