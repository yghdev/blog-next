import type { MetadataRoute } from "next";
import { LIGHT_BG } from "@/lib/theme-colors";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "flechazo's blog",
    short_name: "flechazo",
    description: "记录 AI、开发与折腾的日常",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: LIGHT_BG,
    theme_color: LIGHT_BG,
    lang: "zh-CN",
    categories: ["blog", "technology"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "写文章", url: "/admin/new" },
      { name: "搜索", url: "/search" },
    ],
  };
}
