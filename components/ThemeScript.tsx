import { DARK_BG, LIGHT_BG } from "@/lib/theme-colors";

/**
 * 主题防闪烁脚本（2026-10-23）。
 *
 * 为什么要内联、且放在 <body> 最前面：
 *   如果等 React hydrate 之后再设置 data-theme，暗色用户会先看到一帧白底
 *   （FOUC）。这段脚本是同步执行的，在浏览器首次绘制前就把属性打上。
 *
 * 逻辑必须与 components/ThemeToggle.tsx 保持一致：
 *   1. localStorage 有 light/dark -> 用它
 *   2. 否则跟随系统 prefers-color-scheme
 */
const SCRIPT = [
  "(function(){try{",
  "  var k='blog-theme';",
  "  var v=localStorage.getItem(k);",
  "  if(v!=='light'&&v!=='dark'){",
  "    v=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';",
  "  }",
  "  document.documentElement.setAttribute('data-theme',v);",
  "  var m=document.querySelector('meta[name=theme-color]');",
  // 颜色来自 lib/theme-colors.ts 的常量，不写字面量 —— 避免改了常量
  // 忘了改这里，导致首屏闪一下旧色
  "  if(m)m.setAttribute('content',v==='dark'?'" + DARK_BG + "':'" + LIGHT_BG + "');",
  "}catch(e){}})();",
].join("");

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
