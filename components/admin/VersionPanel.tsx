"use client";
import { useEffect, useState } from "react";
import { diffLines, groupHunks, diffSnapshotFields, type Snapshot } from "@/lib/diff";

/**
 * 版本历史与对比（阶段 03.3，方案 §9.2/§9.3）。
 *
 * 两条不能含糊的语义，界面上必须让用户看见：
 *   1. **恢复只改草稿，不改线上**。所以按钮写"恢复为草稿"而不是"恢复"，
 *      并在确认处说明"还需要发布才会更新前台"。
 *   2. **revision 不是第几次发布**。它是行版本，元数据改一次也会涨，
 *      所以列表按时间倒序、显示"发布/初始基线"而不是"第 N 版"。
 */

export type VersionItem = {
  id: number;
  revision: number;
  reason: string;
  createdAt: string;
  snapshotHash: string;
  label: string;
};

export type VersionPanelProps = {
  postId: number;
  open: boolean;
  onClose: () => void;
  /** 恢复成功：把快照交回编辑器，让用户继续编辑 */
  onRestored: (snapshot: Snapshot) => void;
  /** 当前草稿的版本号，用于带版本校验调用恢复接口 */
  currentDraftRevision: number;
  currentPostRevision: number;
  clientDraftId: string;
  token?: string;
};

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function VersionPanel({
  postId, open, onClose, onRestored,
  currentDraftRevision, currentPostRevision, clientDraftId,
}: VersionPanelProps) {
  const [versions, setVersions] = useState<VersionItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [compare, setCompare] = useState<{
    fromLabel: string; toLabel: string;
    fieldRows: ReturnType<typeof diffSnapshotFields>;
    hunks: ReturnType<typeof groupHunks>;
    added: number; removed: number; identical: boolean;
  } | null>(null);

  // 打开时拉版本列表
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setVersions(null); setErr(""); setSelected(null); setCompare(null);
      const res = await fetch("/api/admin/posts/" + postId + "/restore-version");
      if (cancelled) return;
      if (!res.ok) { setErr("加载版本历史失败"); setVersions([]); return; }
      const d = await res.json();
      setVersions(d.versions ?? []);
    })();
    return () => { cancelled = true; };
  }, [open, postId]);

  /** 选中某版 -> 拉 diff（与当前草稿比） */
  async function loadDiff(revision: number) {
    setBusy(true); setErr("");
    try {
      const res = await fetch(
        "/api/admin/posts/" + postId + "/version-diff?from=" + revision + "&to=current"
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErr(d.error || "对比失败");
        return;
      }
      const d = await res.json();
      const a = d.from.snapshot as Snapshot;
      const b = d.to.snapshot as Snapshot;
      const diff = diffLines(String(a.content ?? ""), String(b.content ?? ""));
      setSelected(revision);
      setCompare({
        fromLabel: d.from.label,
        toLabel: d.to.label,
        fieldRows: diffSnapshotFields(a, b),
        hunks: groupHunks(diff.lines),
        added: diff.added,
        removed: diff.removed,
        identical: diff.identical,
      });
    } finally {
      setBusy(false);
    }
  }

  /** 恢复为草稿：只改草稿，不改线上 */
  async function restoreToDraft(revision: number) {
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/admin/posts/" + postId + "/restore-version", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision,
          expectedDraftRevision: currentDraftRevision,
          expectedPostRevision: currentPostRevision,
          clientDraftId,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(d.error || "恢复失败");
        return;
      }
      /**
       * 恢复成功后把内容交回编辑器。
       *
       * 直接再读一次服务端草稿，而不是自己把 version-diff 的 to 侧拼出来：
       * 恢复过程中 posts 可能刚好被别处改动，重读才是"此刻真实生效的那份草稿"。
       * 也避免用本地推算的快照覆盖掉服务端刚算出的 hash。
       */
      const after = await fetch("/api/admin/posts/" + postId + "/draft");
      if (after.ok) {
        const dd = await after.json();
        if (dd.draft) onRestored(dd.draft.snapshot as Snapshot);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="version-panel" role="dialog" aria-label="版本历史">
      <div className="version-head">
        <h2>版本历史</h2>
        <p className="version-hint">
          恢复历史<strong>只替换当前草稿</strong>，不会改动线上内容 —— 恢复后仍需发布才会更新前台。
        </p>
        <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>关闭</button>
      </div>

      {err ? <div className="notice notice-error">{err}</div> : null}

      <div className="version-body">
        <ul className="version-list">
          {versions === null ? (
            <li className="version-empty">正在加载…</li>
          ) : versions.length === 0 ? (
            <li className="version-empty">还没有历史版本。发布一次之后这里就会出现记录。</li>
          ) : (
            versions.map((v) => (
              <li key={v.id} className={"version-item" + (selected === v.revision ? " is-active" : "")}>
                <div className="version-item-main">
                  <span className="version-item-label">{v.label}</span>
                  <span className="version-item-rev">版本号 {v.revision}</span>
                  <span className="version-item-time">{fmtTime(v.createdAt)}</span>
                </div>
                <div className="version-item-actions">
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void loadDiff(v.revision)}>
                    与当前对比
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void restoreToDraft(v.revision)}>
                    恢复为草稿
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>

        {compare ? (
          <div className="version-diff">
            <div className="version-diff-head">
              <strong>{compare.fromLabel}</strong>
              <span className="version-arrow">→</span>
              <strong>{compare.toLabel}</strong>
              <span className="version-stat">
                {compare.identical ? "内容完全相同" : "+" + compare.added + " 行 / -" + compare.removed + " 行"}
              </span>
            </div>

            {/* 元数据差异先列出来：标题/slug 变了但正文没变，是最容易看漏的情况 */}
            <div className="version-fields">
              {compare.fieldRows.filter((r) => r.changed).length === 0 ? (
                <p className="version-fields-none">标题、路径、分类等元数据无变化</p>
              ) : (
                compare.fieldRows.filter((r) => r.changed).map((r) => (
                  <div key={r.field} className="version-field-row">
                    <span className="version-field-name">{r.label}</span>
                    <span className="version-field-from">{r.from}</span>
                    <span className="version-arrow">→</span>
                    <span className="version-field-to">{r.to}</span>
                  </div>
                ))
              )}
            </div>

            {compare.identical ? (
              <p className="version-identical">正文逐字节相同，没有行级差异。</p>
            ) : (
              <div className="version-lines">
                {compare.hunks.map((h, i) => (
                  <div key={i} className={"version-hunk hunk-" + h.op}>
                    {h.lines.map((l, k) => (
                      <div key={k} className={"version-line line-" + l.op}>
                        <span className="version-no">{l.leftNo ?? ""}</span>
                        <span className="version-no">{l.rightNo ?? ""}</span>
                        <span className="version-sign">{l.op === "insert" ? "+" : l.op === "delete" ? "-" : " "}</span>
                        <code className="version-text">{l.text || " "}</code>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
