"use client";
import { useCallback, useEffect, useRef, useState, useDeferredValue } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { prepareForUpload } from "@/lib/image-convert";
import { isHeic, explainUploadFailure, formatBytes, MAX_UPLOAD_BYTES_ASSUMED, MAX_VIDEO_BYTES_ASSUMED } from "@/lib/image-plan";
import { videoToEmbed, normalizePastedIframe, SUPPORTED_HINT } from "@/lib/video-embed";
import { mediaSnippet, type MediaKind } from "@/lib/editor-media";
import {
  loadDraft,
  publishDraft as apiPublishDraft,
  newRequestId,
  type DraftIdentity,
} from "@/lib/draft-client";
import { canonicalize, hashSnapshot, type Snapshot } from "@/lib/snapshot";
import {
  rebaseDraft as apiRebaseDraft,
} from "@/lib/draft-client";
import { type AutosaveState } from "@/lib/autosave";
import { type LocalDraft } from "@/lib/local-draft";
import { SaveStatus, ConflictDialog, RestoreBanner, type ConflictOption } from "./SaveStatus";
import { VersionPanel } from "./VersionPanel";
import { useAutosave } from "./useAutosave";
import { MediaPicker } from "./MediaPicker";

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
export function Editor({ initial, mode, initialType }: {
  initial?: Initial; mode: "new" | "edit";
  /** 新建时的默认类型（由 /admin/new?type=… 决定），已有内容仍以 initial.type 为准 */
  initialType?: "post" | "page" | "shuoshuo";
}) {
  const [type, setType] = useState(initial?.type || initialType || "post");
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
  /* 从媒体库插入：复用已上传的资源，不必重传一份 */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [videoInput, setVideoInput] = useState("");

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const deferredContent = useDeferredValue(content);

  /**
   * 草稿身份（方案 §4.3）。
   *
   * clientDraftId **只有一份**，住在 useAutosave 里，通过 getClientDraftId() 取。
   * 早期 Editor 自己也有一个 useRef(newClientDraftId())，于是"编辑器以为的会话"
   * 与"自动保存实际用的会话"是两个不同 UUID：加载已有草稿后第一次保存必然
   * DRAFT_FORBIDDEN（该草稿属于另一个编辑会话）—— 线上 403 全部由此而来。
   * 这里保留 identityRef 只作只读镜像，写入必须经过 api.setIdentity / api.afterPublish。
   */
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
  const uploadFile = useCallback(async (raw: File): Promise<{ url: string; kind: MediaKind } | null> => {
    /**
     * 图片走 prepareForUpload（HEIC 转码 / 大图压缩 / 剥 EXIF），视频原样上传。
     *
     * 为什么视频不能走同一条预处理：那段逻辑是 canvas 重编码，只能处理图片。
     * 视频转码需要 WASM 版 ffmpeg（十几 MB），为了一次上传把编辑器包撑大不划算 ——
     * 所以视频策略是「告诉用户上限，超了自己压」，而不是偷偷转码。
     */
    const isVideoFile = (raw.type || "").startsWith("video/");
    let file = raw;
    if (!isVideoFile) {
      const prepared = await prepareForUpload(raw);
      file = prepared.file;
      if (prepared.note) setMsg(prepared.note);
      // 预处理后仍超限就别发请求了，直接说清楚（省一次 30s 的超时等待）
      if (file.size > MAX_UPLOAD_BYTES_ASSUMED) {
        setErr(
          raw.name + " 压缩后仍有 " + formatBytes(file.size) +
          "，超过 " + Math.round(MAX_UPLOAD_BYTES_ASSUMED / 1024 / 1024) + "MB 上限，请先自行导出为小一些的图片"
        );
        return null;
      }
    } else if (file.size > MAX_VIDEO_BYTES_ASSUMED) {
      setErr(
        raw.name + " 有 " + formatBytes(file.size) +
        "，超过 " + Math.round(MAX_VIDEO_BYTES_ASSUMED / 1024 / 1024) + "MB 视频上限。请先压缩，或改用 B 站/YouTube 外链（编辑器支持）"
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
      // kind 由服务端按 magic bytes 判定，前端不猜
      return { url: d.url as string, kind: (d.kind === "video" ? "video" : "image") as MediaKind };
    } catch {
      setErr(raw.name + " 上传中断（网络问题？）");
      return null;
    } finally {
      setUploading((n) => n - 1);
    }
  }, []);

  /**
   * 上传并插入。图片与视频共用这一条路径。
   *
   * 判类型用「MIME 前缀 或 扩展名」，不能只看 MIME：Windows 与部分浏览器给
   * HEIC / 某些视频的 type 是空串，只看 MIME 会把合法文件静默丢掉 ——
   * 这正是历史上「选了图没反应」的来源之一。真正的类型判定仍在服务端
   * （magic bytes），这里只负责「别在上传前就把文件筛掉」。
   */
  const uploadAndInsert = useCallback(async (files: File[]) => {
    setErr("");
    const isMediaLike = (f: File) => {
      const type = (f.type || "").toLowerCase();
      if (type.startsWith("image/") || type.startsWith("video/")) return true;
      if (isHeic(f.name, f.type)) return true;
      // type 为空时按扩展名兜底
      return /\.(png|jpe?g|gif|webp|avif|heic|heif|mp4|webm)$/i.test(f.name || "");
    };
    const media = files.filter(isMediaLike);
    const skipped = files.length - media.length;
    if (!media.length) {
      setErr(skipped ? "只支持图片（PNG/JPEG/GIF/WEBP/AVIF/HEIC）与视频（MP4/WebM）" : "没有可上传的文件");
      return;
    }

    let images = 0, videos = 0;
    for (const f of media) {
      const r = await uploadFile(f);
      if (!r) continue;                                   // 已由 uploadFile 报错
      insert(mediaSnippet(r.kind, r.url, f.name.replace(/\.[^.]+$/, "")));
      if (r.kind === "video") videos++; else images++;
    }
    if (images || videos) {
      const parts: string[] = [];
      if (images) parts.push(images + " 张图片");
      if (videos) parts.push(videos + " 个视频");
      setMsg("已插入 " + parts.join("、" ) + (skipped ? "（跳过 " + skipped + " 个不支持的文件）" : ""));
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

    /**
     * 保存走**自动保存引擎**，而不是这里再拼一次请求。
     *
     * 早期实现有两条并行的保存通路：本函数直接用 identityRef 调 apiSaveDraft，
     * 而自动保存引擎自己维护一份 identity。两者各自演进，结果就是
     * 「点按钮保存」与「等 1.5 秒自动保存」走的是不同的版本号来源 ——
     * 线上那些"草稿已被其他会话修改"的 409 大多源于此（同一个浏览器，
     * 却同时扮演了两个"会话"）。现在只有一条通路，版本号只有一份。
     */
    const outcome = await api.saveSnapshotNow(snapshot);
    const saved = outcome;
    identityRef.current = api.getIdentity();

    if (!saved || saved.kind !== "ok") {
      setBusy(false);
      if (!saved) {
        setErr("保存没有完成（上一次保存仍在进行，或有冲突待处理），请稍后重试");
        return;
      }
      if (saved.kind === "conflict") {
        setErr("保存冲突：服务端已有更新的草稿或文章版本，请对照后选择保留哪一份");
        return;
      }
      setErr(saved.message || "保存失败");
      return;
    }

    setDirty(false);
    const savedPostId = saved.identity.postId;

    if (!publish) {
      setBusy(false);
      /**
       * 存草稿**不改变发布状态**。
       *
       * 早期这里无条件 setStatus("draft")：于是一篇已发布的文章只要点一次
       * 「存草稿」，顶栏按钮就从「更新」变回「发布」，右侧"线上版本"也变成
       * "尚未发布" —— 用户以为文章掉回草稿了（实际 posts 仍是 published）。
       * 只有从未发布过的文章才是 draft。
       */
      if (status !== "published") setStatus("draft");
      setMsg("草稿已保存");
      // 新文章首次保存后接管 URL：之后刷新/回退都还在这一篇上
      if (!initial?.id) {
        try { router.replace("/admin/edit/" + savedPostId); } catch { /* ignore */ }
      }
      router.refresh();
      return;
    }

    /**
     * 发布：用**这次保存返回的**身份，而不是外面再读一次 identityRef。
     *
     * 新文章第一次点「发布」时，上一步才刚把 postId 建出来；早期实现
     * 在创建分支里直接 return 了，于是"点发布"只留下一个草稿壳 ——
     * 用户看到的是"点了发布但文章还在草稿里"。
     */
    const requestId = newRequestId();
    const pub = await apiPublishDraft({
      postId: savedPostId,
      publishRequestId: requestId,
      expectedPostRevision: saved.identity.baseRevision,
      expectedDraftRevision: saved.identity.draftRevision,
      slug: slug || undefined,
    });

    setBusy(false);
    if (!pub.ok) {
      setErr(pub.error.message);
      return;
    }

    setStatus("published");
    setMsg(pub.value.replayed ? "已发布（本次是重试，服务端此前已成功）" : "已发布");
    if (pub.value.slug) setSlug(pub.value.slug);
    /**
     * 发布成功后：服务端已删草稿、posts.revision 已 +1。
     * 必须把这两件事一起同步给状态机 —— 否则"发布完再改一个字"
     * 会立刻 409（线上每日必现）。
     */
    api.afterPublish(pub.value.revision);
    identityRef.current = null;
    router.refresh();
  }, [api, buildSnapshot, initial?.id, router, slug]);

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
  /**
   * 「返回」回到这一类内容自己的列表，而不是永远回文章列表。
   * 从说说明细页点返回却落在文章列表，用户会以为刚才那一条没了。
   */
  const backHref = type === "shuoshuo" ? "/admin/shuoshuo" : type === "page" ? "/admin/pages" : "/admin";
  const backLabel = type === "shuoshuo" ? "说说" : type === "page" ? "页面" : "文章";

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
        <Link href={backHref} className="editor-back" aria-label={"返回" + backLabel}>
          <span aria-hidden>←</span> {backLabel}
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
      {/* 工具栏里的按钮不使用 .btn 的边框样式（见 admin.css 的 editor-toolbar 规则），
          它们是一条安静的凹槽里的轻动作，不该和发布按钮抢视觉重量。 */}
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
                title="选择本地图片或视频上传">上传</button>
        <button type="button" className="btn btn-sm" onClick={() => setPickerOpen(true)}>媒体库</button>
        <button type="button" className="btn btn-sm" onClick={() => { setVideoOpen((v) => !v); setErr(""); }}
                aria-expanded={videoOpen}
                title="插入 B 站 / YouTube 等平台视频">外链视频</button>
        {/* accept 同时列图片与视频：只写图片会让「上传视频」在选择框里根本看不到视频文件 */}
        <input ref={fileRef} type="file" multiple style={{ display: "none" }}
               accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic,image/heif,.heic,.heif,video/mp4,video/webm,.mp4,.webm"
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

          {dragOver ? <div className="notice">松开即可上传图片或视频</div> : null}

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
                           if (f) {
                             const r = await uploadFile(f);
                             // 封面必须是图片：视频传上来当 og:image 只会让分享卡片空白
                             if (r && r.kind === "image") { setCover(r.url); mark({ cover: r.url }); }
                             else if (r) setErr("封面只能是图片，视频请插进正文");
                           }
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

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(snippet) => { insert(snippet); }}
      />

      {/* 版本历史：恢复只改草稿，不改线上（方案 §6.4） */}
      <VersionPanel
        postId={initial?.id ?? 0}
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        /**
         * 必须用 api.identity（响应式），不能用 identityRef.current：
         * ref 变化不触发渲染，面板会一直拿着"打开那一刻"的版本号，
         * 期间只要自动保存过一次，点恢复就 409。
         */
        currentDraftRevision={api.identity?.draftRevision ?? 0}
        currentPostRevision={api.identity?.baseRevision ?? api.getBaseRevision()}
        clientDraftId={getClientDraftId()}
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
          /**
           * 恢复接口已经把服务端 draftRevision +1；本地身份必须同步，
           * 否则用户接着编辑时自动保存会拿旧版本号撞 409。
           * 重读一次草稿身份（而不是在本地 +1）—— 以服务端为准。
           */
          const pid = initial?.id;
          if (pid) {
            void (async () => {
              const r = await loadDraft(pid);
              if (r.ok && r.value.draft) {
                api.setIdentity(r.value.draft.identity);
                identityRef.current = r.value.draft.identity;
                autoResume(r.value.draft.snapshot);
              }
            })();
          }
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
          /**
           * 以服务端草稿为准：把内容替换掉，再让状态机继续。
           *
           * 必须同时把**服务端的草稿身份**装回去（重读一次而不是凭本地猜）：
           * 冲突往往意味着服务端 draftRevision 已经比我们手里的新，
           * 只替换正文而继续用旧版本号，下一次保存还会 409。
           */
          const serverContent = conflict?.serverDraft ?? "";
          setContent(serverContent);
          setConflict(null);
          void (async () => {
            const postId = identityRef.current?.postId ?? initial?.id;
            if (!postId) { autoResume(); return; }
            const res = await loadDraft(postId);
            if (res.ok) {
              if (res.value.draft) {
                api.setIdentity(res.value.draft.identity);
                identityRef.current = res.value.draft.identity;
              } else {
                api.setIdentity(null);
                identityRef.current = null;
              }
              autoResume(res.value.draft?.snapshot ?? undefined);
            } else {
              autoResume();
            }
          })();
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
              clientDraftId: getClientDraftId(),
              snapshot: snap,
              snapshotHash: hashSnapshot(canonicalize(snap)),
              expectedDraftRevision: identityRef.current?.draftRevision ?? 0,
              // 基线必须取引擎的最新值：发布/恢复之后 identityRef 可能是 null，
              // 而 initial.revision 是"打开页面时"的旧值。
              expectedPostRevision: api.getBaseRevision(),
            });
            if (r.ok) {
              /**
               * 必须走 api.setIdentity，而不是只写 identityRef。
               * rebase 之后服务端 draftRevision 已经变了；只改本地 ref 会让
               * 状态机继续拿旧版本号保存，下一次自动保存又 409 ——
               * 也就是"点了用我的版本覆盖，冲突仍在"。
               */
              api.setIdentity(r.value.identity);
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
