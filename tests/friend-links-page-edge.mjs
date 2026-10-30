/**
 * Friends 页边界态：空目录、评论关闭。
 *
 * 这两个状态都依赖"数据真的处于那个状态"，不能靠改样式检查，所以：
 *   - 空目录：把 friend_links 清空，并让 posts 里存在一个正文为空的
 *     friend-links 页面（作者手动清空过正文的真实形态）
 *   - 评论关闭：走真实 settings 接口，再等缓存失效后的稳定结果
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "../tests/helpers/next-server.mjs";
import { waitForFresh } from "../tests/helpers/public-cache.mjs";

const server = await startIsolatedServer({ label: "friends-edge" });
let cookie;

const api = (route, opts = {}) =>
  fetch(server.base + route, {
    method: opts.method || "GET",
    redirect: "manual",
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie: "blog_session=" + cookie } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

try {
  const login = await fetch(server.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: server.fixture.username, password: server.fixture.password }),
  });
  cookie = (login.headers.get("set-cookie") || "").match(/blog_session=([^;]+)/)[1];
  assert.ok(cookie);

  // 清空 friend_links（只剩迁移预置的「开往」）
  const links = await (await api("/api/admin/links")).json();
  for (const l of links.links) await api("/api/admin/links?id=" + l.id, { method: "DELETE" });

  // 建立空的 friend-links 页面并直接发布（创建接口的 status=published 与
  // 编辑器发布走的是同一条通路：建壳 -> 存草稿 -> 发布）
  const created = await (await api("/api/admin/posts", {
    method: "POST",
    body: {
      type: "page", title: "友链", slug: "friend-links", content: "",
      status: "published", comments_enabled: false,
      clientDraftId: "cid-edge-" + Math.random().toString(36).slice(2),
    },
  })).json();
  assert.equal(created.status, "published", "page should be published: " + JSON.stringify(created));

  const emptyState = await waitForFresh(async () => {
    const html = await (await fetch(server.base + "/friend-links")).text();
    return { ok: html.includes("fr-empty-title"), html };
  }, { label: "empty directory state" });
  assert.match(emptyState.html, /这份名单还在等第一位朋友/, "空态标题缺失");
  assert.match(emptyState.html, /后台「外链」管理/, "空态应给出数据来源说明");
  assert.doesNotMatch(emptyState.html, /AGGREGATORS/, "没有聚合入口时不应渲染聚合区块");
  assert.doesNotMatch(emptyState.html, /REQUIREMENTS/, "正文为空时不应渲染申请要求");
  console.log("PASS empty state: placeholder + no phantom sections");

  // 同一页面同时是"空目录 + 评论关闭"：两个降级分支互不影响
  assert.match(emptyState.html, /评论功能当前已关闭/, "评论关闭提示缺失");
  assert.doesNotMatch(emptyState.html, /class="comments"/, "关闭后不应挂载 Artalk");
  assert.match(emptyState.html, /fr-apply-off/, "申请入口应降级成提示而非死锚点");
  assert.doesNotMatch(emptyState.html, /fr-apply-link/, "关闭评论后不应留一个滚不过去的按钮");
  console.log("PASS comments off: Artalk not mounted, apply CTA degrades");

  console.log("All friend-links edge state checks passed.");
} finally {
  await server.close();
}
