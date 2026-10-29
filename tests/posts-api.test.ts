import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { isolatedDataDir, installTestSession, assertIsolatedDataDir } from "./helpers/isolated-db.ts";

/**
 * 阶段 03.1 数据协议测试（方案 §11.1 数据安全硬门槛）。
 *
 * 这个文件在阶段 00 时是"长期行为测试 + 4 条 KNOWN-DEFECT pin"。
 * 03.1 修掉那四条缺陷后，pin 按原约定**改写成正向契约测试** ——
 * 断言"现在是对的"，而不是"现在确实坏成这样"。
 */

const isolated = isolatedDataDir("posts-api-");
process.env.DATA_DIR = isolated.dir;
const dbMod = await import("../lib/db.ts");
const postsRoute = await import("../app/api/admin/posts/route.ts");
const postRoute = await import("../app/api/admin/posts/[id]/route.ts");
const bulkRoute = await import("../app/api/admin/posts/bulk/route.ts");
const draftRoute = await import("../app/api/admin/posts/[id]/draft/route.ts");
const draftsNewRoute = await import("../app/api/admin/drafts/[clientDraftId]/route.ts");
const publishRoute = await import("../app/api/admin/posts/[id]/publish/route.ts");
const publishResultRoute = await import("../app/api/admin/posts/[id]/publish-result/route.ts");
const restoreVersionRoute = await import("../app/api/admin/posts/[id]/restore-version/route.ts");
const publicPosts = await import("../lib/posts.ts");
const snapshotMod = await import("../lib/snapshot.ts");

let userId = 0;
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const clientParams = (cid: string) => ({ params: Promise.resolve({ clientDraftId: cid }) });

function request(url: string, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(url, {
    method: init.method ?? "GET",
    ...(init.body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(init.body),
    }),
  });
}

function row(id: number): any {
  return dbMod.getDb().prepare("SELECT * FROM posts WHERE id = ?").get(id);
}
function draftRow(id: number): any {
  return dbMod.getDb().prepare("SELECT * FROM post_drafts WHERE post_id = ?").get(id);
}
function revisionCount(id: number): number {
  return (dbMod.getDb().prepare("SELECT COUNT(*) c FROM post_revisions WHERE post_id = ?").get(id) as any).c;
}
function auditCount(action: string, id: number): number {
  return (dbMod.getDb().prepare("SELECT COUNT(*) c FROM audit_log WHERE action = ? AND target_id = ?")
    .get(action, String(id)) as any).c;
}

/** 用新文章接口创建"壳 + 草稿"，返回 {postId, identity} */
async function createWithDraft(opts: { cid?: string; snapshot?: Record<string, unknown> } = {}) {
  const cid = opts.cid ?? "cid-" + Math.random().toString(36).slice(2, 10);
  const snap = {
    type: "post",
    title: "测试文章",
    slug: "test-post",
    content: "# 标题\n\n正文",
    cover: null as string | null,
    categories: [] as string[],
    tags: [] as string[],
    comments_enabled: 1 as const,
    ...opts.snapshot,
  };
  const res = await draftsNewRoute.PUT(
    request("http://test.local/api/admin/drafts/" + cid, { method: "PUT", body: { snapshot: snap } }),
    clientParams(cid)
  );
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  return { postId: body.identity.postId as number, identity: body.identity, snapshot: snap, cid };
}

async function saveDraft(postId: number, cid: string, snapshot: Record<string, unknown>, identity: any) {
  return draftRoute.PUT(
    request("http://test.local/api/admin/posts/" + postId + "/draft", {
      method: "PUT",
      body: {
        clientDraftId: cid,
        snapshot,
        expectedPostRevision: identity.baseRevision,
        expectedDraftRevision: identity.draftRevision,
      },
    }),
    params(postId)
  );
}

async function publish(
  postId: number,
  cid: string,
  opts: { requestId?: string; slug?: string; expectedPostRevision?: number; expectedDraftRevision?: number } = {}
) {
  const d = draftRow(postId);
  return publishRoute.POST(
    request("http://test.local/api/admin/posts/" + postId + "/publish", {
      method: "POST",
      body: {
        publishRequestId: opts.requestId ?? "req-" + Math.random().toString(36).slice(2, 12),
        expectedPostRevision: opts.expectedPostRevision ?? row(postId).revision,
        expectedDraftRevision: opts.expectedDraftRevision ?? (d ? d.draft_revision : 0),
        slug: opts.slug,
      },
    }),
    params(postId)
  );
}

