/**
 * 主题底色常量（C-4，2026-11-01）。
 *
 * ## 为什么需要这个文件
 *
 * 主题底色（2026-11-08 起：浅 #ffffff / 深 #0b0f14）原本在 5 个地方各写一份：
 *
 *   app/layout.tsx:55            metadata.themeColor（浏览器地址栏配色）
 *   app/manifest.ts:12-13        PWA 的 background_color / theme_color
 *   components/ThemeToggle.tsx   切换时同步 <meta name="theme-color">
 *   components/ThemeScript.tsx   首屏防闪烁内联脚本
 *
 * 改一个色要记得改 5 处，漏一处就出现「地址栏是旧色、页面是新色」——
 * 而这种不一致只在移动端浏览器（地址栏会跟着 theme-color 变色）上看得见，
 * 桌面开发时完全发现不了。
 *
 * ## 与 CSS 令牌的关系
 *
 * 这两个值必须与 `app/globals.css` 里 `:root --bg` 和
 * `:root[data-theme="dark"] --bg` **保持一致**。CSS 里不能 import TS 常量，
 * 所以这里只能靠注释 + 测试守（`tests/theme-sync.test.ts` 会比对两边）。
 *
 * ## 为什么 ThemeScript 不能直接 import
 *
 * 它是 `<script dangerouslySetInnerHTML>` 的内联脚本，在 HTML 解析阶段
 * 同步执行，早于任何模块加载。所以只能把值**拼进字符串**——但值的来源
 * 仍是这两个常量，改一处即全站生效。
 */

/** 浅色主题的页面底色（= globals.css 的 `:root { --bg }`） */
export const LIGHT_BG = "#f4f5f7";

/** 深色主题的页面底色（= globals.css 的 `:root[data-theme="dark"] { --bg }`） */
export const DARK_BG = "#0b0f14";

/** localStorage 里存主题偏好的键；ThemeScript 与 ThemeToggle 必须一致 */
export const THEME_STORAGE_KEY = "blog-theme";
