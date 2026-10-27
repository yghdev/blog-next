/**
 * 浏览器双页测试基础（阶段 00 基础设施）。
 *
 * 方案 §11.3 明确要求：**同 browser context 两 page 测 localStorage 隔离；
 * 不同 context 测独立会话/存储下的服务端冲突，两者不能互相替代。**
 * 这条在阶段 00 只需要"基础"：能起浏览器、能开两个 page / 两个 context、
 * 能登录进后台、能在 page 间读写 localStorage、能干净收尾。
 * 真正的自动保存状态机场景（跨页覆盖、断网、丢响应）属于 03.2，这里不预演。
 *
 * 为什么用 Playwright 而不是自己搓 CDP：
 *   双 context 的隔离、storage 清理、等待网络静默都是它已经做对的事；
 *   手写 CDP 只会在 03.2 反复踩同样的坑（僵尸进程、端口占用、storage 串味）。
 */
import { chromium } from "@playwright/test";

/**
 * 起浏览器并返回一个 controller。
 * 调用方负责 finally 里 await controller.close()。
 */
export async function startBrowser({ headless = true } = {}) {
  const browser = await chromium.launch({ headless });

  /**
   * 新建一个独立 context 并登录。
   *
   * 每个 context 有**自己的** cookie jar 与 localStorage —— 这正是
   * "不同 context = 独立会话/存储"这条要求的物理基础。同一个 context 里
   * 再 newPage() 才是"同 context 两 page 共享 storage"的场景。
   */
  async function newLoggedInContext(base, fixture) {
    const context = await browser.newContext();
    const page = await context.newPage();

    // 走真实登录接口拿 Cookie，而不是伪造 session：伪造的 Cookie 在
    // 会话表里查不到，会让后续断言以 401 的形式失败，掩盖真正的问题。
    const response = await page.request.post(base + "/api/auth/login", {
      data: { username: fixture.username, password: fixture.password },
    });
    if (response.status() !== 200) {
      throw new Error("Login failed in browser context: " + response.status() + " " + (await response.text()));
    }
    return { context, page };
  }

  return {
    browser,
    newLoggedInContext,
    async close() {
      await browser.close();
    },
  };
}

/**
 * 在一个 page 里写/读 localStorage。
 * 拆成小函数是为了让"同 context 两 page 隔离"的断言读起来像人话。
 */
export function setLocalStorage(page, key, value) {
  return page.evaluate(([k, v]) => { window.localStorage.setItem(k, v); }, [key, value]);
}

export function getLocalStorage(page, key) {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}
