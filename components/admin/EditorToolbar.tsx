"use client";
import type { ReactNode } from "react";
import {
  IconBold, IconCode, IconCodeBlock, IconImage, IconItalic, IconLibrary, IconLink,
  IconList, IconListOrdered, IconMinus, IconQuote, IconTable, IconVideo,
} from "./editor-icons";

/**
 * Markdown 工具栏。
 *
 * 结构按「动作的性质」分组，而不是按图标好不好看排成一排：
 *   文本格式（会改变选中文字）→ 内容结构（插入块级语法）→ 插入内容（引入外部资源）
 * 组与组之间用一条 1px 竖线分隔，组内按钮紧邻。
 *
 * 视觉权重刻意压低：这些是写作过程中的轻动作，不与顶栏的「发布」抢注意力。
 * 悬停只换底色，不位移；按下缩到 0.96，给一次很短的触觉反馈。
 *
 * 无障碍：
 *   - 每个按钮都有 aria-label；H2/H3 用可读的排版字形直接呈现；
 *   - 分组是 role="group" + aria-label，Tab 顺序就是视觉顺序；
 *   - 外链视频是 aria-expanded 的开合按钮；
 *   - 图标一律 aria-hidden，读屏只读一次工具名。
 *
 * 为什么不做撤销 / 重做按钮：textarea 的原生撤销栈与输入法、选区、粘贴历史
 * 深度耦合，自己实现一套「历史数组」会绕开原生栈，导致 Cmd+Z 有时撤销不了。
 * 这里保留原生行为（Cmd/Ctrl+Z 随时可用），不引入第二个撤销系统。
 */

type ToolButton = {
  /** 简短名称：读屏与测试读到的稳定文案（「上传」「媒体库」） */
  label: string;
  /** 悬浮提示与 aria-label 的完整说明（可带快捷键） */
  hint?: string;
  /** 短标签（H2 / H3），给了就不再画图标 */
  text?: string;
  icon?: ReactNode;
  before: string;
  after?: string;
};

const TEXT_TOOLS: ToolButton[] = [
  { label: "二级标题", hint: "二级标题（##）", text: "H2", before: "## " },
  { label: "三级标题", hint: "三级标题（###）", text: "H3", before: "### " },
  { label: "粗体", hint: "粗体（Cmd/Ctrl+B）", icon: <IconBold />, before: "**", after: "**" },
  { label: "斜体", hint: "斜体（Cmd/Ctrl+I）", icon: <IconItalic />, before: "*", after: "*" },
  { label: "行内代码", icon: <IconCode />, before: "`", after: "`" },
  { label: "代码块", icon: <IconCodeBlock />, before: "\n```\n", after: "\n```\n" },
];

const STRUCTURE_TOOLS: ToolButton[] = [
  { label: "引用", icon: <IconQuote />, before: "> " },
  { label: "无序列表", icon: <IconList />, before: "- " },
  { label: "有序列表", icon: <IconListOrdered />, before: "1. " },
  { label: "分隔线", icon: <IconMinus />, before: "\n---\n" },
];

const INSERT_TOOLS: ToolButton[] = [
  { label: "链接", icon: <IconLink />, before: "[", after: "](url)" },
  { label: "表格", icon: <IconTable />, before: "\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n" },
];

function Tool({
  label, hint, text, icon, onClick, expanded,
}: {
  label: string; hint?: string; text?: string; icon?: ReactNode; onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="editor-tool"
      aria-label={hint ?? label}
      aria-expanded={expanded}
      data-tip={hint ?? label}
      onClick={onClick}
    >
      {text ? <span className="editor-tool-text" aria-hidden>{text}</span> : icon}
      {/* 简短名称只给读屏与测试；视觉上是一枚图标，避免工具栏变成一排文字按钮 */}
      <span className="sr-only">{label}</span>
    </button>
  );
}

export function EditorToolbar({
  onInsert, onPickFile, onOpenMedia, onToggleVideo, videoOpen, disabled,
}: {
  onInsert: (before: string, after?: string) => void;
  onPickFile: () => void;
  onOpenMedia: () => void;
  onToggleVideo: () => void;
  videoOpen: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="editor-toolbar" role="group" aria-label="Markdown 格式工具栏" aria-disabled={disabled || undefined}>
      <div className="editor-tool-group" role="group" aria-label="文本格式">
        {TEXT_TOOLS.map((t) => (
          <Tool key={t.label} {...t} onClick={() => onInsert(t.before, t.after)} />
        ))}
      </div>
      <span className="editor-tool-sep" aria-hidden />
      <div className="editor-tool-group" role="group" aria-label="内容结构">
        {STRUCTURE_TOOLS.map((t) => (
          <Tool key={t.label} {...t} onClick={() => onInsert(t.before, t.after)} />
        ))}
      </div>
      <span className="editor-tool-sep" aria-hidden />
      <div className="editor-tool-group" role="group" aria-label="插入内容">
        {INSERT_TOOLS.map((t) => (
          <Tool key={t.label} {...t} onClick={() => onInsert(t.before, t.after)} />
        ))}
        <Tool label="上传" hint="上传图片或视频" icon={<IconImage />} onClick={onPickFile} />
        <Tool label="媒体库" icon={<IconLibrary />} onClick={onOpenMedia} />
        <Tool label="外链视频" hint="插入外链视频（B 站 / YouTube）" icon={<IconVideo />} onClick={onToggleVideo} expanded={videoOpen} />
      </div>
      <span className="editor-toolbar-fill" aria-hidden />
      <span className="editor-toolbar-hint" aria-hidden>Markdown</span>
    </div>
  );
}
