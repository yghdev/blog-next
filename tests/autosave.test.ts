import { test } from "node:test";
import assert from "node:assert/strict";
import { AutosaveEngine, classifyReconcile, type DraftIdentityLite, type SaveOutcome } from "../lib/autosave.ts";
import { createLocalStore, canClearLocal, localUnavailableFallback, draftKey, postMapKey, type LocalDraft } from "../lib/local-draft.ts";

/**
 * 阶段 03.2 自动保存状态机测试（方案 §8.1 / §8.2 / §8.3 / §8.4）。
 *
 * 为什么这些测试在 Node 而不是浏览器里跑：
 * 自动保存真正难的是并发与失败语义（单飞、退避、超时核对），
 * 这些用假时钟 + 假传输层能精确断言每一次状态转移。
 * 放进浏览器测试就只能靠 sleep 撞运气，失败时还说不出错在哪一步。
 */

/* ------------------------------ 假时钟 ------------------------------ */

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    api: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(h: unknown) {
        timers.delete(h as number);
      },
    },
    /** 推进时间并执行到期的定时器（按到期顺序） */
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; }
        }
        if (nextId === null) break;
        const t = timers.get(nextId)!;
        timers.delete(nextId);
        now = t.at;
        t.fn();
      }
      now = target;
    },
    /** 让所有挂起的 promise 结算 */
    flush() {
      return new Promise<void>((r) => setImmediate(r));
    },
    pending() {
      return timers.size;
    },
  };
}

function identity(over: Partial<DraftIdentityLite> = {}): DraftIdentityLite {
  return {
    postId: 1,
    clientDraftId: "cid-1",
    baseRevision: 2,
    draftRevision: 1,
    snapshotHash: "h1",
    ...over,
  };
}

/* ══════════════════════════════════════════════════════════════════
   §8.1 状态机
   ══════════════════════════════════════════════════════════════════ */

test("状态机：输入 -> dirty -> saving -> saved", async () => {
  const clock = fakeTimers();
  const states: string[] = [];
  const engine = new AutosaveEngine({
    save: async () => ({ kind: "ok", identity: identity({ snapshotHash: "h-new" }) }),
    persistLocal: () => true,
    onState: (s) => states.push(s),
    timers: clock.api,
  });

  engine.update({ content: "a" });
  assert.equal(engine.getState(), "dirty");
  assert.equal(states.at(-1), "dirty");

  // debounce 是 1.5s：推进 1400ms 还不该发请求
  clock.advance(1400);
  assert.equal(engine.getState(), "dirty", "未到 debounce 不应开始保存");

  clock.advance(200);
  await clock.flush();
  assert.equal(engine.getState(), "saved");
  // 只记"进入某状态"的通知；dirty 只发一次（update 时），不再是两次
  assert.deepEqual(states, ["dirty", "saving", "saved"]);
  engine.destroy();
});

test("状态机：saving 期间的新输入只标 queued，不并发第二个请求（单飞）", async () => {
  const clock = fakeTimers();
  let saveCalls = 0;
  let release!: (o: SaveOutcome) => void;

  const engine = new AutosaveEngine({
    save: () => {
      saveCalls += 1;
      return new Promise<SaveOutcome>((res) => { release = res; });
    },
    persistLocal: () => true,
    timers: clock.api,
  });

  engine.update({ content: "first" });
  clock.advance(1600);
  await clock.flush();
  assert.equal(engine.getState(), "saving");
  assert.equal(saveCalls, 1);

  // 请求还在飞的时候继续输入两次
  engine.update({ content: "second" });
  assert.equal(engine.getState(), "queued");
  engine.update({ content: "third" });
  assert.equal(engine.getState(), "queued");

  // 关键：这段时间里绝不能出现第二个并发请求
  assert.equal(saveCalls, 1, "单飞：saving 期间不得并发第二个请求");

  // 第一个请求完成 -> 立刻用最新身份保存最新快照
  release({ kind: "ok", identity: identity({ draftRevision: 2, snapshotHash: "h2" }) });
  await clock.flush();

  assert.equal(saveCalls, 2, "成功后应立即补发 queued 的那次");
  assert.equal(engine.getState(), "saving");

  release({ kind: "ok", identity: identity({ draftRevision: 3, snapshotHash: "h3" }) });
  await clock.flush();
  assert.equal(engine.getState(), "saved");
  engine.destroy();
});

