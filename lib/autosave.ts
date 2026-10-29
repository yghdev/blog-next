/**
 * 自动保存状态机（方案 §8.1 / §8.2）。
 *
 * 这个文件**故意不碰浏览器 API**：定时器与传输层都从外部注入。
 * 理由很实际 —— 自动保存的核心难点是"并发与失败语义"，不是 DOM：
 *   - 单飞（saving 期间只标 queued，绝不并发第二个请求）
 *   - 409 停止自动重试 / 5xx 有界退避 / 网络超时进 unknown
 *   - 超时核对（响应丢了到底是没到还是没提交）
 * 这些全都能在 Node 里用假时钟测准；塞进 React 组件里就只能靠浏览器测试
 * 撞运气，而且失败时看不出是哪条转移错了。
 *
 * 状态：idle、dirty、queued、saving、saved、conflict、unknown、failed
 */

export type AutosaveState =
  | "idle"      // 没有未保存改动
  | "dirty"     // 有改动，等待 debounce
  | "queued"    // 正在保存，且期间又有新输入
  | "saving"    // 请求在飞
  | "saved"     // 已确认保存
  | "conflict"  // 版本冲突：停止自动重试，等用户决定
  | "unknown"   // 响应丢失/网络超时：不确定是否已提交
  | "failed";   // 4xx 校验错误或退避耗尽

/** 注入的定时器，测试里换成假时钟 */
export type TimerApi = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type DraftIdentityLite = {
  postId: number;
  clientDraftId: string;
  baseRevision: number;
  draftRevision: number;
  snapshotHash: string;
};

/**
 * 一次保存尝试的结果。刻意与 HTTP 细节解耦：
 * 状态机只关心"能不能重试、要不要停"，不关心 409 的具体文案。
 */
export type SaveOutcome =
  | { kind: "ok"; identity: DraftIdentityLite }
  /** 409：版本冲突。停止自动重试 */
  | { kind: "conflict"; serverSnapshotHash?: string; currentDraftRevision?: number; currentPostRevision?: number }
  /** 400 等：请求本身不合法，盲目重试没有意义 */
  | { kind: "invalid"; message: string }
  /** 401/403：不再重试，但也不清本地数据 */
  | { kind: "forbidden"; message: string }
  /** 5xx：可退避重试 */
  | { kind: "retryable"; message: string }
  /** 网络错误/超时：可能已提交也可能没到 —— 进 unknown 等核对 */
  | { kind: "timeout"; message: string }
  /** 文章已删除（410） */
  | { kind: "gone"; message: string };

export type AutosaveDeps = {
  /** 把快照发给服务端。identity 为 null 表示尚未拿到 postId（新文章首次保存） */
  save(snapshot: unknown, identity: DraftIdentityLite | null): Promise<SaveOutcome>;
  /** 写本地恢复副本（150ms 节流后调用）。返回 false 表示本地写入失败 */
  persistLocal(snapshot: unknown, localSnapshotId: number): boolean;
  onState?(state: AutosaveState, detail?: AutosaveDetail): void;
  /** debounce 初值 1.5s（方案 §0 可调整项） */
  debounceMs?: number;
  /** 本地持久化节流初值 150ms */
  throttleMs?: number;
  timers?: TimerApi;
  /** 5xx 最多重试次数（有界退避） */
  maxRetries?: number;
  /** 打开文章时 posts.revision：没有草稿时首次保存的基线 */
  initialBaseRevision?: number;
};

export type AutosaveDetail = {
  state: AutosaveState;
  /** 冲突/失败/unknown 时保留本次发送的快照，供差异比较（方案 §8.2 末段要求） */
  sentSnapshot?: unknown;
  sentSnapshotHash?: string;
  message?: string;
  /** 本地持久化是否成功；false 时界面必须常驻警告（方案 §8.4） */
  localPersistOk?: boolean;
};

