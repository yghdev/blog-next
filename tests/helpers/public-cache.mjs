/**
 * 公开读取面的缓存预热与验证辅助（阶段 00 基础设施）。
 *
 * 验收矩阵 §11.2 的方法要求：
 *   - 隔离应用与临时数据库，先预热首页、文章、归档等缓存
 *   - 自动保存期间不主动清 posts 缓存；数据库与直读函数是最强断言
 *   - /api/search 是 no-store 直查，是「新内容有没有泄露/生效」的主探针
 *   - sitemap revalidate 3600 单独测，不作为正文泄露主探针
 *
 * 这里只提供机制，不替调用方下判断：预热 = 把页面请求一遍，让它进 unstable_cache；
 * 之后无论数据库怎么变，命中缓存就还是旧值 —— 这正是「缓存可能掩盖数据库变化」
 * 的取证方式。
 */

/** 默认预热的公开面：首页、归档、说说。文章页由调用方按 slug 追加。 */
export const DEFAULT_PUBLIC_PATHS = ["/", "/archives", "/shuoshuo"];

/**
 * 预热公开读取面。
 * @param {string} base 服务根地址
 * @param {string[]} paths 追加路径（如 "/some-slug"）
 * @returns {Promise<Array<{path:string,status:number}>>}
 */
export async function warmPublicCache(base, paths = []) {
  const results = [];
  for (const p of [...DEFAULT_PUBLIC_PATHS, ...paths]) {
    const response = await fetch(base + p, { signal: AbortSignal.timeout(10000) });
    await response.text(); // 必须读完 body，否则流未消费
    results.push({ path: p, status: response.status });
  }
  return results;
}

/** 取页面文本（带超时，避免挂死的请求把整个测试拖住） */
export async function fetchText(base, path, { cookie } = {}) {
  const response = await fetch(base + path, {
    redirect: "manual",
    headers: cookie ? { cookie: "blog_session=" + cookie } : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

/** no-store 直查探针：搜索接口永远绕过缓存，用来回答「数据库里到底有没有」 */
export async function searchProbe(base, query) {
  const response = await fetch(base + "/api/search?q=" + encodeURIComponent(query), {
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  return { status: response.status, hits: body.hits || [], mode: body.mode };
}

/**
 * 轮询直到 `check` 通过。
 *
 * 为什么必须轮询而不是"失效后立刻断言新值"：
 * 本项目的失效走 `revalidateTag(tag, "max")`（lib/purge.ts 的 profile 默认 "max"），
 * 而 "max" 是 **stale-while-revalidate** 语义 —— 失效后的**第一次**请求仍然返回
 * 旧缓存并在后台重建，第二次才拿到新内容。2026-10-27 验收实测：
 *   失效后第 1 次 200（旧正文），第 2 次起才是新值。
 * 这不是 bug，是 Next 的既定行为；测试必须按真实语义写，否则会间歇性假失败，
 * 或者更糟 —— 被"改成断言第一次就是新值"这种写法掩盖掉真问题。
 */
export async function waitForFresh(check, { attempts = 10, delayMs = 100, label = "condition" } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await check();
    if (last.ok) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Timed out waiting for " + label + "; last=" + JSON.stringify(last));
}
