"use client";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Toast（阶段 01-A）。
 *
 * 设计取舍：
 *   1. 不做全局单例的 imperative API（toast.success(...)）。项目的错误提示
 *      目前都是"就地渲染 notice"，引入隐式全局队列会让"这个提示从哪来"变得
 *      难追。这里用受控的 ToastViewport + useToasts 显式管理，调用方持有状态。
 *   2. max 默认 3：超过就丢最旧的。堆到 5 条以上没人读，只会遮住内容。
 *   3. 自动消失按 tone 分档：成功短（2.4s）、错误长（6s，需要时间读完）。
 *      hover 或聚焦时暂停计时，否则用户正在看就消失了。
 *   4. 关闭按钮热区 44px（视觉仍是小图标），符合移动端门禁。
 */

export type ToastTone = "ok" | "warn" | "danger" | "info";

export type ToastItem = {
  id: number;
  tone: ToastTone;
  text: ReactNode;
  /** 覆盖默认存活时间（毫秒）；0 = 不自动消失 */
  duration?: number;
};

const DEFAULT_DURATION: Record<ToastTone, number> = {
  ok: 2400,
  info: 3200,
  warn: 5000,
  // 错误要留够读完的时间；设 0 又会让用户被迫手动关，所以给一个较长的定值
  danger: 6000,
};

let seq = 0;

/** 极简 toast 状态容器。返回 push/dismiss，调用方自己决定在哪渲染 <ToastViewport> */
export function useToasts(max = 3) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = (tone: ToastTone, text: ReactNode, duration?: number) => {
    const id = ++seq;
    setItems((prev) => {
      const next = [...prev, { id, tone, text, duration }];
      // 超出上限时丢最旧的：用户没读到也算，因为最新的才是当前操作的结果
      return next.length > max ? next.slice(next.length - max) : next;
    });
    return id;
  };

  const dismiss = (id: number) => setItems((prev) => prev.filter((t) => t.id !== id));

  return { items, push, dismiss };
}

export function ToastViewport({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="ui-toast-viewport fx-scope">
      {items.map((t) => (
        <ToastCard key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const duration = item.duration ?? DEFAULT_DURATION[item.tone];
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!duration || paused) return;
    const timer = setTimeout(() => onDismiss(item.id), duration);
    return () => clearTimeout(timer);
  }, [duration, paused, item.id, onDismiss]);

  return (
    <div
      className="ui-toast"
      data-tone={item.tone}
      role={item.tone === "danger" ? "alert" : "status"}
      // 悬停/聚焦暂停，避免用户正在读的时候消失
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="ui-toast-text">{item.text}</span>
      <button
        type="button"
        className="ui-toast-close"
        onClick={() => onDismiss(item.id)}
        aria-label="关闭提示"
      >
        ×
      </button>
    </div>
  );
}
