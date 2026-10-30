"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 概览页的速记框：没有草稿时，把「未发布草稿」那一栏变成可用的输入区。
 *
 * 为什么不是另开一套写入接口：速记本质就是一条**说说草稿**，必须走
 * `POST /api/admin/posts`（建壳 + 挂草稿）这条既有通路。自己拼一个
 * INSERT 会绕开 revision、审计、缓存失效，出现「速记存了但列表里没有」
 * 或者「发布后编辑器和列表状态打架」这种只在速记路径复现的怪事。
 *
 * 交互取舍：
 *   1. 默认存成草稿，不直接发布 —— 概览页不该有「误触即对外可见」的动作。
 *      要发就点「去编辑器写」：先落草稿再跳转，正文不会丢在半路。
 *   2. Ctrl/Cmd + Enter 提交；内容为空时按钮禁用，不制造一次空请求。
 *   3. 提交成功后清空输入并刷新服务端组件：这条草稿会立刻成为首屏的
 *      「接着上次的草稿」，同时计数 +1。**这块卡片本身就是成功反馈**，
 *      所以不再额外弹 toast —— 刷新后组件会被替换，浮层反而会消失得莫名其妙。
 */
export function QuickCapture() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉待执行的刷新计时器，避免在已卸载组件上 setState
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  // 自适应高度：两三行短句不滚动，长一点就长高，最多约 6 行
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 152) + "px";
  }, [text]);

  /** 存一条说说草稿。返回新建的 id，失败返回 null（错误已就地展示）。 */
  const save = async (): Promise<number | null> => {
    const body = text.trim();
    if (!body || busy) return null;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/admin/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "shuoshuo", title: "", content: body, status: "draft" }),
      });
      const data = await res.json().catch(() => null) as
        | { ok?: boolean; id?: number; error?: string; code?: string }
        | null;
      if (!res.ok || !data?.ok || !data.id) {
        setErr(data?.error || "速记没有保存成功，请重试");
        return null;
      }
      setText("");
      setSaved(true);
      /**
       * 让「已存为草稿」先被看见，再刷新。
       *
       * 刷新会把这块速记卡换成「接着上次的草稿」，如果立刻刷新，
       * 用户只看到内容消失、版面跳动，容易误判成"没存上"。
       * 600ms 足够读完一行字，又不至于让操作显得迟滞。
       */
      refreshTimer.current = setTimeout(() => {
        // 刷新服务端组件：计数、草稿列表、最近编辑都要跟着变
        router.refresh();
      }, 600);
      return data.id;
    } catch {
      setErr("网络异常，速记没有保存。内容还在输入框里，可以直接重试。");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => { await save(); };

  /** 带着刚写的内容进编辑器：先落草稿再跳转，正文不会丢在半路 */
  const openFull = async () => {
    if (!text.trim()) { router.push("/admin/new?type=shuoshuo"); return; }
    const id = await save();
    if (id) router.push("/admin/edit/" + id);
  };

  return (
    <div className="quick-capture">
      <label className="quick-capture-label" htmlFor="quick-capture-input">
        速记内容
      </label>
      <textarea
        id="quick-capture-input"
        ref={taRef}
        className="quick-capture-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (saved) setSaved(false);
          if (err) setErr("");
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
        }}
        placeholder="此刻的想法、待办、一句摘录…存下来就是一条说说草稿。"
        rows={2}
        maxLength={2000}
        aria-describedby="quick-capture-hint"
      />
      <div className="quick-capture-foot">
        <span className="quick-capture-hint" id="quick-capture-hint" role="status">
          {saved
            ? "已存为草稿，正在刷新…"
            : text.length > 0
              ? text.length + " / 2000"
              : "Ctrl / ⌘ + Enter 保存"}
        </span>
        <div className="quick-capture-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void openFull()}
            disabled={busy}
          >
            去编辑器写
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void submit()}
            disabled={busy || !text.trim()}
          >
            {busy ? "保存中…" : saved ? "已保存 ✓" : "存为草稿"}
          </button>
        </div>
      </div>
      {err ? <p className="quick-capture-error" role="alert">{err}</p> : null}
    </div>
  );
}
