/**
 * 编辑器媒体插入：把「一个资源」变成「一段正文」。
 *
 * 抽成纯函数而不是写在 Editor 里，有两个理由：
 *   1. 插入语法是最容易写错又最难测的部分（HTML 属性、URL 里的括号与空格、
 *      Markdown 的 ![]() 转义规则），放纯函数里能在 Node 里直测；
 *   2. 「上传后插入」与「从媒体库插入」必须产出**完全相同**的语法，
 *      否则同一张图两条路径进来会在正文里长得不一样。
 */

export type MediaKind = "image" | "video";

/**
 * Markdown 链接目标里必须转义的字符。
 *
 * 不转义的后果很具体：文件名里带空格或圆括号（`my photo (1).png`）时，
 * `![](url)` 会在第一个 `)` 处提前闭合，正文里留下一段残破的明文。
 * 而我们的 URL 由服务端生成、通常只有字母数字与斜杠，所以这里只做
 * 防御性转义，不改变常见情况下的输出。
 */
export function escapeMdUrl(url: string): string {
  return url.replace(/([()\s<>])/g, (c) =>
    c === "(" ? "%28" : c === ")" ? "%29" : c === " " ? "%20" : c === "<" ? "%3C" : "%3E"
  );
}

/**
 * 视频用原生 `<video>` 而不是 Markdown 图片语法。
 *
 * 为什么不用 iframe：自托管视频就在本站域名下，用原生标签才能拿到
 * 浏览器的进度条、全屏、画中画、字幕轨道，也不需要在 CSP 里再放宽
 * frame-src。`controls` + `playsinline` 缺一不可 —— 少了 playsinline，
 * iOS 会在点播放时强制全屏接管整个页面。
 *
 * `preload="metadata"` 是刻意的：移动流量下预加载整段视频代价太大，
 * 只取时长与首帧即可。
 */
export function videoSnippet(url: string): string {
  const safe = escapeAttr(url);
  return '<video controls playsinline preload="metadata" src="' + safe + '"></video>';
}

/** HTML 属性值转义：这里的 URL 来自服务端，但仍然不该让引号破坏属性结构 */
function escapeAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 生成插入片段。前后各留一个换行，保证媒体独占一行 ——
 * 紧贴着上一行文字会让 Markdown 把它并进段落里。
 */
export function mediaSnippet(kind: MediaKind, url: string, alt = ""): string {
  if (!url) return "";
  if (kind === "video") return "\n\n" + videoSnippet(url) + "\n\n";
  // 替代文字里的方括号会打断 Markdown 图片语法，统一去掉
  const text = String(alt).replace(/[[\]]/g, "").trim();
  return "\n\n![" + text + "](" + escapeMdUrl(url) + ")\n\n";
}
