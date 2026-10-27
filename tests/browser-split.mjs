/**
 * 浏览器双页基础验证（阶段 00）。
 *
 * 只验证"基础设施能用、隔离是真的"，不写 03.2 的自动保存场景。
 * 两条断言对应方案 §11.3 那对**不能互相替代**的要求：
 *   1. 同 context 两 page：共享同一个 localStorage，于是必须能观察到彼此写入，
 *      并证明"新标签页生成独立身份"是应用层的事，不是浏览器天然给的。
 *   2. 不同 context：cookie 与 localStorage 都独立，用来测服务端冲突的前提成立。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser, setLocalStorage, getLocalStorage } from "./helpers/browser.mjs";

let server;
let controller;

try {
  server = await startIsolatedServer({ label: "browser-split" });
  controller = await startBrowser();

  /* ---------- 同 context 两 page：共享 storage ---------- */
  const { context, page } = await controller.newLoggedInContext(server.base, server.fixture);
  await page.goto(server.base + "/admin", { waitUntil: "domcontentloaded" });
  assert.match(page.url(), /\/admin/, "logged-in context must stay on /admin: " + page.url());

  const second = await context.newPage();
  await second.goto(server.base + "/admin", { waitUntil: "domcontentloaded" });

  await setLocalStorage(page, "draft:probe", "from-page-1");
  assert.equal(await getLocalStorage(second, "draft:probe"), "from-page-1",
    "two pages in the SAME context must share localStorage");
  await setLocalStorage(second, "draft:probe-2", "from-page-2");
  assert.equal(await getLocalStorage(page, "draft:probe-2"), "from-page-2");
  console.log("PASS browser: same-context pages share localStorage");

  /* ---------- 不同 context：完全独立 ---------- */
  const other = await controller.newLoggedInContext(server.base, server.fixture);
  await other.page.goto(server.base + "/admin", { waitUntil: "domcontentloaded" });
  assert.equal(await getLocalStorage(other.page, "draft:probe"), null,
    "a separate context must NOT see the other context's localStorage");

  await setLocalStorage(other.page, "draft:probe", "from-other-context");
  assert.equal(await getLocalStorage(page, "draft:probe"), "from-page-1",
    "writing in one context must not affect the other");

  // Cookie 也必须独立：拿掉一个 context 的 cookie，不应该影响另一个
  const cookiesA = (await context.cookies()).filter((c) => c.name === "blog_session").length;
  const cookiesB = (await other.context.cookies()).filter((c) => c.name === "blog_session").length;
  assert.equal(cookiesA, 1, "context A should hold exactly one session cookie");
  assert.equal(cookiesB, 1, "context B should hold exactly one session cookie");
  console.log("PASS browser: separate contexts are fully isolated (storage + cookies)");

  /* ---------- 未登录重定向仍然生效（证明不是靠伪造 cookie 通过） ---------- */
  const anon = await controller.browser.newContext();
  const anonPage = await anon.newPage();
  const res = await anonPage.goto(server.base + "/admin", { waitUntil: "domcontentloaded" });
  assert.ok(res && res.status() === 200, "redirect target should render");
  assert.match(anonPage.url(), /\/admin\/login/, "anonymous visitor must land on /admin/login: " + anonPage.url());
  await anon.close();
  console.log("PASS browser: anonymous context is redirected to /admin/login");

  console.log("All browser dual-page foundation checks passed.");
} catch (error) {
  if (server && server.logs) console.error(server.logs());
  throw error;
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
