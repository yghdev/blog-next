"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useScrollLock } from "@/components/ui/useScrollLock";
import { formatBytes } from "@/lib/image-plan";

/**
 * 媒体库大图预览（Lightbox）。
 *
 * 为什么不复用前台那个 `components/Lightbox.tsx`：
 *   前台那个是「给正文图片加一个全局 click 监听」，只认 `.prose img`，
 *   且没有标题、尺寸、引用数与切换按钮。媒体库需要的是**一张图的详情视图**，
 *   不是「点开看看」—— 两张图之间还要能左右翻，否则清理时得关掉再点下一张。
 *
 * 取舍：
 *   - portal 到 body 并自带 .fx-scope：浮层在 .admin-shell 之外，不这样做按钮
 *     会掉回前台样式；同时拿到 --fx-* 令牌。
 *   - 打开时锁滚动，Esc 关闭，左右键切图，关闭后焦点还给触发缩略图。
 *   - 不做缩放/拖拽：这一版的目标是「看清并确认是哪张图」，
 *     缩放会引入手势与双指冲突，收益远小于成本。
 */

export type LightboxItem = {
  id: number;
  path: string;
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
  refs: number;
  storage: "qiniu" | "local";
  uploadedAt: string;
};

export function MediaLightbox({ items, id, onClose, onNavigate, onCopy }: {
  items: LightboxItem[];
  id: number | null;
  onClose: () => void;
  onNavigate: (id: number) => void;
  onCopy: (path: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => { setMounted(true); }, []);
  useScrollLock(id !== null && mounted);

  const index = id === null ? -1 : items.findIndex((it) => it.id === id);
  const item = index >= 0 ? items[index] : null;

  /**
   * 焦点只在**打开/关闭**时处理。
   * 不能和键盘监听放同一个 effect：切图会让依赖变化、effect 重跑，
   * cleanup 里的「还焦点给缩略图」就会在每次按方向键时把焦点抢回去。
   */
  useEffect(() => {
    if (id === null) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => closeRef.current?.focus(), 30);
    return () => {
      clearTimeout(t);
      restoreRef.current?.focus?.();
    };
    // 只关心「有没有打开」，不关心打开的是哪一张
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id === null]);

  // 换图时清掉上一张的「已复制」提示，避免把 A 的复制结果标到 B 上
  useEffect(() => { setCopied(false); }, [id]);

  useEffect(() => {
    if (id === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowLeft" && items.length > 1) {
        e.preventDefault();
        onNavigate(items[(index - 1 + items.length) % items.length].id);
      }
      if (e.key === "ArrowRight" && items.length > 1) {
        e.preventDefault();
        onNavigate(items[(index + 1) % items.length].id);
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      // 焦点圈在浮层里，Tab 不会落到背后的网格上
      const nodes = panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]");
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [id, index, items, onClose, onNavigate]);

  if (!mounted || !item) return null;

  const dims = item.width && item.height ? item.width + " × " + item.height : "尺寸未知";

  return createPortal(
    <div className="dialog-mask media-lightbox-mask fx-scope" onClick={onClose}>
      <div
        ref={panelRef}
        className="media-lightbox"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-lightbox-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="media-lightbox-head">
          <div className="media-lightbox-title-wrap">
            <h2 className="media-lightbox-title" id="media-lightbox-title" title={item.filename}>
              {item.filename}
            </h2>
            <div className="media-lightbox-sub">
              {formatBytes(item.size)} · {dims} · {item.storage === "qiniu" ? "七牛 CDN" : "本机磁盘"}
              {item.uploadedAt ? " · " + item.uploadedAt : ""}
            </div>
          </div>
          <span className="media-lightbox-count" aria-live="polite">
            {index + 1} / {items.length}
          </span>
          <button ref={closeRef} type="button" className="media-lightbox-close" onClick={onClose} aria-label="关闭预览">
            ×
          </button>
        </div>

        <div className="media-lightbox-stage">
          {items.length > 1 ? (
            <button
              type="button"
              className="media-lightbox-nav is-prev"
              aria-label="上一张"
              onClick={() => onNavigate(items[(index - 1 + items.length) % items.length].id)}
            >
              ‹
            </button>
          ) : null}
          {/* 原图直出：后台预览不需要 Next/Image 的响应式裁剪，且本地图与 CDN 图同源处理 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.path} alt={item.filename} decoding="async" />
          {items.length > 1 ? (
            <button
              type="button"
              className="media-lightbox-nav is-next"
              aria-label="下一张"
              onClick={() => onNavigate(items[(index + 1) % items.length].id)}
            >
              ›
            </button>
          ) : null}
        </div>

        <div className="media-lightbox-foot">
          {item.refs > 0 ? (
            <span className="media-lightbox-refs">
              仍被 {item.refs} 篇文章引用 · 不能删除
            </span>
          ) : (
            <span className="media-lightbox-refs is-free">未被任何文章引用</span>
          )}
          <span className="media-lightbox-spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => { onCopy(item.path); setCopied(true); }}
          >
            {copied ? "已复制" : "复制 Markdown 引用"}
          </button>
          <a className="btn btn-sm" href={item.path} target="_blank" rel="noreferrer">
            打开原图
          </a>
        </div>
      </div>
    </div>,
    document.body
  );
}
