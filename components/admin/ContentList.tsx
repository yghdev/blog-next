"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { State } from "./ui";

/**
 * 内容列表（B 端设计系统 · 列表页骨架）。
 *
 * 两种行，对应两种信息结构 —— 不是同一套样式换皮：
 *
 *   title 变体（文章 / 页面 / 回收站）：标题是这一行的身份，一行读完。
 *     选择框 → 类型（仅回收站）→ 状态 → 标题 → 日期 → 操作
 *
 *   body 变体（说说）：**正文就是身份**。说说通常只有一两句，没有标题，
 *     如果按标题模型渲染就只能显示「(无标题)」—— 那是把系统的结构缺陷
 *     丢给用户看。这里正文直接当一号信息（15px / 墨色 / 最多 3 行），
 *     下面一行放状态、时间、字数。扫读顺序变成「先读到话，再看到元信息」。
 *
 * 保留既有契约：
 *  - 每项带 revision，批量/删除必须逐项传 expectedRevision（不做旧值兜底）
 *  - 危险操作走 ConfirmDialog，不裸执行
 *  - 状态用 State（圆点 + 文案），不用彩色胶囊：一屏 20 行挂胶囊会变彩虹
 */
type Item = {
  id: number;
  type: string;
  /** 主信息：文章/页面是标题，说说没有标题 */
  label: string;
  /** 纯文本摘要（说说用它当正文） */
  excerpt: string;
  /** 去空白字数 */
  chars: number;
  status: string;
  dateLabel: string;
  revision: number;
  hasDraft?: boolean;
  hasImage?: boolean;
};

const TYPE_LABEL: Record<string, string> = { post: "文章", page: "页面", shuoshuo: "说说" };