const DEFAULT_TIMERS: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown,
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class AutosaveEngine {
  private state: AutosaveState = "idle";
  private latest: unknown = null;
  private localSnapshotId = 0;
  /** 已确认保存的快照序号：只有当它等于当前 localSnapshotId 才算"彻底同步" */
  private confirmedSnapshotId = 0;

  private identity: DraftIdentityLite | null = null;
  /**
   * 当前 posts.revision 的本地副本（草稿基线）。
   *
   * 为什么必须单独存一份：发布成功后服务端会删掉草稿身份（identity = null），
   * 但 posts.revision 已经 +1。如果这时还拿"打开页面时的 revision"去保存，
   * 第一次自动保存就会 BASE_REVISION_CONFLICT —— 用户看到的是"刚发布完就冲突"。
   * 所以 identity 为 null 时，expectedPostRevision 必须取这个值，而不是初始值。
   */
  private baseRevision = 1;
  private debounceHandle: unknown = null;
  private throttleHandle: unknown = null;
  private inFlight = false;
  private queued = false;
  private retries = 0;

  private sentSnapshot: unknown = null;
  private sentSnapshotHash: string | null = null;
  private localPersistOk = true;
  private destroyed = false;

  private readonly deps: Required<Pick<AutosaveDeps, "save" | "persistLocal" | "timers" | "debounceMs" | "throttleMs" | "maxRetries">> & AutosaveDeps;

  constructor(deps: AutosaveDeps) {
    this.deps = {
      debounceMs: 1500,
      throttleMs: 150,
      maxRetries: 3,
      timers: DEFAULT_TIMERS,
      ...deps,
    };
    if (deps.initialBaseRevision && deps.initialBaseRevision > 0) {
      this.baseRevision = deps.initialBaseRevision;
    }
  }

  getState(): AutosaveState {
    return this.state;
  }

  /** 当前草稿身份（供 UI 显示"基于 vN"） */
  getIdentity(): DraftIdentityLite | null {
    return this.identity;
  }

  /** 由外部在打开文章并读到服务端草稿后注入 */
  setIdentity(identity: DraftIdentityLite | null): void {
    this.identity = identity;
    if (identity) this.baseRevision = identity.baseRevision;
  }

  /**
   * 记录当前 posts.revision。
   *
   * 发布成功后由调用方更新：草稿身份会被服务端清掉（identity = null），
   * 但线上版本号已经变了。不同步这一条，发布后的第一次自动保存必然 409。
   */
  setBaseRevision(revision: number): void {
    if (Number.isInteger(revision) && revision > 0) this.baseRevision = revision;
  }

  /** 当前已知的 posts.revision（identity 存在时以草稿基线为准） */
  getBaseRevision(): number {
    return this.identity?.baseRevision ?? this.baseRevision;
  }

  /**
   * 等当前在飞的请求落地（上限 15s）。
   *
   * 发布前需要"先确认服务端草稿就是屏幕上这份"，而自动保存可能正在飞。
   * 不等待就直接发发布请求，服务端拿到的草稿可能是上一次的 ——
   * 这正是"点发布，发出去的却是几个字之前的内容"的成因。
   */
  async waitIdle(timeoutMs = 15000): Promise<void> {
    const started = Date.now();
    while (this.inFlight) {
      if (Date.now() - started > timeoutMs) return;
      // 用真实定时器而不是注入的 timers：这里是"等网络"，不是状态机的计时语义，
      // 测试里的假时钟不该影响它（否则 waitIdle 在测试中永远不返回）。
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }

  /**
   * 用户输入。
   *
   * 三种情况必须分开处理，混在一起就是"保存中继续输入被吞掉"的根源：
   *   - 正在 saving：不并发第二个请求，只标 queued
   *   - conflict/unknown：保持该状态并**立即落本地**，等用户显式处理
   *   - 其余：进入 dirty 并重新计时 debounce
   */
  update(snapshot: unknown): void {
    if (this.destroyed) return;
    this.latest = snapshot;
    this.localSnapshotId += 1;

    // 本地恢复副本走 150ms 节流：不能每次按键都写 localStorage（会卡 typing）
    this.scheduleLocalPersist();

    /**
     * 已经是 queued：保持 queued，不要退回 dirty。
     *
     * 这一步容易漏：queued 的含义是"请求在飞 + 期间又有新输入"。
     * 如果这里再走进下面的 setState("dirty")，状态就会伪装成"还没开始保存"，
     * 界面上的保存指示会闪回"待保存"，而实际上请求仍在飞 ——
     * 用户会以为卡住了并重复点保存。
     */
    if (this.state === "saving" || this.state === "queued") {
      this.queued = true;
      this.setState("queued");
      return;
    }
    // 冲突与 unknown 不自动重试：内容必须由用户确认后才继续（方案 §8.2）
    if (this.state === "conflict" || this.state === "unknown") return;

    this.setState("dirty");
    this.armDebounce();
  }

  /** 立即把当前内存快照落本地（pagehide / visibilitychange 调用，方案 §8.4） */
  flushLocalNow(): boolean {
    this.clearThrottle();
    return this.persistNow();
  }

  /** 手动保存：跳过 debounce 立刻发请求（Cmd/Ctrl+S / 保存按钮） */
  saveNow(): void {
    this.clearDebounce();
    void this.runSave();
  }

  /** 立即保存并等它落地（发布前必须先确保服务端草稿=最新内容） */
  async saveNowAsync(): Promise<SaveOutcome | null> {
    this.clearDebounce();
    if (this.destroyed) return null;

    /**
     * 有界重试：正在飞的那一次刚落地时，可能紧接着又起了一次（queued 补发），
     * 于是这一枪仍会撞上 inFlight。重试几次而不是直接放弃 ——
     * 否则用户在"边打字边点发布"时会看到一个莫名其妙的"保存没有完成"。
     */
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.inFlight) {
        await this.waitIdle();
        continue;
      }
      if (this.latest === null) return null;
      // 冲突/未知/失败态不擅自越过：那需要用户先做决定（方案 §8.2）
      if (this.state === "conflict" || this.state === "unknown") return null;
      const outcome = await this.runSave(this.latest);
      if (outcome) return outcome;
    }
    return null;
  }

  /**
   * 用指定快照立即保存并返回结果（编辑器的「存草稿 / 发布」按钮用）。
   *
   * 为什么不能直接调用私有 runSave：按钮要拿到**这次**的结果来决定是否继续发布。
   * 只触发 saveNow 再查状态是竞态 —— 状态可能还没更新到 saved。
   */
  async saveSnapshotNow(snapshot: unknown): Promise<SaveOutcome | null> {
    this.latest = snapshot;
    this.localSnapshotId += 1;
    this.scheduleLocalPersist();
    return this.saveNowAsync();
  }

  /** 用户处理完冲突后继续（重新读取或 rebase 成功后调用） */
  resume(snapshot?: unknown): void {
    if (snapshot !== undefined) this.latest = snapshot;
    this.retries = 0;
    this.setState("dirty");
    this.armDebounce();
  }

  /** 放弃：清掉定时器，不再自动保存（例如离开页面） */
  destroy(): void {
    this.destroyed = true;
    this.clearDebounce();
    this.clearThrottle();
  }

  /* --------------------------- 内部实现 --------------------------- */

  private setState(state: AutosaveState, extra: Partial<AutosaveDetail> = {}): void {
    this.state = state;
    this.deps.onState?.(state, {
      state,
      localPersistOk: this.localPersistOk,
      ...extra,
    });
  }

  private armDebounce(): void {
    this.clearDebounce();
    this.debounceHandle = this.deps.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.runSave();
    }, this.deps.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceHandle !== null) {
      this.deps.timers.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
  }

  private scheduleLocalPersist(): void {
    if (this.throttleHandle !== null) return;
    this.throttleHandle = this.deps.timers.setTimeout(() => {
      this.throttleHandle = null;
      this.persistNow();
    }, this.deps.throttleMs);
  }

  private clearThrottle(): void {
    if (this.throttleHandle !== null) {
      this.deps.timers.clearTimeout(this.throttleHandle);
      this.throttleHandle = null;
    }
  }

  private persistNow(): boolean {
    // 只在确有内容时写：空内容写进去会把用户的旧草稿覆盖成空
    if (this.latest === null) return this.localPersistOk;
    const ok = this.deps.persistLocal(this.latest, this.localSnapshotId);
    this.localPersistOk = ok;
    if (!ok) {
      // 本地失败必须让界面知道（常驻警告），但不能因此中断服务端自动保存
      this.deps.onState?.(this.state, { state: this.state, localPersistOk: false });
    }
    return ok;
  }

  /**
   * 执行一次保存。
   *
   * 单飞在这里实现：`inFlight` 为真时**直接返回**，绝不再发第二个请求。
   * 这不是性能优化 —— 并发两个保存请求会让服务端收到两份不同快照，
   * 后到的那个可能反而更旧，用户的输入顺序就被打乱了。
   */
  private async runSave(override?: unknown): Promise<SaveOutcome | null> {
    if (this.destroyed) return null;
    if (this.inFlight) {
      /**
       * 已经有一个请求在飞：不能并发（会打乱写入顺序），
       * 但**这次调用不能假装成功**。若调用方是「请等这次保存落地」，
       * 它得到的应该是"还在飞"，由调用方决定等还是重试。
       */
      if (override !== undefined) this.latest = override;
      return null;
    }
    const snapshotAtSend = override ?? this.latest;
    if (snapshotAtSend === null) return null;

    this.inFlight = true;
    const snapshotIdAtSend = this.localSnapshotId;
    this.sentSnapshot = snapshotAtSend;
    this.setState("saving");

    let outcome: SaveOutcome;
    try {
      outcome = await this.deps.save(snapshotAtSend, this.identity);
    } catch (e) {
      // 传输层抛异常 = 不知道服务端收没收到，按 unknown 处理
      outcome = { kind: "timeout", message: (e as Error)?.message ?? "网络错误" };
    }
    this.inFlight = false;
    this.queued = false;

    switch (outcome.kind) {
      case "ok": {
        this.identity = outcome.identity;
        this.sentSnapshotHash = outcome.identity.snapshotHash;
        this.retries = 0;
        this.confirmedSnapshotId = snapshotIdAtSend;

        // 保存期间又有新输入：立刻用**最新身份**继续保存最新快照
        if (this.localSnapshotId > snapshotIdAtSend) {
          this.setState("queued");
          void this.runSave();
          return outcome;
        }
        this.setState("saved");
        return outcome;
      }

      case "conflict": {
        // 停止自动重试，保留本地完整快照，进入冲突界面（方案 §8.1）
        this.flushLocalNow();
        this.setState("conflict", {
          sentSnapshot: this.sentSnapshot,
          sentSnapshotHash: this.sentSnapshotHash ?? undefined,
          message: "草稿版本冲突，需要你确认后继续",
        });
        return outcome;
      }

      case "timeout": {
        // 可能已提交也可能没到 —— 不清本地、不盲目覆盖，等核对
        this.flushLocalNow();
        this.setState("unknown", {
          sentSnapshot: this.sentSnapshot,
          sentSnapshotHash: this.sentSnapshotHash ?? undefined,
          message: outcome.message,
        });
        return outcome;
      }

      case "retryable": {
        this.retries += 1;
        if (this.retries > this.deps.maxRetries) {
          this.flushLocalNow();
          this.setState("failed", { message: "服务端连续失败，请稍后手动重试" });
          return outcome;
        }
        // 有界指数退避：1s、2s、4s…（上限 8s）
        const wait = Math.min(1000 * 2 ** (this.retries - 1), 8000);
        this.setState("dirty", { message: "保存失败，正在重试（" + this.retries + "/" + this.deps.maxRetries + "）" });
        this.clearDebounce();
        this.debounceHandle = this.deps.timers.setTimeout(() => {
          this.debounceHandle = null;
          void this.runSave();
        }, wait);
        return outcome;
      }

      case "invalid":
      case "forbidden":
      case "gone": {
        // 4xx 不盲目重试；本地数据一律保留（方案 §8.1 末条）
        this.flushLocalNow();
        this.setState("failed", {
          sentSnapshot: this.sentSnapshot,
          message: outcome.message,
        });
        return outcome;
      }
    }
    return outcome;
  }
}

