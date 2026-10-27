"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Empty } from "./ui";

type Item = {
  id: number; path: string; filename: string; mime: string; size: number;
  created_at: string; width: number | null; height: number | null; refs: number;
  /** 图片实际存在哪：七牛（CDN 直链）还是本机磁盘（历史存量） */
  storage: "qiniu" | "local";
};

export function MediaGrid({ items, storageConfigured, cdnDomain }: {
  items: Item[];
  storageConfigured: boolean;
  cdnDomain: string;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [orphans, setOrphans] = useState<string[] | null>(null);
  const [pending, setPending] = useState<Item | null>(null);
  /* 铁律 10：复制反馈自熄——记录刚复制的那一项，2.5s 后自动淡出恢复 */
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async (p: string) => {
    // 重复点击先清计时器：不叠加、不闪烁、不提前熄灭
    if (copyTimer.current) { clearTimeout(copyTimer.current); copyTimer.current = null; }
    try {
      await navigator.clipboard.writeText("![](" + p + ")");
      setCopied(p);
      setMsg("已复制 Markdown 引用：" + p);
      copyTimer.current = setTimeout(() => {
        setCopied(null);
        setMsg("");
        copyTimer.current = null;
      }, 2500);
    } catch {
      setErr("复制失败，请手动选取");
    }
  };

  const remove = async (item: Item) => {
    setMsg(""); setErr(""); setBusy(true); setPending(null);
    const res = await fetch("/api/admin/media/" + item.id, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg("已删除"); router.refresh(); }
    else setErr(d.error || "删除失败");
  };

  const scan = async () => {
    setMsg(""); setErr(""); setBusy(true);
    const res = await fetch("/api/admin/media", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "scan-orphans" }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setOrphans(d.orphans || []);
      setMsg(
        "本机 " + d.onDisk + " 个 / 七牛 " + (d.qiniu ?? 0) + " 个 / 库内 " + d.inDb + " 条" +
        " / 孤儿 " + d.orphanCount + " 个" +
        (d.missingCount ? " / 裂图 " + d.missingCount + " 个" : "")
      );
    } else setErr(d.error || "扫描失败");
  };

  return (
    <>
      <div style={{
        display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap",
        alignItems: "center",
      }}>
        <button className="btn btn-sm" onClick={scan} disabled={busy}>扫描孤儿文件</button>
        <span style={{
          fontSize: ".72rem", padding: "3px 10px", borderRadius: 20,
          background: storageConfigured ? "var(--ok-bg, #e7f7ee)" : "var(--warn-bg, #fff4e5)",
          color: storageConfigured ? "var(--ok-fg, #1a7f4b)" : "var(--warn-fg, #a15c00)",
        }}>
          {storageConfigured
            ? "新图写入七牛 · " + (cdnDomain || "CDN 未填")
            : "七牛未配置 · 新图写入本机磁盘"}
        </span>
      </div>

      {msg ? <div className="notice notice-ok">{msg}</div> : null}
      {err ? <div className="notice notice-error">{err}</div> : null}

      {orphans && orphans.length ? (
        <section style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginBottom: 18, background: "var(--card-bg)" }}>
          <div style={{ fontSize: ".85rem", color: "var(--text-p2)", marginBottom: 8 }}>
            以下文件在磁盘上但不在 media 表里（多为历史上传，未自动删除）：
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: ".74rem", color: "var(--text-p3)", maxHeight: 160, overflow: "auto" }}>
            {orphans.map((o) => <div key={o}>{o}</div>)}
          </div>
        </section>
      ) : null}

      {items.length === 0 ? (
        <Empty
          title="还没有图片"
          hint="在编辑器里粘贴或拖入图片就会自动上传到这里。历史文章里引用过但没登记的图片，可以用上方「扫描孤儿文件」找出来。"
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 12 }}>
          {items.map((m) => (
            <figure key={m.id} style={{
              margin: 0, border: "1px solid var(--border)", borderRadius: 12,
              overflow: "hidden", background: "var(--card-bg)",
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.path} alt={m.filename} loading="lazy"
                   style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} />
              <figcaption style={{ padding: "8px 10px" }}>
                <div style={{ fontSize: ".72rem", color: "var(--text-p3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.filename}
                </div>
                <div style={{ fontSize: ".68rem", color: "var(--text-p4)", margin: "2px 0 8px" }}>
                  {(m.size / 1024).toFixed(0)} KB{m.width ? " · " + m.width + "×" + m.height : ""}
                  {" · "}{m.refs > 0 ? "引用 " + m.refs : "未引用"}
                </div>
                <div style={{ fontSize: ".66rem", color: "var(--text-p4)", marginBottom: 8 }}>
                  <span style={{
                    padding: "1px 6px", borderRadius: 4,
                    background: "var(--bg-tint)",
                    color: m.storage === "qiniu" ? "var(--ok-fg, #1a7f4b)" : "var(--text-p3)",
                  }}>{m.storage === "qiniu" ? "七牛 CDN" : "本机磁盘"}</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className="btn btn-sm copy-btn"
                    data-done={copied === m.path ? "true" : "false"}
                    aria-live="polite"
                    style={{ padding: "2px 8px", fontSize: ".72rem" }}
                    onClick={() => copy(m.path)}
                  >{copied === m.path ? "已复制" : "复制"}</button>
                  <button className="btn btn-sm btn-danger" disabled={busy || m.refs > 0}
                          title={m.refs > 0 ? "仍被文章引用，不能删除" : "删除"}
                          style={{ padding: "2px 8px", fontSize: ".72rem", opacity: m.refs > 0 ? .45 : 1 }}
                          onClick={() => setPending(m)}>删除</button>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={"删除图片「" + (pending?.filename ?? "") + "」？"}
        description={
          <>
            文件会从磁盘和 media 表里一起移除，<strong>不可撤销</strong>。
            若这张图仍被任何文章引用，按钮是禁用状态 —— 请先改掉正文里的引用。
          </>
        }
        confirmLabel="删除图片"
        danger
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => { if (pending) void remove(pending); }}
      />
    </>
  );
}