before(() => {
  const session = installTestSession(dbMod.getDb());
  userId = session.userId;
});
after(() => {
  (globalThis as any).__blogTestNext.cookies = () => ({ get: () => undefined });
  dbMod.closeDb();
  isolated.cleanup();
});

/* ══════════════════════════════════════════════════════════════════
   基础：隔离与鉴权
   ══════════════════════════════════════════════════════════════════ */

test("fixture refuses the development database and uses a fresh temporary database", () => {
  assert.throws(() => assertIsolatedDataDir("data"), /isolated temporary/);
  assert.equal(dbMod.dbPath(), isolated.dbPath);
  assert.equal((dbMod.getDb().prepare("SELECT COUNT(*) c FROM posts").get() as any).c, 0);
  assert.ok(userId > 0);
});

test("admin post API rejects unauthenticated requests without writing", async () => {
  const count = (dbMod.getDb().prepare("SELECT COUNT(*) c FROM posts").get() as any).c;
  (globalThis as any).__blogTestNext.cookies = () => ({ get: () => undefined });
  const res = await postsRoute.POST(request("http://test.local/api/admin/posts", { method: "POST", body: {} }));
  assert.equal(res.status, 401);
  assert.equal((dbMod.getDb().prepare("SELECT COUNT(*) c FROM posts").get() as any).c, count);
  // 重新装会话时**必须更新 userId**：installTestSession 会删掉并重建 test-admin，
  // 旧的 userId 从此悬空。后续用它写 audit_log 会撞 users 的外键
  // （actor_user_id REFERENCES users(id)），报一个与真实原因无关的
  // "FOREIGN KEY constraint failed"。
  userId = installTestSession(dbMod.getDb()).userId;
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 1：自动保存 10 次后 posts 全行逐字段不变
   ══════════════════════════════════════════════════════════════════ */

test("门槛1: saving a draft 10 times leaves the published posts row byte-identical", async () => {
  const { postId, cid } = await createWithDraft({
    snapshot: { title: "已发布", slug: "published-1", content: "原始正文" },
  });
  const pub = await publish(postId, cid, { slug: "published-1" });
  assert.equal(pub.status, 200, await pub.text());
  assert.equal(row(postId).status, "published");

  const before = JSON.stringify(row(postId));

  let identity: any = { baseRevision: row(postId).revision, draftRevision: 0 };
  for (let i = 1; i <= 10; i++) {
    const res = await saveDraft(postId, cid, {
      type: "post", title: "改过的标题 " + i, slug: "changed-" + i,
      content: "改过的正文 " + i, cover: null, categories: ["新分类"], tags: ["新标签"],
      comments_enabled: 1,
    }, identity);
    // 只读一次 body：Response 的 body 只能消费一次，
    // 先 text() 再 json() 会抛 "Body is unusable"（这坑在断言失败时才暴露，
    // 成功路径上看起来一切正常，所以更要一次读干净）
    const text = await res.text();
    assert.equal(res.status, 200, text);
    identity = JSON.parse(text).identity;
  }

  assert.equal(JSON.stringify(row(postId)), before, "草稿保存不得改动 posts 任何字段");
  assert.equal(draftRow(postId).draft_revision, 10);
  assert.equal(publicPosts.getPostBySlug("published-1")?.content, "原始正文");
  assert.equal(publicPosts.resolveSlug("changed-10").post, undefined);
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 3：新文章壳与草稿不出现在任何公开面
   ══════════════════════════════════════════════════════════════════ */

test("门槛3: new shells and drafts never appear on public surfaces", async () => {
  const { postId, snapshot } = await createWithDraft({
    snapshot: { title: "秘密草稿", slug: "secret-draft", content: "不可见内容" },
  });
  assert.equal(row(postId).status, "draft");
  assert.equal(row(postId).published_at, null);
  assert.equal(row(postId).revision, 1);

  assert.match(row(postId).slug, /^draft-/, "壳 slug 必须是 draft-<hex> 保留值");
  assert.notEqual(row(postId).slug, snapshot.slug);

  assert.equal(publicPosts.resolveSlug("secret-draft").post, undefined);
  assert.equal(publicPosts.getPostBySlug("secret-draft"), undefined);
  assert.equal(publicPosts.listPosts().some((p) => p.id === postId), false);
  assert.equal(
    publicPosts.listArchives().some((y) => y.months.some((m) => m.posts.some((p) => p.id === postId))),
    false
  );
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 4：发布 revision 恰好 +1、历史不可变、草稿清理、审计恰好一条
   ══════════════════════════════════════════════════════════════════ */

test("门槛4: publish bumps revision by exactly 1, writes one immutable revision, clears draft, one strict audit", async () => {
  const { postId, cid } = await createWithDraft({
    snapshot: { title: "发布测试", slug: "publish-once", content: "正文 A" },
  });
  const revBefore = row(postId).revision;
  const histBefore = revisionCount(postId);
  const auditBefore = auditCount("post.publish", postId);

  const res = await publish(postId, cid, { slug: "publish-once", requestId: "req-once-1" });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  assert.equal(row(postId).revision, revBefore + 1, "revision 必须恰好 +1");
  assert.equal(row(postId).status, "published");
  assert.equal(revisionCount(postId), histBefore + 1);
  assert.equal(auditCount("post.publish", postId), auditBefore + 1, "强制审计恰好一条");
  assert.equal(draftRow(postId), undefined, "发布后草稿必须清理");

  const hist = dbMod.getDb().prepare(
    "SELECT snapshot_json, snapshot_hash, reason, revision FROM post_revisions WHERE post_id = ? ORDER BY id DESC LIMIT 1"
  ).get(postId) as any;
  assert.equal(hist.reason, "publish");
  assert.equal(hist.revision, revBefore + 1);
  assert.equal(JSON.parse(hist.snapshot_json).content, "正文 A");
  assert.equal(hist.snapshot_hash, snapshotMod.hashSnapshot(hist.snapshot_json));
  assert.equal(row(postId).content, "正文 A");
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 8：发布响应丢失后重试不重复发布/历史/审计
   ══════════════════════════════════════════════════════════════════ */

test("门槛8: re-publishing with the same requestId is idempotent (no double posts/revision/audit)", async () => {
  const { postId, cid } = await createWithDraft({
    snapshot: { title: "幂等测试", slug: "idem-1", content: "正文" },
  });
  const requestId = "req-idem-fixed";

  const first = await publish(postId, cid, { slug: "idem-1", requestId });
  assert.equal(first.status, 200, await first.text());
  const revAfterFirst = row(postId).revision;
  const histAfterFirst = revisionCount(postId);
  const auditAfterFirst = auditCount("post.publish", postId);

  const second = await publish(postId, cid, { slug: "idem-1", requestId });
  const body = await second.json();
  assert.equal(second.status, 200, JSON.stringify(body));
  assert.equal(body.replayed, true, "同请求重试应标记 replayed");

  assert.equal(row(postId).revision, revAfterFirst, "不得再次递增 revision");
  assert.equal(revisionCount(postId), histAfterFirst, "不得重复追加历史");
  assert.equal(auditCount("post.publish", postId), auditAfterFirst, "不得重复写审计");
});

test("门槛8b: publish-result lets a client reconcile after a lost response", async () => {
  const { postId, cid } = await createWithDraft({
    snapshot: { title: "核对测试", slug: "result-1", content: "正文" },
  });
  const requestId = "req-result-fixed";
  await publish(postId, cid, { slug: "result-1", requestId });

  const miss = await publishResultRoute.GET(
    request("http://test.local/api/admin/posts/" + postId + "/publish-result?requestId=nope"),
    params(postId)
  );
  assert.equal(miss.status, 200);
  assert.equal((await miss.json()).found, false);

  const hit = await publishResultRoute.GET(
    request("http://test.local/api/admin/posts/" + postId + "/publish-result?requestId=" + requestId),
    params(postId)
  );
  const hitBody = await hit.json();
  assert.equal(hitBody.found, true);
  assert.equal(hitBody.revision, row(postId).revision);
  assert.equal(hitBody.slug, "result-1");
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 6：无草稿首次保存用旧 expectedPostRevision -> 基线冲突
   ══════════════════════════════════════════════════════════════════ */

test("门槛6: first draft save with a stale expectedPostRevision returns BASE_REVISION_CONFLICT (no auto-rebase)", async () => {
  const { postId, snapshot } = await createWithDraft({ snapshot: { title: "旧版本", slug: "stale-1" } });
  dbMod.getDb().prepare("DELETE FROM post_drafts WHERE post_id = ?").run(postId);

  const res = await draftRoute.PUT(
    request("http://test.local/api/admin/posts/" + postId + "/draft", {
      method: "PUT",
      body: {
        clientDraftId: "cid-stale",
        snapshot: { ...snapshot, slug: "stale-1" },
        expectedPostRevision: 999,
        expectedDraftRevision: 0,
      },
    }),
    params(postId)
  );
  const body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, "BASE_REVISION_CONFLICT");
  assert.equal(draftRow(postId), undefined, "不得自动 rebase");
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 7：同 clientDraftId 重试不重复创建；不同快照不静默丢弃
   ══════════════════════════════════════════════════════════════════ */

test("门槛7: same clientDraftId retry does not create a second shell; different snapshot is not silently dropped", async () => {
  const cid = "cid-retry-fixed";
  const snap = {
    type: "post", title: "重试", slug: "retry-1", content: "正文",
    cover: null, categories: [], tags: [], comments_enabled: 1,
  };

  const r1 = await draftsNewRoute.PUT(
    request("http://test.local/api/admin/drafts/" + cid, { method: "PUT", body: { snapshot: snap } }),
    clientParams(cid)
  );
  const b1 = await r1.json();
  assert.equal(r1.status, 200);

  const r2 = await draftsNewRoute.PUT(
    request("http://test.local/api/admin/drafts/" + cid, { method: "PUT", body: { snapshot: snap } }),
    clientParams(cid)
  );
  const b2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(b2.identity.postId, b1.identity.postId, "同 clientDraftId 不得创建第二篇");
  assert.equal(b2.unchanged, true);

  const r3 = await draftsNewRoute.PUT(
    request("http://test.local/api/admin/drafts/" + cid, {
      method: "PUT",
      body: { snapshot: { ...snap, content: "完全不同的正文" } },
    }),
    clientParams(cid)
  );
  assert.equal(r3.status, 409, "不同快照且无版本必须 409");
  assert.equal((await r3.json()).code, "DRAFT_REVISION_CONFLICT");
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 5：恢复历史只改草稿，发布才追加历史，revision 不回退
   ══════════════════════════════════════════════════════════════════ */

test("门槛5: restoring a version only replaces the draft; publishing afterwards appends history and never rewinds revision", async () => {
  const { postId, cid } = await createWithDraft({
    snapshot: { title: "版本一", slug: "ver-1", content: "内容一" },
  });
  await publish(postId, cid, { slug: "ver-1" });
  const revAfterFirstPublish = row(postId).revision;
  const histAfterFirst = revisionCount(postId);

  const d1 = await saveDraft(postId, "cid-ver", {
    type: "post", title: "版本二", slug: "ver-1", content: "内容二",
    cover: null, categories: [], tags: [], comments_enabled: 1,
  }, { baseRevision: row(postId).revision, draftRevision: 0 });
  assert.equal(d1.status, 200, await d1.text());
  await publish(postId, "cid-ver", { slug: "ver-1" });
  const revAfterSecond = row(postId).revision;
  assert.equal(revAfterSecond, revAfterFirstPublish + 1);
  assert.equal(row(postId).content, "内容二");

  const versions = await restoreVersionRoute.GET(
    request("http://test.local/api/admin/posts/" + postId + "/restore-version"),
    params(postId)
  );
  const vlist = (await versions.json()).versions;
  const target = vlist.find((v: any) => v.revision === revAfterFirstPublish);
  assert.ok(target, "应该能列出第一次发布的版本");

  const restoreRes = await restoreVersionRoute.POST(
    request("http://test.local/api/admin/posts/" + postId + "/restore-version", {
      method: "POST",
      body: {
        revision: revAfterFirstPublish,
        expectedPostRevision: row(postId).revision,
        expectedDraftRevision: 0,
        clientDraftId: "cid-restore",
      },
    }),
    params(postId)
  );
  const restoreBody = await restoreRes.json();
  assert.equal(restoreRes.status, 200, JSON.stringify(restoreBody));

  assert.equal(row(postId).content, "内容二", "恢复历史不得改动线上内容");
  assert.equal(row(postId).revision, revAfterSecond, "revision 不得回退");
  assert.equal(revisionCount(postId), histAfterFirst + 1, "恢复本身不插入历史");

  assert.equal(JSON.parse(draftRow(postId).snapshot_json).content, "内容一");
  assert.equal(draftRow(postId).base_revision, row(postId).revision, "草稿基线是当前 posts.revision，不是历史 revision");

  await publish(postId, "cid-restore", { slug: "ver-1" });
  assert.equal(row(postId).content, "内容一");
  assert.equal(revisionCount(postId), histAfterFirst + 2);
  assert.equal(row(postId).revision, revAfterSecond + 1, "revision 继续递增，不回退");
});

/* ══════════════════════════════════════════════════════════════════
   pin#1 转正向：正文逐字节保留（不再 trim）
   ══════════════════════════════════════════════════════════════════ */

test("pin#1 转正向: draft/publish preserves significant leading and trailing whitespace", async () => {
  const content = "\n\n# 标题\n\n正文段落\n\n\n";
  const { postId, cid } = await createWithDraft({ snapshot: { title: "空白", slug: "whitespace-1", content } });

  assert.equal(JSON.parse(draftRow(postId).snapshot_json).content, content, "草稿快照必须逐字节保留");

  const pub = await publish(postId, cid, { slug: "whitespace-1" });
  assert.equal(pub.status, 200, await pub.text());
  assert.equal(row(postId).content, content, "发布后正文必须逐字节保留（不再 trim）");
});

/* ══════════════════════════════════════════════════════════════════
   pin#2 转正向：cover:null 能真正清除
   ══════════════════════════════════════════════════════════════════ */

test("pin#2 转正向: PATCH cover:null actually clears the cover (tri-state)", async () => {
  const { postId } = await createWithDraft({ snapshot: { title: "封面", slug: "cover-1" } });

  const set = await postRoute.PATCH(
    request("http://test.local/api/admin/posts/" + postId, {
      method: "PATCH",
      body: { cover: "/images/cover.png", expectedRevision: row(postId).revision },
    }),
    params(postId)
  );
  assert.equal(set.status, 200, await set.text());
  assert.equal(row(postId).cover, "/images/cover.png");

  const clear = await postRoute.PATCH(
    request("http://test.local/api/admin/posts/" + postId, {
      method: "PATCH",
      body: { cover: null, expectedRevision: row(postId).revision },
    }),
    params(postId)
  );
  assert.equal(clear.status, 200, await clear.text());
  assert.equal(row(postId).cover, null, "cover:null 必须真正清除封面");
});

/* ══════════════════════════════════════════════════════════════════
   pin#3 转正向：PATCH 只改传入字段
   ══════════════════════════════════════════════════════════════════ */

test("pin#3 转正向: a title-only PATCH leaves categories and tags untouched", async () => {
  const { postId } = await createWithDraft({ snapshot: { title: "原标题", slug: "tri-1" } });

  await postRoute.PATCH(
    request("http://test.local/api/admin/posts/" + postId, {
      method: "PATCH",
      body: { categories: ["技术"], tags: ["sqlite", "next"], expectedRevision: row(postId).revision },
    }),
    params(postId)
  );
  assert.deepEqual(JSON.parse(row(postId).categories), ["技术"]);
  assert.deepEqual(JSON.parse(row(postId).tags), ["sqlite", "next"]);

  const res = await postRoute.PATCH(
    request("http://test.local/api/admin/posts/" + postId, {
      method: "PATCH",
      body: { title: "只改标题", expectedRevision: row(postId).revision },
    }),
    params(postId)
  );
  assert.equal(res.status, 200, await res.text());
  assert.equal(row(postId).title, "只改标题");
  assert.deepEqual(JSON.parse(row(postId).categories), ["技术"], "未提供的 categories 不得被清空");
  assert.deepEqual(JSON.parse(row(postId).tags), ["sqlite", "next"], "未提供的 tags 不得被清空");
});

/* ══════════════════════════════════════════════════════════════════
   pin#4 转正向：slug 别名与 posts 更新在同一事务
   ══════════════════════════════════════════════════════════════════ */

test("pin#4 转正向: a failed posts update rolls back the alias write too", async () => {
  const { postId } = await createWithDraft({ snapshot: { title: "别名事务", slug: "alias-tx-old" } });
  const db = dbMod.getDb();

  // 先把 posts 的 slug 设成 alias-tx-old（草稿里的拟定 slug 尚未落到 posts，
  // 新建时 posts.slug 还是 draft-xxx 壳值），否则下面的"旧 slug 写别名"用的是壳值
  const seed = await postRoute.PATCH(
    request("http://test.local/api/admin/posts/" + postId, {
      method: "PATCH",
      body: { slug: "alias-tx-old", expectedRevision: row(postId).revision },
    }),
    params(postId)
  );
  assert.equal(seed.status, 200, await seed.text());
  assert.equal(row(postId).slug, "alias-tx-old");

  // 用触发器让 UPDATE posts 失败，观察 alias 是否残留
  db.exec("CREATE TRIGGER IF NOT EXISTS probe_alias_boom BEFORE UPDATE ON posts BEGIN SELECT RAISE(ABORT, 'probe boom'); END;");
  let status = 0;
  try {
    const res = await postRoute.PATCH(
      request("http://test.local/api/admin/posts/" + postId, {
        method: "PATCH",
        body: { slug: "alias-tx-new", expectedRevision: row(postId).revision },
      }),
      params(postId)
    );
    status = res.status;
  } finally {
    db.exec("DROP TRIGGER IF EXISTS probe_alias_boom");
  }

  assert.ok(status >= 500, "UPDATE 失败应表现为服务端错误，实际 " + status);
  assert.equal(row(postId).slug, "alias-tx-old", "文章 slug 未变");
  const alias = db.prepare("SELECT post_id FROM post_aliases WHERE slug = ?").get("alias-tx-old") as any;
  assert.equal(alias, undefined, "别名必须随事务回滚，不得残留");
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 10：完整快照缺字段被拒绝；服务端不信任客户端 hash
   ══════════════════════════════════════════════════════════════════ */

test("门槛10a: incomplete snapshot is rejected with 400", async () => {
  const { postId, cid } = await createWithDraft({});
  const res = await draftRoute.PUT(
    request("http://test.local/api/admin/posts/" + postId + "/draft", {
      method: "PUT",
      body: {
        clientDraftId: cid,
        snapshot: { type: "post", title: "x", slug: "x", content: "y" },
        expectedPostRevision: row(postId).revision,
        expectedDraftRevision: draftRow(postId).draft_revision,
      },
    }),
    params(postId)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "SNAPSHOT_INVALID");
});

test("门槛10b: server rejects a client-supplied hash that does not match", async () => {
  const { postId, cid } = await createWithDraft({});
  const res = await draftRoute.PUT(
    request("http://test.local/api/admin/posts/" + postId + "/draft", {
      method: "PUT",
      body: {
        clientDraftId: cid,
        snapshot: { type: "post", title: "a", slug: "a", content: "b", cover: null, categories: [], tags: [], comments_enabled: 1 },
        snapshotHash: "deadbeef",
        expectedPostRevision: row(postId).revision,
        expectedDraftRevision: draftRow(postId).draft_revision,
      },
    }),
    params(postId)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "CLIENT_HASH_MISMATCH");
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 12：批量逐项结果
   ══════════════════════════════════════════════════════════════════ */

test("门槛12: bulk publish bumps only successful items; items with drafts are skipped", async () => {
  const a = await createWithDraft({ snapshot: { title: "批量A", slug: "bulk-a" } });
  const b = await createWithDraft({ snapshot: { title: "批量B", slug: "bulk-b" } });
  dbMod.getDb().prepare("DELETE FROM post_drafts WHERE post_id = ?").run(a.postId);

  const revA = row(a.postId).revision;
  const revB = row(b.postId).revision;

  const res = await bulkRoute.POST(
    request("http://test.local/api/admin/posts/bulk", {
      method: "POST",
      body: {
        action: "publish",
        items: [
          { id: a.postId, expectedRevision: revA },
          { id: b.postId, expectedRevision: revB },
        ],
      },
    })
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  const resA = body.results.find((r: any) => r.id === a.postId);
  const resB = body.results.find((r: any) => r.id === b.postId);
  assert.equal(resA.ok, true, "A 无草稿，应发布成功");
  assert.equal(resA.outcome, "published");
  assert.equal(row(a.postId).revision, revA + 1, "成功项 revision +1");
  assert.equal(row(a.postId).status, "published");

  assert.equal(resB.ok, false);
  assert.equal(resB.outcome, "skipped");
  assert.equal(resB.code, "HAS_UNPUBLISHED_DRAFT", "有草稿的项必须跳过，不隐式选快照");
  assert.equal(row(b.postId).revision, revB, "跳过项 revision 不变");
  assert.equal(row(b.postId).status, "draft");
});

test("门槛12b: bulk reports conflicts per-item instead of failing the whole batch", async () => {
  const c = await createWithDraft({ snapshot: { title: "冲突C", slug: "bulk-c" } });
  dbMod.getDb().prepare("DELETE FROM post_drafts WHERE post_id = ?").run(c.postId);

  const res = await bulkRoute.POST(
    request("http://test.local/api/admin/posts/bulk", {
      method: "POST",
      body: { action: "publish", items: [{ id: c.postId, expectedRevision: 999 }] },
    })
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.summary.conflicts, 1);
  assert.equal(body.summary.succeeded, 0);
  assert.equal(body.results[0].code, "BASE_REVISION_CONFLICT");
  assert.equal(row(c.postId).status, "draft", "冲突项完全不变");
});

/* ══════════════════════════════════════════════════════════════════
   §11.1 门槛 13：软删后保存 410
   ══════════════════════════════════════════════════════════════════ */

test("门槛13: saving a draft after soft delete returns 410", async () => {
  const { postId, cid, snapshot } = await createWithDraft({ snapshot: { title: "删除后", slug: "deleted-1" } });
  const d = draftRow(postId);

  // 直接走写核心的软删（绕过 step-up 的外层鉴权，专注验证保存语义）
  const { softDeletePost } = await import("../lib/post-writes.ts");
  softDeletePost({
    db: dbMod.getDb(),
    postId,
    actor: { userId, userName: "test-admin" },
    expectedRevision: row(postId).revision,
  });

  const res = await draftRoute.PUT(
    request("http://test.local/api/admin/posts/" + postId + "/draft", {
      method: "PUT",
      body: {
        clientDraftId: cid,
        snapshot: { ...snapshot },
        expectedPostRevision: row(postId).revision,
        expectedDraftRevision: d.draft_revision,
      },
    }),
    params(postId)
  );
  const body = await res.json();
  assert.equal(res.status, 410, JSON.stringify(body));
  assert.equal(body.code, "ARTICLE_GONE");
});

/* ══════════════════════════════════════════════════════════════════
   §4.3 草稿身份一致性
   ══════════════════════════════════════════════════════════════════ */

test("draft identity: a mismatched clientDraftId is rejected, not silently accepted", async () => {
  const { postId, snapshot } = await createWithDraft({});
  const d = draftRow(postId);

  const res = await draftRoute.PUT(
    request("http://test.local/api/admin/posts/" + postId + "/draft", {
      method: "PUT",
      body: {
        clientDraftId: "completely-different-cid",
        snapshot: { ...snapshot, content: "改过" },
        expectedPostRevision: row(postId).revision,
        expectedDraftRevision: d.draft_revision,
      },
    }),
    params(postId)
  );
  assert.equal(res.status, 403, "身份不一致必须拒绝");
  assert.equal((await res.json()).code, "DRAFT_FORBIDDEN");
});

/* ══════════════════════════════════════════════════════════════════
   版本校验必需：没有"跳过并发检查"的开关
   ══════════════════════════════════════════════════════════════════ */

test("metadata PATCH requires expectedRevision and rejects a stale one", async () => {
  const { postId } = await createWithDraft({});

  const missing = await postRoute.PATCH(
    request("http://test.local/api/admin/posts/" + postId, { method: "PATCH", body: { title: "x" } }),
    params(postId)
  );
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "REVISION_REQUIRED");

  const stale = await postRoute.PATCH(
    request("http://test.local/api/admin/posts/" + postId, {
      method: "PATCH",
      body: { title: "x", expectedRevision: 999 },
    }),
    params(postId)
  );
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "BASE_REVISION_CONFLICT");
});

/* ══════════════════════════════════════════════════════════════════
   快照 canonicalize / hash 的纯函数契约
   ══════════════════════════════════════════════════════════════════ */

test("snapshot: canonicalize keeps field order and preserves array order", () => {
  const snap = {
    type: "post" as const, title: "T", slug: "s", content: "c",
    cover: null, categories: ["乙", "甲"], tags: ["z", "a"], comments_enabled: 1 as const,
  };
  const json = snapshotMod.canonicalize(snap);
  assert.equal(json, JSON.stringify({
    type: "post", title: "T", slug: "s", content: "c",
    cover: null, categories: ["乙", "甲"], tags: ["z", "a"], comments_enabled: 1,
  }));
  assert.deepEqual(JSON.parse(json).categories, ["乙", "甲"]);
  assert.equal(snapshotMod.hashSnapshot(json).length, 64);
  assert.notEqual(
    snapshotMod.hashSnapshot(json),
    snapshotMod.hashSnapshot(json.replace('"z"', '"a"'))
  );
});

test("snapshot: title/content are not trimmed during canonicalization", () => {
  const snap = {
    type: "post" as const, title: "  有空格  ", slug: "s", content: "\n\n正文\n\n",
    cover: null, categories: [], tags: [], comments_enabled: 1 as const,
  };
  const json = snapshotMod.canonicalize(snap);
  assert.equal(JSON.parse(json).title, "  有空格  ");
  assert.equal(JSON.parse(json).content, "\n\n正文\n\n");
});

test("snapshot: excerpt 是可选字段，历史快照的哈希不受影响", () => {
  const legacy = {
    type: "post" as const, title: "T", slug: "s", content: "c",
    cover: null, categories: [], tags: [], comments_enabled: 1 as const,
  };
  const json = snapshotMod.canonicalize(legacy);
  // 没有 excerpt 键时 canonicalize 不得凭空写一个 —— 否则所有历史快照哈希都会变
  assert.ok(!json.includes("excerpt"), "无 excerpt 时不得生成该键：" + json);

  const withExcerpt = snapshotMod.parseSnapshot({ ...legacy, excerpt: "手写摘要" });
  assert.equal(withExcerpt.ok, true);
  if (withExcerpt.ok) assert.equal(withExcerpt.snapshot.excerpt, "手写摘要");

  // 出现但类型不对要拒
  const bad = snapshotMod.parseSnapshot({ ...legacy, excerpt: 42 });
  assert.equal(bad.ok, false);

  // 留空字符串是合法的"没有自定义摘要"
  const empty = snapshotMod.parseSnapshot({ ...legacy, excerpt: "" });
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.snapshot.excerpt, "");
});

test("snapshot: parseSnapshot rejects missing cover and wrong types", () => {
  const noCover = snapshotMod.parseSnapshot({
    type: "post", title: "t", slug: "s", content: "c", categories: [], tags: [], comments_enabled: 1,
  });
  assert.equal(noCover.ok, false);

  const badType = snapshotMod.parseSnapshot({
    type: "nope", title: "t", slug: "s", content: "c", cover: null, categories: [], tags: [], comments_enabled: 1,
  });
  assert.equal(badType.ok, false);

  const ok = snapshotMod.parseSnapshot({
    type: "post", title: "t", slug: "s", content: "c", cover: null, categories: [], tags: [], comments_enabled: 1,
  });
  assert.equal(ok.ok, true);
});
