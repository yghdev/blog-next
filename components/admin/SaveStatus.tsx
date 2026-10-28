"use client";
import { useEffect, useRef } from "react";
import type { AutosaveState } from "@/lib/autosave";

/**
 * 保存状态指示器（方案 §9.2「双状态」）。
 *
 * 关键设计：**草稿状态与线上版本状态必须分开显示**。
 * 合并成一个"已保存"会让用户以为改动已经上线 —— 而这正是草稿/发布两层
 * 要消除的误解。这里永远同时给出两个事实：
 *   - 草稿：正在保存 / 已存草稿（几点）
 *   - 线上：已发布（几点）/ 有未发布改动
 */

export type SaveStatusProps = {
  state: AutosaveState;
  /** 服务端确认的保存时间（UTC ISO），null 表示还没存过 */
  savedAt: string | null;
  /** 线上版本信息：null 表示这篇文章还没发布过 */
  publishedAt: string | null;
  /** 是否存在未发布的草稿改动 */
  hasUnpublishedChanges: boolean;
  /** 本地恢复副本写入失败时为 true —— 必须常驻警告（方案 §8.4） */
  localUnavailable?: boolean;
  /** 保存失败/冲突时的说明 */
  message?: string;
  onRetry?: () => void;
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

const DRAFT_LABEL: Record<AutosaveState, string> = {
  idle: "无未保存改动",
  dirty: "有改动，等待保存",
  queued: "正在保存（有新输入排队）",
  saving: "正在保存…",
  saved: "草稿已保存",
  conflict: "保存冲突，需确认",
  unknown: "保存结果未知",
  failed: "保存失败",
};

export function SaveStatus({
  state, savedAt, publishedAt, hasUnpublishedChanges, localUnavailable, message, onRetry,
}: SaveStatusProps) {
  const tone =
    state === "conflict" || state === "failed" ? "danger"
    : state === "unknown" ? "warn"
    : state === "saved" ? "ok"
    : "neutral";

  const badgeClass =
    tone === "danger" ? "badge badge-danger"
    : tone === "warn" ? "badge badge-warn"
    : tone === "ok" ? "badge badge-ok"
    : "badge";

  return (
    <div className="save-status" role="status" aria-live="polite">
      {/* 第一行：草稿状态 */}
      <div className="save-status-row">
        <span className={badgeClass}>{DRAFT_LABEL[state]}</span>
        {savedAt ? <span className="save-status-meta">草稿存于 {fmt(savedAt)}</span> : null}
        {state === "failed" && onRetry ? (
          <button type="button" className="btn btn-sm" onClick={onRetry}>重试</button>
        ) : null}
      </div>

      {/* 第二行：线上状态。刻意与草稿分开，避免"已保存"被误读成"已上线" */}
      <div className="save-status-row">
        {publishedAt ? (
          <span className="save-status-meta">
            线上版本 {fmt(publishedAt)}
            {hasUnpublishedChanges ? <strong className="save-status-dirty"> · 有未发布改动</strong> : null}
          </span>
        ) : (
          <span className="save-status-meta">
            尚未发布{hasUnpublishedChanges ? <strong className="save-status-dirty"> · 有未发布改动</strong> : null}
          </span>
        )}
      </div>

      {message ? <div className="save-status-msg">{message}</div> : null}

      {/* 本地恢复不可用是常驻警告，不自动消失（方案 §8.4） */}
      {localUnavailable ? (
        <div className="notice notice-warn save-status-local" role="alert">
          本机无法保存恢复副本（可能是隐私模式或存储已满）。
          请立即保存到服务端或导出备份 —— 此时关闭页面，未同步内容可能丢失。
        </div>
      ) : null}
    </div>
  );
}

/**
 * 冲突对比对话框（方案 §9.2「冲突提供三方差异：当前 posts、服务端草稿、本地快照」）。
 *
 * 三方并列而**不提供自动合并**：Markdown 正文自动合并的风险远大于收益
 * （改一个错字可能悄悄吃掉一整段代码块）。用户必须明确选一份，
 * 或手动把想要的内容复制过去。
 */
export type ConflictOption = {
  key: "online" | "server-draft" | "local";
  title: string;
  hint: string;
  content: string;
  /** 该份内容的时间/版本说明 */
  meta: string;
};

export type ConflictDialogProps = {
  open: boolean;
  options: ConflictOption[];
  busy?: boolean;
  onKeepLocal: () => void;
  onUseServer: () => void;
  onClose: () => void;
};

export function ConflictDialog({ open, options, busy, onKeepLocal, onUseServer, onClose }: ConflictDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog ref={ref} className="conflict-dialog" onClose={onClose} aria-label="保存冲突">
      <div className="conflict-head">
        <h2>保存冲突</h2>
        <p>
          这篇内容在别处被改过。下面三份并列显示，<strong>系统不会自动合并</strong> ——
          请对照后决定保留哪一份。
        </p>
      </div>

      <div className="conflict-grid">
        {options.map((o) => (
          <section key={o.key} className="conflict-col">
            <header>
              <h3>{o.title}</h3>
              <p className="conflict-hint">{o.hint}</p>
              <p className="conflict-meta">{o.meta}</p>
            </header>
            <pre className="conflict-body">{o.content}</pre>
          </section>
        ))}
      </div>

      <div className="conflict-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>稍后处理</button>
        <button type="button" className="btn" onClick={onUseServer} disabled={busy}>
          以服务端草稿为准
        </button>
        <button type="button" className="btn btn-primary" onClick={onKeepLocal} disabled={busy}>
          用我的版本覆盖（rebase）
        </button>
      </div>
    </dialog>
  );
}

/**
 * 本地草稿恢复提示条。
 *
 * 单独抽出来是因为它有两条容易写错的要求：
 *   1. 必须显示**这份草稿有多旧**（savedAt）—— 否则用户不知道该不该信它
 *   2. "丢弃"只清本地快照，**不调接口**（与服务端草稿的放弃是两件事）
 */
export type RestoreBannerProps = {
  title: string;
  savedAt: string;
  onRestore: () => void;
  onDiscard: () => void;
};

export function RestoreBanner({ title, savedAt, onRestore, onDiscard }: RestoreBannerProps) {
  return (
    <div className="notice save-restore-banner" role="status">
      <span style={{ flex: 1, fontSize: ".84rem" }}>
        发现本机暂存的草稿「{title || "(无标题)"}」（{fmt(savedAt)}）
      </span>
      <button type="button" className="btn btn-sm" onClick={onRestore}>恢复</button>
      <button type="button" className="btn btn-sm" onClick={onDiscard}>丢弃</button>
    </div>
  );
}