test("状态机：409 停止自动重试并进入 conflict，保留发送快照", async () => {
  const clock = fakeTimers();
  let saveCalls = 0;
  const engine = new AutosaveEngine({
    save: async () => {
      saveCalls += 1;
      return { kind: "conflict", serverSnapshotHash: "other", currentDraftRevision: 5, currentPostRevision: 3 };
    },
    persistLocal: () => true,
    onState: () => {},
    timers: clock.api,
  });

  engine.update({ content: "x" });
  clock.advance(1600);
  await clock.flush();
  assert.equal(engine.getState(), "conflict");

  // 冲突后再输入：不自动重试（等用户确认）
  engine.update({ content: "y" });
  clock.advance(5000);
  await clock.flush();
  assert.equal(engine.getState(), "conflict", "冲突态不得自动重试");
  assert.equal(saveCalls, 1, "409 之后不应再自动发请求");
  engine.destroy();
});

test("状态机：5xx 有界退避，耗尽后 failed", async () => {
  const clock = fakeTimers();
  let calls = 0;
  const engine = new AutosaveEngine({
    save: async () => { calls += 1; return { kind: "retryable", message: "500" }; },
    persistLocal: () => true,
    timers: clock.api,
    maxRetries: 2,
  });

  engine.update({ content: "x" });
  clock.advance(1600);            // 第一次请求
  await clock.flush();
  assert.equal(calls, 1);
  assert.equal(engine.getState(), "dirty", "可重试时应回到 dirty 等待退避");

  clock.advance(1100);            // 退避 1s 后重试
  await clock.flush();
  assert.equal(calls, 2);

  clock.advance(2100);            // 退避 2s 后重试（第 3 次）
  await clock.flush();
  assert.equal(calls, 3);

  clock.advance(4100);
  await clock.flush();
  assert.equal(engine.getState(), "failed", "超过最大重试次数应 failed");
  engine.destroy();
});

test("状态机：4xx 校验错误不盲目重试", async () => {
  const clock = fakeTimers();
  let calls = 0;
  const engine = new AutosaveEngine({
    save: async () => { calls += 1; return { kind: "invalid", message: "快照缺字段" }; },
    persistLocal: () => true,
    timers: clock.api,
  });

  engine.update({ content: "x" });
  clock.advance(1600);
  await clock.flush();
  assert.equal(engine.getState(), "failed");
  clock.advance(10000);
  await clock.flush();
  assert.equal(calls, 1, "400 不应重试");
  engine.destroy();
});

test("状态机：网络超时进入 unknown，且不清本地", async () => {
  const clock = fakeTimers();
  let localWrites = 0;
  const engine = new AutosaveEngine({
    save: async () => { throw new Error("timeout"); },
    persistLocal: () => { localWrites += 1; return true; },
    timers: clock.api,
  });

  engine.update({ content: "x" });
  clock.advance(1600);
  await clock.flush();
  assert.equal(engine.getState(), "unknown");
  // unknown 时必须把当前内存快照立刻落本地（方案 §8.2 末段）
  assert.ok(localWrites > 0, "unknown 时必须 flush 本地快照");
  engine.destroy();
});

test("状态机：401/403 也不清本地恢复数据", async () => {
  const clock = fakeTimers();
  let cleared = false;
  const engine = new AutosaveEngine({
    save: async () => ({ kind: "forbidden", message: "401" }),
    persistLocal: () => { cleared = false; return true; },  // persistLocal 只写不清
    timers: clock.api,
  });
  engine.update({ content: "x" });
  clock.advance(1600);
  await clock.flush();
  assert.equal(engine.getState(), "failed");
  assert.equal(cleared, false);
  engine.destroy();
});

test("状态机：150ms 节流写本地，不是每次按键都写", async () => {
  const clock = fakeTimers();
  let writes = 0;
  const engine = new AutosaveEngine({
    save: async () => ({ kind: "ok", identity: identity() }),
    persistLocal: () => { writes += 1; return true; },
    timers: clock.api,
  });

  // 连续 5 次输入（模拟快速打字）
  for (let i = 0; i < 5; i++) engine.update({ content: "typing " + i });
  assert.equal(writes, 0, "节流未到期不应写本地");

  clock.advance(160);
  assert.equal(writes, 1, "150ms 节流内多次输入只写一次");
  engine.destroy();
});