/* ══════════════════════════════════════════════════════════════════
   超时核对（方案 §8.2）
   ══════════════════════════════════════════════════════════════════ */

/** 发送前必须记录的信息，缺一不可 —— 否则核对就是猜 */
export type ReconcileContext = {
  preIdentity: DraftIdentityLite | null;
  /** 本次发出的快照 hash */
  sentSnapshotHash: string;
  /** 若成功，draftRevision 应该是多少（有新草稿 = pre+1；首次 = 1） */
  expectedDraftRevision: number;
};

/** GET 回来的当前草稿状态（无草稿时为 null） */
export type ObservedDraft = {
  identity: DraftIdentityLite;
  snapshotHash: string;
  draftRevision: number;
  baseRevision: number;
} | null;

export type ReconcileOutcome =
  /** 已确认保存成功 */
  | { kind: "already-saved"; draftRevision: number }
  /** 服务端已有相同内容且版本更大：当前值已同步，但不能清除更新的本地编辑 */
  | { kind: "synced-newer"; draftRevision: number }
  /** posts 基线变了：需要用户决定如何合并 */
  | { kind: "base-revision-conflict" }
  /** hash 不同且 draftRevision 更大：别人改过 */
  | { kind: "draft-revision-conflict" }
  /** 服务端仍等于发送前的状态：本次确实没落库，可以用原身份有界重试 */
  | { kind: "not-sent" }
  /** draftRevision 没变但 hash 变了：状态自相矛盾，必须显式重新读取 */
  | { kind: "inconsistent-state" }
  /** GET 失败或身份无法确认：保持 unknown */
  | { kind: "unknown" };

