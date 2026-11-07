import { Fragment } from "react";
import { splitHighlights } from "@/lib/highlight";

/**
 * 搜索命中高亮（P0-6，2026-11-07）。
 *
 * 为什么不用 `dangerouslySetInnerHTML` + 字符串替换：
 *   文章标题和摘要都是用户内容（标题可以是任意字符）。拼 HTML 意味着
 *   每一处都要自己转义，漏一个就是 XSS；而 React 把"命中/非命中"切成
 *   片段渲染，文本节点天然被转义，不需要任何 `replace(/&/g, …)` 的仪式。
 *
 * 匹配规则与排序、摘要共用 lib/highlight.ts 的同一套 matcher —— 见那里的注释。
 */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const parts = splitHighlights(text, terms);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p.hit ? <mark className="search-hit">{p.text}</mark> : p.text}
        </Fragment>
      ))}
    </>
  );
}
