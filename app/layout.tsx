import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ScrollReset } from "@/components/ScrollReset";
import { MobileNav } from "@/components/MobileNav";
import { VisitorBeacon } from "@/components/VisitorBeacon";
import { PwaRegister } from "@/components/PwaRegister";
import { MobileKeyboardGuard } from "@/components/MobileKeyboardGuard";
import { getSettings } from "@/lib/settings";
import { listFriendLinksCached } from "@/lib/cached";
import { MobileSidebarContent } from "@/components/MobileSidebar";
import { SiteFooter } from "@/components/SiteFooter";
import { ThemeScript } from "@/components/ThemeScript";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SidebarSheetProvider } from "@/components/SidebarSheet";
import { FrontOnly } from "@/components/FrontOnly";

/**
 * C4：站名/描述此前硬编码在这里，改一个字要重新构建。
 * 现在从 settings 表读（进程内缓存，写即失效）。
 */
export async function generateMetadata(): Promise<Metadata> {
  const s = getSettings();
  return {
    title: { default: s.siteTitle, template: "%s · " + s.author },
    description: s.siteDescription,
    metadataBase: new URL(process.env.SITE_URL || "https://blog.yghsite.cn"),
    manifest: "/manifest.webmanifest",
    applicationName: s.siteTitle,
    openGraph: {
      type: "website",
      siteName: s.siteTitle,
      title: s.siteTitle,
      description: s.siteDescription,
      locale: "zh_CN",
    },
    twitter: {
      card: "summary_large_image",
      title: s.siteTitle,
      description: s.siteDescription,
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
  themeColor: "#fffefc",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
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
          <FrontOnly><MobileNav links={drawerLinks} /></FrontOnly>
          {children}
          {/* 全站页脚：备案号与页脚文字此前只有后台能填、前台没渲染 */}
          <FrontOnly><SiteFooter /></FrontOnly>
        </SidebarSheetProvider>
        {/* 访客埋点：必须在 FrontOnly 内 —— 后台页面不该被统计，
            管理员自己的前台浏览由接口层按 session 排除（见 app/api/hit） */}
        <FrontOnly><VisitorBeacon /></FrontOnly>
        <PwaRegister />
        {/* 软键盘弹起时把聚焦的输入框滚到视口中部，防止手机上打字看不见 */}
        <MobileKeyboardGuard />
      </body>
    </html>
  );
}
