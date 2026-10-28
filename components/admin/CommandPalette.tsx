"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminSearchHit } from "@/lib/admin-search";

/**
 * 命令面板（阶段 04，方案 §10）。
 *
 * 三条设计约束，都来自"这个是效率工具，不能变成新的故障点"：
 *
 *  1. **搜索失败不影响导航与操作**。所以面板里永远保留一组静态入口
 *     （写文章 / 内容 / 评论 / 媒体 / 设置…），接口挂了照样能跳转。
 *     把导航能力全部依赖在搜索接口上，等于给后台加了一个单点故障。
 *  2. **纯键盘可用**：Ctrl/Cmd+K 打开，↑↓ 选择，Enter 进入，Esc 关闭。
 *     不做"必须先点输入框"这种半残的键盘支持。
 *  3. 搜索走 300ms 防抖（方案 §0 可调整项），且**只认最后一次请求**：
 *     快速输入时先发的请求可能后到，若把它的结果画上去，用户会看到
 *     与输入框不符的列表。
 */

type StaticAction = {
  key: string;
  label: string;
  hint: string;
  href: string;
  /** 用于搜索过滤的关键词 */
  keywords: string;
};

const STATIC_ACTIONS: StaticAction[] = [
  { key: "new", label: "写文章", hint: "新建一篇", href: "/admin/new", keywords: "写文章 新建 创建 编辑 write new" },
  { key: "posts", label: "内容列表", hint: "文章 / 页面 / 说说", href: "/admin", keywords: "内容 文章 列表 posts content" },
  { key: "overview", label: "概览", hint: "继续工作", href: "/admin/overview", keywords: "概览 首页 待办 overview home" },
  { key: "comments", label: "评论", hint: "审核与回复", href: "/admin/comments", keywords: "评论 审核 comments" },
  { key: "media", label: "媒体", hint: "图片与文件", href: "/admin/media", keywords: "媒体 图片 文件 media" },
  { key: "links", label: "外链", hint: "友链与聚合", href: "/admin/links", keywords: "外链 友链 links" },
  { key: "audit", label: "日志", hint: "操作记录", href: "/admin/audit", keywords: "日志 审计 操作 audit log" },
  { key: "settings", label: "设置", hint: "站点 / 安全 / 存储", href: "/admin/settings", keywords: "设置 配置 settings" },
];

type Item =
  | { kind: "action"; action: StaticAction }
  | { kind: "hit"; hit: AdminSearchHit };

const TYPE_LABEL: Record<string, string> = { post: "文章", page: "页面", shuoshuo: "说说" };

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AdminSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** 只认最后一次请求：先发后到的响应必须丢弃 */
  const reqSeq = useRef(0);

  /* ---------------- 快捷键 ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      // 打开后自动聚焦，用户不必再点一下输入框
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    // 关闭时清空，下次打开是干净状态
    setQ(""); setHits([]); setError(""); setActive(0);
  }, [open]);

  /* ---------------- 搜索（300ms 防抖） ---------------- */
  useEffect(() => {
    if (!open) return;
    const keyword = q.trim();
    if (!keyword) {
      setHits([]); setLoading(false); setError("");
      return;
    }

    const seq = ++reqSeq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/admin/search?q=" + encodeURIComponent(keyword));
        // 丢弃过期响应
        if (seq !== reqSeq.current) return;
        if (!res.ok) {
          /**
           * 搜索失败**不弹全局错误、不清空静态入口**。
           * 用户此刻最可能的需求是"算了，直接去内容列表"，
           * 而不是阅读一段错误信息。所以只在面板内提示一行。
           */
          setError("搜索暂时不可用，你仍可以用下面的快捷入口");
          setHits([]);
          return;
        }
        const d = await res.json();
        if (seq !== reqSeq.current) return;
        setHits(Array.isArray(d.hits) ? d.hits : []);
        setError("");
        setActive(0);
      } catch {
        if (seq !== reqSeq.current) return;
        setError("搜索暂时不可用，你仍可以用下面的快捷入口");
        setHits([]);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [q, open]);

  /* ---------------- 组装列表 ---------------- */
  const actions = useMemo(() => {
    const keyword = q.trim().toLowerCase();
    if (!keyword) return STATIC_ACTIONS;
    return STATIC_ACTIONS.filter(
      (a) => a.label.toLowerCase().includes(keyword) || a.keywords.toLowerCase().includes(keyword)
    );
  }, [q]);

  const items: Item[] = useMemo(() => {
    const list: Item[] = actions.map((action) => ({ kind: "action" as const, action }));
    for (const hit of hits) list.push({ kind: "hit", hit });
    return list;
  }, [actions, hits]);

  // 选中项越界时归零（结果数量变化后 active 可能指向不存在的项）
  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items.length, active]);

  const go = useCallback((item: Item) => {
    const href = item.kind === "action" ? item.action.href : "/admin/edit/" + item.hit.id;
    setOpen(false);
    router.push(href);
  }, [router]);

  /* ---------------- 键盘导航 ---------------- */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item) go(item);
    }
  };

  // 选中项滚动进视野：列表比面板高时，键盘移动必须能带过去
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  return (
    <div className="cmdk-backdrop" onClick={() => setOpen(false)}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索内容或跳转…（Esc 关闭）"
          aria-label="搜索内容或跳转"
          aria-controls="cmdk-list"
          aria-activedescendant={items[active] ? "cmdk-item-" + active : undefined}
          autoComplete="off"
        />

        {error ? <div className="cmdk-error" role="status">{error}</div> : null}

        <ul className="cmdk-list" id="cmdk-list" ref={listRef} role="listbox" aria-label="结果">
          {loading && items.length === 0 ? (
            <li className="cmdk-empty">正在搜索…</li>
          ) : items.length === 0 ? (
            <li className="cmdk-empty">
              {q.trim() ? "没有匹配的内容" : "输入关键词开始搜索"}
            </li>
          ) : (
            items.map((item, i) => (
              <li
                key={item.kind === "action" ? "a-" + item.action.key : "h-" + item.hit.id}
                id={"cmdk-item-" + i}
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                className={"cmdk-item" + (i === active ? " is-active" : "")}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item)}
              >
                {item.kind === "action" ? (
                  <>
                    <span className="cmdk-icon" aria-hidden="true">→</span>
                    <span className="cmdk-main">
                      <span className="cmdk-title">{item.action.label}</span>
                      <span className="cmdk-meta">{item.action.hint}</span>
                    </span>
                    <span className="cmdk-badge">跳转</span>
                  </>
                ) : (
                  <>
                    <span className="cmdk-icon" aria-hidden="true">·</span>
                    <span className="cmdk-main">
                      <span className="cmdk-title">{item.hit.title}</span>
                      <span className="cmdk-meta">
                        {TYPE_LABEL[item.hit.type] ?? item.hit.type}
                        {" · "}
                        {item.hit.status === "published" ? "已发布" : "草稿"}
                        {item.hit.hasDraft ? " · 有未发布改动" : ""}
                        {item.hit.matchedIn === "draft" ? " · 命中草稿标题" : ""}
                      </span>
                    </span>
                    <span className="cmdk-badge">编辑</span>
                  </>
                )}
              </li>
            ))
          )}
        </ul>

        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
          <span className="cmdk-foot-hint">Ctrl/Cmd + K 随时唤起</span>
        </div>
      </div>
    </div>
  );
}