test("状态机：flushLocalNow 立即落盘（pagehide/visibilitychange 用）", () => {
  const clock = fakeTimers();
  let writes = 0;
  const engine = new AutosaveEngine({
    save: async () => ({ kind: "ok", identity: identity() }),
    persistLocal: () => { writes += 1; return true; },
    timers: clock.api,
  });
  engine.update({ content: "x" });
  assert.equal(writes, 0);
  engine.flushLocalNow();
  assert.equal(writes, 1, "flushLocalNow 必须同步立即写");
  engine.destroy();
});

test("状态机：queued 之后成功，用最新身份保存最新快照", async () => {
  const clock = fakeTimers();
  const sent: unknown[] = [];
  let release!: (o: SaveOutcome) => void;
  const engine = new AutosaveEngine({
    save: (snap) => {
      sent.push(snap);
      return new Promise<SaveOutcome>((res) => { release = res; });
    },
    persistLocal: () => true,
    timers: clock.api,
  });

  engine.update({ content: "v1" });
  clock.advance(1600);
  await clock.flush();
  release({ kind: "ok", identity: identity({ draftRevision: 2 }) });
  await clock.flush();

  // 第二次发送的必须是"最新的"内容
  engine.update({ content: "v2" });
  engine.update({ content: "v3" });
  clock.advance(1600);
  await clock.flush();
  assert.deepEqual(sent.at(-1), { content: "v3" }, "必须发送最新快照，不是排队的旧值");
  release({ kind: "ok", identity: identity({ draftRevision: 3 }) });
  await clock.flush();
  engine.destroy();
});

/* ══════════════════════════════════════════════════════════════════
   §8.2 超时核对
   ══════════════════════════════════════════════════════════════════ */

const pre = identity({ draftRevision: 3, snapshotHash: "h-old", baseRevision: 2 });

test("核对：完全匹配 -> already-saved", () => {
  const r = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    { identity: identity({ draftRevision: 4, snapshotHash: "h-sent" }), snapshotHash: "h-sent", draftRevision: 4, baseRevision: 2 },
    2
  );
  assert.equal(r.kind, "already-saved");
});

test("核对：hash 相同但版本更大 -> synced-newer（不能清本地新编辑）", () => {
  const r = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    { identity: identity({ draftRevision: 6, snapshotHash: "h-sent" }), snapshotHash: "h-sent", draftRevision: 6, baseRevision: 2 },
    2
  );
  assert.equal(r.kind, "synced-newer");
});

test("核对：posts 基线变化 -> base-revision-conflict", () => {
  const r = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    { identity: identity({ draftRevision: 4, snapshotHash: "h-sent" }), snapshotHash: "h-sent", draftRevision: 4, baseRevision: 9 },
    9   // 当前 posts.revision 变了
  );
  assert.equal(r.kind, "base-revision-conflict");
});

test("核对：draftRevision 未变但 hash 变了 -> inconsistent-state（禁止直接重试）", () => {
  const r = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    // 版本没涨（仍 3），但内容既不是我们发的、也不是发送前的
    { identity: identity({ draftRevision: 3, snapshotHash: "h-mystery" }), snapshotHash: "h-mystery", draftRevision: 3, baseRevision: 2 },
    2
  );
  assert.equal(r.kind, "inconsistent-state");
});

test("核对：服务端仍是发送前状态 -> not-sent（可安全重试）", () => {
  const r = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    { identity: identity({ draftRevision: 3, snapshotHash: "h-old" }), snapshotHash: "h-old", draftRevision: 3, baseRevision: 2 },
    2
  );
  assert.equal(r.kind, "not-sent");
});

test("核对：hash 不同且版本更大 -> draft-revision-conflict", () => {
  const r = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    { identity: identity({ draftRevision: 7, snapshotHash: "h-other" }), snapshotHash: "h-other", draftRevision: 7, baseRevision: 2 },
    2
  );
  assert.equal(r.kind, "draft-revision-conflict");
});

test("核对：首次保存且服务端无草稿 -> not-sent", () => {
  const r = classifyReconcile(
    { preIdentity: null, sentSnapshotHash: "h-sent", expectedDraftRevision: 1 },
    null,
    1
  );
  assert.equal(r.kind, "not-sent");
});

test("核对：有历史草稿但服务端查不到 -> unknown（不盲目覆盖）", () => {
  const r = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    null,
    2
  );
  assert.equal(r.kind, "unknown");
});

