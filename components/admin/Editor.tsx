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
import { rebaseDraft as apiRebaseDraft } from "@/lib/draft-client";
import type { AutosaveState } from "@/lib/autosave";
import type { LocalDraft } from "@/lib/local-draft";
import type { Facet } from "@/lib/post-facets";
import { SaveStatus, ConflictDialog, RestoreBanner, type ConflictOption } from "./SaveStatus";
import { VersionPanel } from "./VersionPanel";
import { useAutosave } from "./useAutosave";
import { MediaPicker } from "./MediaPicker";
import { EditorToolbar } from "./EditorToolbar";
import { TokenField } from "./TokenField";
import { useScrollLock } from "@/components/ui/useScrollLock";
import {
  IconArrowLeft, IconArrowUpRight, IconCheck, IconChevronDown, IconClose, IconEye,
  IconFolder, IconGlobe, IconHistory, IconImage, IconImagePlus, IconMaximize, IconMessage,
  IconMinimize, IconPen, IconSettings, IconTrash, IconColumns,
} from "./editor-icons";

type Initial = {
  id?: number; type?: string; title?: string; slug?: string; content?: string;
  /** 自定义摘要（可选）；为空时发布/卡片展示自动截取正文开头 */
  excerpt?: string;
  status?: string; categories?: string[]; tags?: string[]; cover?: string | null; published_at?: string | null;
  comments_enabled?: number;
  /** posts.revision：草稿基线与并发校验的起点（方案 §3.1） */
  revision?: number;
};

/** 三种视图：编辑 / 分屏 / 预览 */
type ViewMode = "edit" | "split" | "preview";

const VIEW_STORAGE_KEY = "editor:view-mode";
const RAIL_STORAGE_KEY = "editor:rail-open";

const VIEW_ITEMS: { key: ViewMode; label: string; icon: React.ReactNode }[] = [
  { key: "edit", label: "编辑", icon: <IconPen size={15} /> },
  { key: "split", label: "分屏", icon: <IconColumns size={15} /> },
  { key: "preview", label: "预览", icon: <IconEye size={15} /> },
];

const AUTOSAVE_SHORT: Record<AutosaveState, string> = {
  idle: "无未保存改动",
  dirty: "有改动待保存",
  queued: "保存中…",
  saving: "保存中…",
  saved: "已保存",
  conflict: "保存冲突",
  unknown: "保存结果未知",
  failed: "保存失败",
};

