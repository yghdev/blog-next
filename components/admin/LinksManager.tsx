"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Empty } from "./ui";
import {
  IconChevronDown, IconClose, IconEye, IconEyeOff, IconPen, IconPlus, IconSearch, IconTrash,
} from "./editor-icons";
// 从 shared 引，**不能**从 @/lib/friend-links：后者 import 了 ./db（better-sqlite3
// → node:fs），"use client" 组件引它会打穿浏览器包，构建直接报找不到 fs。
import { isSafeUrl, KIND_LABEL, type FriendLink } from "@/lib/friend-links-shared";

/**
 * 外链管理。
 *
 * 这一版的改动都围绕「首屏先看到列表」：
 *
 *  1) **表单默认收起**。以前新增表单常驻在页首、纯纵向全宽，把「已有外链」
 *     挤到首屏之外；现在是一条 52px 的「添加外链」入口带，点开才展开成卡片，
 *     收起时保留未保存的草稿（入口带会提示「继续填写」），不会静默丢输入。
 *
 *  2) **表单改成紧凑栅格**。名称 / 链接同一行（5 : 7），描述独占一行，
 *     分类 / 排序 / 前台显示三个短字段并成一行；纵向高度约为原来的六成。
 *
 *  3) **列表可查**。名称 / 链接 / 描述即时搜索 + 全部 / 已显示 / 已隐藏
 *     分段筛选，计数跟着结果变。数据量小时纯前端过滤，不额外打接口。
 *
 *  4) **列表行与操作分级**。行内只留「名称 + 分类 + 状态 / 描述 + 链接」，
 *     行距收紧；隐藏 / 编辑 / 删除收成图标按钮（带 tooltip 与 aria-label），
 *     删除用分隔线隔开、悬停才转危险色，并继续走 ConfirmDialog。
 *
 * 保留不动：提交前拦住空名称与非 http(s) 链接；隐藏是「保留记录」的
 * 推荐做法；删除必须二次确认。这三条是既有 B 端门禁的正确实现。
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

type StatusFilter = "all" | "visible" | "hidden";

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
  /** 表单面板是否展开：默认收起，让列表优先出现在首屏 */
  const [open, setOpen] = useState(false);
  /** 列表筛选：即时搜索 + 显隐状态 */
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setForm((f) => ({ ...f, [k]: v }));

  const reset = () => {
    setForm(EMPTY);
    setErr("");
    setFieldErr({});
    setEditing(null);
    setOpen(false);
  };

  /** 只清空字段、不收起面板：连续新增时用 */
  const resetFields = () => {
    setForm(EMPTY);
    setFieldErr({});
    setEditing(null);
  };

  /** 收起面板但保留草稿：入口带会提示「继续填写 / 继续编辑」。
      焦点送回入口带 —— 否则键盘用户收起后焦点落在被隐藏的表单里，Tab 会从文档开头重新数。 */
  const collapse = () => {
    setOpen(false);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".link-compose-trigger")?.focus();
    });
  };

  /** 展开并聚焦第一个字段。编辑时从列表末尾点进来也能看到表单变化。 */
  const expand = (scroll = false) => {
    setOpen(true);
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => {
      document.getElementById("link-name")?.focus({ preventScroll: true });
    });
  };

  /** 草稿是否与初始值不同：只用来提示「收起后还有内容」 */
  const dirty = useMemo(
    () =>
      !!form.name.trim() || !!form.url.trim() || !!form.desc.trim() ||
      form.kind !== EMPTY.kind || form.sort_order !== EMPTY.sort_order || !form.visible,
    [form]
  );

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
      if (editingMode) {
        // 编辑是一次性任务：保存后收起，回到列表确认改动
        reset();
      } else {
        // 新增常常连着来几条：清空字段但保持展开，焦点回到名称，
        // 不用为了下一条再点一次「添加外链」
        resetFields();
        requestAnimationFrame(() => document.getElementById("link-name")?.focus({ preventScroll: true }));
      }
      router.refresh();
    } else setErr(d.error || "保存失败");
  };

  const remove = async (l: FriendLink) => {
    setBusy(true); setMsg(""); setErr(""); setPending(null);
    const res = await fetch("/api/admin/links?id=" + l.id, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setMsg("已删除「" + l.name + "」");
      // 正在编辑的条目被删掉时，表单不能继续指向一条不存在的记录
      if (editing?.id === l.id) reset();
      router.refresh();
    } else setErr(d.error || "删除失败");
  };

  const toggle = async (l: FriendLink) => {
    setBusy(true); setMsg(""); setErr("");
    const nextVisible = l.visible !== 1;
    const res = await fetch("/api/admin/links", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: l.id, visible: nextVisible }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setMsg(nextVisible ? "已显示「" + l.name + "」" : "已隐藏「" + l.name + "」");
      // 若这一条正在表单里编辑，同步勾选状态，避免保存时把显隐改回去
      if (form.id === l.id) set("visible", nextVisible);
      if (editing?.id === l.id) setEditing({ ...editing, visible: nextVisible ? 1 : 0 });
      router.refresh();
    } else setErr(d.error || "操作失败");
  };

  const edit = (l: FriendLink) => {
    setEditing(l);
    setForm({
      id: l.id, name: l.name, url: l.url, desc: l.desc,
      kind: l.kind, sort_order: l.sort_order, visible: l.visible === 1,
    });
    setMsg(""); setErr(""); setFieldErr({});
    expand(true);
  };

  const counts = useMemo(() => ({
    all: initial.length,
    visible: initial.filter((l) => l.visible === 1).length,
    hidden: initial.filter((l) => l.visible !== 1).length,
  }), [initial]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return initial.filter((l) => {
      if (status === "visible" && l.visible !== 1) return false;
      if (status === "hidden" && l.visible === 1) return false;
      if (!q) return true;
      return l.name.toLowerCase().includes(q) || l.url.toLowerCase().includes(q) || l.desc.toLowerCase().includes(q);
    });
  }, [initial, status, query]);

  const filtering = status !== "all" || !!query.trim();
  const clearFilters = () => { setQuery(""); setStatus("all"); };

  const formTitle = editing ? "编辑外链" : "新增外链";
  const triggerTitle = editing
    ? "继续编辑「" + editing.name + "」"
    : dirty
      ? "继续填写新增外链"
      : "添加外链";
  const triggerHint = editing
    ? "表单已收起，填写的内容还在"
    : dirty
      ? "表单已收起，未保存的内容还在"
      : "名称、链接、分类与排序";

  return (
    <>
      {msg ? <div className="notice notice-ok" role="status">{msg}</div> : null}
      {err ? <div className="notice notice-error" role="alert">{err}</div> : null}

      <section
        className={"link-compose" + (open ? " is-open" : "") + (!open && (dirty || editing) ? " is-dirty" : "")}
        aria-label="外链表单"
      >
        {open ? (
          <div className="link-compose-head">
            <div className="link-compose-heading">
              <h2 className="link-compose-title">{formTitle}</h2>
              <p className="link-compose-desc">
                保存后友链页、前台右栏与手机抽屉立即刷新，不用重新部署。取消勾选「在前台显示」会保留记录但不在前台出现。
              </p>
            </div>
            <button type="button" className="btn btn-sm link-compose-collapse" aria-expanded="true"
                    aria-controls="link-form-body" onClick={collapse} disabled={busy}>
              收起
            </button>
          </div>
        ) : (
          <button type="button" className="link-compose-trigger" aria-expanded="false"
                  aria-controls="link-form-body" onClick={() => expand(false)}>
            <span className="link-compose-plus" aria-hidden><IconPlus size={16} /></span>
            <span className="link-compose-copy">
              <b>{triggerTitle}</b>
              <em>{triggerHint}</em>
            </span>
            <span className="link-compose-cta" aria-hidden>
              展开表单<IconChevronDown size={14} />
            </span>
          </button>
        )}

        <div id="link-form-body" className="link-form-body" hidden={!open}>
          {editing ? (
            <div className="link-editbar">
              <span>正在编辑「<b>{editing.name}</b>」</span>
              <span className="link-editbar-hint">保存会覆盖这一条，取消则保持原样</span>
            </div>
          ) : null}

          <div className="link-form">
            <div className={"field" + (fieldErr.name ? " is-invalid" : "")}>
              <label htmlFor="link-name">名称</label>
              <input id="link-name" className="input" value={form.name} placeholder="开往" maxLength={40}
                     aria-invalid={fieldErr.name ? "true" : undefined}
                     aria-describedby={fieldErr.name ? "link-name-err" : undefined}
                     onChange={(e) => set("name", e.target.value)} />
              {fieldErr.name ? <div className="field-error" id="link-name-err">{fieldErr.name}</div> : null}
            </div>

            <div className={"field" + (fieldErr.url ? " is-invalid" : "")}>
              <label htmlFor="link-url">链接</label>
              <input id="link-url" className="input" value={form.url}
                     placeholder="https://www.travellings.cn/go.html"
                     inputMode="url" autoComplete="url"
                     aria-invalid={fieldErr.url ? "true" : undefined}
                     aria-describedby={fieldErr.url ? "link-url-err" : undefined}
                     onChange={(e) => set("url", e.target.value)} />
              {fieldErr.url ? <div className="field-error" id="link-url-err">{fieldErr.url}</div> : null}
            </div>

            <div className="field link-field-desc">
              <label htmlFor="link-desc">描述（可空，显示在名称下方）</label>
              <input id="link-desc" className="input" value={form.desc}
                     placeholder="友链接力 · 随机去往一个陌生博客" maxLength={80}
                     onChange={(e) => set("desc", e.target.value)} />
            </div>

            <div className="link-form-meta">
              <div className="field">
                <label htmlFor="link-kind">分类</label>
                <select id="link-kind" className="input" value={form.kind}
                        onChange={(e) => set("kind", e.target.value as "friend" | "hub")}>
                  <option value="friend">友链（紧凑列表）</option>
                  <option value="hub">聚合（卡片）</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="link-sort">排序 <span className="link-label-hint">小的靠前</span></label>
                <input id="link-sort" className="input" type="number" min={0} max={9999}
                       inputMode="numeric" value={form.sort_order}
                       onChange={(e) => set("sort_order", Number(e.target.value) || 0)} />
              </div>

              <div className="field link-field-visible">
                <span className="link-field-label">前台状态</span>
                {/* 整块是一个 label：点方框、点文字、点两侧留白都能切换，
                    比只让 15px 的复选框可点更好用 */}
                <label className="link-check" htmlFor="link-visible">
                  <input id="link-visible" type="checkbox" checked={form.visible}
                         onChange={(e) => set("visible", e.target.checked)} />
                  <span>在前台显示</span>
                </label>
              </div>
            </div>
          </div>

          <div className="link-form-actions">
            <span className="link-form-hint">名称与链接必填，链接须以 http:// 或 https:// 开头</span>
            <button type="button" className="btn" disabled={busy} onClick={reset}>
              {editing ? "取消编辑" : "取消"}
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
              {busy ? "保存中…" : editing ? "保存修改" : "添加"}
            </button>
          </div>
        </div>
      </section>

      <section className="card link-list-card">
        <div className="link-list-head">
          <div className="link-list-title">
            <h2>已有外链</h2>
            <span className="link-counts" aria-live="polite">
              {filtering
                ? "匹配 " + filtered.length + " / 共 " + counts.all + " 条"
                : "共 " + counts.all + " 条 · 显示 " + counts.visible + " · 隐藏 " + counts.hidden}
            </span>
          </div>

          <div className="link-tools">
            <div className="link-search">
              <IconSearch size={15} aria-hidden />
              <input className="input" type="search" value={query}
                     placeholder="搜索名称或链接" aria-label="搜索外链名称、链接或描述"
                     onChange={(e) => setQuery(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} />
              {query ? (
                <button type="button" className="link-search-clear" aria-label="清除搜索"
                        onClick={() => setQuery("")}>
                  <IconClose size={13} />
                </button>
              ) : null}
            </div>

            <div className="link-filter" role="group" aria-label="按显示状态筛选">
              {([
                { key: "all", label: "全部", count: counts.all },
                { key: "visible", label: "已显示", count: counts.visible },
                { key: "hidden", label: "已隐藏", count: counts.hidden },
              ] as const).map((t) => (
                <button key={t.key} type="button" className="link-filter-item"
                        aria-pressed={status === t.key}
                        onClick={() => setStatus(t.key)}>
                  {t.label}<span className="link-filter-count">{t.count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {initial.length === 0 ? (
          <div className="link-empty">
            <Empty
              title="还没有外链"
              hint="点上方「添加外链」展开表单，填好名称和链接就能添加。友链会出现在友链页与右栏，聚合站（如「开往」）在友链页单独成组。"
              actions={<button type="button" className="btn btn-sm" onClick={() => expand(false)}>添加第一条</button>}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="link-empty">
            <Empty
              title="没有匹配的外链"
              hint={"当前筛选：" + (status === "visible" ? "只看已显示" : status === "hidden" ? "只看已隐藏" : "全部") +
                    (query.trim() ? " · 搜索「" + query.trim() + "」" : "") + "。换个关键词，或回到全部。"}
              actions={<button type="button" className="btn btn-sm" onClick={clearFilters}>清除筛选</button>}
            />
          </div>
        ) : (
          <ul className="link-list">
            {filtered.map((l) => {
              const shown = l.visible === 1;
              const actionLabel = (shown ? "隐藏" : "显示") + "「" + l.name + "」";
              return (
                <li key={l.id} className={"link-row" + (shown ? "" : " is-hidden")}>
                  <div className="link-main">
                    <div className="link-name">
                      <span className="link-name-text" title={l.name}>{l.name}</span>
                      <span className="link-kind">{KIND_LABEL[l.kind]}</span>
                      <span className={"fx-state" + (shown ? " is-published" : "")}>
                        {shown ? "已显示" : "已隐藏"}
                      </span>
                    </div>
                    <div className="link-sub">
                      {l.desc ? <span className="link-desc" title={l.desc}>{l.desc}</span> : null}
                      {l.desc ? <span className="link-sub-sep" aria-hidden>·</span> : null}
                      <span className="link-url" title={l.url}>{l.url}</span>
                    </div>
                  </div>

                  <span className="link-sort" title={"排序值 " + l.sort_order + "，越小越靠前"}>
                    排序 {l.sort_order}
                  </span>

                  <div className="link-actions">
                    {/* 桌面只有图标（tooltip 补文案，行更安静）；手机上把动作词显出来 ——
                        触屏没有 hover，只剩三个图标会让人靠猜 */}
                    <button type="button" className="link-act" disabled={busy}
                            onClick={() => toggle(l)} aria-label={actionLabel} data-tip={shown ? "隐藏" : "显示"}>
                      {shown ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                      <span className="link-act-label">{shown ? "隐藏" : "显示"}</span>
                    </button>
                    <button type="button" className="link-act" disabled={busy}
                            onClick={() => edit(l)} aria-label={"编辑「" + l.name + "」"} data-tip="编辑">
                      <IconPen size={16} />
                      <span className="link-act-label">编辑</span>
                    </button>
                    <span className="link-act-sep" aria-hidden />
                    <button type="button" className="link-act is-danger" disabled={busy}
                            onClick={() => setPending(l)} aria-label={"删除「" + l.name + "」"} data-tip="删除">
                      <IconTrash size={16} />
                      <span className="link-act-label">删除</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={"删除外链「" + (pending?.name ?? "") + "」？"}
        description="删除后它立刻从友链页、右栏和手机抽屉里消失。只是暂时不想展示的话，用「隐藏」保留记录。"
        confirmLabel="删除外链"
        danger
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => { if (pending) void remove(pending); }}
      />
    </>
  );
}
