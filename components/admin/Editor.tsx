"use client";
import { useCallback, useEffect, useRef, useState, useDeferredValue } from "react";
import { useRouter } from "next/navigation";
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

  /* ---------------- 自动保存（阶段 03.2） ---------------- */
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

  /** 本地存储：只在浏览器里可用；SSR 期间给一个空实现避免崩 */
  const localStoreRef = useRef(
    typeof window === "undefined"
      ? null
      : createLocalStore(window.localStorage)
  );

  /**
   * 用 ref 保存"最新快照的构造方式"，供状态机回调读取。
   *
   * 为什么不用 state：状态机的 persistLocal/save 回调在定时器里执行，
   * 闭包捕获的 state 会是旧值（经典的 stale closure）。用 ref 拿最新值，
   * 才能保证"存下去的永远是用户此刻看到的内容"。
   */
  const snapshotBuilderRef = useRef<() => Snapshot>(() => ({
    type: "post", title: "", slug: "", content: "", cover: null,
    categories: [], tags: [], comments_enabled: 1,
  }));

  const engineRef = useRef<AutosaveEngine | null>(null);

  if (!engineRef.current && typeof window !== "undefined") {
    engineRef.current = new AutosaveEngine({
      save: async (snapshot, identity) => {
        const snap = snapshot as Snapshot;
        const outcome = await autosaveOnce({
          postId: identity?.postId ?? initial?.id,
          clientDraftId: clientDraftIdRef.current,
          snapshot: snap,
          snapshotHash: hashSnapshot(canonicalize(snap)),
          expectedPostRevision: identity?.baseRevision ?? initial?.revision ?? 1,
          expectedDraftRevision: identity?.draftRevision ?? 0,
        });
        if (outcome.kind === "ok") {
          identityRef.current = outcome.identity;
          setSavedAtIso(new Date().toISOString());
          // 新文章首次保存后接管 URL，后续都用 postId
          if (!initial?.id && outcome.identity.postId) {
            try { router.replace("/admin/edit/" + outcome.identity.postId); } catch { /* ignore */ }
          }
        }
        return outcome;
      },
      persistLocal: (snapshot, localSnapshotId) => {
        const store = localStoreRef.current;
        if (!store) return true;   // SSR：不谎报失败
        const draft: LocalDraft = {
          clientDraftId: clientDraftIdRef.current,
          postId: identityRef.current?.postId ?? initial?.id ?? null,
          baseRevision: identityRef.current?.baseRevision ?? initial?.revision ?? 1,
          draftRevision: identityRef.current?.draftRevision ?? 0,
          snapshot,
          localSnapshotId,
          confirmedHash: identityRef.current?.snapshotHash ?? null,
          savedAt: new Date().toISOString(),
        };
        const ok = store.save(draft);
        if (!ok) setLocalUnavailable(true);
        return ok;
      },
      onState: (state, detail) => {
        setAutoState(state);
        setAutoMsg(detail?.message ?? "");
        if (detail?.localPersistOk === false) setLocalUnavailable(true);
        // 冲突：拉服务端当前草稿与线上内容，准备三方对比
        if (state === "conflict") void openConflict(detail?.sentSnapshot as Snapshot | null);
      },
    });
  }

  /**
   * 冲突时准备三方对比（方案 §9.2）。
   *
   * 用 function 声明而不是 const：引擎的 onState 回调在构造时就引用了它，
   * 而 const 箭头函数此时还在 TDZ 里 —— 那样会在"真的发生冲突"这一天才崩，
   * 也就是最难排查的时刻。
   */
  async function openConflict(sentSnapshot: Snapshot | null): Promise<void> {
    const postId = identityRef.current?.postId ?? initial?.id;
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

  /**
   * 任何输入都走这里：置 dirty + 通知自动保存状态机。
   *
   * 快照由 snapshotBuilderRef 现取，而不是把构造结果传下去 ——
   * 状态机在 150ms/1.5s 的定时器里才真正消费快照，那时用户可能已经又输入了。
   * 传"构造方式"而不是"构造结果"，才能保证存的是最新那份。
   */
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
    const snap = { ...snapshotBuilderRef.current(), ...(override ?? {}) };
    engineRef.current?.update(snap);
  }, []);

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
        engineRef.current?.setIdentity(d.identity);
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

  /* ---------------- 自动保存的持久化边界（方案 §8.4） ---------------- */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    /**
     * 切后台/关页面前同步 flush。
     *
     * 用 pagehide + visibilitychange:hidden 两个事件，因为它们各覆盖一半场景：
     *   - pagehide 在导航离开时触发（尤其是 bfcache 场景）
     *   - visibilitychange 在切标签/切 App/锁屏时触发（此时页面并不会卸载）
     * 只监听其中一个，会在另一类退出路径上丢掉最后的输入。
     *
     * beforeunload 只用来**提示**，不承担保存：它可能被浏览器忽略，
     * 而且同步写 localStorage 是唯一可靠的收尾动作。
     */
    const flush = () => { engine.flushLocalNow(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const st = engine.getState();
      if (st === "dirty" || st === "queued" || st === "saving" || st === "unknown") {
        // 确有未同步内容才提示，避免每次关闭都弹（方案 §8.4）
        engine.flushLocalNow();
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      engine.destroy();
    };
  }, []);

  /* ---------------- 打开时检查本地可恢复草稿 ---------------- */
  useEffect(() => {
    const store = localStoreRef.current;
    if (!store) return;
    /**
     * 已有文章：按 postId 映射找对应草稿。
     * 新文章：本标签页的 clientDraftId 通常对不上（新标签页会生成新 UUID），
     * 所以退回"扫描全部本地草稿，挑一份未绑定文章的新稿"。
     *
     * 这一步正是"崩溃后重开还能恢复"的关键：崩溃/关标签页后重新打开，
     * 浏览器给的是**新的标签页**，sessionStorage 里的身份已经没了。
     * 只按当前 clientDraftId 去找，等于每次崩溃都恢复不了自己刚写的东西 ——
     * 那本地持久化就白做了。
     */
    let local: LocalDraft | null = null;
    if (initial?.id) {
      const cid = store.findClientDraftId(1, initial.id) ?? clientDraftIdRef.current;
      local = store.load(1, cid);
    } else {
      const all = store.list(1);
      // 优先取"没绑定 postId"的稿子（即新文章尚未首次保存的内容）
      local = all.filter((d) => !d.postId).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))[0] ?? null;
      if (!local) local = store.load(1, clientDraftIdRef.current);
    }
    if (!local) return;
    // 与服务端当前内容比较：完全一样就不打扰用户
    const same =
      JSON.stringify(local.snapshot) ===
      JSON.stringify({
        type, title, slug, content, cover,
        categories: cats.split(",").map((x) => x.trim()).filter(Boolean),
        tags: tags.split(",").map((x) => x.trim()).filter(Boolean),
        comments_enabled: commentsEnabled ? 1 : 0,
      });
    if (!same) setRestoreInfo(local);
    // 只在挂载时检查一次：后续输入不应反复弹出提示
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 说明：旧的 DRAFT_KEY 本地草稿机制已被 lib/local-draft.ts 取代，整段删除。
   *
   * 删掉的理由不是"新代码更好看"，而是**两套本地存储会互相打架**：
   * 旧实现按 postId 存一份 {title,content}，新实现按 clientDraftId 存完整快照。
   * 同时存在时，恢复界面会拿到哪一份取决于执行顺序，而两份的时间戳口径不同
   * （旧的 at 是写入时刻，新的 savedAt 是节流后的真实落盘时刻）。
   * 那种"看起来都在工作、偶尔恢复出旧内容"的 bug 最难查。
   * 旧的 beforeunload 也被替换成新实现里"只在确有未同步状态时提示"的版本。
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
  snapshotBuilderRef.current = buildSnapshot;

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
    <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <select className="input" value={type} onChange={(e) => { setType(e.target.value); mark({ type: e.target.value as Snapshot["type"] }); }}
                style={{ width: 110, padding: "6px 10px" }}>
          <option value="post">文章</option>
          <option value="page">页面</option>
          <option value="shuoshuo">说说</option>
        </select>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: ".74rem", color: "var(--text-p4)" }}>
          {chars} 字{uploading ? " · 上传中 " + uploading : ""}
        </span>
        <button className="btn btn-sm editor-split-btn" onClick={() => setSplit(!split)}>
          {split ? "单栏" : "分屏预览"}
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
            engineRef.current?.update(s2);
            setRestoreInfo(null);
          }}
          onDiscard={() => {
            // 只清本地快照，**不调接口** —— 与服务端草稿的"放弃"是两件事（方案 §6.5）
            localStoreRef.current?.clear(1, restoreInfo.clientDraftId, restoreInfo.postId);
            setRestoreInfo(null);
          }}
        />
      ) : null}

      {!isShuo ? (
        <div className="field">
          <label>标题</label>
          <input className="input" value={title} onChange={(e) => { setTitle(e.target.value); mark({ title: e.target.value }); }}
                 placeholder="文章标题" style={{ fontSize: "1.05rem", fontFamily: "var(--font-serif)" }} />
        </div>
      ) : null}

      {!isShuo && mode === "edit" ? (
        <div className="field">
          <label>URL 路径（改动会自动为旧地址保留 301 跳转）</label>
          <input className="input" value={slug} onChange={(e) => { setSlug(e.target.value); mark({ slug: e.target.value }); }} />
        </div>
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

      <div className="editor-grid" style={{ gridTemplateColumns: split ? "1fr 1fr" : "1fr" }}>
        <textarea
          ref={taRef}
          className="textarea"
          value={content}
          onChange={(e) => { setContent(e.target.value); mark({ content: e.target.value }); }}
          onPaste={onPaste}
          placeholder={isShuo
            ? "写点什么…（可直接粘贴图片）"
            : "支持 Markdown。可直接粘贴或拖入图片；iPhone 的 HEIC 会自动转成 JPEG，大图自动压缩"}
          style={{ minHeight: isShuo ? 140 : 420, fontFamily: "var(--font-mono)", fontSize: ".9rem", lineHeight: 1.7 }}
        />
        {split ? (
          <div className="prose" style={{
            minHeight: 420, maxHeight: 620, overflow: "auto", padding: "16px 18px",
            border: "1px solid var(--border)", borderRadius: 12, background: "var(--card-bg)",
          }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
        ) : null}
      </div>

      {/* 视频外链面板：不做自托管视频（带宽与备份链都不允许），
          这里只把平台链接转成 iframe 嵌入代码插入正文。 */}
      {videoOpen ? (
        <div
          style={{
            marginTop: 10, padding: "12px 14px", border: "1px solid var(--border)",
            borderRadius: 12, background: "var(--bg-tint)",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <label style={{ fontSize: ".84rem", fontWeight: 600 }}>视频链接</label>
            <span style={{ fontSize: ".74rem", color: "var(--text-p4)", flex: 1, minWidth: 200 }}>
              贴链接即可，视频留在原平台播放，本站不存文件
            </span>
            <button type="button" className="btn btn-sm" onClick={() => { setVideoOpen(false); setVideoInput(""); }}
                    style={{ padding: "3px 9px", fontSize: ".78rem" }}>关闭</button>
          </div>
          <input
            className="input"
            value={videoInput}
            onChange={(e) => setVideoInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); insertVideo(); } }}
            placeholder="BV1rAdTBfEEn / youtube.com/watch?v=... / 直接粘贴 <iframe> 代码"
            style={{ fontFamily: "var(--font-mono)", fontSize: ".84rem" }}
            autoFocus
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={insertVideo}
                    style={{ padding: "5px 14px", fontSize: ".8rem" }}>插入视频</button>
            <span style={{ fontSize: ".72rem", color: "var(--text-p4)", flex: 1, minWidth: 180 }}>
              {SUPPORTED_HINT}
            </span>
          </div>
        </div>
      ) : null}

      {dragOver ? (
        <div className="notice" style={{ marginTop: 8 }}>松开即可上传图片</div>
      ) : null}

      {!isShuo ? (
        <div className="editor-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", marginTop: 12 }}>
          <div className="field">
            <label>分类（逗号分隔）</label>
            <input className="input" value={cats} onChange={(e) => { setCats(e.target.value); mark({ categories: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); }} placeholder="学习, AI" />
          </div>
          <div className="field">
            <label>标签（逗号分隔）</label>
            <input className="input" value={tags} onChange={(e) => { setTags(e.target.value); mark({ tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); }} placeholder="部署, 工具" />
          </div>
        </div>
      ) : null}

      {!isShuo ? (
        <div className="field" style={{ marginTop: 12 }}>
          <label>封面图（可选，用于分享卡片 og:image）</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
                <img src={cover} alt="封面" style={{ height: 40, borderRadius: 6, border: "1px solid var(--border)" }} />
                <button type="button" className="btn btn-sm" onClick={() => { setCover(null); mark({ cover: null }); }}>移除</button>
              </>
            ) : <span style={{ fontSize: ".78rem", color: "var(--text-p4)" }}>未设置</span>}
          </div>
        </div>
      ) : null}

      {/* 单篇评论开关：页面类型默认也想开评论，但隐私政策这类应当可以单独关掉 */}
      <label style={{
        display: "flex", gap: 8, alignItems: "center", marginTop: 14,
        fontSize: ".86rem", color: "var(--text-p2)", cursor: "pointer",
      }}>
        <input type="checkbox" checked={commentsEnabled}
               onChange={(ev) => { setCommentsEnabled(ev.target.checked); mark({ comments_enabled: ev.target.checked ? 1 : 0 }); }} />
        允许评论
        <span style={{ fontSize: ".76rem", color: "var(--text-p4)" }}>
          （关闭后该页面不显示评论区）
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
        onRetry={() => { engineRef.current?.saveNow(); }}
      />

      <div className="editor-savebar">
        <span className="editor-savebar-hint">
          {dirty ? "有未保存改动 · Cmd/Ctrl+S 保存" : ""}
        </span>
        {/* 版本历史只有已存在的文章才有意义：新文章还没有任何历史 */}
        {initial?.id ? (
          <button className="btn" disabled={busy} onClick={() => setVersionOpen(true)}>
            版本历史
          </button>
        ) : null}
        <button className="btn" disabled={busy} onClick={() => save("draft")}>存草稿</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => save("published")}>
          {busy ? "保存中…" : status === "published" ? "更新" : "发布"}
        </button>
      </div>

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
          engineRef.current?.resume();
        }}
        onKeepLocal={() => {
          // 用我的版本覆盖：显式 rebase，不做字段级合并
          const snap = buildSnapshot();
          setConflict(null);
          void (async () => {
            const postId = identityRef.current?.postId ?? initial?.id;
            if (!postId) { engineRef.current?.resume(snap); return; }
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
              engineRef.current?.resume(snap);
            } else {
              setErr(r.error.message);
            }
          })();
        }}
      />
    </div>
  );
}
