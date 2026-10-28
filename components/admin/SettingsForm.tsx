"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Settings } from "@/lib/settings";

/**
 * 站点设置表单（阶段 02-5 重做）。
 *
 * 改掉的三个真问题：
 *
 *  1) **「友链（每行 一个，名称|链接）」共存于本页，但已经没有用了**。
 *     外链早在 2026-10-23 就改成独立的 friend_links 表 + /admin/links 管理，
 *     这一格文本前台**一处都不渲染**（友链渲染只读 friend_links）。留着它
 *     等于让人填一个永远不生效的输入框 —— 填完保存成功，前台什么都没变。
 *     现在移除了输入框，改成一句说明并给出 /admin/links 的入口。
 *     （settings.friendLinks 字段与 KEY_MAP 保留，避免旧数据与 RSS 读取路径断裂。）
 *
 *  2) 9 个字段平铺成一个长表单，保存失败时看不出是哪一组的问题。
 *     现在按"站点身份 / 显示 / 功能开关"分组，每组有标题与说明。
 *
 *  3) 改了没保存就离开（或点了刷新）毫无提示。现在顶栏常驻"未保存改动"
 *     提示 + 放弃按钮，保存成功后变回"已保存 · 时间"。
 *     不做离开拦截：B 端后台里误弹 confirm 比丢一次编辑更烦，
 *     而且这些字段都能重填 —— 用持续可见的提示代替打断。
 */

type Group = { key: string; title: string; desc: string; fields: (keyof Settings)[] };

const GROUPS: Group[] = [
  {
    key: "identity",
    title: "站点身份",
    desc: "决定浏览器标签页、搜索引擎结果与 RSS 里显示的站点名。",
    fields: ["siteTitle", "siteSubtitle", "siteDescription", "author"],
  },
  {
    key: "footer",
    title: "页脚与合规",
    desc: "页脚文字支持纯文本；备案号显示在页脚末尾，留空则不显示。",
    fields: ["footerText", "icp"],
  },
  {
    key: "display",
    title: "显示",
    desc: "展示时区影响文章日期与列表里的时间显示，不影响数据存储（库里统一存 UTC）。",
    fields: ["timezone"],
  },
];

const FIELD_LABEL: Partial<Record<keyof Settings, string>> = {
  siteTitle: "站点标题",
  siteSubtitle: "副标题",
  siteDescription: "站点描述（SEO / RSS 摘要）",
  author: "作者",
  footerText: "页脚文字",
  icp: "备案号",
  timezone: "展示时区",
};

const PLACEHOLDER: Partial<Record<keyof Settings, string>> = {
  siteTitle: "flechazo's blog",
  siteSubtitle: "扬帆起航",
  siteDescription: "记录 AI、开发与折腾的日常。",
  author: "flechazo",
  footerText: "© 2026 flechazo",
  icp: "陕ICP备xxxxxxx号",
  timezone: "Asia/Shanghai",
};

const MULTILINE = new Set<keyof Settings>(["siteDescription", "footerText"]);

