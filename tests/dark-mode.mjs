/**
 * 阶段 01-B 暗色缺陷回归：状态徽章必须跟随主题。
 *
 * 这三个页面的问题不是"配色不好看"，而是 token 名字写错导致 fallback
 * 静默接管 —— 暗色主题下留下一整块浅色亮斑。所以断言方式也要对得上：
 * 不比对"具体色值"，而是比对**切换主题后颜色确实变了**，
 * 以及**不再是浅色主题那套硬编码值**。
 */
import assert from "node:assert/strict";
import { startIsolatedServer } from "./helpers/next-server.mjs";
import { startBrowser } from "./helpers/browser.mjs";
import { contrastFromLayers, parseColor, relativeLuminance } from "./helpers/contrast.mjs";

let server, controller;
try {
  server = await startIsolatedServer({ label: "dark-mode" });
  controller = await startBrowser();
  const { page } = await controller.newLoggedInContext(server.base, server.fixture);

  // 关掉过渡，取稳态值（阶段 01-A 踩过：切主题瞬间取到插值中间态）
  async function snapshot(pathName) {
    await page.goto(server.base + pathName, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.waitForTimeout(150);
    const light = await page.evaluate(collect);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(150);
    const dark = await page.evaluate(collect);
    return { light, dark };
  }

  // 抓所有"状态徽章"候选：带 background/color 的内联 span
  function collect() {
    const out = [];
    for (const el of document.querySelectorAll("span,div")) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const fg = cs.color;
      if (!bg || bg === "rgba(0, 0, 0, 0)") continue;
      if (!el.textContent || el.textContent.trim().length > 60) continue;
      // 收集从元素自身到 body 的背景层，最后补上 body 底色（必须不透明）
      const layers = [];
      let cur = el;
      while (cur) {
        const b = getComputedStyle(cur).backgroundColor;
        if (b && !/rgba\(0, 0, 0, 0\)/.test(b)) layers.push(b);
        cur = cur.parentElement;
      }
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      if (bodyBg && !/rgba\(0, 0, 0, 0\)/.test(bodyBg)) layers.push(bodyBg);
      out.push({ text: el.textContent.trim().slice(0, 30), bg, fg, layers });
    }
    return out;
  }

  const media = await snapshot("/admin/media");
  const storage = await snapshot("/admin/storage");

  // 1) 主题切换后，这些元素的颜色必须变化（token 生效）
  function changedCount(snap) {
    let n = 0;
    for (const l of snap.light) {
      const d = snap.dark.find((x) => x.text === l.text);
      if (d && (d.bg !== l.bg || d.fg !== l.fg)) n++;
    }
    return n;
  }

  const mediaChanged = changedCount(media);
  const storageChanged = changedCount(storage);
  console.log("INFO 01-B: 跟随主题变化的彩色元素 /admin/media=" + mediaChanged + " /admin/storage=" + storageChanged);
  assert.ok(mediaChanged > 0, "/admin/media 应有元素在切换主题后变色（token 生效）");
  assert.ok(storageChanged > 0, "/admin/storage 应有元素在切换主题后变色（token 生效）");

  // 2) 暗色下不能再出现"浅色主题硬编码值"：这些元素的背景亮度必须够暗
  function tooBright(snap) {
    const bad = [];
    for (const d of snap.dark) {
      const c = parseColor(d.bg);
      if (!c) continue;
      const lum = relativeLuminance(c);
      // 暗色背景亮度应远低于 0.5；原先的 #e7f7ee / #fff4e5 约为 0.90 / 0.93
      if (lum > 0.5) bad.push({ text: d.text, bg: d.bg, lum: Math.round(lum * 100) / 100 });
    }
    return bad;
  }
  const mediaBright = tooBright(media);
  const storageBright = tooBright(storage);
  assert.deepEqual(mediaBright, [], "/admin/media 暗色下仍有浅底亮块：" + JSON.stringify(mediaBright));
  assert.deepEqual(storageBright, [], "/admin/storage 暗色下仍有浅底亮块：" + JSON.stringify(storageBright));
  console.log("PASS 01-B: 暗色下无浅底亮块残留（/admin/media、/admin/storage）");

  // 3) 文字在各自背景上仍可读（避免"修成暗底暗字"这种反向错误）
  function unreadable(snap) {
    const bad = [];
    for (const d of snap.dark) {
      // 用真实背景层（末层是 body 的不透明底色），不做任何兜底猜测
      const ratio = contrastFromLayers(d.fg, d.layers);
      if (ratio !== null && ratio < 3) bad.push({ text: d.text, bg: d.bg, fg: d.fg, ratio: Math.round(ratio * 100) / 100 });
    }
    return bad;
  }
  const bad = [...unreadable(media), ...unreadable(storage)];
  assert.deepEqual(bad, [], "暗色下状态徽章文字对比度过低：" + JSON.stringify(bad));
  console.log("PASS 01-B: 暗色下状态徽章文字可读（对比度 >= 3）");

  // 4) PostList 的危险操作仍是 .btn-danger，且暗色下没有亮红块
  await page.goto(server.base + "/admin", { waitUntil: "networkidle" });
  const dangerOk = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".btn-danger")];
    return btns.every((b) => getComputedStyle(b).backgroundColor !== "rgb(229, 72, 77)");
  });
  assert.ok(dangerOk, "危险按钮不得回到硬编码的 #e5484d 实色");
  console.log("PASS 01-B: PostList 危险按钮未回退到硬编码红色");

  console.log("All 01-B dark mode checks passed.");
} finally {
  if (controller) await controller.close();
  if (server) await server.close();
}
