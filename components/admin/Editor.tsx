"use client";
import { useCallback, useEffect, useRef, useState, useDeferredValue } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { prepareForUpload } from "@/lib/image-convert";
import { isHeic, explainUploadFailure, formatBytes, MAX_UPLOAD_BYTES_ASSUMED } from "@/lib/image-plan";
import { videoToEmbed, normalizePastedIframe, SUPPORTED_HINT } from "@/lib/video-embed";
import {
  loadDraft,
  saveDraft as apiSaveDraft,
  publishDraft as apiPublishDraft,
  newClientDraftId,
  newRequestId,
  type DraftIdentity,
} from "@/lib/draft-client";
import { canonicalize, hashSnapshot, type Snapshot } from "@/lib/snapshot";
import {
  autosaveOnce,
  observeDraft,
  rebaseDraft as apiRebaseDraft,
} from "@/lib/draft-client";
import { AutosaveEngine, classifyReconcile, type AutosaveState } from "@/lib/autosave";
import { createLocalStore, canClearLocal, localUnavailableFallback, type LocalDraft } from "@/lib/local-draft";
import { SaveStatus, ConflictDialog, RestoreBanner, type ConflictOption } from "./SaveStatus";
import { VersionPanel } from "./VersionPanel";
import { useAutosave } from "./useAutosave";

type Initial = {
  id?: number; type?: string; title?: string; slug?: string; content?: string;
  status?: string; categories?: string[]; tags?: string[]; cover?: string | null; published_at?: string | null;
  comments_enabled?: number;
  /** posts.revision：草稿基线与并发校验的起点（方案 §3.1） */
  revision?: number;
};


/**
 * 编辑器（C7）。
 *
 * 本轮补上的（原实现全都没有）：
 *   - 粘贴上传 / 拖拽上传（README 早就承诺"可直接粘贴图片"，代码里 0 实现）
 *   - 本地草稿自动保存 + 崩溃后可恢复
 *   - Cmd/Ctrl+S 保存、Cmd/Ctrl+B/I 包裹
 *   - 分屏实时预览（用 useDeferredValue 防抖，不再点一次刷一次）
 *   - 封面上传 + 字数统计
 */
