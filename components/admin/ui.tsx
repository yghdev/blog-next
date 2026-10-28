import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 后台通用原子组件。
 *
 * 这一层只负责**结构与语义**，所有视觉来自 app/admin/admin.css 的 --fx-* 令牌
 * 与 .fx-scope 作用域。页面里不写行内样式、不写魔法数字 —— 否则「设计系统」
 * 就退化成「一堆长得像的 class」。
 */

/**
 * 页面标题区。
 *
 * 编辑部式排版：眉标（说明栏目与上下文）→ 衬线大标题 → 一句辅助说明。
 * 右侧操作区保持紧凑，且**只放这一页真正需要的动作** ——「写文章」已常驻
 * 在侧栏，这里不再重复出现（除非这一页的主操作不是写文章）。
 */
export function PageHeader({ title, sub, actions, eyebrow, count }: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  /** 标题上方的眉标，如「内容 · 全部」；不传则不渲染 */
  eyebrow?: ReactNode;
  /** 标题后的数量，与标题同基线但明显更弱 */
  count?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-row">
        <div className="page-head-copy">
          {eyebrow ? <div className="page-head-eyebrow">{eyebrow}</div> : null}
          <h1>
            {title}
            {count !== undefined && count !== null ? <span className="page-head-count">{count}</span> : null}
          </h1>
          {sub ? <p className="page-head-sub">{sub}</p> : null}
        </div>
        {actions ? <div className="page-head-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * 独立表面（卡片）。
 *
 * 用它的判据只有一条：这块内容**需要一个明确边界**（独立操作区、需要
 * 单独保存的表单、与周围语义不同的模块）。列表、统计、说明段落一律不用。
 * 传 `head` 时标题会带一条分隔线，适合「面板 + 内容」的结构。
 */
export function Card({ title, desc, children, head }: {
  title?: string; desc?: string; children: ReactNode; head?: ReactNode;
}) {
  if (head) {
    return (
      <section className="fx-panel">
        <div className="fx-panel-head">
          <h2 className="fx-panel-title">{title}</h2>
          {head}
        </div>
        <div className="fx-panel-body">{children}</div>
      </section>
    );
  }
  return (
    <section className="fx-panel">
      <div className="fx-panel-body">
        {title ? <h2 className="fx-panel-title">{title}</h2> : null}
        {desc ? <p className="page-head-sub">{desc}</p> : null}
        {children}
      </div>
    </section>
  );
}

export function Notice({ kind, children }: { kind: "ok" | "error" | "warn" | "info"; children: ReactNode }) {
  return <div className={"notice notice-" + kind}>{children}</div>;
}

/**
 * 空状态。B 端门禁：不光要「这里什么都没有」，还要说清为什么为空、
 * 并给一个行动出口。
 */
export function Empty({ title, hint, actions }: {
  title: string; hint?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className="empty-block">
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

/** 列表内的轻量空态：安静的一行，不占一整块留白 */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="fx-empty-inline">{children}</p>;
}

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

/**
 * 业务徽标：浅底深字 + 明确业务文案。
 *
 * **什么时候不要用它**：列表行里的状态优先用 <State>（一行小字 + 圆点）。
 * 每行都挂一个彩色胶囊，会让整页变成一条彩虹，反而不容易扫读。
 * 徽标留给「与正文混排、需要跳出视线」的位置，例如计数、标签、类型。
 */
export function Badge({ tone = "neutral", dot, children }: {
  tone?: BadgeTone; dot?: boolean; children: ReactNode;
}) {
  const cls = "badge" + (tone === "neutral" ? "" : " badge-" + tone) + (dot ? " badge-dot" : "");
  return <span className={cls}>{children}</span>;
}

/**
 * 轻状态标记：圆点 + 文案，不用胶囊。
 *
 * 已发布用实心点（确定的、落地了的），草稿用空心点（还没落地），
 * 回收站沿用危险色。颜色只是辅助线索，文案本身已经说清楚状态。
 */
export function State({ status }: { status: "published" | "draft" | "trash" }) {
  const map = {
    published: { cls: "is-published", text: "已发布" },
    draft: { cls: "is-draft", text: "草稿" },
    trash: { cls: "is-trash", text: "已删除" },
  } as const;
  const m = map[status];
  return <span className={"fx-state " + m.cls}>{m.text}</span>;
}

/**
 * 数值 + 标签（编辑部式的一行数字，不是统计卡片）。
 *
 * 刻意不叫 Kpi、也不用卡片样式：概览页的统计不该是几个等大的白盒子。
 * 这个组件只输出「数字 + 标签」两行排版元素，边界靠上下的细分隔线，
 * 不靠背景色或边框 —— 所以一屏里有四五个也不会变成卡片墙。
 */
export function Figure({ label, value, href, alert }: {
  label: string; value: number | string; href?: string; alert?: boolean;
}) {
  const inner = (
    <>
      <span className={"fx-figure-value" + (alert ? " is-alert" : "")}>{value}</span>
      <span className="fx-figure-label">{label}</span>
    </>
  );
  return href
    ? <Link className="fx-figure" href={href}>{inner}</Link>
    : <div className="fx-figure">{inner}</div>;
}

/** 区块标题：无表面的分组头，靠字重与细线组织 */
export function SectionHead({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="fx-section-head">
      <h2 className="fx-section-title">{title}</h2>
      {action ? <span className="fx-section-more">{action}</span> : null}
    </div>
  );
}