test("核对：正常未发送与服务端被绕过写入必须区分开", () => {
  // 同一个"hash 不同"，但一个版本没动、一个动了 —— 处理方式完全不同
  const notSent = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    { identity: identity({ draftRevision: 3, snapshotHash: "h-old" }), snapshotHash: "h-old", draftRevision: 3, baseRevision: 2 },
    2
  );
  const inconsistent = classifyReconcile(
    { preIdentity: pre, sentSnapshotHash: "h-sent", expectedDraftRevision: 4 },
    { identity: identity({ draftRevision: 3, snapshotHash: "h-mystery" }), snapshotHash: "h-mystery", draftRevision: 3, baseRevision: 2 },
    2
  );
  assert.equal(notSent.kind, "not-sent");
  assert.equal(inconsistent.kind, "inconsistent-state");
  assert.notEqual(notSent.kind, inconsistent.kind);
});

/* ══════════════════════════════════════════════════════════════════
   §8.3 本地键与清理
   ══════════════════════════════════════════════════════════════════ */

function memStorage(failing = false) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failing) throw new Error("QuotaExceededError");
      m.set(k, v);
    },
    removeItem: (k: string) => { m.delete(k); },
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
  };
}

test("本地键格式符合 §8.3 约定", () => {
  assert.equal(draftKey(7, "cid-abc"), "draft:7:cid-abc");
  assert.equal(postMapKey(7, 42), "draft-post:7:42");
});

test("本地草稿：存/取/清完整往返", () => {
  const store = createLocalStore(memStorage());
  const d: LocalDraft = {
    clientDraftId: "cid-1", postId: 5, baseRevision: 2, draftRevision: 3,
    snapshot: { title: "标题", content: "正文" },
    localSnapshotId: 10, confirmedHash: "h", savedAt: new Date().toISOString(),
  };
  assert.equal(store.save(d), true);
  const back = store.load(1, "cid-1");
  assert.deepEqual(back?.snapshot, { title: "标题", content: "正文" });
  assert.equal(back?.localSnapshotId, 10);

  store.clear(1, "cid-1", 5);
  assert.equal(store.load(1, "cid-1"), null);
});

test("本地草稿：配额失败返回 false，且绝不降级成假草稿", () => {
  const store = createLocalStore(memStorage(true));
  const ok = store.save({
    clientDraftId: "cid-1", postId: null, baseRevision: 1, draftRevision: 1,
    snapshot: { title: "t" }, localSnapshotId: 1, confirmedHash: null, savedAt: "x",
  });
  assert.equal(ok, false, "写入失败必须如实返回 false");
  // 失败后不应留下任何"摘要/假草稿"
  assert.equal(store.load(1, "cid-1"), null);
});

test("本地草稿：损坏 JSON 视为没有，不假装能恢复", () => {
  const storage = memStorage();
  storage.setItem(draftKey(0, "cid-bad"), "{not json");
  const store = createLocalStore(storage);
  assert.equal(store.load(1, "cid-bad"), null);
});

test("本地草稿：缺 snapshot 的残缺数据不当作可恢复草稿", () => {
  const storage = memStorage();
  storage.setItem(draftKey(0, "cid-partial"), JSON.stringify({ clientDraftId: "cid-partial", savedAt: "x" }));
  const store = createLocalStore(storage);
  assert.equal(store.load(1, "cid-partial"), null);
});

test("canClearLocal：保存期间有新输入时不得清本地副本", () => {
  // 服务端确认的是第 5 份，但用户已经输入到第 6 份
  assert.equal(canClearLocal({ confirmedSnapshotId: 5, currentLocalSnapshotId: 6, queued: false }), false);
  // 有 queued 时也不清
  assert.equal(canClearLocal({ confirmedSnapshotId: 5, currentLocalSnapshotId: 5, queued: true }), false);
  // 确认的就是最新那份，且没排队 -> 可以清
  assert.equal(canClearLocal({ confirmedSnapshotId: 5, currentLocalSnapshotId: 5, queued: false }), true);
});

test("本地不可用时给出常驻警告并要求导出/存服务端", () => {
  const f = localUnavailableFallback("quota");
  assert.equal(f.persistentWarning, true);
  assert.equal(f.advice, "export-or-save-server");
  assert.match(f.message, /导出/);
  // 明确告知风险，而不是含糊地"可能有问题"
  assert.match(f.message, /丢失/);
});