export function Editor({ initial, mode }: { initial?: Initial; mode: "new" | "edit" }) {
  const [type, setType] = useState(initial?.type || "post");
  const [title, setTitle] = useState(initial?.title || "");
  const [slug, setSlug] = useState(initial?.slug || "");
  const [content, setContent] = useState(initial?.content || "");
  const [cats, setCats] = useState((initial?.categories || []).join(", "));
  const [tags, setTags] = useState((initial?.tags || []).join(", "));
  const [status, setStatus] = useState(initial?.status || "draft");
  const [cover, setCover] = useState<string | null>(initial?.cover ?? null);
  const [commentsEnabled, setCommentsEnabled] = useState<boolean>((initial?.comments_enabled ?? 1) !== 0);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [split, setSplit] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [dirty, setDirty] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /* 视频外链：点工具栏「视频」展开的输入面板（不做自托管，见 lib/video-embed.ts 的说明） */
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoInput, setVideoInput] = useState("");

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const deferredContent = useDeferredValue(content);

  /**
   * 草稿身份（方案 §4.3）。
   * clientDraftId 在组件生命周期内保持稳定：同一次编辑会话的所有保存
   * 都用它，服务端据此判断"这是同一个编辑会话的重试"还是"另一处编辑"。
   */
  const clientDraftIdRef = useRef<string>(newClientDraftId());
  const identityRef = useRef<DraftIdentity | null>(null);

  /* ---------------- 自动保存（阶段 03.2，编排抽到 useAutosave） ---------------- */
  const [autoState, setAutoState] = useState<AutosaveState>("idle");
  const [autoMsg, setAutoMsg] = useState<string>("");
  const [savedAtIso, setSavedAtIso] = useState<string | null>(null);
  const [localUnavailable, setLocalUnavailable] = useState(false);
  const [conflict, setConflict] = useState<{
    sent: Snapshot | null;
    online: string;
    serverDraft: string;
    serverMeta: string;
  } | null>(null);
  const [restoreInfo, setRestoreInfo] = useState<LocalDraft | null>(null);
  const [versionOpen, setVersionOpen] = useState(false);

  /**
   * 冲突时准备三方对比（方案 §9.2）。
   *
   * 用 function 声明而不是 const：useAutosave 的 onConflict 回调在构造时就引用了它，
   * 而 const 箭头函数此时还在 TDZ 里 —— 那样会在"真的发生冲突"这一天才崩，
   * 也就是最难排查的时刻。
   */
  async function openConflict(sentSnapshot: Snapshot | null): Promise<void> {
    const postId = api.getIdentity()?.postId ?? initial?.id;
    if (!postId) return;
    // 只发一次 GET：既要草稿正文来做对比，也要版本号写进说明
    const loaded = await loadDraft(postId);
    const draft = loaded.ok ? loaded.value.draft : null;
    setConflict({
      sent: sentSnapshot,
      online: initial?.content ?? "",
      serverDraft: draft ? String(draft.snapshot.content ?? "") : "",
      serverMeta: draft
        ? "草稿 v" + draft.identity.draftRevision + " · 基于线上 v" + draft.identity.baseRevision
        : "服务端没有草稿",
    });
  }

  /** 读当前编辑器内容（给 useAutosave 用 ref 取，避免陈旧闭包） */
  const snapshotRef = useRef<() => Snapshot>(() => ({
    type: "post", title: "", slug: "", content: "", cover: null,
    categories: [], tags: [], comments_enabled: 1,
  }));

  const api = useAutosave({
    postId: initial?.id,
    initialRevision: initial?.revision,
    getSnapshot: () => snapshotRef.current(),
    onPostCreated: (postId: number) => {
      try { router.replace("/admin/edit/" + postId); } catch { /* ignore */ }
    },
    onState: (state: AutosaveState, detail: { message?: string; localPersistOk?: boolean }) => {
      setAutoState(state);
      setAutoMsg(detail.message ?? "");
      if (detail.localPersistOk === false) setLocalUnavailable(true);
      if (state === "saved") setSavedAtIso(new Date().toISOString());
    },
    onConflict: (sent: Snapshot | null) => { void openConflict(sent); },
    onLocalDraftFound: (draft: LocalDraft) => setRestoreInfo(draft),
  });

  const { mark: autoMark, saveNow: autoSaveNow, flushLocal, resume: autoResume, keepLocal, setIdentity, getClientDraftId } = api;

  /**
   * 标记改动并驱动自动保存。
   *
   * 参数 `override` 是**本次输入后的最新值**。
   * 为什么必须传：React 的 setState 是异步的，`mark()` 执行时
   * 闭包里的 title/content 还是上一次渲染的值。若在这里读闭包，
   * 自动保存就会把"上一个字"的版本发上去 —— 表现为"保存成功但内容是旧的"，
   * 而且每次只差一次击键，看起来像是偶发的同步延迟，极难归因。
   */
  const mark = useCallback((override?: Partial<Snapshot>) => {
    setDirty(true);
    autoMark(override);
  }, [autoMark]);

  /* ---------------- 服务端草稿：打开已有文章时加载 ---------------- */
  /**
   * 方案 §6.1.1「打开已有文章」：取得 posts 当前版本并 GET 草稿接口；
   * 有草稿加载草稿，无草稿加载 posts（initial 里已经是 posts 当前内容）。
   *
   * 顺序很重要：先拿到 draft 再决定覆盖表单，且**只有服务端草稿比 posts 新**
   * 才覆盖 —— 否则用户刚打开页面就被一份陈旧草稿盖掉线上内容。
   */
  useEffect(() => {
    if (mode !== "edit" || !initial?.id) return;
    let cancelled = false;
    (async () => {
      const res = await loadDraft(initial.id!);
      if (cancelled) return;
      if (res.ok && res.value.draft) {
        const d = res.value.draft;
        // 绑定这个编辑会话的身份：后续保存用草稿自己的 clientDraftId，
        // 否则服务端会认为"另一个会话在改"
        clientDraftIdRef.current = d.identity.clientDraftId;
        identityRef.current = d.identity;
        // **必须同时告诉状态机**：引擎自己维护一份 identity，
        // 用于算 expectedPostRevision / expectedDraftRevision。
        // 只更新 identityRef 不同步引擎，会让它以为"还没有草稿"（draftRevision=0），
        // 于是拿 0 去和已存在的 v1 比较 —— 第一次自动保存就撞 409，
        // 而且表面上看起来像"版本冲突"，很难联想到是漏了这一步同步。
        setIdentity(d.identity);
        const s = d.snapshot;
        setType(s.type);
        setTitle(s.title);
        setSlug(s.slug);
        setContent(s.content);
        setCover(s.cover);
        setCats(s.categories.join(", "));
        setTags(s.tags.join(", "));
        setCommentsEnabled(s.comments_enabled !== 0);
        setMsg("已载入上次未发布的草稿");
      }
    })();
    return () => { cancelled = true; };
  }, [mode, initial?.id]);

  /* ---------------- 持久化边界与本地恢复检查 ---------------- */
  /**
   * 这两块（pagehide/visibilitychange flush、本地可恢复草稿扫描）已移到
   * components/admin/useAutosave.ts。留这条注释是为了让人知道"不是漏了"：
   * 它们现在与状态机在同一个 hook 里，改的时候只需看那一处。
   */

  /* ---------------- 实时预览（防抖） ---------------- */
  useEffect(() => {
    if (!split) return;
    let alive = true;
    const t = setTimeout(async () => {
      const res = await fetch("/api/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: deferredContent }),
      });
      const d = await res.json().catch(() => ({ html: "" }));
      if (alive) setPreviewHtml(d.html || "");
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [deferredContent, split]);

  /* ---------------- 插入 / 上传 ---------------- */
  const insert = useCallback((text: string, wrap = false) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = content.slice(s, e);
    const next = content.slice(0, s) + text + sel + (wrap ? text : "") + content.slice(e);
    setContent(next);
    mark({ content: next });
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + text.length + (wrap ? sel.length : 0);
    });
  }, [content]);

  /**
   * 上传单张图。
   *
   * 关键点：先把文件在浏览器里过一遍（lib/image-convert）——
   *   · HEIC/HEIF（iPhone 默认格式）服务端认不出 magic bytes，必须转码
   *   · 超过 8MB 或长边 2560px 的图会被缩 + 重编码，顺带剥掉 EXIF/GPS
   * 服务端的安全校验完全不依赖这段逻辑（它只看 magic bytes），所以绕过也没用。
   */
  const uploadFile = useCallback(async (raw: File): Promise<string | null> => {
    const { file, note } = await prepareForUpload(raw);
    if (note) setMsg(note);
    // 预处理后仍超限就别发请求了，直接说清楚（省一次 30s 的超时等待）
    if (file.size > MAX_UPLOAD_BYTES_ASSUMED) {
      setErr(
        raw.name + " 压缩后仍有 " + formatBytes(file.size) +
        "，超过 " + Math.round(MAX_UPLOAD_BYTES_ASSUMED / 1024 / 1024) + "MB 上限，请先自行导出为小一些的图片"
      );
      return null;
    }
    const fd = new FormData();
    fd.append("file", file);
    setUploading((n) => n + 1);
    try {
      const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(explainUploadFailure(raw.name, res.status, d.error || ""));
        return null;
      }
      return d.url as string;
    } catch {
      setErr(raw.name + " 上传中断（网络问题？）");
      return null;
    } finally {
      setUploading((n) => n - 1);
    }
  }, []);

  const uploadAndInsert = useCallback(async (files: File[]) => {
    setErr("");
    // 不能只看 f.type：Windows/部分浏览器给 HEIC 的 type 是空串，
    // 用 startsWith("image/") 会把它静默丢掉 —— 这正是"选了图没反应"的来源之一。
    const isImageLike = (f: File) =>
      (f.type || "").startsWith("image/") || isHeic(f.name, f.type);
    const images = files.filter(isImageLike);
    const skipped = files.length - images.length;
    if (!images.length) {
      setErr(
        skipped
          ? "这里只能上传图片；视频请用外链嵌入（B 站/YouTube 的分享代码可直接粘进正文）"
          : "没有可上传的文件"
      );
      return;
    }

    let ok = 0;
    for (const f of images) {
      const url = await uploadFile(f);
      if (url) { insert("![](" + url + ")\n"); ok++; }
    }
    if (ok) {
      setMsg("已插入 " + ok + " 张图片" + (skipped ? "（跳过 " + skipped + " 个非图片文件）" : ""));
      setTimeout(() => setMsg(""), 2500);
    }
  }, [insert, uploadFile]);

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) { e.preventDefault(); await uploadAndInsert(files); }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) await uploadAndInsert(files);
  };

  /**
   * 插入视频。
   *
   * 走外链而非上传 —— 这台机器出口带宽只有 400~700KB/s 且并行不叠加，
   * 自托管视频会让每个访客等几十秒。视频由平台托管，本站零带宽零磁盘。
   *
   * 两种输入：平台链接/编号（重新拼出 embed 地址），或直接粘贴的 <iframe>
   * （只取 src 并校验白名单域名，其余属性一律丢弃）。
   */
  const insertVideo = useCallback(() => {
    setErr("");
    const raw = videoInput.trim();
    if (!raw) { setErr("请先粘贴视频链接或嵌入代码"); return; }

    const parsed = videoToEmbed(raw);
    if (parsed) {
      insert("\n\n" + parsed.embed + "\n\n");
      setVideoInput("");
      setVideoOpen(false);
      setMsg("已插入 " + parsed.video.label + " 视频");
      setTimeout(() => setMsg(""), 2500);
      return;
    }

    // 不是可识别的链接，再试"直接粘贴的 iframe"
    const normalized = normalizePastedIframe(raw);
    if (normalized) {
      insert("\n\n" + normalized + "\n\n");
      setVideoInput("");
      setVideoOpen(false);
      setMsg("已插入嵌入视频");
      setTimeout(() => setMsg(""), 2500);
      return;
    }

    setErr("识别不了这个链接。" + SUPPORTED_HINT);
  }, [videoInput, insert]);

  /* ---------------- 保存 ----------------
   *
   * 阶段 03.1 起编辑器走草稿协议（方案 §6.1.1 的调用矩阵）：
   *   - 存草稿 -> PUT 草稿接口，只写 post_drafts，**不动线上内容**
   *   - 发布   -> POST publish，正文取服务端当前草稿（不是本次请求另传一套）
   *
   * 这里刻意先存草稿再发布：这样"发布出去的"就是"刚才确认过的那份草稿"，
   * 而不是客户端内存里可能已被后续输入改过、却还没落库的内容。
   */
  const buildSnapshot = useCallback((): Snapshot => ({
    type: type as Snapshot["type"],
    title,
    slug,
    content,
    cover,
    categories: cats.split(",").map((x) => x.trim()).filter(Boolean),
    tags: tags.split(",").map((x) => x.trim()).filter(Boolean),
    comments_enabled: commentsEnabled ? 1 : 0,
  }), [type, title, slug, content, cover, cats, tags, commentsEnabled]);

  // 每次渲染都把最新的构造器放进 ref：状态机的定时器回调据此取当前内容
  snapshotRef.current = buildSnapshot;

  const save = useCallback(async (nextStatus?: string) => {
    const publish = nextStatus === "published";
    setBusy(true); setErr(""); setMsg("");

    const snapshot = buildSnapshot();
    const snapshotHash = hashSnapshot(canonicalize(snapshot));

    // 版本信息：身份来自上次成功响应；新文章首次保存时 postId 未知，
    // expectedPostRevision 用 1（壳的初始 revision），expectedDraftRevision 用 0。
    const identity = identityRef.current;
    const postId = identity?.postId ?? initial?.id;
    const expectedPostRevision = identity?.baseRevision ?? initial?.revision ?? 1;
    const expectedDraftRevision = identity?.draftRevision ?? 0;

    const saved = await apiSaveDraft({
      postId,
      clientDraftId: clientDraftIdRef.current,
      snapshot,
      snapshotHash,
      expectedPostRevision,
      expectedDraftRevision,
    });

    if (!saved.ok) {
      setBusy(false);
      // 冲突类错误要把服务端现状说清楚，否则用户只会看到"保存失败"
      if (saved.error.kind === "conflict") {
        setErr(
          saved.error.message +
          "（当前版本 v" + (saved.error.server?.currentPostRevision ?? "?") +
          "，草稿 v" + (saved.error.server?.currentDraftRevision ?? "?") + "）"
        );
        // 保存冲突/失败时**不清本地草稿**（方案 §8.1），刷新后还能恢复
      } else {
        setErr(saved.error.message);
      }
      return;
    }

    identityRef.current = saved.value.identity;
    setDirty(false);

    // 新文章首次保存成功后接管 URL，后续保存都用 postId
    if (!postId) {
      router.replace("/admin/edit/" + saved.value.postId);
      router.refresh();
      setBusy(false);
      setMsg("草稿已保存");
      return;
    }

    if (!publish) {
      setBusy(false);
      setStatus("draft");
      setMsg("草稿已保存");
      router.refresh();
      return;
    }

    // 发布：正文取服务端刚确认的草稿
    const identity2 = identityRef.current!;
    const requestId = newRequestId();
    const pub = await apiPublishDraft({
      postId: identity2.postId,
      publishRequestId: requestId,
      expectedPostRevision: identity2.baseRevision,
      expectedDraftRevision: identity2.draftRevision,
      slug: slug || undefined,
    });

    setBusy(false);
    if (!pub.ok) {
      if (pub.error.kind === "conflict") {
        // 发布冲突同样保留全部本地内容，让用户重新加载后比较
        setErr(pub.error.message);
      } else {
        setErr(pub.error.message);
      }
      return;
    }

    setStatus("published");
    setMsg("已发布");
    if (pub.value.slug) setSlug(pub.value.slug);
    // 发布后草稿被清理，身份作废；后续编辑会以新的 posts.revision 为基线
    identityRef.current = null;
    router.refresh();
  }, [buildSnapshot, initial?.id, initial?.revision, router, slug]);

  /* ---------------- 快捷键 ---------------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === "s") { e.preventDefault(); void save(); }
      else if (e.key === "b" || e.key === "i") {
        const ta = taRef.current;
        if (document.activeElement === ta) { e.preventDefault(); insert(e.key === "b" ? "**" : "*", true); }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save, insert]);

  const isShuo = type === "shuoshuo";
  const chars = content.replace(/\s/g, "").length;

  return (
    <div className="editor-workbench"
         onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
         onDragLeave={() => setDragOver(false)}
         onDrop={onDrop}>
      {/*
        顶部操作条：返回 · 类型 · 字数 / 保存状态 · 预览 · 存草稿 · 发布。
        刻意贴紧页面顶部而不是浮在屏幕中间 —— 编辑时视线在正文，回退/发布
        这类全局动作应当固定在同一个位置，不必滚动寻找。
      */}
      <div className="editor-topbar">
        <Link href="/admin" className="editor-back" aria-label="返回内容列表">
          <span aria-hidden>←</span> 内容
        </Link>

        <select
          className="input editor-type"
          value={type}
          aria-label="内容类型"
          onChange={(e) => { setType(e.target.value); mark({ type: e.target.value as Snapshot["type"] }); }}
        >
          <option value="post">文章</option>
          <option value="page">页面</option>
          <option value="shuoshuo">说说</option>
        </select>

        <span className="editor-topbar-fill" />

        <span className="editor-count">
          {chars} 字{uploading ? " · 上传中 " + uploading : ""}
        </span>

        <button type="button" className="btn btn-sm editor-split-btn" onClick={() => setSplit(!split)}>
          {split ? "单栏" : "分屏预览"}
        </button>

        {/* 版本历史只有已存在的文章才有意义：新文章还没有任何历史 */}
        {initial?.id ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setVersionOpen(true)}>
            版本历史
          </button>
        ) : null}

        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save("draft")}>
          存草稿
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => save("published")}>
          {busy ? "保存中…" : status === "published" ? "更新" : "发布"}
        </button>
      </div>

      {msg ? <div className="notice notice-ok">{msg}</div> : null}
      {err ? <div className="notice notice-error">{err}</div> : null}

      {/* 本地可恢复草稿：显示保存时间，否则用户不知道该不该信它（方案 §8.3） */}
      {restoreInfo ? (
        <RestoreBanner
          title={String((restoreInfo.snapshot as Record<string, unknown>)?.title ?? "")}
          savedAt={restoreInfo.savedAt}
          onRestore={() => {
            const s2 = restoreInfo.snapshot as Snapshot;
            setType(s2.type); setTitle(s2.title); setSlug(s2.slug); setContent(s2.content);
            setCover(s2.cover); setCats(s2.categories.join(", ")); setTags(s2.tags.join(", "));
            setCommentsEnabled(s2.comments_enabled !== 0);
            setDirty(true);
            // 恢复后立刻进入自动保存流程：用户选择恢复就是要这份内容
            autoMark(s2);
            setRestoreInfo(null);
          }}
          onDiscard={() => {
            // 只清本地快照，**不调接口** —— 与服务端草稿的"放弃"是两件事（方案 §6.5）
            api.clearLocal(restoreInfo.clientDraftId, restoreInfo.postId);
            setRestoreInfo(null);
          }}
        />
      ) : null}

      <div className="editor-layout">
        {/* ── 主编辑区：标题 → 工具条 → 正文 ── */}
        <div className="editor-main">
          {!isShuo ? (
            <label className="editor-title-field">
              <span className="sr-only">标题</span>
              <input
                className="editor-title-input"
                value={title}
                onChange={(e) => { setTitle(e.target.value); mark({ title: e.target.value }); }}
                placeholder="文章标题"
              />
            </label>
          ) : null}

      {/* 工具栏。手机端每个按钮靠 .editor-toolbar 的断点规则顶到 44pt，
          否则 3px 9px 内边距的按钮只有约 22×24px，手指基本点不中。 */}
      <div className="editor-toolbar">
        {[
          { l: "H2", v: "## ", w: false },
          { l: "H3", v: "### ", w: false },
          { l: "粗体", v: "**", w: true },
          { l: "斜体", v: "*", w: true },
          { l: "代码", v: "BT", w: true },
          { l: "代码块", v: "\nBTBTBT\n", w: false },
          { l: "引用", v: "> ", w: false },
          { l: "列表", v: "- ", w: false },
          { l: "链接", v: "[文本](url)", w: false },
          { l: "表格", v: "\n| 列1 | 列2 |\n| --- | --- |\n|   |   |\n", w: false },
          { l: "分隔线", v: "\n---\n", w: false },
        ].map((b) => (
          <button key={b.l} type="button" className="btn btn-sm"
                  onClick={() => insert(b.v.split("BT").join(String.fromCharCode(96)), b.w)}
                  style={{ padding: "3px 9px", fontSize: ".78rem" }}>{b.l}</button>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}
                style={{ padding: "3px 9px", fontSize: ".78rem" }}>图片</button>
        <button type="button" className="btn btn-sm" onClick={() => { setVideoOpen((v) => !v); setErr(""); }}
                aria-expanded={videoOpen}
                style={{ padding: "3px 9px", fontSize: ".78rem" }}>视频</button>
        <input ref={fileRef} type="file" multiple style={{ display: "none" }}
               accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic,image/heif,.heic,.heif"
               onChange={(e) => { const fs2 = Array.from(e.target.files ?? []); if (fs2.length) void uploadAndInsert(fs2); e.target.value = ""; }} />
      </div>

          <div className={"editor-grid" + (split ? " is-split" : "")}>
            <textarea
              ref={taRef}
              className="textarea editor-textarea"
              value={content}
              onChange={(e) => { setContent(e.target.value); mark({ content: e.target.value }); }}
              onPaste={onPaste}
              placeholder={isShuo
                ? "写点什么…（可直接粘贴图片）"
                : "支持 Markdown。可直接粘贴或拖入图片；iPhone 的 HEIC 会自动转成 JPEG，大图自动压缩"}
            />
            {split ? (
              <div className="prose editor-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            ) : null}
          </div>

      {/* 视频外链面板：不做自托管视频（带宽与备份链都不允许），
          这里只把平台链接转成 iframe 嵌入代码插入正文。 */}
          {/* 视频外链面板：不做自托管视频（带宽与备份链都不允许），
              这里只把平台链接转成 iframe 嵌入代码插入正文。 */}
          {videoOpen ? (
            <div className="editor-video">
              <div className="editor-video-head">
                <label htmlFor="editor-video-url">视频链接</label>
                <span className="editor-video-hint">贴链接即可，视频留在原平台播放，本站不存文件</span>
                <button type="button" className="btn btn-sm btn-ghost"
                        onClick={() => { setVideoOpen(false); setVideoInput(""); }}>关闭</button>
              </div>
              <input
                id="editor-video-url"
                className="input"
                value={videoInput}
                onChange={(e) => setVideoInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); insertVideo(); } }}
                placeholder="BV1rAdTBfEEn / youtube.com/watch?v=... / 直接粘贴 <iframe> 代码"
                autoFocus
              />
              <div className="editor-video-foot">
                <button type="button" className="btn btn-sm btn-primary" onClick={insertVideo}>插入视频</button>
                <span className="editor-video-hint">{SUPPORTED_HINT}</span>
              </div>
            </div>
          ) : null}

          {dragOver ? <div className="notice">松开即可上传图片</div> : null}

        </div>{/* /editor-main */}

        {/*
          辅助区：分类、标签、封面、别名、评论开关、保存状态。
          放在右栏而不是塞在正文下面 —— 元信息是「写完之后顺手补的」，
          不该把正文推离视口。窄屏时它折到正文下方（见 admin.css）。
        */}
        <aside className="editor-aside" aria-label="文章元信息">
          {!isShuo && mode === "edit" ? (
            <div className="field">
              <label htmlFor="editor-slug">URL 路径</label>
              <input
                id="editor-slug"
                className="input"
                value={slug}
                onChange={(e) => { setSlug(e.target.value); mark({ slug: e.target.value }); }}
              />
              <span className="editor-field-hint">改动会自动为旧地址保留 301 跳转。</span>
            </div>
          ) : null}

          {!isShuo ? (
            <>
              <div className="field">
                <label htmlFor="editor-cats">分类</label>
                <input
                  id="editor-cats"
                  className="input"
                  value={cats}
                  onChange={(e) => { setCats(e.target.value); mark({ categories: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); }}
                  placeholder="学习, AI"
                />
                <span className="editor-field-hint">逗号分隔</span>
              </div>

              <div className="field">
                <label htmlFor="editor-tags">标签</label>
                <input
                  id="editor-tags"
                  className="input"
                  value={tags}
                  onChange={(e) => { setTags(e.target.value); mark({ tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); }}
                  placeholder="部署, 工具"
                />
                <span className="editor-field-hint">逗号分隔</span>
              </div>

              <div className="field">
                <span className="editor-field-label">封面图</span>
                <div className="editor-cover">
                  <button type="button" className="btn btn-sm" onClick={() => coverRef.current?.click()}>选择图片</button>
                  <input ref={coverRef} type="file" style={{ display: "none" }}
                         accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic,image/heif,.heic,.heif"
                         onChange={async (e) => {
                           const f = e.target.files?.[0];
                           if (f) { const url = await uploadFile(f); if (url) { setCover(url); mark({ cover: url }); } }
                           e.target.value = "";
                         }} />
                  {cover ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={cover} alt="封面预览" className="editor-cover-thumb" />
                      <button type="button" className="btn btn-sm btn-ghost"
                              onClick={() => { setCover(null); mark({ cover: null }); }}>移除</button>
                    </>
                  ) : <span className="editor-field-hint">未设置</span>}
                </div>
                <span className="editor-field-hint">用于分享卡片的 og:image</span>
              </div>
            </>
          ) : null}

          {/* 单篇评论开关：页面类型默认也想开评论，但隐私政策这类应当可以单独关掉 */}
          <label className="switch-row editor-switch">
            <input type="checkbox" checked={commentsEnabled}
                   onChange={(ev) => { setCommentsEnabled(ev.target.checked); mark({ comments_enabled: ev.target.checked ? 1 : 0 }); }} />
            <span>
              <b>允许评论</b>
              <em>关闭后该页面不显示评论区</em>
            </span>
          </label>

          {/* 双状态指示器：草稿状态与线上版本分开显示（方案 §9.2） */}
          <SaveStatus
            state={autoState}
            savedAt={savedAtIso}
            publishedAt={initial?.published_at ?? (status === "published" ? savedAtIso : null)}
            hasUnpublishedChanges={autoState !== "idle" && autoState !== "saved"}
            localUnavailable={localUnavailable}
            message={autoMsg}
            onRetry={() => { autoSaveNow(); }}
          />

          <p className="editor-kbd-hint">Cmd/Ctrl+S 保存</p>
        </aside>
      </div>{/* /editor-layout */}

      {/* 版本历史：恢复只改草稿，不改线上（方案 §6.4） */}
      <VersionPanel
        postId={initial?.id ?? 0}
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        currentDraftRevision={identityRef.current?.draftRevision ?? 0}
        currentPostRevision={identityRef.current?.baseRevision ?? initial?.revision ?? 1}
        clientDraftId={clientDraftIdRef.current}
        onRestored={(snap) => {
          // 恢复后的内容进入编辑器；用户继续编辑或显式发布
          setType(snap.type ?? type);
          setTitle(String(snap.title ?? ""));
          setSlug(String(snap.slug ?? ""));
          setContent(String(snap.content ?? ""));
          setCover(snap.cover ?? null);
          setCats((snap.categories ?? []).join(", "));
          setTags((snap.tags ?? []).join(", "));
          setCommentsEnabled(snap.comments_enabled !== 0);
          setDirty(true);
          setMsg("已把所选版本恢复为草稿，发布后才会更新前台");
        }}
      />

      {/* 冲突三方对比：绝不自动合并，用户必须明确选一份（方案 §9.2） */}
      <ConflictDialog
        open={!!conflict}
        busy={busy}
        options={
          conflict
            ? ([
                {
                  key: "online",
                  title: "当前线上版本",
                  hint: "读者此刻看到的版本",
                  meta: initial?.published_at ? "发布于 " + initial.published_at : "未发布",
                  content: conflict.online,
                },
                {
                  key: "server-draft",
                  title: "服务端草稿",
                  hint: "别处保存的最新草稿",
                  meta: conflict.serverMeta,
                  content: conflict.serverDraft,
                },
                {
                  key: "local",
                  title: "我这里的版本",
                  hint: "本次编辑尚未保存的内容",
                  meta: "本地内存",
                  content: conflict.sent ? String(conflict.sent.content ?? content) : content,
                },
              ] as ConflictOption[])
            : []
        }
        onClose={() => setConflict(null)}
        onUseServer={() => {
          // 以服务端草稿为准：把内容替换掉，再让状态机继续
          setContent(conflict?.serverDraft ?? "");
          setConflict(null);
          autoResume();
        }}
        onKeepLocal={() => {
          // 用我的版本覆盖：显式 rebase，不做字段级合并
          const snap = buildSnapshot();
          setConflict(null);
          void (async () => {
            const postId = identityRef.current?.postId ?? initial?.id;
            if (!postId) { autoResume(snap); return; }
            const r = await apiRebaseDraft({
              postId,
              clientDraftId: clientDraftIdRef.current,
              snapshot: snap,
              snapshotHash: hashSnapshot(canonicalize(snap)),
              expectedDraftRevision: identityRef.current?.draftRevision ?? 0,
              expectedPostRevision: identityRef.current?.baseRevision ?? initial?.revision ?? 1,
            });
            if (r.ok) {
              identityRef.current = r.value.identity;
              autoResume(snap);
            } else {
              setErr(r.error.message);
            }
          })();
        }}
      />
    </div>
  );
}
