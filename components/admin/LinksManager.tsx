"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Empty, Badge } from "./ui";
// 从 shared 引，**不能**从 @/lib/friend-links：后者 import 了 ./db（better-sqlite3
// → node:fs），"use client" 组件引它会打穿浏览器包，构建直接报找不到 fs。
import { isSafeUrl, KIND_LABEL, type FriendLink } from "@/lib/friend-links-shared";

/**
 * 外链管理（阶段 02-5 重做）。
 *
 * 改掉的四个真问题：
 *
 *  1) **保存没有任何校验**。名称/链接两个必填项为空也能点，请求打出去才报错；
 *     URL 只允许 http/https（isSafeUrl 早就写好了，前台渲染前也会过滤），
 *     但后台表单不告诉人，填个 javascript: 会保存成功、前台静默不显示 ——
 *     用户看到的是"我加了外链但侧栏没有"。现在提交前拦住并说明原因。
 *
 *  2) **编辑态没有视觉标识**。点「编辑」后只是表单标题从"新增"变成"编辑外链"，
 *     没有说明正在改哪一条，改错了也不知道在改谁。现在顶部有编辑条
 *     （显示正在编辑的名称 + 取消）。
 *
 *  3) **隐藏状态只用 opacity .5 表示**，而且按钮文案在"隐藏/显示"之间跳，
 *     看不出当前状态。现在用 Badge 明确写「已显示 / 已隐藏」，
 *     按钮改成"隐藏/显示"这个动作词并给 aria-pressed。
 *
 *  4) 行内样式收进 `.link-*` 类名（原来一行约 10 个魔法数字）。
 *
 * 保留不动：删除走 ConfirmDialog 而不是 window.confirm；隐藏是"保留记录"的
 * 推荐做法而不是删除 —— 这是既有 B 端门禁的正确实现。
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
  /** 待确认的删除对象 */
  const [pending, setPending] = useState<FriendLink | null>(null);
  /** 正在编辑的那条（仅用于展示，避免"改了谁"看不出来） */
  const [editing, setEditing] = useState<FriendLink | null>(null);
  /** 前端校验错误：不发给服务端，直接在表单里说清楚 */
  const [fieldErr, setFieldErr] = useState<{ name?: string; url?: string }>({});

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setForm((f) => ({ ...f, [k]: v }));

  const reset = () => { setForm(EMPTY); setErr(""); setFieldErr({}); setEditing(null); };

  const validate = (): boolean => {
    const e: { name?: string; url?: string } = {};
    if (!form.name.trim()) e.name = "名称必填 —— 它显示在右栏列表里";
    if (!form.url.trim()) e.url = "链接必填";
    else if (!isSafeUrl(form.url.trim())) {
      e.url = "只接受以 http:// 或 https:// 开头的地址。前台不会渲染其它协议（会被过滤掉），" +
              "所以保存了也不会显示。";
    }
    setFieldErr(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    setMsg(""); setErr("");
    if (!validate()) return;
    setBusy(true);
    const editingMode = form.id !== undefined;
    const payload = { ...form, name: form.name.trim(), url: form.url.trim(), desc: form.desc.trim() };
    const res = await fetch("/api/admin/links", {
      method: editingMode ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editingMode ? payload : { ...payload, id: undefined }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setMsg(editingMode ? "已更新「" + payload.name + "」" : "已添加「" + payload.name + "」");
      reset();
      router.refresh();
    } else setErr(d.error || "保存失败");
  };

  const remove = async (l: FriendLink) => {
    setBusy(true); setMsg(""); setErr(""); setPending(null);
    const res = await fetch("/api/admin/links?id=" + l.id, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg("已删除「" + l.name + "」"); router.refresh(); }
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
    if (res.ok) { setMsg(l.visible === 1 ? "已隐藏「" + l.name + "」" : "已显示「" + l.name + "」"); router.refresh(); }
    else setErr(d.error || "操作失败");
  };

  const edit = (l: FriendLink) => {
    setEditing(l);
    setForm({
      id: l.id, name: l.name, url: l.url, desc: l.desc,
      kind: l.kind, sort_order: l.sort_order, visible: l.visible === 1,
    });
    setMsg(""); setErr(""); setFieldErr({});
    // 编辑时滚回表单，否则在长列表末尾点编辑看不到任何变化
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const counts = useMemo(() => ({
    all: initial.length,
    visible: initial.filter((l) => l.visible === 1).length,
    hidden: initial.filter((l) => l.visible !== 1).length,
  }), [initial]);

  return (
    <>
      {msg ? <div className="notice notice-ok" role="status">{msg}</div> : null}
      {err ? <div className="notice notice-error" role="alert">{err}</div> : null}

      <section className="card">
        <h2 className="settings-group-title">
          {editing ? "编辑外链" : "新增外链"}
        </h2>
        <p className="settings-group-desc">
          保存后前台右栏与手机抽屉立即刷新，不用重新部署。「显示/隐藏」决定是否出现在前台，
          隐藏会保留记录，删除才是真的移除。
        </p>

        {editing ? (
          <div className="link-editbar">
            <span>正在编辑：<b>{editing.name}</b></span>
            <button className="btn btn-sm" onClick={reset} disabled={busy}>取消编辑</button>
          </div>
        ) : null}

        <div className="link-form">
          <div className={"field" + (fieldErr.name ? " is-invalid" : "")}>
            <label htmlFor="link-name">名称</label>
            <input id="link-name" className="input" value={form.name} placeholder="开往"
                   aria-invalid={fieldErr.name ? "true" : undefined}
                   aria-describedby={fieldErr.name ? "link-name-err" : undefined}
                   onChange={(e) => set("name", e.target.value)} />
            {fieldErr.name ? <div className="field-error" id="link-name-err">{fieldErr.name}</div> : null}
          </div>

          <div className={"field field-wide" + (fieldErr.url ? " is-invalid" : "")}>
            <label htmlFor="link-url">链接</label>
            <input id="link-url" className="input" value={form.url}
                   placeholder="https://www.travellings.cn/go.html"
                   aria-invalid={fieldErr.url ? "true" : undefined}
                   aria-describedby={fieldErr.url ? "link-url-err" : undefined}
                   onChange={(e) => set("url", e.target.value)} />
            {fieldErr.url ? <div className="field-error" id="link-url-err">{fieldErr.url}</div> : null}
          </div>

          <div className="field field-wide">
            <label htmlFor="link-desc">描述（可空，显示在名称下方）</label>
            <input id="link-desc" className="input" value={form.desc}
                   placeholder="友链接力 · 随机去往一个陌生博客"
                   onChange={(e) => set("desc", e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="link-kind">分类</label>
            <select id="link-kind" className="input" value={form.kind}
                    onChange={(e) => set("kind", e.target.value as "friend" | "hub")}>
              <option value="friend">友链（紧凑列表）</option>
              <option value="hub">聚合（卡片）</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="link-sort">排序（小的靠前）</label>
            <input id="link-sort" className="input" type="number" value={form.sort_order}
                   onChange={(e) => set("sort_order", Number(e.target.value) || 0)} />
          </div>

          <label className="switch-row link-visible-switch">
            <input type="checkbox" checked={form.visible}
                   onChange={(e) => set("visible", e.target.checked)} />
            <span>
              <b>在前台显示</b>
              <em>取消勾选则保存为隐藏状态</em>
            </span>
          </label>
        </div>

        <div className="link-form-actions">
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? "保存中…" : editing ? "保存修改" : "添加"}
          </button>
          {editing ? <button className="btn" disabled={busy} onClick={reset}>取消</button> : null}
        </div>
      </section>

      <section className="card">
        <h2 className="settings-group-title">
          已有外链
          <span className="link-counts">
            共 {counts.all} 条 · 显示 {counts.visible} · 隐藏 {counts.hidden}
          </span>
        </h2>

        {initial.length === 0 ? (
          <Empty
            title="还没有外链"
            hint="上方的表单填好名称和链接就能添加。友链出现在右栏列表，聚合站（如「开往」）渲染成卡片。"
            actions={
              <button className="btn btn-sm" onClick={() => {
                const el = document.getElementById("link-name");
                el?.focus();
              }}>填第一条</button>
            }
          />
        ) : (
          <div className="link-list">
            {initial.map((l) => (
              <div key={l.id} className={"link-row" + (l.visible === 1 ? "" : " is-hidden")}>
                <div className="link-main">
                  <div className="link-name">
                    {l.name}
                    <Badge tone={l.kind === "hub" ? "info" : "neutral"}>{KIND_LABEL[l.kind]}</Badge>
                    {l.visible === 1
                      ? <Badge tone="ok" dot>已显示</Badge>
                      : <Badge tone="warn" dot>已隐藏</Badge>}
                  </div>
                  <div className="link-url" title={l.url}>{l.url}</div>
                </div>
                <span className="link-sort">#{l.sort_order}</span>
                <div className="link-actions">
                  <button className="btn btn-sm" disabled={busy} onClick={() => toggle(l)}
                          aria-pressed={l.visible !== 1}
                          aria-label={(l.visible === 1 ? "隐藏" : "显示") + "「" + l.name + "」"}>
                    {l.visible === 1 ? "隐藏" : "显示"}
                  </button>
                  <button className="btn btn-sm" disabled={busy} onClick={() => edit(l)}
                          aria-label={"编辑「" + l.name + "」"}>编辑</button>
                  <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setPending(l)}
                          aria-label={"删除「" + l.name + "」"}>删除</button>
                </div>
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
