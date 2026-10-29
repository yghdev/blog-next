"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/snapshot";
import { canonicalize, hashSnapshot } from "@/lib/snapshot";
import { AutosaveEngine, type AutosaveState, type SaveOutcome } from "@/lib/autosave";
import { autosaveOnce, newClientDraftId, rebaseDraft as apiRebaseDraft, type DraftIdentity } from "@/lib/draft-client";
import { createLocalStore, type LocalDraft } from "@/lib/local-draft";

/**
 * 自动保存的编排（从 Editor.tsx 里抽出来的）。
 *
 * 为什么值得单独一个 hook：这部分有**四类互相牵制的状态** ——
 * 草稿身份、状态机、本地存储、冲突处理。它们全都依赖"最新的编辑器内容"，
 * 而 React 的闭包会让"最新"变成"上一次渲染"。混在 900 行的组件里，
 * 任何一次改动都可能悄悄破坏其中一条（实测踩过两次），而且报错位置
 * 离真正原因很远。抽出来后这些约束集中在一处，改起来才有边界。
 *
 * 注意：这个 hook **不渲染任何东西**，只负责数据与状态；
 * 界面仍由 Editor 决定，所以它不是"第二套 UI"。
 */

export type UseAutosaveInput = {
  /** 已有文章的 id；新文章为 undefined */
  postId?: number;
  /** posts.revision，作为草稿基线起点 */
  initialRevision?: number;
  /** 读当前编辑器内容（用 ref 传，避免闭包陈旧） */
  getSnapshot: () => Snapshot;
  /** 新文章首次保存成功后接管 URL */
  onPostCreated?: (postId: number) => void;
  /** 状态变化通知（供界面显示） */
  onState?: (state: AutosaveState, detail: { message?: string; localPersistOk?: boolean; sentSnapshot?: unknown }) => void;
  /** 进入冲突时，界面需要打开三方对比 */
  onConflict?: (sentSnapshot: Snapshot | null) => void;
  /** 首次挂载时若发现本地可恢复草稿 */
  onLocalDraftFound?: (draft: LocalDraft) => void;
};

export type AutosaveApi = {
  /** 内容变化时调用；override 为本次输入后的最新值 */
  mark: (override?: Partial<Snapshot>) => void;
  /** 立即保存（Cmd/Ctrl+S） */
  saveNow: () => void;
  /** 用指定快照立即保存，并返回本次结果（发布按钮用） */
  saveSnapshotNow: (snapshot: Snapshot) => Promise<SaveOutcome | null>;
  /** 立即把内存快照落本地（pagehide/visibilitychange） */
  flushLocal: () => void;
  /** 冲突处理后恢复自动保存 */
  resume: (snapshot?: Snapshot) => void;
  /** 用当前内容覆盖服务端草稿（rebase），不做字段级合并 */
  keepLocal: (snapshot: Snapshot) => Promise<{ ok: boolean; message?: string }>;
  /** 应用从服务端读到的草稿身份 */
  setIdentity: (identity: DraftIdentity | null) => void;
  /**
   * 发布成功后调用：服务端删了草稿、posts.revision 变了。
   * 必须同时把"身份作废 + 新基线"同步给状态机，否则下一次自动保存就会 409。
   */
  afterPublish: (newPostRevision: number) => void;
  /** 当前身份（响应式，供版本面板等需要"保存后自动刷新"的 UI 使用） */
  identity: DraftIdentity | null;
  /** 当前身份（只读用途） */
  getIdentity: () => DraftIdentity | null;
  /** 当前 posts.revision（没有草稿身份时也能取到，避免用打开页面时的旧值） */
  getBaseRevision: () => number;
  /** clientDraftId（版本恢复接口需要） */
  getClientDraftId: () => string;
  /** 本地存储不可用（界面需常驻警告） */
  isLocalUnavailable: () => boolean;
  /** 清除指定本地草稿（"丢弃本地未同步内容"用，**不调接口**） */
  clearLocal: (clientDraftId: string, postId: number | null) => void;
  /** 卸载时清理 */
  destroy: () => void;
};

