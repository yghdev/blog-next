"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useScrollLock } from "@/components/ui/useScrollLock";
import { mediaSnippet, type MediaKind } from "@/lib/editor-media";

/**
 * 从媒体库插入资源（编辑器用）。
 *
 * 为什么需要它：在编辑器里插入一张「上个月传过的封面」时，用户手上没有那个
 * URL —— 只有两种办法，重新上传一遍（占双份空间、媒体库里出现两张一样的图），
 * 或者去 /admin/media 复制再回来粘贴（丢掉编辑位置）。这个面板把那条路缩成
 * 一次点击。
 *
 * 三个刻意的取舍：
 *   1. **挂在 portal 上而不是页面里**：编辑器有 `editor-aside` 的 sticky 容器，
 *      在它内部放浮层会被裁切；portal 到 body 顺带拿到 `.fx-scope` 作用域。
 *   2. **只做插入，不做管理**：删除、扫描孤儿这些仍归 /admin/media 管。
 *      一个「选择器」不该长出第二个管理界面。
 *   3. **搜索防抖 300ms 且可取消**：媒体库可能上万条，逐字发请求会打满连接；
 *      同时用请求序号丢弃过期响应，避免"打字快时结果回跳"。
 */

type Item = {
  id: number;
  path: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  kind: MediaKind;
};

type Filter = "all" | "image" | "video";

const PAGE = 48;

export function MediaPicker({ open, onClose, onPick }: {
  open: boolean;
  onClose: () => void;
  /** 交给编辑器插入正文；kind 已由服务端判定 */
  onPick: (snippet: string, item: Item) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [offset, setOffset] = useState(0);

  /** 请求序号：只接受最后一次发出的响应，防止慢请求覆盖新结果 */
  const seq = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open && mounted);

  const load = useCallback(async (nextOffset: number, append: boolean) => {
    const id = ++seq.current;
    setLoading(true);
    setErr("");
    try {
      const sp = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      if (q.trim()) sp.set("q", q.trim());
      if (filter !== "all") sp.set("kind", filter);
      const res = await fetch("/api/admin/media?" + sp.toString());
      const d = await res.json().catch(() => ({}));
      if (id !== seq.current) return;                    // 已被更新的请求取代
      if (!res.ok) { setErr(d.error || "媒体库加载失败"); return; }
      const rows = (d.rows ?? []) as Item[];
      setItems((prev) => (append ? [...prev, ...rows] : rows));
      setTotal(d.total ?? rows.length);
      setOffset(nextOffset);
    } catch {
      if (id === seq.current) setErr("媒体库加载失败（网络问题？）");
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [q, filter]);

  /* 打开时重置并加载第一页 —— 每次都从干净状态开始，避免上次的搜索残留 */
  useEffect(() => {
    if (!open) return;
    setQ("");
    setFilter("all");
    setItems([]);
    setTotal(0);
    // 等 state 落定再拉：直接用默认参数请求，绕过上面被重置的闭包值
    const id = ++seq.current;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/media?limit=" + PAGE + "&offset=0");
        const d = await res.json().catch(() => ({}));
        if (id !== seq.current) return;
        if (res.ok) { setItems(d.rows ?? []); setTotal(d.total ?? 0); setOffset(0); }
        else setErr(d.error || "媒体库加载失败");
      } catch {
        if (id === seq.current) setErr("媒体库加载失败（网络问题？）");
      } finally {
        if (id === seq.current) setLoading(false);
      }
    })();
  }, [open]);

  /* 搜索 / 筛选变化：防抖 300ms 后重新从第一页拉 */
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { void load(0, false); }, 300);
    return () => clearTimeout(t);
  }, [q, filter, open, load]);

  /* 焦点管理：打开进面板，Esc 关闭并把焦点还给触发元素 */
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      restoreFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const hasMore = items.length < total;

  return createPortal(
    <div className="dialog-mask fx-scope" onClick={onClose}>
      <div
        ref={panelRef}
        className="dialog-panel fx-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fx-picker-head">
          <h2 className="dialog-title" id="picker-title">从媒体库插入</h2>
          <button type="button" className="fx-picker-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <p className="dialog-desc">
          点选即可插入到光标处。图片插 Markdown 引用，视频插原生 <code>video</code> 标签。
        </p>

        <div className="fx-picker-tools">
          <div className="fx-picker-tabs" role="group" aria-label="按类型筛选">
            {([
              { key: "all", label: "全部" },
              { key: "image", label: "图片" },
              { key: "video", label: "视频" },
            ] as { key: Filter; label: string }[]).map((f) => (
              <button
                key={f.key}
                type="button"
                className={"fx-picker-tab" + (filter === f.key ? " is-active" : "")}
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
              >{f.label}</button>
            ))}
          </div>
          <label className="fx-picker-search">
            <span className="sr-only">搜索文件名</span>
            <input
              ref={inputRef}
              className="input"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索文件名或路径"
            />
          </label>
        </div>

        {err ? <div className="notice notice-error" role="alert">{err}</div> : null}

        {items.length === 0 && loading ? (
          <div className="fx-picker-empty">正在加载…</div>
        ) : items.length === 0 ? (
          <div className="fx-picker-empty">
            {q || filter !== "all"
              ? "没有匹配的资源。换个关键词，或切回「全部」。"
              : "媒体库还是空的。在编辑器里粘贴或拖入文件即可上传。"}
          </div>
        ) : (
          <div className="fx-picker-grid">
            {items.map((m) => (
              <button
                key={m.id}
                type="button"
                className="fx-picker-item"
                onClick={() => {
                  onPick(mediaSnippet(m.kind, m.path, m.filename.replace(/\.[^.]+$/, "")), m);
                  onClose();
                }}
                title={m.filename}
              >
                <span className="fx-picker-thumb">
                  {m.kind === "video" ? (
                    <>
                      {/* 视频不生成缩略图：服务端没有转码能力，用原生 video 取首帧代价太高。
                          这里给一个明确的类型标记，比显示一个永远空白的 <img> 诚实。 */}
                      <span className="fx-picker-video-badge">视频</span>
                    </>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={m.path} alt="" loading="lazy" decoding="async" />
                  )}
                </span>
                <span className="fx-picker-name">{m.filename}</span>
              </button>
            ))}
          </div>
        )}

        <div className="fx-picker-foot">
          <span className="fx-picker-count">
            {loading && items.length > 0 ? "加载中…" : "已显示 " + items.length + " / " + total}
          </span>
          {hasMore ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={loading}
              onClick={() => void load(offset + PAGE, true)}
            >{loading ? "加载中…" : "加载更多"}</button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
