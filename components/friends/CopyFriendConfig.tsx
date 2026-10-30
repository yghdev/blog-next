"use client";
import { useEffect, useRef, useState } from "react";
import { SiteAvatar } from "./SiteAvatar";

/**
 * 「复制本站友链信息」按钮。
 *
 * 三条实现约束，都来自本项目已有的坑：
 *
 * 1) **复制失败必须有出路**。navigator.clipboard 只在安全上下文（https/localhost）
 *    可用，且用户可能拒绝权限。失败时不再弹一个浏览器 alert 就完事，而是把
 *    配置文本展开在按钮下面，让用户手动全选复制。
 *
 * 2) **反馈自熄**。成功态 2.5s 后还原，与全站 .copy-btn[data-done] 的过渡同一套
 *    淡出节奏；文案宽度用 min-width 锁住，按钮不因「复制/已复制」抖动。
 *
 * 3) **不做 aria-live 轰炸**。提示挂在一个 role="status" 的常驻节点上，
 *    只改文字，读屏会读一次而不是重新插入整块。
 */
export function CopyFriendConfig({
  text,
  label = "复制本站友链信息",
}: {
  text: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const flash = () => {
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 2500);
  };

  const copy = async () => {
    setFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      flash();
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="fr-copy">
      <button
        type="button"
        className="fr-copy-btn copy-btn"
        data-done={done ? "true" : "false"}
        onClick={copy}
        aria-label={label}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
          {done ? (
            <path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <>
              <rect x="9" y="9" width="11" height="11" rx="2" fill="none"
                    stroke="currentColor" strokeWidth="1.7" />
              <path d="M15 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1.5"
                    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </>
          )}
        </svg>
        {/* 两段文案叠在同一个网格单元里：宽度取较长的一条，
            「复制 → 已复制」不会让按钮抖动（CLS）。视觉文案对读屏隐藏，
            真正的播报由下面那个 role=status 负责。 */}
        <span className="fr-copy-label" aria-hidden="true">
          <span className="fr-copy-idle">{label}</span>
          <span className="fr-copy-done">已复制到剪贴板</span>
        </span>
      </button>

      <span className="fr-sr-only" role="status">
        {done ? "本站友链信息已复制到剪贴板" : ""}
      </span>

      {failed ? (
        <div className="fr-copy-fallback" role="alert">
          <p>浏览器不允许自动复制（常见于非 HTTPS 环境或权限被拒），请手动复制下面这段：</p>
          <textarea readOnly value={text} rows={6} onFocus={(e) => e.currentTarget.select()} />
        </div>
      ) : null}
    </div>
  );
}
