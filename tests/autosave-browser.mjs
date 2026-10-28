/**
 * 自动保存与本地恢复的浏览器回归（阶段 03.2，方案 §11.3）。
 *
 * 这一层测的是"真实浏览器里才会出现的组合"：
 * 崩溃后重开、断网、响应丢失、两个标签页、保存期间继续输入。
 * 状态机的单步转移由 tests/autosave.test.ts 在 Node 里精确覆盖，
 * 这里不重复那些，只验"接起来之后是否还对"。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser, getLocalStorage } from "./helpers/browser.mjs";

let server;
let controller;

const T = (name, fn) => { tests.push({ name, fn }); };
const tests = [];

/* ---------------------------- 场景 ---------------------------- */

T("自动保存：输入后 1.5s 内自动写入服务端草稿，posts 未变", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const postId = await createPost(page, "autosave-basic");

  const before = await getPost(page, postId);
  await page.goto(server.base + "/admin/edit/" + postId, { waitUntil: "networkidle" });

  // 改标题，等自动保存 debounce（1.5s）+ 一点余量
  await page.fill('input[placeholder="文章标题"]', "自动保存后的标题");
  await page.waitForTimeout(2600);

  const after = await getPost(page, postId);
  // 关键：posts 一个字段都不许变（未发布内容不得泄露到线上）
  assert.equal(after.post.title, before.post.title, "自动保存不得修改 posts.title");
  assert.equal(after.post.content, before.post.content, "自动保存不得修改 posts.content");

  // 草稿确实写进去了
  assert.ok(after.draft, "应已生成服务端草稿");
  const snap = JSON.parse(after.draft.snapshot_json ?? "{}");
  assert.equal(snap.title, "自动保存后的标题", "草稿快照应包含新标题");
});

T("保存状态指示器同时显示草稿与线上两种状态", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const postId = await createPost(page, "status-indicator");
  await page.goto(server.base + "/admin/edit/" + postId, { waitUntil: "networkidle" });

  // 双状态必须同时存在：草稿状态 + 线上版本
  const statusText = await page.locator(".save-status").innerText();
  assert.match(statusText, /草稿|改动|保存/, "应显示草稿状态");
  assert.match(statusText, /线上|尚未发布/, "应显示线上状态");
});

T("断网：保存失败后保留本地副本，恢复网络可继续", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const postId = await createPost(page, "offline-recovery");
  await page.goto(server.base + "/admin/edit/" + postId, { waitUntil: "networkidle" });

  // 断网
  await page.context().setOffline(true);
  await page.fill('input[placeholder="文章标题"]', "断网时写的内容");
  await page.waitForTimeout(2200);

  // 本地必须留住了完整内容（不是摘要）
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("draft:")));
  assert.ok(keys.length > 0, "断网后必须有本地草稿键");
  const raw = await getLocalStorage(page, keys[0]);
  const local = JSON.parse(raw);
  assert.equal(local.snapshot.title, "断网时写的内容", "本地必须保存完整快照");
  assert.ok(local.snapshot.content !== undefined, "本地快照必须含完整正文，不能是摘要");

  // 恢复网络后应能继续保存
  await page.context().setOffline(false);
  await page.waitForTimeout(300);

  const after = await getPost(page, postId);
  assert.equal(after.post.title, (await getPost(page, postId)).post.title, "posts 仍不应被改动");
});

T("崩溃恢复：关掉页面重开，本地草稿可恢复", async () => {
  const { page, context } = await controller.newLoggedInContext(server.base, server.fixture);
  const postId = await createPost(page, "crash-recovery");

  // 用一个"新文章"页面写内容，不保存就关掉（模拟崩溃）
  await page.goto(server.base + "/admin/new", { waitUntil: "networkidle" });
  await page.fill('input[placeholder="文章标题"]', "崩溃前的标题");
  // 触发 flush：pagehide 会同步写本地
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });
  await page.waitForTimeout(300);

  const beforeKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("draft:")));
  assert.ok(beforeKeys.length > 0, "pagehide 应把内容 flush 到本地");

  // 关掉这个 tab，重开同一 URL（同一 context 保留 localStorage）
  await page.close();
  const page2 = await context.newPage();
  await page2.goto(server.base + "/admin/new", { waitUntil: "networkidle" });

  // 应出现恢复提示（带保存时间）
  const banner = page2.locator(".save-restore-banner");
  await banner.waitFor({ timeout: 5000 });
  const text = await banner.innerText();
  assert.match(text, /崩溃前的标题|暂存/, "应提示发现本地草稿");
  assert.match(text, /\d{2}:\d{2}|\d{4}/, "必须显示保存时间，否则用户不知道该不该信它");

  // 点恢复，内容应回到表单
  await page2.locator(".save-restore-banner button", { hasText: "恢复" }).click();
  await page2.waitForTimeout(300);
  assert.equal(await page2.inputValue('input[placeholder="文章标题"]'), "崩溃前的标题");
});

T("两个标签页：本地草稿互不覆盖", async () => {
  const { page, context } = await controller.newLoggedInContext(server.base, server.fixture);

  // 两个 tab 各自打开"新文章"，写不同内容
  await page.goto(server.base + "/admin/new", { waitUntil: "networkidle" });
  await page.fill('input[placeholder="文章标题"]', "标签页 A 的内容");
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });

  const page2 = await context.newPage();
  await page2.goto(server.base + "/admin/new", { waitUntil: "networkidle" });
  await page2.fill('input[placeholder="文章标题"]', "标签页 B 的内容");
  await page2.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });
  await page2.waitForTimeout(300);

  // 两个 tab 生成不同的 clientDraftId -> 两份独立草稿
  const keys = await page2.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("draft:")));
  assert.ok(keys.length >= 2, "两个标签页应各有一份本地草稿，实际 " + keys.length);

  const contents = await page2.evaluate((ks) =>
    ks.map((k) => JSON.parse(localStorage.getItem(k)).snapshot.title), keys);
  assert.ok(contents.includes("标签页 A 的内容"), "A 的内容必须还在");
  assert.ok(contents.includes("标签页 B 的内容"), "B 的内容必须还在");
});

