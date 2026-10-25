import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 后台通用原子组件。
 *
 * 之前这些全用行内 style 各写一遍，结果是「每页一个 padding」。
 * 现在统一收口到类名，页面只负责结构。
 */

export function PageHeader({ title, sub, actions }: {
  title: string; sub?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-row">
        <div style={{ minWidth: 0 }}>
          <h1>{title}</h1>
          {sub ? <p className="page-head-sub">{sub}</p> : null}
        </div>
        {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div> : null}
      </div>
    </div>
  );
}

export function Card({ title, desc, children }: { title?: string; desc?: string; children: ReactNode }) {
  return (
    <section style={{
      border: "1px solid var(--border)", borderRadius: 14, background: "var(--card-bg)",
      padding: 20, marginBottom: 18,
    }}>
      {title ? <h2 style={{ fontSize: ".95rem", color: "var(--text-p0)", margin: "0 0 4px", fontWeight: 600 }}>{title}</h2> : null}
      {desc ? <p style={{ fontSize: ".82rem", color: "var(--text-p3)", margin: "0 0 14px", textWrap: "pretty" }}>{desc}</p> : null}
      {children}
    </section>
  );
}

export function Notice({ kind, children }: { kind: "ok" | "error" | "warn" | "info"; children: ReactNode }) {
  return <div className={"notice notice-" + kind}>{children}</div>;
}

/**
 * 空状态。B 端门禁 14：不光要「这里什么都没有」，
 * 还要说清为什么为空、并给一个行动出口。
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

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info";

/** 业务徽标：浅底深字 + 明确业务文案（门禁 08） */
export function Badge({ tone = "neutral", dot, children }: {
  tone?: BadgeTone; dot?: boolean; children: ReactNode;
}) {
  const cls = "badge" + (tone === "neutral" ? "" : " badge-" + tone) + (dot ? " badge-dot" : "");
  return <span className={cls}>{children}</span>;
}

/** KPI 卡片：数值右对齐等宽数字，label 在上（门禁 12） */
export function Kpi({ label, value, href, alert }: {
  label: string; value: number | string; href?: string; alert?: boolean;
}) {
  const inner = (
    <>
      <span className="kpi-label">{label}</span>
      <span className={"kpi-value" + (alert ? " is-alert" : "")}>{value}</span>
    </>
  );
  return href
    ? <Link className="kpi-card" href={href}>{inner}</Link>
    : <div className="kpi-card">{inner}</div>;
}