export function useAutosave(input: UseAutosaveInput): AutosaveApi {
  const identityRef = useRef<DraftIdentity | null>(null);
  /**
   * identity 的响应式副本。
   *
   * 为什么要多一份 state：identityRef 变化不触发重渲染，于是"版本历史"面板
   * 拿到的 draftRevision 会一直停在面板打开那一刻 —— 期间发生任何一次自动保存，
   * 点"恢复为草稿"就会 409（草稿已被修改）。线上那次 restore-version 409 即此。
   */
  const [identityView, setIdentityView] = useState<DraftIdentity | null>(null);
  const clientDraftIdRef = useRef<string>(newClientDraftId());
  const localUnavailableRef = useRef(false);

  const getSnapshotRef = useRef(input.getSnapshot);
  getSnapshotRef.current = input.getSnapshot;

  const onStateRef = useRef(input.onState);
  onStateRef.current = input.onState;
  const onConflictRef = useRef(input.onConflict);
  onConflictRef.current = input.onConflict;
  const onPostCreatedRef = useRef(input.onPostCreated);
  onPostCreatedRef.current = input.onPostCreated;

  const localStoreRef = useRef(
    typeof window === "undefined" ? null : createLocalStore(window.localStorage)
  );

  const engineRef = useRef<AutosaveEngine | null>(null);

  if (!engineRef.current && typeof window !== "undefined") {
    engineRef.current = new AutosaveEngine({
      initialBaseRevision: input.initialRevision,
      save: async (snapshot, identity) => {
        const snap = snapshot as Snapshot;
        /**
         * expectedPostRevision 的三级来源，顺序不能换：
         *   1) engine 的 identity（有草稿时，它就是草稿的基线）
         *   2) engine 自己记的 baseRevision（发布后 identity 被清空，但 revision 已 +1）
         *   3) 打开页面时的 initialRevision（新文章首次保存）
         * 早期实现只有 1 和 3，于是"发布成功后继续编辑"第一枪就 409 ——
         * 服务端 revision 已是 2，客户端还在喊 1。
         */
        const outcome = await autosaveOnce({
          postId: identity?.postId ?? input.postId,
          clientDraftId: clientDraftIdRef.current,
          snapshot: snap,
          snapshotHash: hashSnapshot(canonicalize(snap)),
          expectedPostRevision: identity?.baseRevision ?? engineRef.current?.getBaseRevision() ?? input.initialRevision ?? 1,
          expectedDraftRevision: identity?.draftRevision ?? 0,
        });
        if (outcome.kind === "ok") {
          identityRef.current = outcome.identity;
          setIdentityView(outcome.identity);
          // 新文章首次保存后接管 URL，后续都用 postId
          if (!input.postId && outcome.identity.postId) {
            onPostCreatedRef.current?.(outcome.identity.postId);
          }
        }
        return outcome;
      },

      persistLocal: (snapshot, localSnapshotId) => {
        const store = localStoreRef.current;
        if (!store) return true; // SSR：不谎报失败
        const ok = store.save({
          clientDraftId: clientDraftIdRef.current,
          postId: identityRef.current?.postId ?? input.postId ?? null,
          baseRevision: identityRef.current?.baseRevision ?? input.initialRevision ?? 1,
          draftRevision: identityRef.current?.draftRevision ?? 0,
          snapshot,
          localSnapshotId,
          confirmedHash: identityRef.current?.snapshotHash ?? null,
          savedAt: new Date().toISOString(),
        });
        if (!ok) localUnavailableRef.current = true;
        return ok;
      },

      onState: (state, detail) => {
        onStateRef.current?.(state, {
          message: detail?.message,
          localPersistOk: detail?.localPersistOk,
          sentSnapshot: detail?.sentSnapshot,
        });
        if (detail?.localPersistOk === false) localUnavailableRef.current = true;
        if (state === "conflict") onConflictRef.current?.((detail?.sentSnapshot as Snapshot) ?? null);
      },
    });
  }

  /* ---------------- 持久化边界（方案 §8.4） ---------------- */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    /**
     * 用 pagehide + visibilitychange 两个事件，因为它们各覆盖一半场景：
     *   - pagehide 在导航离开时触发（含 bfcache）
     *   - visibilitychange 在切标签/切 App/锁屏时触发（页面并不卸载）
     * 只监听一个，会在另一类退出路径上丢掉最后的输入。
     * beforeunload 只用来提示，不承担保存职责。
     */
    const flush = () => { engine.flushLocalNow(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const st = engine.getState();
      if (st === "dirty" || st === "queued" || st === "saving" || st === "unknown") {
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

  const mark = useCallback((override?: Partial<Snapshot>) => {
    engineRef.current?.update({ ...getSnapshotRef.current(), ...(override ?? {}) });
  }, []);

  const saveNow = useCallback(() => { engineRef.current?.saveNow(); }, []);
  /** 用当前编辑器内容立即保存一次，并拿到这次的结果（发布按钮据此决定是否继续） */
  const saveSnapshotNow = useCallback(async (snapshot: Snapshot) => {
    const engine = engineRef.current;
    if (!engine) return null;
    return engine.saveSnapshotNow(snapshot);
  }, []);
  const flushLocal = useCallback(() => { engineRef.current?.flushLocalNow(); }, []);

  const resume = useCallback((snapshot?: Snapshot) => {
    engineRef.current?.resume(snapshot ?? getSnapshotRef.current());
  }, []);

  const setIdentity = useCallback((identity: DraftIdentity | null) => {
    identityRef.current = identity;
    setIdentityView(identity);
    /**
     * clientDraftId 也必须跟着切。
     *
     * 草稿与 clientDraftId 是**一对一绑定**的（服务端 DRAFT_FORBIDDEN 校验）。
     * 早期这里只同步了 identityRef，没同步 hook 自己的 clientDraftIdRef，
     * 于是编辑器加载到别人（或上一个会话）建的草稿后，第一次自动保存
     * 会拿一个全新的 UUID 去更新 —— 服务端只能回「该草稿属于另一个编辑会话」。
     * 线上所有 DRAFT_FORBIDDEN 都是这么来的：不是并发，是自己人不认自己人。
     */
    if (identity) clientDraftIdRef.current = identity.clientDraftId;
    // 同时同步给引擎：它自己维护一份 identity 用于算 expected 版本。
    // 只更新 ref 不同步引擎，会让它以为"还没有草稿"（draftRevision=0），
    // 首次保存就撞 409，表面上完全像一个版本冲突。
    engineRef.current?.setIdentity(identity);
  }, []);

  /**
   * 发布成功后调用。
   *
   * 这一步是"发布完继续写"能正常工作的前提：
   *   1) 服务端把草稿删了 -> 本地身份必须一起作废，否则下一次保存会带着
   *      已不存在的 draftRevision 去更新，服务端只能回 DRAFT_NOT_FOUND；
   *   2) posts.revision 已经 +1 -> 引擎的基线必须跟上，否则第一次自动保存
   *      就是 BASE_REVISION_CONFLICT。
   * 早期版本两条都没做，线上表现为"刚发布完，随便改一个字就提示冲突"。
   */
  const afterPublish = useCallback((newPostRevision: number) => {
    identityRef.current = null;
    setIdentityView(null);
    const engine = engineRef.current;
    if (!engine) return;
    engine.setIdentity(null);
    engine.setBaseRevision(newPostRevision);
  }, []);

  const keepLocal = useCallback(async (snapshot: Snapshot): Promise<{ ok: boolean; message?: string }> => {
    const postId = identityRef.current?.postId ?? input.postId;
    if (!postId) {
      engineRef.current?.resume(snapshot);
      return { ok: true };
    }
    const r = await apiRebaseDraft({
      postId,
      clientDraftId: clientDraftIdRef.current,
      snapshot,
      snapshotHash: hashSnapshot(canonicalize(snapshot)),
      expectedDraftRevision: identityRef.current?.draftRevision ?? 0,
      expectedPostRevision: identityRef.current?.baseRevision ?? input.initialRevision ?? 1,
    });
    if (!r.ok) return { ok: false, message: r.error.message };
    identityRef.current = r.value.identity;
    setIdentityView(r.value.identity);
    engineRef.current?.setIdentity(r.value.identity);
    engineRef.current?.resume(snapshot);
    return { ok: true };
  }, [input.postId, input.initialRevision]);

  const destroy = useCallback(() => { engineRef.current?.destroy(); }, []);

  /** 挂载时检查本地可恢复草稿（崩溃后重开靠这条） */
  useEffect(() => {
    const store = localStoreRef.current;
    if (!store) return;
    let local: LocalDraft | null = null;
    if (input.postId) {
      const cid = store.findClientDraftId(1, input.postId) ?? clientDraftIdRef.current;
      local = store.load(1, cid);
    } else {
      /**
       * 新文章：崩溃后重开是**新标签页**，sessionStorage 身份已丢失。
       * 只按当前 clientDraftId 找，等于每次崩溃都恢复不了自己刚写的东西。
       * 所以退回"扫描本地草稿，取未绑定 postId 的那份"。
       */
      const all = store.list(1);
      local = all.filter((d) => !d.postId).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))[0] ?? null;
      if (!local) local = store.load(1, clientDraftIdRef.current);
    }
    if (local) input.onLocalDraftFound?.(local);
    // 只在挂载时检查一次：后续输入不应反复弹出提示
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 打开已有文章时**不再**在这里独立拉一次草稿。
   *
   * 早期 Editor 与本 hook 各拉一次 GET /draft（线上日志里同一秒成对出现），
   * 两边都写 clientDraftId / identity。只要两次响应之间隔了一次自动保存，
   * 编辑器里显示的内容与状态机持有的版本号就来自两份不同的响应，
   * 于是"自己跟自己的另一个会话冲突"。现在只由 Editor 拉一次并注入。
   */

  return {
    mark, saveNow, saveSnapshotNow, flushLocal, resume, keepLocal, setIdentity, afterPublish,
    identity: identityView,
    getIdentity: () => identityRef.current,
    getBaseRevision: () => engineRef.current?.getBaseRevision() ?? input.initialRevision ?? 1,
    getClientDraftId: () => clientDraftIdRef.current,
    isLocalUnavailable: () => localUnavailableRef.current,
    clearLocal: (clientDraftId: string, postId: number | null) => {
      localStoreRef.current?.clear(1, clientDraftId, postId);
    },
    destroy,
  };
}
