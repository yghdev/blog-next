"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Empty } from "./ui";
import type { FriendLink } from "@/lib/friend-links";

/**
 * 外链管理（2026-10-23）。
 *
 * 一行一条，支持增 / 改 / 删 / 显隐 / 排序。
 * 保存后服务端会 revalidateTag，前台侧栏与手机抽屉立即刷新。
 */

type Draft = {
  id?: number;
  name: string;
  url: string;
  desc: string;
  kind: "friend" | "hub";
  sort_order: number;
  visible: boolean;
};

const EMPTY: Draft = { name: "", url: "", desc: "", kind: "friend", sort_order: 100, visible: true };

export function LinksManager({ initial }: { initial: FriendLink[] }) {
  const router = useRouter();
  const [form, setForm] = useState<Draft>(EMPTY);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  /* 待确认的删除对象。用真实弹窗而不是 window.confirm：
     后者在手机上是个丑原生提示、不可样式化，也写不清不可逆后果。 */
  const [pending, setPending] = useState<FriendLink | null>(null);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setForm((f) => ({ ...f, [k]: v }));

  const reset = () => { setForm(EMPTY); setErr(""); };

  const save = async () => {
    setBusy(true); setMsg(""); setErr("");
    const editing = form.id !== undefined;
    const res = await fetch("/api/admin/links", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing ? form : { ...form, id: undefined }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setMsg(editing ? "已更新" : "已添加");
      setForm(EMPTY);
      router.refresh();
    } else setErr(d.error || "保存失败");
  };

  const remove = async (l: FriendLink) => {
    setBusy(true); setMsg(""); setErr(""); setPending(null);
    const res = await fetch("/api/admin/links?id=" + l.id, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg("已删除"); router.refresh(); }
    else setErr(d.error || "删除失败");
  };

  const toggle = async (l: FriendLink) => {
    setBusy(true); setMsg(""); setErr("");
    const res = await fetch("/api/admin/links", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: l.id, visible: l.visible !== 1 }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg(l.visible === 1 ? "已隐藏" : "已显示"); router.refresh(); }
    else setErr(d.error || "操作失败");
  };

  const edit = (l: FriendLink) => {
    setForm({
      id: l.id, name: l.name, url: l.url, desc: l.desc,
      kind: l.kind, sort_order: l.sort_order, visible: l.visible === 1,
    });
    setMsg(""); setErr("");
  };

  const box: React.CSSProperties = {
    border: "1px solid var(--border)", borderRadius: 14,
    background: "var(--card-bg)", padding: 20, marginBottom: 18,
  };

  return (
    <>
      {msg ? <div className="notice notice-ok">{msg}</div> : null}
      {err ? <div className="notice notice-error">{err}</div> : null}

      <section style={box}>
        <h2 style={{ fontSize: ".95rem", color: "var(--text-p0)", margin: "0 0 14px", fontWeight: 600 }}>
          {form.id !== undefined ? "编辑外链" : "新增外链"}
        </h2>

        <div className="field">
          <label>名称</label>
          <input className="input" value={form.name} placeholder="开往"
                 onChange={(e) => set("name", e.target.value)} />
        </div>

        <div className="field">
          <label>链接</label>
          <input className="input" value={form.url} placeholder="https://www.travellings.cn/go.html"
                 onChange={(e) => set("url", e.target.value)} />
        </div>

        <div className="field">
          <label>描述（可空，显示在名称下方）</label>
          <input className="input" value={form.desc} placeholder="友链接力 · 随机去往一个陌生博客"
                 onChange={(e) => set("desc", e.target.value)} />
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "0 0 160px" }}>
            <label>分类</label>
            <select className="input" value={form.kind}
                    onChange={(e) => set("kind", e.target.value as "friend" | "hub")}>
              <option value="friend">友链（紧凑列表）</option>
              <option value="hub">聚合（卡片）</option>
            </select>
          </div>

          <div className="field" style={{ flex: "0 0 120px" }}>
            <label>排序（小的靠前）</label>
            <input className="input" type="number" value={form.sort_order}
                   onChange={(e) => set("sort_order", Number(e.target.value) || 0)} />
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: ".86rem", color: "var(--text-p2)", paddingBottom: 10 }}>
            <input type="checkbox" checked={form.visible} onChange={(e) => set("visible", e.target.checked)} />
            显示
          </label>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? "保存中…" : form.id !== undefined ? "保存修改" : "添加"}
          </button>
          {form.id !== undefined ? (
            <button className="btn" disabled={busy} onClick={reset}>取消</button>
          ) : null}
        </div>
      </section>

      <section style={box}>
        <h2 style={{ fontSize: ".95rem", color: "var(--text-p0)", margin: "0 0 14px", fontWeight: 600 }}>
          已有外链（{initial.length}）
        </h2>

        {initial.length === 0 ? (
          <Empty
            title="还没有外链"
            hint="上方的表单填好名称和链接就能添加。友链出现在右栏列表，聚合站渲染成卡片。"
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {initial.map((l) => (
              <div key={l.id} style={{
                display: "flex", alignItems: "center", gap: 12,
                border: "1px solid var(--border)", borderRadius: 11,
                padding: "10px 14px", background: "var(--bg)",
                opacity: l.visible === 1 ? 1 : .5,
              }}>
                <span style={{ fontSize: ".9rem" }}>{l.kind === "hub" ? "🚇" : "🔗"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: ".88rem", color: "var(--text-p1)", fontWeight: 500 }}>
                    {l.name}
                    {l.visible !== 1 ? <span style={{ color: "var(--text-p4)", fontWeight: 400 }}>（已隐藏）</span> : null}
                  </div>
                  <div style={{ fontSize: ".72rem", color: "var(--text-p4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.url}
                  </div>
                </div>
                <span style={{ fontSize: ".7rem", color: "var(--text-p4)", fontVariantNumeric: "tabular-nums" }}>
                  #{l.sort_order}
                </span>
                <button className="btn btn-sm" disabled={busy} onClick={() => toggle(l)}>
                  {l.visible === 1 ? "隐藏" : "显示"}
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => edit(l)}>编辑</button>
                <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setPending(l)}>删除</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={"删除外链「" + (pending?.name ?? "") + "」？"}
        description="删除后它立刻从右栏和手机抽屉里消失。只是暂时不想展示的话，用「隐藏」保留记录。"
        confirmLabel="删除外链"
        danger
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => { if (pending) void remove(pending); }}
      />
    </>
  );
}
