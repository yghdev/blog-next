"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * 评论操作（B 端门禁 07 + 11）。
 *
 * 「通过」与「垃圾」在审核语境下是一对责任判断，二者都用次级按钮样式，
 * 不用颜色诱导 —— 之前「通过」是实心主按钮，「垃圾」是灰色，等于替审核人
 * 先做了决定。真正的破坏性操作「删除」才用语义红色，并且必须确认。
 */
export function CommentActions({ id, currentStatus }: { id: number; currentStatus?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirming, setConfirming] = useState(false);

  const act = async (action: "approve" | "spam" | "delete") => {
    setBusy(true); setErr("");
    const res = await fetch("/api/admin/comments/" + id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setErr(d.error || "操作失败");
    }
    setBusy(false);
    setConfirming(false);
    router.refresh();
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {currentStatus !== "approved" ? (
          <button className="btn btn-sm" disabled={busy} onClick={() => act("approve")}>通过</button>
        ) : null}
        {currentStatus !== "spam" ? (
          <button className="btn btn-sm" disabled={busy} onClick={() => act("spam")}>标记垃圾</button>
        ) : null}
        <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirming(true)}>
          删除
        </button>
      </div>
      {err ? <div className="notice notice-error" style={{ margin: "8px 0 0", padding: "6px 10px" }}>{err}</div> : null}

      <ConfirmDialog
        open={confirming}
        title="删除这条评论？"
        description="删除后该评论从前台立即消失，且无法在后台找回。如果只是不希望它显示，用「标记垃圾」可以保留记录。"
        confirmLabel="删除评论"
        danger
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => act("delete")}
      />
    </div>
  );
}