export function ContentList({ items, trash, stepUpRequired, variant = "title", showType = false }: {
  items: Item[];
  trash: boolean;
  stepUpRequired: boolean;
  /** title = 标题优先（文章/页面/回收站）；body = 正文优先（说说） */
  variant?: "title" | "body";
  /** 是否显示类型标记（回收站里类型混杂，需要；独立页面不需要） */
  showType?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [bulkResult, setBulkResult] = useState<
    | null
    | {
        summary: { total: number; succeeded: number; skipped: number; conflicts: number; notFound: number };
        problems: { id: number; message: string }[];
      }
  >(null);
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<
    | null
    | { kind: "bulk-delete" }
    | {
        kind: "purge"; id: number; title: string;
        comments: number | null; versions: number | null; drafts: number | null;
      }
  >(null);

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allOn = items.length > 0 && selected.length === items.length;

  const bulk = async (action: string) => {
    setMsg(""); setErr("");
    if (!selected.length) { setErr("请先选择条目"); return; }
    setBusy(true);
    const targets = selected
      .map((id) => items.find((it) => it.id === id))
      .filter((it): it is Item => !!it)
      .map((it) => ({ id: it.id, expectedRevision: it.revision }));
    const res = await fetch("/api/admin/posts/bulk", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: targets, action, totp: code }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    setPending(null);
    if (res.ok) {
      const summary = d.summary ?? { total: 0, succeeded: 0, skipped: 0, conflicts: 0, notFound: 0 };
      const problems = (d.results ?? [])
        .filter((r: any) => !r.ok)
        .map((r: any) => ({ id: r.id, message: r.message ?? r.code ?? "未处理" }));
      setBulkResult({ summary, problems });
      setMsg("");
      setSelected([]); setCode(""); setNeedCode(false);
      router.refresh();
    } else if (res.status === 428) {
      setPending(null);
      if (d.code === "STEP_UP_RELOGIN") {
        setNeedCode(false);
        setErr("这次操作需要重新登录后才能执行（未启用两步验证时，敏感操作只允许在登录后 10 分钟内进行）。");
      } else {
        setNeedCode(true);
        setErr("该操作需要两步验证码，请在下方输入后重新执行");
      }
    } else setErr(d.error || "操作失败");
  };

  const restore = async (id: number) => {
    setBusy(true); setErr(""); setMsg("");
    const item = items.find((it) => it.id === id);
    const res = await fetch("/api/admin/posts/" + id + "/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: item?.revision ?? 0 }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg("已恢复"); router.refresh(); }
    else setErr(d.error || "恢复失败");
  };

  const purge = async (id: number) => {
    setBusy(true); setErr(""); setMsg("");
    const res = await fetch("/api/admin/posts/" + id + "/restore", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totp: code }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    setPending(null);
    if (res.ok) {
      const bits = ["评论 " + d.purgedComments + " 条"];
      if (d.purgedVersions) bits.push("历史版本 " + d.purgedVersions + " 个");
      if (d.purgedDrafts) bits.push("草稿 " + d.purgedDrafts + " 份");
      setMsg("已彻底删除，连带清除" + bits.join("、"));
      router.refresh();
    } else if (res.status === 428) {
      if (d.code === "STEP_UP_RELOGIN") {
        setNeedCode(false);
        setErr("彻底删除需要重新登录后才能执行（未启用两步验证时，敏感操作只允许登录后 10 分钟内进行）。");
      } else {
        setNeedCode(true);
        setErr("彻底删除需要两步验证码，请在下方输入后重试");
      }
    } else setErr(d.error || "删除失败");
  };

  const askPurge = async (id: number, title: string) => {
    setPending({ kind: "purge", id, title, comments: null, versions: null, drafts: null });
    const res = await fetch("/api/admin/posts/" + id + "/restore", { method: "GET" });
    if (!res.ok) return;
    const d = await res.json().catch(() => null);
    if (!d) return;
    setPending({ kind: "purge", id, title, comments: d.comments ?? 0, versions: d.versions ?? 0, drafts: d.drafts ?? 0 });
  };

  const clearSel = () => setSelected([]);
  /**
   * 行结构按**条目**决定，不是按页面决定：
   * 回收站里文章与说说混在一起，如果按页面统一成标题型，
   * 说说那一行又只剩一段被截断的正文、没有标题可读。
   * 所以：说说永远走正文型，其它走标题型。
   */
  const isBodyItem = (type: string) => variant === "body" || type === "shuoshuo";

  return (
    <>
      {msg ? <div className="notice notice-ok">{msg}</div> : null}
      {err ? (
        <div className="notice notice-error">
          {err}
          {/重新登录/.test(err) ? (
            <a className="btn btn-sm" href="/admin/login" style={{ marginLeft: 12 }}>去登录</a>
          ) : null}
        </div>
      ) : null}

      {bulkResult ? (
        <div className="bulk-result-bar" role="status">
          <span className="bulk-result-stat">共 <span className="bulk-result-num">{bulkResult.summary.total}</span> 条</span>
          <span className="bulk-result-stat">成功 <span className="bulk-result-num ok">{bulkResult.summary.succeeded}</span></span>
          {bulkResult.summary.skipped > 0 ? (
            <span className="bulk-result-stat">跳过 <span className="bulk-result-num warn">{bulkResult.summary.skipped}</span></span>
          ) : null}
          {bulkResult.summary.conflicts > 0 ? (
            <span className="bulk-result-stat">冲突 <span className="bulk-result-num danger">{bulkResult.summary.conflicts}</span></span>
          ) : null}
          {bulkResult.summary.notFound > 0 ? (
            <span className="bulk-result-stat">不存在 <span className="bulk-result-num danger">{bulkResult.summary.notFound}</span></span>
          ) : null}
          {bulkResult.problems.length ? (
            <span className="cmdk-meta" title={bulkResult.problems.map((p) => "ID " + p.id + "：" + p.message).join("\n")}>
              未完成：{bulkResult.problems.slice(0, 2).map((p) => "ID " + p.id + "（" + p.message + "）").join("；")}
              {bulkResult.problems.length > 2 ? " …等 " + bulkResult.problems.length + " 条" : ""}
            </span>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={() => setBulkResult(null)} style={{ marginLeft: "auto" }}>
            知道了
          </button>
        </div>
      ) : null}

      {needCode || code ? (
        <div className="filter-bar" style={{ marginBottom: 12 }}>
          <span style={{ fontSize: ".82rem", color: "var(--fx-muted)" }}>两步验证码</span>
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            placeholder="6 位数字或恢复码"
            style={{ maxWidth: 200 }}
          />
        </div>
      ) : null}

      {selected.length > 0 ? (
        <div className="bulk-bar" aria-label="批量操作">
          <span className="fx-bulkbar-count">已选 {selected.length} 项</span>
          <span className="bulk-bar-fill" />
          {trash ? (
            <button className="btn btn-sm" disabled={busy} onClick={() => bulk("restore")}>批量恢复</button>
          ) : (
            <>
              <button className="btn btn-sm" disabled={busy} onClick={() => bulk("publish")}>发布</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => bulk("unpublish")}>转草稿</button>
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setPending({ kind: "bulk-delete" })}>移入回收站</button>
            </>
          )}
          <button className="btn btn-sm btn-ghost" onClick={clearSel}>取消选择</button>
        </div>
      ) : null}

      <div className="content-list-meta">
        <label className="select-all">
          <input type="checkbox" checked={allOn} onChange={() => setSelected(allOn ? [] : items.map((i) => i.id))} />
          <span>全选</span>
        </label>
        <span>{items.length} 条</span>
      </div>

      <div className={"data-panel" + (variant === "body" ? " is-body" : "")}>
        {items.map((p) => {
          const on = selected.includes(p.id);
          const isBody = isBodyItem(p.type);
          /**
           * 选择框的可读名只取前 30 字。
           * 直接把正文拼进去会让读屏在一条 5000 字的说说上朗读整段 ——
           * aria-label 是「这是哪一条」的定位信息，不是内容本身。
           */
          const short = (p.excerpt || p.label || "这一条").replace(/\s+/g, " ").trim().slice(0, 30);
          const check = (
            <input
              type="checkbox"
              checked={on}
              onChange={() => toggle(p.id)}
              aria-label={"选择 " + short}
            />
          );

          if (isBody) {
            /**
             * 说说行：正文即身份。
             * 整块正文都是编辑入口（手机上是 44pt 以上的热区），
             * 元信息压在下面一行 —— 不把「已发布/日期」插进正文里切断句子。
             */
            const body = (
              <>
                <span className="shuo-text">{p.excerpt || "（空说说）"}</span>
                <span className="shuo-meta">
                  {/* 回收站里的每一条都是已删除：显示「已发布」会让用户以为它还挂在线 */}
                  <State status={trash ? "trash" : p.status === "published" ? "published" : "draft"} />
                  {!trash && p.hasDraft && p.status === "published" ? <span className="shuo-flag">有未发布改动</span> : null}
                  {p.hasImage ? <span className="shuo-flag">含图</span> : null}
                  <span>{p.chars} 字</span>
                  <span className="shuo-dot" aria-hidden>·</span>
                  <span>{p.dateLabel}</span>
                </span>
              </>
            );
            return (
              <div key={p.id} className={"data-row content-row is-body" + (on ? " is-selected" : "")}>
                {check}
                {showType ? (
                  <span className="content-type is-body-type" aria-hidden title={TYPE_LABEL[p.type] ?? p.type}>
                    {(TYPE_LABEL[p.type] ?? p.type).slice(0, 1)}
                  </span>
                ) : null}
                {trash
                  ? <span className="shuo-main">{body}</span>
                  : <Link href={"/admin/edit/" + p.id} className="shuo-main">{body}</Link>}
                {trash ? (
                  <span className="fx-row-actions">
                    <button className="btn btn-sm" disabled={busy} onClick={() => restore(p.id)}>恢复</button>
                    <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void askPurge(p.id, p.excerpt || "这条说说")}>
                      彻底删除
                    </button>
                  </span>
                ) : null}
              </div>
            );
          }

          return (
            <div key={p.id} className={"data-row content-row" + (on ? " is-selected" : "")}>
              {check}
              {showType ? (
                <span className="content-type" aria-hidden title={TYPE_LABEL[p.type] ?? p.type}>
                  {(TYPE_LABEL[p.type] ?? p.type).slice(0, 1)}
                </span>
              ) : null}
              <State status={trash ? "trash" : p.status === "published" ? "published" : "draft"} />
              {trash
                ? <span className="data-row-title">{p.label}</span>
                : <Link href={"/admin/edit/" + p.id} className="data-row-title">{p.label}</Link>}
              {p.hasDraft && p.status === "published" ? <span className="data-row-flag">有未发布改动</span> : null}
              <span className="data-row-meta">{p.dateLabel}</span>
              {trash ? (
                <span className="fx-row-actions">
                  <button className="btn btn-sm" disabled={busy} onClick={() => restore(p.id)}>恢复</button>
                  <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void askPurge(p.id, p.label)}>
                    彻底删除
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={pending?.kind === "bulk-delete"}
        title={"把选中的 " + selected.length + " 条内容移入回收站？"}
        description={
          <>
            移入回收站后前台立即不可见，但数据仍在库里，可以在回收站里恢复。
            {stepUpRequired ? <><br />此操作需要两步验证码。</> : null}
          </>
        }
        confirmLabel="移入回收站"
        danger
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => bulk("delete")}
      />

      <ConfirmDialog
        open={pending?.kind === "purge"}
        title={"彻底删除「" + (pending?.kind === "purge" ? pending.title : "") + "」？"}
        description={
          <>
            这个操作<strong>不可逆</strong>，回收站里也找不回来。将一并删除：
            <br />
            {pending?.kind === "purge" && pending.comments !== null ? (
              <>
                · 评论 <strong>{pending.comments}</strong> 条
                <br />
                · 发布历史 <strong>{pending.versions}</strong> 个版本
                <br />
                · 未发布草稿 <strong>{pending.drafts}</strong> 份
              </>
            ) : (
              <span style={{ color: "var(--fx-muted)" }}>正在统计将删除的内容…</span>
            )}
            <br />
            建议先确认备份（每日 04:00 自动跑）。
            {stepUpRequired ? <><br />需要两步验证码。</> : null}
          </>
        }
        confirmLabel="彻底删除"
        danger
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => { if (pending?.kind === "purge") void purge(pending.id); }}
      />
    </>
  );
}
