import type { NextConfig } from "next";

/**
 * 安全响应头（方案 A2）。
 *
 * 背景：全站此前**没有任何**安全头 —— 一处上传型 XSS 就能带着管理员 Cookie
 * 打同源请求。这里补齐基础头，并给 CSP 分两档。
 *
 * CSP 的落地策略（重要）：
 *   全站在 JSX 里大量使用内联 style 属性（AdminShell、RightBar、动态分类色…），
 *   直接下发强 CSP 会让界面大面积失效。因此默认只发 **Report-Only**，
 *   观察几天确认没有新的违规再切 enforce：把 CSP_MODE 设成 "enforce" 即可。
 */
const CSP_MODE = process.env.CSP_MODE === "enforce" ? "enforce" : "report-only";

/**
 * 统计脚本的源。
 *
 * 坑点：next.config.ts 是在**构建期**求值的，而 NEXT_PUBLIC_UMAMI_SRC 是
 * systemd 在运行期注入的 —— 构建机上根本没有这个变量，于是 CSP 里漏掉了
 * umami 的源，一旦把 CSP 从 Report-Only 切成 enforce，统计上报会被直接拦掉。
 *
 * 这里有两条路：
 *   a) 构建时注入（要求构建机也配同一组环境变量，容易忘）
 *   b) 给一个**默认值**兜住，再用环境变量覆盖（本次采用）
 * 选 b，因为统计域名是固定的，忘配也不会静默失效。
 */
const UMAMI_SRC = process.env.NEXT_PUBLIC_UMAMI_SRC || "https://umami.yghsite.cn/script.js";

function originOf(src: string): string {
  try {
    return new URL(src).origin;
  } catch {
    return "";
  }
}

// 构建期拿不到环境变量时，至少把已知的统计域名放行，避免 enforce 后统计失效
const EXTRA_ORIGINS = (process.env.CSP_EXTRA_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const umamiOrigin = originOf(UMAMI_SRC);

/**
 * 评论系统（Artalk）的源。
 * 与 Umami 同理：构建期拿不到运行期环境变量，所以给默认值兜底。
 * 若漏了这里，CSP 一旦切 enforce，评论区的脚本/接口会被直接拦掉 ——
 * 而且不会报错，只会"评论区空白"，非常难查。
 */
const ARTALK_SRC = process.env.NEXT_PUBLIC_ARTALK_SRC || "https://artalk.yghsite.cn";
const artalkOrigin = originOf(ARTALK_SRC);

const allowedOrigins = [...new Set([umamiOrigin, artalkOrigin, ...EXTRA_ORIGINS].filter(Boolean))];

export function buildCsp(extra: { scriptSrc?: string[]; styleSrc?: string[] } = {}) {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...allowedOrigins, ...(extra.scriptSrc ?? [])];
  const styleSrc = ["'self'", "'unsafe-inline'", ...allowedOrigins, ...(extra.styleSrc ?? [])];
  const connectSrc = ["'self'", ...allowedOrigins];
  return [
    "default-src 'self'",
    "script-src " + scriptSrc.join(" "),
    "style-src " + styleSrc.join(" "),
    "img-src 'self' data: blob: https:",
    "font-src " + ["'self'", "data:", ...allowedOrigins].join(" "),
    "connect-src " + connectSrc.join(" "),
    "media-src 'self' https:",
    // 文章里嵌了 bilibili 等播放器（hook.md 里有 iframe），需要放行 frame-src
    "frame-src 'self' https:",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

const baseSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

/**
 * 重要：next.config 的 headers() 在**构建期**求值并写进 routes-manifest.json，
 * 运行期改环境变量对它无效 —— 也就是说 CSP_MODE 这种开关放在这里是死代码。
 * 实测确认过：以 CSP_MODE=enforce 启动，响应头仍然是 Report-Only。
 *
 * 所以 CSP 交给 proxy.ts 在运行期下发（它每个请求都执行，能读到当时的 env）。
 * 这里只保留与 CSP 无关的静态安全头。
 */

const nextConfig: NextConfig = {
  output: "standalone",

  /**
   * 依赖追踪排除（2026-10-22）。
   *
   * 问题：lib/db.ts、app/api/admin/upload 等处写了
   * `path.join(process.cwd(), "data")` 这类运行期才求值的路径。
   * Next 的 nft 静态分析无法确定实际会读哪些文件，于是**把整个项目根
   * 目录都收进产物** —— healthz 的 trace 里就有 346 个文件，包括
   * drafts/（未发布草稿）、tests/、docs/、甚至 blog.db 和 dist.tar.gz。
   *
   * 后果有两个，都很严重：
   *   1) 发布包从约 60MB 涨到 225MB，每次部署都在搬运源码；
   *   2) **未发布的草稿会跟着产物一起上传到服务器**，属于内容泄露。
   *
   * 这些目录运行期完全用不到（数据走 DATA_DIR 环境变量指向
   * /var/lib/blog，上传走 UPLOAD_DIR），直接排除。
   */
  outputFileTracingExcludes: {
    "*": [
      "drafts/**",
      "tests/**",
      "docs/**",
      "out/**",
      "dist/**",
      ".next/standalone/**",
      "content/**",
      "deploy/**",
      "scripts/**",
      "app/**",
      "components/**",
      "lib/**",
      "data/**",
      "*.md",
      "*.db",
      "*.tar.gz",
      "tsconfig.tsbuildinfo",
      "package-lock.json",
      "postcss.config.mjs",
      "proxy.ts",
      "next.config.ts",
    ],
  },
  serverExternalPackages: ["better-sqlite3"],
  images: { unoptimized: true },
  experimental: {
    // 由浏览器原生处理前进/后退的滚动位置，避免 Next 的 scroll 恢复与应用渲染打架造成的跳动
    scrollRestoration: false,

    /**
     * 请求体上限（2026-10-28，上传视频时暴露的问题）。
     *
     * 两层原因，都是实测出来的：
     *
     * 1) Next 默认只把 10MB 读进内存，超出部分**被静默截断**：接口拿到的是
     *    一个不完整的 FormData，file 字段为空，于是报「没有收到文件」——
     *    真实原因是「文件太大」。这个报错指不到体积上，排查了两轮才定位。
     *
     * 2) 更关键：**这个值直接决定进程内存**。整个 body 在进入 route handler
     *    之前就被读进内存了，所以设得越大，一次上传就可能把进程顶进 cgroup
     *    节流（MemoryHigh=300M），进而拖垮同进程的所有请求 —— 2026-10-28
     *    线上事故就是这么来的（当时设的 48mb + 视频上限 40MB）。
     *
     * 现在视频上限 16MB（lib/upload.ts 的 MAX_VIDEO_BYTES），这里给 20mb：
     * 比上限略大以容纳 multipart 边界与表单字段，同时保证峰值内存
     * （基线 ~120MB + 约 6.5 × 20MB ≈ 250MB）仍在 MemoryHigh=300M 之下。
     */
    proxyClientMaxBodySize: "20mb",
  },
  async headers() {
    return [
      {
        // 后台：更严的 CSP（禁 iframe、禁外链资源）+ 绝不缓存
        source: "/admin/:path*",
        headers: [
          ...baseSecurityHeaders,
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/api/admin/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
        ],
      },
      {
        source: "/:path*",
        headers: [...baseSecurityHeaders,],
      },
    ];
  },
};

export default nextConfig;
