/**
 * 写作工作台的图标集（唯一图标体系）。
 *
 * 项目没有图标依赖，后台现有图标（侧栏折叠箭头、菜单键）都是内联 SVG。
 * 这里沿用同一种语言：20×20 画布、1.6 描边、圆头圆角、currentColor。
 * **不要混入第二套图标库**（Heroicons / Lucide / emoji）—— 混用会让工具栏
 * 在 14 个按钮之间出现三种笔画粗细，看起来像拼装件。
 *
 * 尺寸由 CSS 决定（默认 18px），SVG 只负责形状；颜色一律 currentColor，
 * 所以悬浮 / 聚焦 / 禁用状态不需要额外覆盖。
 */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconArrowLeft = (p: P) => (
  <Svg {...p}><path d="M16 10H4M9 5l-5 5 5 5" /></Svg>
);
export const IconArrowUpRight = (p: P) => (
  <Svg {...p}><path d="M6 14 14 6M7 6h7v7" /></Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}><path d="m5 8 5 5 5-5" /></Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}><path d="m5 5 10 10M15 5 5 15" /></Svg>
);
export const IconBold = (p: P) => (
  <Svg {...p}>
    <path d="M6 3.5h4.6a3.1 3.1 0 0 1 0 6.2H6zM6 9.7h5.4a3.4 3.4 0 0 1 0 6.8H6z" />
  </Svg>
);
export const IconItalic = (p: P) => (
  <Svg {...p}><path d="M8 3.5h7M5 16.5h7M12 3.5 8 16.5" /></Svg>
);
export const IconCode = (p: P) => (
  <Svg {...p}><path d="m7 6-4 4 4 4M13 6l4 4-4 4" /></Svg>
);
export const IconCodeBlock = (p: P) => (
  <Svg {...p}><path d="M3.5 6.5h13v7h-13zM6.5 3.5h7M6.5 16.5h7M6 10h.01M9 10h5" /></Svg>
);
export const IconQuote = (p: P) => (
  <Svg {...p}>
    <path d="M4 6.5h4v4.2c0 2.4-1.3 3.7-3.4 4.1M12 6.5h4v4.2c0 2.4-1.3 3.7-3.4 4.1" />
  </Svg>
);
export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01" />
  </Svg>
);
export const IconListOrdered = (p: P) => (
  <Svg {...p}>
    <path d="M8 5.5h8.5M8 10h8.5M8 14.5h8.5M3.4 4.4h1v3M3.2 13.1c0-1 1.7-1.3 1.7-.2 0 .8-1.7 1-1.7 2.1h2" />
  </Svg>
);
export const IconMinus = (p: P) => (
  <Svg {...p}><path d="M4 10h12" /></Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M8.5 11.5 11.5 8.5M7.4 13.9l-1.1 1.1a3 3 0 0 1-4.2-4.2l2.4-2.4a3 3 0 0 1 4.2 0M12.6 6.1l1.1-1.1a3 3 0 0 1 4.2 4.2l-2.4 2.4a3 3 0 0 1-4.2 0" />
  </Svg>
);
export const IconTable = (p: P) => (
  <Svg {...p}><path d="M3.5 4.5h13v11h-13zM3.5 8.5h13M8 8.5v7M12 8.5v7" /></Svg>
);
export const IconImage = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 4.5h13v11h-13zM3.5 12l3.2-3.2 2.8 2.8 2.2-2.2 4.8 4.8" />
    <circle cx="12.8" cy="7.6" r="1.1" />
  </Svg>
);
export const IconImagePlus = (p: P) => (
  <Svg {...p}>
    <path d="M16.5 11.5v4h-13v-11h8M3.5 12.5l3.2-3.2 3 3 1.8-1.8 2.4 2.4M15 3.5v4M13 5.5h4" />
  </Svg>
);
export const IconLibrary = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 5.5h5v9h-5zM8.5 8.5h4v6h-4zM12.5 4.5h4v10h-4z" />
  </Svg>
);
export const IconVideo = (p: P) => (
  <Svg {...p}><path d="M3.5 5.5h9v9h-9zM12.5 9l4-2.2v6.4L12.5 11" /></Svg>
);
export const IconEye = (p: P) => (
  <Svg {...p}><path d="M2.5 10s2.6-4.5 7.5-4.5S17.5 10 17.5 10s-2.6 4.5-7.5 4.5S2.5 10 2.5 10Z" /><circle cx="10" cy="10" r="2.1" /></Svg>
);
export const IconColumns = (p: P) => (
  <Svg {...p}><path d="M3.5 4.5h13v11h-13zM10 4.5v11" /></Svg>
);
export const IconPen = (p: P) => (
  <Svg {...p}><path d="m4 16 1-3.6L13.6 3.8a1.8 1.8 0 0 1 2.6 2.6L7.6 15 4 16Z" /><path d="m12.2 5.2 2.6 2.6" /></Svg>
);
export const IconMaximize = (p: P) => (
  <Svg {...p}><path d="M7 3.5H3.5V7M13 3.5h3.5V7M7 16.5H3.5V13M13 16.5h3.5V13" /></Svg>
);
export const IconMinimize = (p: P) => (
  <Svg {...p}><path d="M3.5 7H7V3.5M16.5 7H13V3.5M3.5 13H7v3.5M16.5 13H13v3.5" /></Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h12M4 10h12M4 14h12" />
    <circle cx="7" cy="6" r="1.4" fill="var(--fx-canvas)" />
    <circle cx="13" cy="10" r="1.4" fill="var(--fx-canvas)" />
    <circle cx="8.5" cy="14" r="1.4" fill="var(--fx-canvas)" />
  </Svg>
);
export const IconHistory = (p: P) => (
  <Svg {...p}><path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 4.5v3.2h3.2M10 6.5V10l2.4 1.5" /></Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}><path d="m4 10.5 4 4 8-9" /></Svg>
);
export const IconTag = (p: P) => (
  <Svg {...p}><path d="M3.5 9.5v-6h6l7 7-6 6z" /><circle cx="6.4" cy="6.4" r="1" /></Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}><path d="M3.5 5.5h4l1.6 2h7.4v7h-13z" /></Svg>
);
export const IconMessage = (p: P) => (
  <Svg {...p}><path d="M3.5 4.5h13v9h-7.5L5 16.5v-3H3.5z" /></Svg>
);
export const IconGlobe = (p: P) => (
  <Svg {...p}><circle cx="10" cy="10" r="6.5" /><path d="M3.5 10h13M10 3.5c2 2.2 2 10.8 0 13M10 3.5c-2 2.2-2 10.8 0 13" /></Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}><path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5 5.5l.9 11h8.2l.9-11M8.3 9v4.5M11.7 9v4.5" /></Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}><path d="M10 4v12M4 10h12" /></Svg>
);
export const IconUpload = (p: P) => (
  <Svg {...p}><path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13.5v2h12v-2" /></Svg>
);
export const IconSpark = (p: P) => (
  <Svg {...p}><path d="M10 3v3M10 14v3M3 10h3M14 10h3M5 5l2 2M13 13l2 2M15 5l-2 2M7 13l-2 2" /></Svg>
);