export function SettingsForm({ initial }: { initial: Settings }) {
  const router = useRouter();
  const [form, setForm] = useState<Settings>(initial);
  const [saved, setSaved] = useState<Settings>(initial);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));

  /** 只比较表单里真的能改的键：friendLinks/umamiTotal 不在表单上，不该算作"有改动" */
  const editableKeys = useMemo(
    () => [...GROUPS.flatMap((g) => g.fields), "commentEnabled", "rssEnabled"] as (keyof Settings)[],
    []
  );
  const dirtyKeys = editableKeys.filter((k) => form[k] !== saved[k]);
  const dirty = dirtyKeys.length > 0;

  const save = async () => {
    setBusy(true); setMsg(""); setErr("");
    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setSaved(form);
      setMsg("已保存，前台下一次请求即生效");
      setSavedAt(new Date().toLocaleTimeString("zh-CN"));
      // 页脚/标题在后台上层 layout 里也出现，刷新一次保证所见即所得
      router.refresh();
    } else setErr(d.error || "保存失败");
  };

  const reset = () => {
    setForm(saved);
    setMsg(""); setErr("");
  };

  const field = (key: keyof Settings) => (
    <div className={"field" + (MULTILINE.has(key) ? " field-wide" : "")} key={String(key)}>
      <label htmlFor={"set-" + String(key)}>{FIELD_LABEL[key] ?? String(key)}</label>
      {MULTILINE.has(key) ? (
        <textarea
          id={"set-" + String(key)}
          className="textarea"
          value={String(form[key] ?? "")}
          placeholder={PLACEHOLDER[key]}
          onChange={(e) => set(key, e.target.value as never)}
        />
      ) : (
        <input
          id={"set-" + String(key)}
          className="input"
          value={String(form[key] ?? "")}
          placeholder={PLACEHOLDER[key]}
          onChange={(e) => set(key, e.target.value as never)}
        />
      )}
    </div>
  );

  return (
    <>
      {msg ? <div className="notice notice-ok" role="status">{msg}</div> : null}
      {err ? <div className="notice notice-error" role="alert">{err}</div> : null}

      {/*
        分组不是卡片。设置页天然有 4–5 组字段，如果每组都套一层边框盒子，
        整页就变成一叠白方块 —— 视觉上分不出「哪一组更重要」，只是把
        本来就该由标题承担的分隔重复画了一遍。
        这里用「衬线组标题 + 上下细线 + 组间大留白」组织，表单本身靠间距呼吸。
      */}
      {GROUPS.map((g) => (
        <section className="settings-group" key={g.key}>
          <h2 className="settings-group-title">{g.title}</h2>
          <p className="settings-group-desc">{g.desc}</p>
          <div className="settings-grid">{g.fields.map(field)}</div>
        </section>
      ))}

      <section className="settings-group">
        <h2 className="settings-group-title">功能开关</h2>
        <p className="settings-group-desc">
          关掉评论后前台不再渲染评论区（历史评论保留，重新打开即恢复）；关掉 RSS 后 /rss.xml 返回 404。
        </p>
        <div className="settings-switches">
          <label className="switch-row">
            <input type="checkbox" checked={form.commentEnabled}
                   onChange={(e) => set("commentEnabled", e.target.checked)} />
            <span>
              <b>开启评论</b>
              <em>关闭后文章页底部不再显示评论区</em>
            </span>
          </label>
          <label className="switch-row">
            <input type="checkbox" checked={form.rssEnabled}
                   onChange={(e) => set("rssEnabled", e.target.checked)} />
            <span>
              <b>开放 RSS</b>
              <em>关闭后 /rss.xml 不再对外提供订阅源</em>
            </span>
          </label>
        </div>
      </section>

      {/* 友链曾经是这里的一个自由文本框，现已由独立表接管 —— 说清楚去哪改，
          而不是把人领到一个保存了也不生效的输入框前面 */}
      <section className="settings-group">
        <h2 className="settings-group-title">友链与聚合站</h2>
        <p className="settings-group-desc">
          外链已改为逐条管理（名称、链接、分类、排序、显隐），保存后前台右栏与手机抽屉立即刷新。
          原先这里的「每行 名称|链接」文本框前台已不再读取，故已移除。
        </p>
        <a className="btn btn-sm" href="/admin/links">去「外链」管理</a>
      </section>

      {/* 常驻保存条：dirty 时给出未保存提醒与放弃入口，保存后显示时间 */}
      <div className="settings-savebar">
        <span className={dirty ? "settings-dirty" : "settings-saved"} aria-live="polite">
          {dirty
            ? "有 " + dirtyKeys.length + " 处未保存的改动"
            : savedAt ? "已保存 · " + savedAt : "当前无改动"}
        </span>
        <span className="settings-savebar-fill" />
        {dirty ? (
          <button className="btn btn-sm" disabled={busy} onClick={reset}>放弃改动</button>
        ) : null}
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>
          {busy ? "保存中…" : "保存设置"}
        </button>
      </div>
    </>
  );
}