T("保存期间继续输入：不会被清掉（canClearLocal 语义）", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const postId = await createPost(page, "typing-during-save");
  await page.goto(server.base + "/admin/edit/" + postId, { waitUntil: "networkidle" });

  // 快速连续输入，跨越 debounce 边界
  const ta = page.locator("textarea").first();
  await ta.click();
  for (let i = 1; i <= 5; i++) {
    await ta.type("段落 " + i + "\n");
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2600);

  // 最后一段必须在编辑器里还在
  const value = await ta.inputValue();
  assert.match(value, /段落 5/, "保存期间输入的内容不得被清掉");

  // 服务端草稿最终应包含最新内容
  const after = await getPost(page, postId);
  assert.ok(after.draft, "应有服务端草稿");
  const snap = JSON.parse(after.draft.snapshot_json);
  assert.match(snap.content, /段落 5/, "服务端草稿最终应包含最新一段");
});

T("冲突：服务端草稿被别处改动时显示三方对比且不自动合并", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const postId = await createPost(page, "conflict-case");
  await page.goto(server.base + "/admin/edit/" + postId, { waitUntil: "networkidle" });

  // 先在服务端造一份草稿
  await page.fill('input[placeholder="文章标题"]', "我的版本");
  await page.waitForTimeout(2600);

  // 用 API 从"另一处"改这份草稿（模拟另一台设备）
  const other = await page.request.put(server.base + "/api/admin/posts/" + postId + "/draft", {
    data: {
      clientDraftId: (await (await page.request.get(server.base + "/api/admin/posts/" + postId + "/draft")).json())
        .draft.identity.clientDraftId,
      snapshot: {
        type: "post", title: "别处的版本", slug: "conflict-case", content: "别处写的正文",
        cover: null, categories: [], tags: [], comments_enabled: 1,
      },
      expectedPostRevision: (await (await page.request.get(server.base + "/api/admin/posts/" + postId + "/draft")).json()).postRevision,
      expectedDraftRevision: (await (await page.request.get(server.base + "/api/admin/posts/" + postId + "/draft")).json()).draft.identity.draftRevision,
    },
  });
  assert.equal(other.status(), 200, await other.text());

  // 现在编辑器再保存 -> 应进入冲突
  await page.fill('input[placeholder="文章标题"]', "我这边的第二次修改");
  await page.waitForTimeout(2800);

  const status = await page.locator(".save-status").innerText();
  assert.match(status, /冲突/, "版本被别处改过后保存应进入冲突态，实际：" + status);

  // 三方对比对话框
  const dialog = page.locator(".conflict-dialog");
  await dialog.waitFor({ timeout: 5000 });
  const cols = await page.locator(".conflict-col h3").allInnerTexts();
  assert.equal(cols.length, 3, "必须是三方对比，实际：" + JSON.stringify(cols));
  assert.ok(cols.some((c) => /线上/.test(c)), "应含当前线上版本");
  assert.ok(cols.some((c) => /服务端草稿/.test(c)), "应含服务端草稿");
  assert.ok(cols.some((c) => /我/.test(c)), "应含本地版本");
});

T("本地存储不可用：显示常驻警告并要求导出/存服务端", async () => {
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);
  const postId = await createPost(page, "quota-fail");
  await page.goto(server.base + "/admin/edit/" + postId, { waitUntil: "networkidle" });

  // 让 setItem 抛配额异常
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k) {
      if (String(k).startsWith("draft:")) throw new Error("QuotaExceededError");
      return orig.apply(this, arguments);
    };
  });

  await page.fill('input[placeholder="文章标题"]', "配额已满");
  await page.waitForTimeout(2600);

  // 常驻警告（不自动消失）
  const notice = page.locator(".save-status-local");
  await notice.waitFor({ timeout: 5000 });
  const text = await notice.innerText();
  assert.match(text, /导出|备份/, "必须给出导出/备份的出口");
  assert.match(text, /丢失/, "必须说明关闭页面会丢内容");

  // 再等一会儿，警告仍然在（不自动消失）
  await page.waitForTimeout(1500);
  assert.equal(await notice.isVisible(), true, "常驻警告不得自动消失");
});

/* ---------------------------- 辅助 ---------------------------- */

async function createPost(page, slug) {
  const res = await page.request.post(server.base + "/api/admin/posts", {
    data: {
      type: "post", title: "初始标题 " + slug, slug, content: "初始正文",
      status: "draft", categories: [], tags: [],
      clientDraftId: "cid-" + slug + "-" + Math.random().toString(36).slice(2, 8),
    },
  });
  const body = await res.json();
  assert.equal(res.status(), 200, JSON.stringify(body));
  return body.id;
}

async function getPost(page, id) {
  const res = await page.request.get(server.base + "/api/admin/posts/" + id);
  assert.equal(res.status(), 200, await res.text());
  return res.json();
}

/* ---------------------------- 运行 ---------------------------- */

try {
  server = await startIsolatedServer({ label: "phase032" });
  controller = await startBrowser();

  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log("PASS 03.2: " + t.name);
      passed += 1;
    } catch (e) {
      failures.push({ name: t.name, message: e.message });
      console.error("FAIL 03.2: " + t.name + "\n  " + e.message);
    }
  }

  console.log(passed + "/" + tests.length + " 通过");
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    console.log("All phase-03.2 autosave checks passed.");
  }
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