function timeOf(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * 写作工作台（Editorial Studio）。
 *
 * 这一版把「表单 + 属性栏」改成「纸张 + 编辑部操作条」：
 *   1. 顶部只有一层操作条：返回 · 文档名 · 保存状态 · 视图 · 专注 · 设置 · 存草稿 · 发布。
 *      不再有 PageHeader 的第二个大标题压在文章标题上面。
 *   2. 中央是唯一的视觉主体：标题 → 摘要 → 工具栏 → 正文，正文列最大 820px，
 *      两侧留白随视口伸缩（不是固定宽度居中后两边一大片空）。
 *   3. 右侧「文章设置」按内容归档 / 封面与摘要 / 发布选项三组组织，
 *      去掉卡片嵌套，只用组标题 + 细分隔线 + 留白。
 *   4. 窄屏时右栏变抽屉，编辑器始终是单栏；不挤压正文。
 *
 * 数据与流程（自动保存、草稿协议、冲突、版本、封面/媒体上传、发布）全部沿用
 * 原有实现，本次只改壳与交互入口 —— 这条边界是刻意的：改版不应重写文章系统。
 */
export function Editor({ initial, mode, initialType, facets }: {
  initial?: Initial; mode: "new" | "edit";
  /** 新建时的默认类型（由 /admin/new?type=… 决定），已有内容仍以 initial.type 为准 */
  initialType?: "post" | "page" | "shuoshuo";
  /** 站内已有的分类 / 标签候选（服务端读取，绝不在前端硬编码） */
  facets?: { categories: Facet[]; tags: Facet[] };
}) {
  const [type, setType] = useState(initial?.type || initialType || "post");
  const [title, setTitle] = useState(initial?.title || "");
  const [slug, setSlug] = useState(initial?.slug || "");
  const [content, setContent] = useState(initial?.content || "");
  const [excerpt, setExcerpt] = useState(initial?.excerpt || "");
  const [cats, setCats] = useState<string[]>(initial?.categories || []);
  const [tags, setTags] = useState<string[]>(initial?.tags || []);
  const [status, setStatus] = useState(initial?.status || "draft");
  const [cover, setCover] = useState<string | null>(initial?.cover ?? null);
  const [commentsEnabled, setCommentsEnabled] = useState<boolean>((initial?.comments_enabled ?? 1) !== 0);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [previewHtml, setPreviewHtml] = useState("");
  const [dragOver, setDragOver] = useState(false);
  /** 专注写作：隐藏左导航与右栏，只留标题 / 工具栏 / 正文 */
  const [focus, setFocus] = useState(false);
  /** 右栏开合（桌面折叠 / 窄屏抽屉） */
  const [railOpen, setRailOpen] = useState(true);
  /* 视频外链：点工具栏「视频」展开的输入面板（不做自托管，见 lib/video-embed.ts 的说明） */
  const [videoOpen, setVideoOpen] = useState(false);
  /* 从媒体库插入：复用已上传的资源，不必重传一份 */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [videoInput, setVideoInput] = useState("");

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const excerptRef = useRef<HTMLInputElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const deferredContent = useDeferredValue(content);

  const categorySuggestions = facets?.categories ?? [];
  const tagSuggestions = facets?.tags ?? [];

  /**
   * 草稿身份（方案 §4.3）。
   *
   * clientDraftId **只有一份**，住在 useAutosave 里，通过 getClientDraftId() 取。
   * identityRef 只作只读镜像，写入必须经过 api.setIdentity / api.afterPublish。
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
   * 而 const 箭头函数此时还在 TDZ 里 —— 那样会在"真的发生冲突"这一天才崩。
   */
  async function openConflict(sentSnapshot: Snapshot | null): Promise<void> {
    const postId = api.getIdentity()?.postId ?? initial?.id;
    if (!postId) return;
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
    type: "post", title: "", slug: "", content: "", excerpt: "", cover: null,
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

  const { mark: autoMark, saveNow: autoSaveNow, resume: autoResume, setIdentity, getClientDraftId } = api;

  /**
   * 标记改动并驱动自动保存。
   *
   * 参数 `override` 是**本次输入后的最新值**。
   * 为什么必须传：React 的 setState 是异步的，`mark()` 执行时
   * 闭包里的 title/content 还是上一次渲染的值。若在这里读闭包，
   * 自动保存就会把"上一个字"的版本发上去 —— 表现为"保存成功但内容是旧的"。
   */
  const mark = useCallback((override?: Partial<Snapshot>) => {
    autoMark(override);
  }, [autoMark]);

  /* ---------------- 服务端草稿：打开已有文章时加载 ---------------- */
  /**
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
        identityRef.current = d.identity;
        setIdentity(d.identity);
        const s = d.snapshot;
        setType(s.type);
        setTitle(s.title);
        setSlug(s.slug);
        setContent(s.content);
        setExcerpt(s.excerpt ?? "");
        setCover(s.cover);
        setCats(s.categories);
        setTags(s.tags);
        setCommentsEnabled(s.comments_enabled !== 0);
        setMsg("已载入上次未发布的草稿");
      }
    })();
    return () => { cancelled = true; };
  }, [mode, initial?.id]);

  /* ---------------- 视图与面板偏好的本地记忆 ---------------- */
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_STORAGE_KEY);
      if (v === "edit" || v === "split" || v === "preview") setViewMode(v);
      const r = localStorage.getItem(RAIL_STORAGE_KEY);
      if (r === "0") setRailOpen(false);
    } catch {
      /* 隐私模式下读不到就用默认值，不影响功能 */
    }
  }, []);

  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  useEffect(() => {
    try { localStorage.setItem(RAIL_STORAGE_KEY, railOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [railOpen]);

  /**
   * 专注模式只改「壳」：给 body 挂一个类，隐藏左侧导航与页面留白。
   * 用 body 而不是组件内部类，因为侧栏在 AdminShell 里、在 Editor 之外。
   * 卸载时一定摘掉 —— 否则下一次进入别的后台页面会没有侧栏。
   */
  useEffect(() => {
    document.body.classList.toggle("editor-focus-mode", focus);
    return () => { document.body.classList.remove("editor-focus-mode"); };
  }, [focus]);

  /** Esc 退出专注模式。若有对话框打开（媒体库 / 版本 / 冲突），交给对话框处理。 */
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".dialog-mask, .version-panel, .conflict-dialog")) return;
      setFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  /** 测量顶栏高度给 sticky 工具栏用：顶栏在窄屏会换成两行，写死数值必错位 */
  useEffect(() => {
    const chrome = chromeRef.current;
    const box = workbenchRef.current;
    if (!chrome || !box) return;
    const sync = () => box.style.setProperty("--editor-chrome-h", chrome.offsetHeight + "px");
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(chrome);
    return () => ro.disconnect();
  }, []);

  /** 窄屏（≤960px）：右栏是抽屉，与 CSS 断点保持一致 —— 断点不一致会出现
   *  "960–1080 之间右栏看着是栏、JS 却按抽屉锁了滚动"的双重语义。 */
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1199px)");
    const sync = () => {
      setNarrow(mq.matches);
      // 进入窄屏时把抽屉收起来：默认打开会一进页面就被设置面板盖住正文
      if (mq.matches) setRailOpen(false);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  useScrollLock(narrow && railOpen && !focus);

  /**
   * 窄屏抽屉：Esc 关闭、打开时把焦点送进面板。
   * 键盘用户打开设置后，焦点若留在操作条上，Tab 会一路穿过正文才到面板 ——
   * 抽屉在视觉上浮在最上层，焦点顺序却还在下面，等于"看得见摸不着"。
   */
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!narrow || !railOpen || focus) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setRailOpen(false); };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      railRef.current?.querySelector<HTMLElement>(".editor-rail-head button")?.focus();
    }, 40);
    return () => { clearTimeout(t); document.removeEventListener("keydown", onKey); };
  }, [narrow, railOpen, focus]);

  /* ---------------- 预览（防抖） ---------------- */
  useEffect(() => {
    if (viewMode === "edit") return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/preview", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: deferredContent }),
        });
        const d = await res.json().catch(() => ({ html: "" }));
        if (alive) setPreviewHtml(d.html || "");
      } catch {
        if (alive) setPreviewHtml("");
      }
    }, 320);
    return () => { alive = false; clearTimeout(t); };
  }, [deferredContent, viewMode]);

  /**
   * 正文高度跟随内容：让"纸"随段落一起变长，页面整体滚动。
   *
   * 为什么不用 CSS `field-sizing: content`：它目前只在 Chromium 系可用，
   * Safari 上会让正文永远停在 min-height（写到第三段就被一条内部滚动条困住）。
   * 这里读一次 scrollHeight 是同步布局，但每次击键只有一次，代价可接受；
   * 分屏模式下清掉内联高度，交给 CSS 的定高 + overflow 处理（那才有滚动同步）。
   */
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (viewMode === "split") {
      ta.style.height = "";
      return;
    }
    const grow = () => {
      ta.style.height = "auto";
      // box-sizing 是 border-box：scrollHeight 不含上下边框，直接赋给它会让
      // 内容区比文字矮 2px，底部压出一行看不见的滚动。把边框补回去。
      const borders = ta.offsetHeight - ta.clientHeight;
      ta.style.height = ta.scrollHeight + borders + "px";
    };
    const raf = requestAnimationFrame(grow);
    /**
     * 窗口变窄会让同样的文字多折几行、变高 —— 高度是按 px 写死的，
     * 不重算就会出现"底部几行被裁掉、内部又不能滚"。ResizeObserver 覆盖
     * 窗口缩放、侧栏折叠、右栏开合这三条会改变正文宽度的路径。
     */
    // 观察**外层**而不是 textarea 自己：grow 会改它自己的高度，
    // 观察自身会在"设 auto → 量 scrollHeight → 设回 px"之间来回触发，
    // 形成 ResizeObserver 循环（控制台会刷 loop 警告，长文尤其明显）。
    const ro = new ResizeObserver(grow);
    if (ta.parentElement) ro.observe(ta.parentElement);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [content, viewMode]);

  /* ---------------- 插入 / 上传 ---------------- */
  const insert = useCallback((text: string, wrap = false, after?: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = content.slice(s, e);
    const tail = after ?? (wrap ? text : "");
    const next = content.slice(0, s) + text + sel + tail + content.slice(e);
    setContent(next);
    mark({ content: next });
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + text.length + sel.length;
    });
  }, [content, mark]);

  /** 工具栏的统一入口：有选区包住它，没有选区就插语法并留空位 */
  const toolInsert = useCallback((before: string, after?: string) => {
    insert(before, false, after);
  }, [insert]);

  /**
   * 上传单张图。
   *
   * 关键点：先把文件在浏览器里过一遍（lib/image-convert）——
   *   · HEIC/HEIF（iPhone 默认格式）服务端认不出 magic bytes，必须转码
   *   · 超过 8MB 或长边 2560px 的图会被缩 + 重编码，顺带剥掉 EXIF/GPS
   * 服务端的安全校验完全不依赖这段逻辑（它只看 magic bytes），所以绕过也没用。
   */
  const uploadFile = useCallback(async (raw: File): Promise<{ url: string; kind: MediaKind } | null> => {
    const isVideoFile = (raw.type || "").startsWith("video/");
    let file = raw;
    if (!isVideoFile) {
      const prepared = await prepareForUpload(raw);
      file = prepared.file;
      if (prepared.note) setMsg(prepared.note);
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
   * HEIC / 某些视频的 type 是空串，只看 MIME 会把合法文件静默丢掉。
   */
  const uploadAndInsert = useCallback(async (files: File[]) => {
    setErr("");
    const isMediaLike = (f: File) => {
      const t = (f.type || "").toLowerCase();
      if (t.startsWith("image/") || t.startsWith("video/")) return true;
      if (isHeic(f.name, f.type)) return true;
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
      setMsg("已插入 " + parts.join("、") + (skipped ? "（跳过 " + skipped + " 个不支持的文件）" : ""));
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
   * 插入视频（外链）。
   *
   * 走外链而非上传 —— 这台机器出口带宽只有 400~700KB/s 且并行不叠加，
   * 自托管视频会让每个访客等几十秒。视频由平台托管，本站零带宽零磁盘。
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

  /* ---------------- 保存 ---------------- */
  const buildSnapshot = useCallback((): Snapshot => ({
    type: type as Snapshot["type"],
    title,
    slug,
    content,
    excerpt,
    cover,
    categories: cats,
    tags,
    comments_enabled: commentsEnabled ? 1 : 0,
  }), [type, title, slug, content, excerpt, cover, cats, tags, commentsEnabled]);

  // 每次渲染都把最新的构造器放进 ref：状态机的定时器回调据此取当前内容
  snapshotRef.current = buildSnapshot;

  /**
   * 同步的提交闸门。
   *
   * 只靠 `busy` state 不够：React 的 setState 是异步的，同一帧里的两次点击
   * 都读到 busy=false，会各自发出一次保存 + 一次发布。发布本身有
   * publishRequestId 幂等兜底，但保存会白白多打一次请求、版本号也可能错位。
   * ref 是同步的，第二次点击必然被拦下。
   */
  const submittingRef = useRef(false);

  const save = useCallback(async (nextStatus?: string) => {
    const publish = nextStatus === "published";
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true); setErr(""); setMsg("");

    const snapshot = buildSnapshot();

    /**
     * 保存走**自动保存引擎**，而不是这里再拼一次请求 —— 版本号只有一份，
     * 否则「点按钮保存」与「等 1.5 秒自动保存」会走不同身份，必然 409。
     */
    const saved = await api.saveSnapshotNow(snapshot);
    identityRef.current = api.getIdentity();

    if (!saved || saved.kind !== "ok") {
      submittingRef.current = false;
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

    const savedPostId = saved.identity.postId;

    if (!publish) {
      submittingRef.current = false;
      setBusy(false);
      /**
       * 存草稿**不改变发布状态**。只有从未发布过的文章才是 draft。
       */
      if (status !== "published") setStatus("draft");
      setMsg("草稿已保存");
      if (!initial?.id) {
        try { router.replace("/admin/edit/" + savedPostId); } catch { /* ignore */ }
      }
      router.refresh();
      return;
    }

    /**
     * 发布：用**这次保存返回的**身份，而不是外面再读一次 identityRef。
     * 新文章第一次点「发布」时，上一步才刚把 postId 建出来。
     */
    const requestId = newRequestId();
    const pub = await apiPublishDraft({
      postId: savedPostId,
      publishRequestId: requestId,
      expectedPostRevision: saved.identity.baseRevision,
      expectedDraftRevision: saved.identity.draftRevision,
      slug: slug || undefined,
    });

    submittingRef.current = false;
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
     * 必须把这两件事一起同步给状态机 —— 否则"发布完再改一个字"会立刻 409。
     */
    api.afterPublish(pub.value.revision);
    identityRef.current = null;
    router.refresh();
  }, [api, buildSnapshot, busy, initial?.id, router, slug, status]);

  /* ---------------- 快捷键 ---------------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === "s") { e.preventDefault(); void save(); }
      else if (e.key === "b" || e.key === "i") {
        const ta = taRef.current;
        if (document.activeElement === ta) {
          e.preventDefault();
          insert(e.key === "b" ? "**" : "*", true);
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save, insert]);

  /* ---------------- 分屏滚动同步 ----------------
   * 只在两边都真的滚动时按比例对齐；任一侧触顶/触底就停，避免互相拉扯。
   * 用 ref 标记 120ms 内谁在驱动，防止 A→B→A 的反馈循环。
   */
  const syncLock = useRef(0);
  const syncScroll = (from: "ta" | "preview") => {
    const ta = taRef.current, pv = previewRef.current;
    if (!ta || !pv) return;
    const now = Date.now();
    if (now < syncLock.current) return;
    syncLock.current = now + 120;
    const src = from === "ta" ? ta : pv;
    const dst = from === "ta" ? pv : ta;
    const srcRange = src.scrollHeight - src.clientHeight;
    const dstRange = dst.scrollHeight - dst.clientHeight;
    if (srcRange <= 0 || dstRange <= 0) return;
    dst.scrollTop = (src.scrollTop / srcRange) * dstRange;
  };

  const isShuo = type === "shuoshuo";
  const chars = content.replace(/\s/g, "").length;
  /**
   * 「返回」回到这一类内容自己的列表，而不是永远回文章列表。
   * 从说说明细页点返回却落在文章列表，用户会以为刚才那一条没了。
   */
  const backHref = type === "shuoshuo" ? "/admin/shuoshuo" : type === "page" ? "/admin/pages" : "/admin";
  const backLabel = type === "shuoshuo" ? "说说" : type === "page" ? "页面" : "文章";
  const docName = title.trim() || "未命名草稿";
  const saveShort = AUTOSAVE_SHORT[autoState];
  const saveTime = savedAtIso ? timeOf(savedAtIso) : "";

  const statusText = status === "published"
    ? (autoState !== "idle" && autoState !== "saved" ? "已发布 · 有未发布改动" : "已发布")
    : "草稿 · 尚未发布";

  const publishLabel = busy
    ? "处理中…"
    : status === "published"
      ? "更新文章"
      : "发布文章";

  return (
    <div
      ref={workbenchRef}
      className="editor-workbench"
      data-focus={focus ? "true" : "false"}
      data-mode={viewMode}
      data-rail={railOpen ? "open" : "closed"}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* ══ 第一层：页面操作条（唯一的一条 top bar） ══ */}
      <div className="editor-chrome" ref={chromeRef}>
        <div className="editor-chrome-row">
          <Link href={backHref} className="editor-back" aria-label={"返回" + backLabel}>
            <IconArrowLeft size={15} />
            <span>{backLabel}</span>
          </Link>
          <span className="editor-crumb-sep" aria-hidden>/</span>
          <span className="editor-doc-name" title={docName}>{docName}</span>

          {/* 自动保存状态：失败/冲突要能直接看见，其他情况下安静 */}
          <span
            className="editor-save-compact"
            data-tone={autoState === "failed" ? "danger" : autoState === "conflict" ? "warn" : autoState === "saved" ? "ok" : "neutral"}
            role="status"
            aria-live="polite"
          >
            <span className="editor-save-dot" aria-hidden />
            {saveShort}
            {saveTime && autoState === "saved" ? " · " + saveTime : ""}
          </span>
          {/* 保存失败时就地给重试：让用户不必打开设置栏才能自救 */}
          {autoState === "failed" || autoState === "unknown" ? (
            <button type="button" className="editor-retry-btn" onClick={() => autoSaveNow()}>
              重试
            </button>
          ) : null}

          <span className="editor-chrome-fill" />

          <div className="editor-view-switch" role="group" aria-label="编辑视图">
            {VIEW_ITEMS.map((v) => (
              <button
                key={v.key}
                type="button"
                className={"editor-view-btn" + (viewMode === v.key ? " is-active" : "")}
                aria-pressed={viewMode === v.key}
                aria-label={v.label + "模式"}
                onClick={() => setViewMode(v.key)}
                title={v.label + "模式"}
              >
                {v.icon}
                <span>{v.label}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            className={"editor-icon-btn" + (focus ? " is-active" : "")}
            aria-pressed={focus}
            aria-label={focus ? "退出专注模式（Esc）" : "专注写作模式"}
            title={focus ? "退出专注模式（Esc）" : "专注写作模式"}
            onClick={() => setFocus(!focus)}
          >
            {focus ? <IconMinimize size={17} /> : <IconMaximize size={17} />}
          </button>

          {/* 专注模式下右栏本来就不存在，设置开关一并藏起来，避免按了没反应 */}
          {!focus ? (
            <button
              type="button"
              className={"editor-icon-btn" + (railOpen ? " is-active" : "")}
              aria-pressed={railOpen}
              aria-controls="editor-rail"
              aria-label={railOpen ? "收合文章设置" : "展开文章设置"}
              title={railOpen ? "收合文章设置" : "展开文章设置"}
              onClick={() => setRailOpen(!railOpen)}
            >
              <IconSettings size={17} />
            </button>
          ) : null}

          <button type="button" className="btn btn-sm editor-btn-draft" disabled={busy} onClick={() => save("draft")}>
            保存草稿
          </button>
          <button type="button" className="btn btn-sm btn-primary editor-btn-publish" disabled={busy} onClick={() => save("published")}>
            {publishLabel}
            {!busy ? <IconArrowUpRight size={15} /> : null}
          </button>
        </div>
      </div>

      {/* 成功类提示走一条安静的行内状态，不铺满一屏绿色横幅 ——
          写作时它只是"刚才那一下生效了"，不是需要阅读的公告。 */}
      {msg ? (
        <p className="editor-flash" role="status" aria-live="polite">
          <IconCheck size={13} /> {msg}
        </p>
      ) : null}
      {err ? <div className="notice notice-error editor-notice" role="alert">{err}</div> : null}

      {/* 本地可恢复草稿：显示保存时间，否则用户不知道该不该信它（方案 §8.3） */}
      {restoreInfo ? (
        <RestoreBanner
          title={String((restoreInfo.snapshot as Record<string, unknown>)?.title ?? "")}
          savedAt={restoreInfo.savedAt}
          onRestore={() => {
            const s2 = restoreInfo.snapshot as Snapshot;
            setType(s2.type); setTitle(s2.title); setSlug(s2.slug); setContent(s2.content);
            setExcerpt(s2.excerpt ?? "");
            setCover(s2.cover); setCats(s2.categories); setTags(s2.tags);
            setCommentsEnabled(s2.comments_enabled !== 0);
            autoMark(s2);
            setRestoreInfo(null);
          }}
          onDiscard={() => {
            api.clearLocal(restoreInfo.clientDraftId, restoreInfo.postId);
            setRestoreInfo(null);
          }}
        />
      ) : null}

      <div className="editor-body">
        {/* ══ 第二层：写作区 ══ */}
        <main className="editor-canvas" aria-label="文章编辑区">
          <div className="editor-article">
            <div className="editor-headline">
              {!isShuo ? (
                <label className="editor-title-field">
                  <span className="sr-only">文章标题</span>
                  <input
                    className="editor-title-input"
                    value={title}
                    onChange={(e) => { setTitle(e.target.value); mark({ title: e.target.value }); }}
                    placeholder="文章标题"
                    aria-label="文章标题"
                  />
                </label>
              ) : null}

              {!isShuo ? (
                <input
                  ref={excerptRef}
                  id="editor-excerpt"
                  className="editor-subtitle-input"
                  value={excerpt}
                  maxLength={300}
                  onChange={(e) => { setExcerpt(e.target.value); mark({ excerpt: e.target.value }); }}
                  placeholder="一句摘要，显示在文章卡片与分享预览里（可选）"
                  aria-label="文章摘要（可选）"
                />
              ) : null}

              <div className="editor-byline">
                <span>{type === "shuoshuo" ? "说说" : type === "page" ? "页面" : "文章"}</span>
                <span aria-hidden>·</span>
                <span>{statusText}</span>
                <span aria-hidden>·</span>
                <span className="editor-byline-count">{chars} 字</span>
                {uploading ? <><span aria-hidden>·</span><span>上传中 {uploading}</span></> : null}
              </div>
            </div>

            {/* 工具栏：吸顶但不与顶栏叠加（top 用实测的 chrome 高度） */}
            <EditorToolbar
              onInsert={toolInsert}
              onPickFile={() => fileRef.current?.click()}
              onOpenMedia={() => setPickerOpen(true)}
              onToggleVideo={() => { setVideoOpen((v) => !v); setErr(""); }}
              videoOpen={videoOpen}
            />

            {/* accept 同时列图片与视频：只写图片会让「上传视频」在选择框里根本看不到视频文件 */}
            <input ref={fileRef} type="file" multiple style={{ display: "none" }}
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic,image/heif,.heic,.heif,video/mp4,video/webm,.mp4,.webm"
              onChange={(e) => { const fs2 = Array.from(e.target.files ?? []); if (fs2.length) void uploadAndInsert(fs2); e.target.value = ""; }} />

            {videoOpen ? (
              <div className="editor-video">
                <div className="editor-video-head">
                  <label htmlFor="editor-video-url">外链视频</label>
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

            {dragOver ? <div className="notice editor-drop-hint">松开即可上传图片或视频</div> : null}

            {/* 正文：编辑 / 分屏 / 预览。
                textarea **始终挂载**：预览模式下只是 CSS 隐藏，节点不销毁。
                React 一旦卸载 textarea，原生撤销栈、光标、选区与滚动位置全部丢失 ——
                用户切去看一眼预览再切回来，Cmd+Z 就撤不回去了。 */}
            <div className="editor-sheet">
              <textarea
                ref={taRef}
                className="textarea editor-textarea"
                data-hidden={viewMode === "preview" ? "true" : undefined}
                value={content}
                onChange={(e) => { setContent(e.target.value); mark({ content: e.target.value }); }}
                onPaste={onPaste}
                onScroll={viewMode === "split" ? () => syncScroll("ta") : undefined}
                placeholder={isShuo
                  ? "写点什么…（可直接粘贴图片）"
                  : "正文从这里开始。支持 Markdown，可直接粘贴或拖入图片。"}
                aria-label="正文（Markdown）"
                spellCheck={false}
              />

              {viewMode !== "edit" ? (
                /* 滚动容器是 pane 本身（不是里面的 .prose）：滚动同步必须监听真正
                   在滚的那个节点，否则 onScroll 永远不触发，同步是"看起来写了"的死代码。 */
                <div
                  ref={previewRef}
                  className="editor-preview-pane"
                  onScroll={viewMode === "split" ? () => syncScroll("preview") : undefined}
                >
                  <div className="editor-preview-head" aria-hidden>
                    <IconEye size={14} /> 预览
                  </div>
                  {!isShuo && title.trim() ? <h1 className="editor-preview-title">{title}</h1> : null}
                  {!isShuo && excerpt.trim() ? <p className="editor-preview-excerpt">{excerpt}</p> : null}
                  <div
                    className="prose editor-preview"
                    // 预览来自已鉴权的 /api/preview（服务端统一 Markdown 渲染，与前台同一套）
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                  {!previewHtml ? (
                    <p className="editor-preview-empty">正文还是空的。开始写，这里会实时出现渲染结果。</p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="editor-foot">
              <span className="editor-foot-hint">
                {viewMode === "preview"
                  ? "预览模式 · 正文不参与编辑"
                  : "Markdown · 支持图片粘贴与拖拽"}
              </span>
            </div>
          </div>
        </main>

        {/* ══ 第三层：文章设置（右栏，窄屏抽屉） ══ */}
        {narrow && railOpen && !focus ? (
          <button
            type="button"
            className="editor-rail-scrim"
            aria-label="关闭文章设置"
            onClick={() => setRailOpen(false)}
          />
        ) : null}

        <aside
          ref={railRef}
          id="editor-rail"
          className="editor-rail"
          aria-label="文章设置"
          aria-hidden={!railOpen && narrow ? true : undefined}
        >
          <div className="editor-rail-head">
            <h2>文章设置</h2>
            <button type="button" className="editor-icon-btn" aria-label="关闭文章设置" onClick={() => setRailOpen(false)}>
              <IconClose size={16} />
            </button>
          </div>

          <div className="editor-rail-scroll">
            {/* ── A. 内容归档 ── */}
            <section className="editor-group" aria-labelledby="group-archive">
              <h3 className="editor-group-title" id="group-archive">
                <IconFolder size={16} /> 内容归档
              </h3>

              {/* 类型在新建与编辑时都可改：这是既有能力（拆路由后仍保留），
                  但放在设置栏而不是顶栏 —— 它是一篇内容的归档属性，不是高频动作。 */}
              <div className="editor-field">
                <label className="editor-field-label" htmlFor="editor-type">内容类型</label>
                <div className="editor-select">
                  <select
                    id="editor-type"
                    className="input"
                    value={type}
                    aria-label="内容类型"
                    onChange={(e) => { setType(e.target.value); mark({ type: e.target.value as Snapshot["type"] }); }}
                  >
                    <option value="post">文章</option>
                    <option value="page">页面</option>
                    <option value="shuoshuo">说说</option>
                  </select>
                  <IconChevronDown size={14} />
                </div>
              </div>

              {!isShuo ? (
                <>
                  <TokenField
                    id="editor-cats"
                    label="分类"
                    values={cats}
                    suggestions={categorySuggestions}
                    placeholder={cats.length ? "继续添加分类" : "添加或选择分类"}
                    hint="回车创建，退格删除最后一个；分类用于归档浏览。"
                    onChange={(next) => { setCats(next); mark({ categories: next }); }}
                  />

                  <TokenField
                    id="editor-tags"
                    label="标签"
                    values={tags}
                    suggestions={tagSuggestions}
                    placeholder={tags.length ? "继续添加标签" : "添加或选择标签"}
                    hint="标签会出现在标签云与相关文章里。"
                    onChange={(next) => { setTags(next); mark({ tags: next }); }}
                  />

                  {mode === "edit" ? (
                    <div className="editor-field">
                      <label className="editor-field-label" htmlFor="editor-slug">URL 路径</label>
                      <input
                        id="editor-slug"
                        className="input"
                        value={slug}
                        onChange={(e) => { setSlug(e.target.value); mark({ slug: e.target.value }); }}
                      />
                      <span className="editor-field-hint">改动会自动为旧地址保留 301 跳转。</span>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="editor-group-note">
                  说说没有标题与归档信息，正文就是它的全部内容。
                </p>
              )}
            </section>

            {/* ── B. 封面与摘要 ── */}
            {!isShuo ? (
              <section className="editor-group" aria-labelledby="group-cover">
                <h3 className="editor-group-title" id="group-cover">
                  <IconImage size={16} /> 封面与摘要
                </h3>

                <div className="editor-field">
                  <span className="editor-field-label">封面图</span>
                  <div className={"editor-cover" + (cover ? " has-image" : "")}>
                    {cover ? (
                      <a className="editor-cover-frame" href={cover} target="_blank" rel="noreferrer" title="在新标签页查看原图">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={cover} alt="封面预览" />
                        <span className="editor-cover-zoom" aria-hidden>查看</span>
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="editor-cover-frame is-empty"
                        onClick={() => coverRef.current?.click()}
                        aria-label="选择封面图片"
                      >
                        <IconImagePlus size={22} />
                        <span className="editor-cover-empty-hint">选择或上传封面</span>
                      </button>
                    )}
                    <div className="editor-cover-actions">
                      <button type="button" className="btn btn-sm" onClick={() => coverRef.current?.click()}>
                        {cover ? "更换封面" : "选择封面"}
                      </button>
                      {cover ? (
                        <button type="button" className="btn btn-sm btn-ghost"
                          onClick={() => { setCover(null); mark({ cover: null }); }}>
                          <IconTrash size={14} /> 移除
                        </button>
                      ) : null}
                      <span className="editor-field-hint">建议比例 16:9，用于文章卡片与社交分享。</span>
                    </div>
                  </div>
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
                </div>

                <div className="editor-field">
                  <span className="editor-field-label">文章摘要</span>
                  <p className="editor-summary-preview">
                    {excerpt.trim() ? excerpt : "留空时自动提取正文开头作为摘要。"}
                  </p>
                  <button
                    type="button"
                    className="btn btn-sm editor-summary-edit"
                    onClick={() => {
                      if (narrow) setRailOpen(false);
                      requestAnimationFrame(() => excerptRef.current?.focus());
                    }}
                  >
                    在正文上方编辑摘要
                  </button>
                  <span className="editor-field-hint">
                    摘要用于文章卡片与分享预览；正文里的第一段不一定是读者最先看到的那句话。
                  </span>
                </div>
              </section>
            ) : null}

            {/* ── C. 发布选项 ── */}
            <section className="editor-group" aria-labelledby="group-publish">
              <h3 className="editor-group-title" id="group-publish">
                <IconGlobe size={16} /> 发布选项
              </h3>

              <label className="editor-switch">
                <span className="editor-switch-copy">
                  <b><IconMessage size={14} /> 允许评论</b>
                  <em>关闭后文章不显示评论区</em>
                </span>
                <span className="editor-switch-control">
                  <input type="checkbox" checked={commentsEnabled}
                    onChange={(ev) => { setCommentsEnabled(ev.target.checked); mark({ comments_enabled: ev.target.checked ? 1 : 0 }); }} />
                  <span className="editor-switch-track" aria-hidden><span /></span>
                </span>
              </label>

              <div className="editor-status">
                <span className="editor-field-label">文章状态</span>
                <span className={"fx-state " + (status === "published" ? "is-published" : "is-draft")}>
                  {status === "published" ? "已发布" : "草稿"}
                </span>
                <span className="editor-field-hint">
                  {status === "published"
                    ? "线上读者可见。存草稿只影响草稿，点「更新文章」才推送。"
                    : "尚未发布，线上不可见。点「发布文章」才对外可见。"}
                </span>
              </div>

              {/* 双状态：草稿状态与线上版本分开显示（方案 §9.2） */}
              <SaveStatus
                state={autoState}
                savedAt={savedAtIso}
                publishedAt={initial?.published_at ?? (status === "published" ? savedAtIso : null)}
                hasUnpublishedChanges={autoState !== "idle" && autoState !== "saved"}
                localUnavailable={localUnavailable}
                message={autoMsg}
                onRetry={() => { autoSaveNow(); }}
              />

              {initial?.id ? (
                <button type="button" className="btn btn-sm editor-history-btn" disabled={busy} onClick={() => setVersionOpen(true)}>
                  <IconHistory size={14} /> 版本历史
                </button>
              ) : null}

              <p className="editor-kbd-hint">Cmd / Ctrl + S 保存 · Esc 退出专注模式</p>
            </section>
          </div>
        </aside>
      </div>

      {/* 手机端底部操作条：发布永远在拇指可及的位置，并避让 Home Bar。
          桌面上这条不渲染（display:none），顶栏的两个按钮就是唯一入口。 */}
      <div className="editor-mobile-actions" role="group" aria-label="文章操作">
        {focus ? (
          // 专注模式下顶栏会随滚动离开视口；退出入口必须常驻在拇指区
          <button type="button" className="editor-mobile-rail-btn" onClick={() => setFocus(false)}>
            <IconMinimize size={16} />
            退出专注
          </button>
        ) : (
          <button
            type="button"
            className="editor-mobile-rail-btn"
            aria-expanded={railOpen}
            aria-controls="editor-rail"
            onClick={() => setRailOpen(true)}
          >
            <IconSettings size={16} />
            文章设置
          </button>
        )}
        <span className="editor-mobile-fill" />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save("draft")}>
          保存草稿
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => save("published")}>
          {busy ? "处理中…" : status === "published" ? "更新文章" : "发布文章"}
          {!busy ? <IconArrowUpRight size={15} /> : null}
        </button>
      </div>

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
        currentDraftRevision={api.identity?.draftRevision ?? 0}
        currentPostRevision={api.identity?.baseRevision ?? api.getBaseRevision()}
        clientDraftId={getClientDraftId()}
        onRestored={(snap) => {
          setType(snap.type ?? type);
          setTitle(String(snap.title ?? ""));
          setSlug(String(snap.slug ?? ""));
          setContent(String(snap.content ?? ""));
          setExcerpt(snap.excerpt ?? "");
          setCover(snap.cover ?? null);
          setCats(snap.categories ?? []);
          setTags(snap.tags ?? []);
          setCommentsEnabled(snap.comments_enabled !== 0);
          setMsg("已把所选版本恢复为草稿，发布后才会更新前台");
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
              expectedPostRevision: api.getBaseRevision(),
            });
            if (r.ok) {
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
