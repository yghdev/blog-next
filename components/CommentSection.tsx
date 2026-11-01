"use client";
import { useEffect, useRef, useState } from "react";

/**
 * 评论区 —— 接入自建 Artalk（https://artalk.js.org）。
 *
 * ⚠️ 用法注意：Artalk v2 的 UMD 包把 window.Artalk 定义成**对象**，
 *    提供 Artalk.init(opts) 方法，不是构造函数。
 *    写成 new Artalk(...) 会抛 "Artalk is not a constructor"，
 *    表现就是"评论组件加载失败"——这个坑踩过一次，记在这里。
 *
 * 其他要点：
 *   1) 脚本异步加载，不阻塞首屏
 *   2) pageKey 用 slug（不用 id）：换库/重建时评论不会错位
 *   3) CSP 必须放行 artalk 域名，否则脚本加载了也不生效
 *   4) **主题必须手动同步**（2026-10-23）：darkMode 传布尔值而不是 "auto"。
 *      "auto" 只看 prefers-color-scheme，用户在本站点手动切到暗色时
 *      （html[data-theme] 变了但系统没变）评论区不会跟着换，视觉上是白框配黑页面。
 */
const ARTALK_SRC = process.env.NEXT_PUBLIC_ARTALK_SRC || "https://artalk.yghsite.cn";
const ARTALK_SITE = process.env.NEXT_PUBLIC_ARTALK_SITE || "flechazo blog";

type ArtalkInstance = {
  destroy: () => void;
  reload: () => void;
  setDarkMode?: (v: boolean) => void;
};
type ArtalkApi = {
  init: (opts: Record<string, unknown>) => ArtalkInstance;
  loadCountWidget?: (el: HTMLElement) => void;
};

declare global {
  interface Window {
    Artalk?: ArtalkApi;
  }
}

let loading: Promise<ArtalkApi> | null = null;

/** 读当前生效的主题：优先 html[data-theme]，没有则看系统 */
function currentIsDark(): boolean {
  if (typeof document === "undefined") return false;
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Artalk 的样式表。不加载的话评论区会完全裸奔（只有文字没有布局）。
 *  CSS 里的图标全是内联 data: SVG，无需额外放行域名。
 */
function ensureArtalkCss(): void {
  const id = "artalk-css";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = ARTALK_SRC + "/dist/Artalk.css";
  document.head.appendChild(link);
}

/** 只加载一次 Artalk 主脚本，多个组件共享 */
function loadArtalk(): Promise<ArtalkApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  ensureArtalkCss();
  if (window.Artalk?.init) return Promise.resolve(window.Artalk);
  if (loading) return loading;

  loading = new Promise<ArtalkApi>((resolve, reject) => {
    const sel = "script[data-artalk-src]";
    const done = () => {
      if (window.Artalk?.init) resolve(window.Artalk);
      else reject(new Error("Artalk 脚本已加载但未挂载到 window"));
    };
    const existing = document.querySelector<HTMLScriptElement>(sel);
    if (existing) {
      existing.addEventListener("load", done);
      existing.addEventListener("error", () => reject(new Error("script error")));
      if (window.Artalk?.init) done();
      return;
    }
    const s = document.createElement("script");
    s.src = ARTALK_SRC + "/dist/Artalk.js";
    s.async = true;
    s.dataset.artalkSrc = "1";
    s.onload = done;
    s.onerror = () => reject(new Error("script error"));
    document.head.appendChild(s);
  });
  return loading;
}

export function CommentSection({ postId, pageKey }: { postId: number; pageKey: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ArtalkInstance | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    loadArtalk()
      .then((Artalk) => {
        if (!alive || !hostRef.current) return;
        instanceRef.current?.destroy();
        instanceRef.current = Artalk.init({
          el: hostRef.current,
          server: ARTALK_SRC,
          site: ARTALK_SITE,
          pageKey,
          pageTitle: document.title,
          locale: "zh-CN",
          // 传布尔值而非 "auto"：让评论区跟随站点自己的主题开关，
          // 而不是只看操作系统设置。
          darkMode: currentIsDark(),
          imgUpload: false,
        });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[artalk] 加载失败:", msg);
        setError("评论组件加载失败：" + msg);
      });

    return () => {
      alive = false;
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, [pageKey]);

  // 主题切换时同步评论区（MutationObserver 监听 html[data-theme]）
  useEffect(() => {
    const sync = () => {
      const inst = instanceRef.current;
      if (!inst?.setDarkMode) return;
      try { inst.setDarkMode(currentIsDark()); } catch { /* 实例可能已销毁 */ }
    };

    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // 未手动选择主题时，系统切换也要跟随
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { if (!localStorage.getItem("blog-theme")) sync(); };
    mq.addEventListener("change", onScheme);

    return () => {
      mo.disconnect();
      mq.removeEventListener("change", onScheme);
    };
  }, []);

  return (
    <section className="comments" data-post-id={postId}>
      {error ? <div className="notice notice-error comment-error">{error}</div> : null}
      <div ref={hostRef} />
    </section>
  );
}
