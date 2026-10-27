"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Badge, Empty } from "./ui";

/**
 * Item 带 revision：批量/删除操作必须逐项传 expectedRevision（方案 §5.1）。
 * 没有"用列表渲染时的旧版本顶上"这种兜底 —— 那等于绕过并发检查。
 */
type Item = { id: number; type: string; title: string; status: string; dateLabel: string; revision: number };

const TYPE_LABEL: Record<string, string> = { post: "文章", page: "页面", shuoshuo: "说说" };

/**
 * 内容列表（B 端设计系统 · 列表页骨架）。
 *
 * 本轮改掉的：
 *  1) 危险颜色 #e5484d 硬编码在行内 style —— 暗色主题下是刺眼的亮红块。
 *     改用 .btn-danger（浅底深字语义色，跟随主题）。
 *  2) 「移入回收站」「彻底删除」点一下就执行，没有任何确认。彻底删除是
 *     不可逆的，必须过 ConfirmDialog 并写清连带影响。
 *  3) 状态原来只是一串灰字，看不出草稿/已发布。改成 Badge（浅底深字）。
 *  4) 手机端标题、日期、按钮全挤在一行，溢出后按钮被挤出屏幕。
 *     现在 .data-row 在 ≤820px 自动折行，按钮顶到 48dp。
 *  5) 空列表原来只有一句「还没有内容」，没有出口。现在给出原因 + 新建入口。
 */
export function PostList({ items, trash, stepUpRequired }: { items: Item[]; trash: boolean; stepUpRequired: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  /* 待确认的破坏性动作。null = 没有弹窗 */
  const [pending, setPending] = useState<
    | null
    | { kind: "bulk-delete" }
    | {
        kind: "purge"; id: number; title: string;
        /** 影响面，null 表示还在查（方案 §3.5：确认框要列出将删掉什么） */
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
    // 逐项带 expectedRevision：服务端逐条校验并逐条返回结果，
    // 允许部分成功（方案 §7.1）。不能只传 ids —— 那会退化成"全成全败"。
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
      // 逐项结果里失败的原因要能说清，否则用户不知道哪几条没动、为什么
      const s = d.summary ?? {};
      const parts: string[] = [];
      if (s.succeeded) parts.push("成功 " + s.succeeded);
      if (s.skipped) parts.push("跳过 " + s.skipped);
      if (s.conflicts) parts.push("冲突 " + s.conflicts);
      if (s.notFound) parts.push("不存在 " + s.notFound);
      setMsg("已处理：" + (parts.join(" · ") || "无变更"));

      const problems = (d.results ?? []).filter((r: any) => !r.ok);
      if (problems.length) {
        setErr(
          problems
            .slice(0, 3)
            .map((r: any) => "ID " + r.id + "：" + (r.message ?? r.code ?? "未处理"))
            .join("；") + (problems.length > 3 ? " …等 " + problems.length + " 条" : "")
        );
      }
      setSelected([]); setCode(""); setNeedCode(false);
      router.refresh();
    } else if (res.status === 428) {
      setNeedCode(true);
      setErr("该操作需要两步验证码，请在下方输入后重试");
      setPending(action === "delete" ? { kind: "bulk-delete" } : null);
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
      // 说清连带删掉了什么：用户在确认框里看到过的数字，删除后要能对上
      const bits = ["评论 " + d.purgedComments + " 条"];
      if (d.purgedVersions) bits.push("历史版本 " + d.purgedVersions + " 个");
      if (d.purgedDrafts) bits.push("草稿 " + d.purgedDrafts + " 份");
      setMsg("已彻底删除，连带清除" + bits.join("、"));
      router.refresh();
    } else if (res.status === 428) {
      setNeedCode(true);
      setErr("彻底删除需要两步验证码，请在下方输入后重试");
    } else setErr(d.error || "删除失败");
  };

  /**
   * 打开彻底删除确认框前先查影响面（方案 §3.5）：
   * 确认框必须列出将删除的历史版本数、草稿和评论影响。
   * 只写"不可逆"是不够的 —— 用户有权知道具体会掉多少东西。
   */
  const askPurge = async (id: number, title: string) => {
    setPending({ kind: "purge", id, title, comments: null, versions: null, drafts: null });
    const res = await fetch("/api/admin/posts/" + id + "/restore", { method: "GET" });
    if (!res.ok) return;
    const d = await res.json().catch(() => null);
    if (!d) return;
    setPending({
      kind: "purge", id, title,
      comments: d.comments ?? 0, versions: d.versions ?? 0, drafts: d.drafts ?? 0,
    });
  };

  const clearSel = () => setSelected([]);

  if (items.length === 0) {
    return (
      <Empty
        title={trash ? "回收站是空的" : "还没有内容"}
        hint={trash
          ? "删除的内容会先放进回收站，可以在这里恢复，或者彻底清除。"
          : "写下第一篇，或者先在设置里检查内容类型筛选是否把结果挡住了。"}
        actions={trash
          ? <Link className="btn btn-sm" href="/admin">回到内容列表</Link>
          : <Link className="btn btn-primary btn-sm" href="/admin/new">新建文章</Link>}
      />
    );
  }

  return (
    <>
      {msg ? <div className="notice notice-ok">{msg}</div> : null}
      {err ? <div className="notice notice-error">{err}</div> : null}

      {needCode || code ? (
        <div className="filter-bar" style={{ marginBottom: 12 }}>
          <span style={{ fontSize: ".82rem", color: "var(--text-p3)" }}>两步验证码</span>
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
          <Badge tone="info">已选 {selected.length}</Badge>
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
        <span>{items.length} 条内容</span>
      </div>

      <div className="data-panel">
        {items.map((p) => (
          <div key={p.id} className="data-row content-row">
            <input
              type="checkbox"
              checked={selected.includes(p.id)}
              onChange={() => toggle(p.id)}
              aria-label={"选择 " + (p.title || "无标题")}
              style={{ flexShrink: 0 }}
            />

            <span className="content-type">{TYPE_LABEL[p.type] ?? p.type}</span>

            {/* 状态：不再是一串灰字，而是有语义的徽标 */}
            {p.status === "published"
              ? <Badge tone="ok" dot>已发布</Badge>
              : <Badge tone="warn" dot>草稿</Badge>}

            {trash ? (
              <span className="data-row-title">{p.title || "(无标题)"}</span>
            ) : (
              <Link href={"/admin/edit/" + p.id} className="data-row-title">{p.title || "(无标题)"}</Link>
            )}

            <span className="data-row-meta">{p.dateLabel}</span>

            {trash ? (
              <span className="data-actions" style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button className="btn btn-sm" disabled={busy} onClick={() => restore(p.id)}>恢复</button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={() => void askPurge(p.id, p.title || "(无标题)")}
                >彻底删除</button>
              </span>
            ) : null}
          </div>
        ))}
      </div>

      {/* 破坏性动作确认。标题只交代对象，副作用写进描述，按钮是明确动宾。 */}
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
              <span style={{ color: "var(--text-p3)" }}>正在统计将删除的内容…</span>
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
