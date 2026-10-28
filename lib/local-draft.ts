/**
 * 本地草稿持久化（方案 §8.3 / §8.4）。
 *
 * 目标是"崩溃/断网后还能把内容拿回来"，所以这一层的每条规则都在防同一件事：
 * **让用户以为存住了，其实没有**。
 *
 * 三条硬规则（都对应真实事故形态）：
 *   1. 以真实 setItem 结果为准。不设"跨浏览器固定容量安全线"——
 *      那个数字永远猜错，且不同浏览器/隐私模式差异巨大。
 *   2. 完整草稿写入失败时**不得**标记"本地已保存"。宁可显示警告，
 *      也不要让用户以为万无一失然后关掉标签页。
 *   3. 禁止在正常草稿键里存"只含摘要/hash 的假草稿"。要么是完整可恢复内容，
 *      要么什么都不留 —— 半份草稿比没有更危险。
 *
 * 本地键约定（§8.3）：
 *   草稿：draft:<userId>:<clientDraftId>
 *   映射：draft-post:<userId>:<postId> → clientDraftId
 */

export type LocalDraft = {
  clientDraftId: string;
  postId: number | null;
  baseRevision: number;
  draftRevision: number;
  /** 完整快照（方案 §4.1 的形状），不是摘要 */
  snapshot: unknown;
  /** 每次输入递增；用来判断"服务端确认的是不是最新那份" */
  localSnapshotId: number;
  /** 服务端已确认的 hash；null 表示还没确认过 */
  confirmedHash: string | null;
  /** 写入时间（UTC ISO），用于在恢复界面显示"这份有多旧" */
  savedAt: string;
};

const PREFIX = "draft:";
const MAP_PREFIX = "draft-post:";

export function draftKey(userId: number, clientDraftId: string): string {
  return PREFIX + userId + ":" + clientDraftId;
}

export function postMapKey(userId: number, postId: number): string {
  return MAP_PREFIX + userId + ":" + postId;
}

/** 存储抽象：默认用 localStorage，测试注入假实现（含配额失败） */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type LocalStore = {
  /** 写完整草稿。返回 false 表示本地写入失败（配额/隐私模式），调用方须显示常驻警告 */
  save(draft: LocalDraft): boolean;
  load(userId: number, clientDraftId: string): LocalDraft | null;
  /** 按 postId 映射找回 clientDraftId（已有文章刷新后据此定位草稿） */
  findClientDraftId(userId: number, postId: number): string | null;
  bindPost(userId: number, postId: number, clientDraftId: string): boolean;
  clear(userId: number, clientDraftId: string, postId?: number | null): void;
  /** 列出该用户所有本地草稿（恢复界面用） */
  list(userId: number): LocalDraft[];
};

export function createLocalStore(storage: StorageLike): LocalStore {
  return {
    save(draft) {
      try {
        // 必须是完整内容：不裁剪、不降级、不丢字段
        storage.setItem(draftKey(0, draft.clientDraftId), JSON.stringify(draft));
        return true;
      } catch {
        // 配额超限或隐私模式：**不抛给调用方**，但要如实返回 false
        return false;
      }
    },

    load(userId, clientDraftId) {
      // 先按带 userId 的键读；旧版本可能写成 draft:0:<cid>，兼容回退
      for (const key of [draftKey(userId, clientDraftId), draftKey(0, clientDraftId)]) {
        try {
          const raw = storage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as LocalDraft;
          // 校验形状：残缺数据宁可当没有，也不要拿去覆盖用户内容
          if (!parsed || typeof parsed !== "object") continue;
          if (typeof parsed.clientDraftId !== "string") continue;
          if (parsed.snapshot === undefined || parsed.snapshot === null) continue;
          return parsed;
        } catch {
          // 损坏的 JSON 视为没有（方案明确：不假装能恢复）
          continue;
        }
      }
      return null;
    },

    findClientDraftId(userId, postId) {
      for (const key of [postMapKey(userId, postId), postMapKey(0, postId)]) {
        try {
          const v = storage.getItem(key);
          if (v) return v;
        } catch {
          /* ignore */
        }
      }
      return null;
    },

    bindPost(userId, postId, clientDraftId) {
      try {
        storage.setItem(postMapKey(0, postId), clientDraftId);
        return true;
      } catch {
        return false;
      }
    },

    clear(userId, clientDraftId, postId) {
      try {
        storage.removeItem(draftKey(0, clientDraftId));
        storage.removeItem(draftKey(userId, clientDraftId));
        if (postId !== undefined && postId !== null) storage.removeItem(postMapKey(0, postId));
      } catch {
        // 清不掉也不该阻断流程；只是下次还会看到"可恢复"提示
        /* ignore */
      }
    },

    list(userId) {
      const out: LocalDraft[] = [];
      try {
        // 遍历所有 key（Storage 的 length/key 在测试替身里也实现了）
        const anyStorage = storage as StorageLike & { length?: number; key?: (i: number) => string | null };
        if (typeof anyStorage.length !== "number" || typeof anyStorage.key !== "function") return out;
        for (let i = 0; i < anyStorage.length; i++) {
          const k = anyStorage.key(i);
          if (!k || !k.startsWith(PREFIX)) continue;
          const raw = storage.getItem(k);
          if (!raw) continue;
          try {
            const d = JSON.parse(raw) as LocalDraft;
            if (d && typeof d.clientDraftId === "string" && d.snapshot != null) out.push(d);
          } catch {
            continue;
          }
        }
      } catch {
        /* ignore */
      }
      return out;
    },
  };
}

/**
 * 判断能否安全清除本地副本（方案 §8.3 最后两条）。
 *
 * 只有"服务端确认的快照 == 当前本地快照"且"没有更新的编辑/queued"才允许清。
 * 这条判断写成纯函数，是因为它最容易写错 —— 保存响应到达时用户往往还在打字，
 * 一旦按"请求成功"就清本地，那几秒的输入就永远丢了。
 */
export function canClearLocal(input: {
  confirmedSnapshotId: number;
  currentLocalSnapshotId: number;
  queued: boolean;
}): boolean {
  if (input.queued) return false;
  return input.confirmedSnapshotId >= input.currentLocalSnapshotId;
}

/**
 * 本地不可用时的降级策略（方案 §8.4）。
 *
 * 明确拒绝"把草稿降级成摘要"这种做法：那会让用户以为自己有一份可恢复的内容，
 * 实际恢复出来是空的。正确做法是保留服务端自动保存 + 提供导出。
 */
export type LocalFallback = {
  /** 是否必须常驻警告（不自动消失） */
  persistentWarning: boolean;
  /** 建议用户可用的两条出口 */
  advice: "export-or-save-server";
  message: string;
};

export function localUnavailableFallback(reason: "quota" | "private-mode" | "unknown"): LocalFallback {
  const why =
    reason === "quota" ? "浏览器本地存储空间不足"
    : reason === "private-mode" ? "当前处于隐私/无痕模式，本地存储不可用"
    : "浏览器本地存储不可用";
  return {
    persistentWarning: true,
    advice: "export-or-save-server",
    message:
      why + "：本机暂时无法保存恢复副本。请立即把内容保存到服务端，或导出 Markdown/JSON 备份 —— " +
      "此时若关闭页面，未同步的内容可能丢失。",
  };
}