/**
 * 判断"响应丢了"到底是哪种情况。
 *
 * 这里最容易犯的错是把"请求没到服务端"和"服务端改了但版本没 bump"
 * 混为一谈 —— 前者可以安全重试，后者重试会把别人的修改覆盖掉。
 */
export function classifyReconcile(
  ctx: ReconcileContext,
  observed: ObservedDraft,
  currentPostRevision: number
): ReconcileOutcome {
  if (!observed) {
    // 没有草稿：如果本次是首次保存，说明确实没落库；否则说明草稿被清理（例如刚发布）
    if (ctx.preIdentity === null) return { kind: "not-sent" };
    return { kind: "unknown" };
  }

  const o = observed;

  /**
   * 顺序很重要：**先查基线**再查"内容是否匹配"。
   *
   * 内容完全匹配但 posts 基线已经变了（别人发布了新版本），
   * 这时既不能说"已保存、可以继续"，也不能自动 rebase —— 草稿基于旧基线，
   * 直接继续保存会把旧内容叠到新发布的内容上。基线冲突优先级最高。
   */
  if (ctx.preIdentity && currentPostRevision !== ctx.preIdentity.baseRevision) {
    return { kind: "base-revision-conflict" };
  }

  // 1) 完全匹配：我们发的那份已经在服务端，且版本正好是预期值
  if (
    ctx.preIdentity !== null &&
    o.identity.postId === ctx.preIdentity.postId &&
    o.identity.clientDraftId === ctx.preIdentity.clientDraftId &&
    o.snapshotHash === ctx.sentSnapshotHash &&
    o.draftRevision === ctx.expectedDraftRevision
  ) {
    return { kind: "already-saved", draftRevision: o.draftRevision };
  }

  // 2) 内容相同但版本更大：已同步，只是本地还有更新编辑
  if (o.snapshotHash === ctx.sentSnapshotHash) {
    return { kind: "synced-newer", draftRevision: o.draftRevision };
  }

  // 4) 服务端仍是发送前的身份与内容：本次确实没落库，可安全重试。
  //    这条必须在"状态矛盾"之前判：hash 等于 preIdentity.snapshot_hash 说明
  //    服务端就是发送前那份，是完全正常的状态，不是矛盾。
  if (ctx.preIdentity && o.snapshotHash === ctx.preIdentity.snapshotHash) {
    return { kind: "not-sent" };
  }

  // 5) draftRevision 未变，但 hash 既不是我们发的、也不是发送前的 —— 这才叫矛盾
  //    （版本没涨却内容变了，说明服务端状态被绕过正常写入路径改过）
  if (ctx.preIdentity && o.draftRevision === ctx.preIdentity.draftRevision) {
    return { kind: "inconsistent-state" };
  }

  // 6) 版本更大且内容不同：别人改过
  if (ctx.preIdentity && o.draftRevision > ctx.preIdentity.draftRevision) {
    return { kind: "draft-revision-conflict" };
  }

  return { kind: "unknown" };
}
