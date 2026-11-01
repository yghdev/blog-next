import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 右栏区块单源（B-8，2026-11-01）。
 *
 * ## 问题
 *
 * 同一批右栏区块在**桌面右栏**与**手机抽屉**里各写了一遍：
 *
 *   统计块    RightBar.tsx:31-44      vs  MobileSidebar.tsx:28-41
 *   聚合/友链 FriendLinks.tsx:14-50   vs  MobileSidebar.tsx:44-85
 *   标签云    RightBar.tsx:51-71      vs  MobileSidebar.tsx:88-108
 *
 * 不只是"看起来像"：连 `🚇` / `🔗` / `↗` 这些图标字符都一模一样地抄了两遍。
 * 后果是改一处忘另一处 —— 比如给统计块加个"较昨日"标记，桌面有了手机没有；
 * 或者某天把图标换成 SVG，只改了一边。这类不一致极难在走查中发现，
 * 因为没人会同时开着桌面和手机抽屉对照。
 *
 * ## 修法
 *
 * 抽 4 个**纯展示**组件（都只接收数据，不自己查库）：
 *   SidebarBlock     —— <section class="rb-block"> + 标题 + 可选计数徽标
 *   StatsBlock       —— 站点统计九宫格
 *   TagCloudBlock    —— 标签云
 *   FriendLinkBlocks —— 聚合 + 友链两块（复用 HubCard / LinkRow）
 *
 * `RightBar` 与 `MobileSidebarContent` 只负责**取数 + 组合**。
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("B-8 四个纯展示组件都存在", () => {
  const files = [
    "components/rightbar/Blocks.tsx",
    "components/rightbar/StatsBlock.tsx",
    "components/rightbar/TagCloudBlock.tsx",
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), "应存在 " + f);
  }
  // FriendLinkBlocks 放在 FriendLinks.tsx 里导出（复用 HubCard / LinkRow）
  const fl = read("components/FriendLinks.tsx");
  assert.match(fl, /export function FriendLinkBlocks/, "FriendLinks.tsx 应导出 FriendLinkBlocks");
});

test("B-8 展示组件必须是纯展示：不查库、不 import cached", () => {
  /**
   * 这是分层的核心约束。如果展示组件自己查库，它就只能用在服务端，
   * 而且数据源一变就得改组件 —— 那和现在的重复代码没有本质区别。
   */
  for (const f of [
    "components/rightbar/Blocks.tsx",
    "components/rightbar/StatsBlock.tsx",
    "components/rightbar/TagCloudBlock.tsx",
  ]) {
    const src = read(f);
    assert.doesNotMatch(src, /@\/lib\/cached/, f + " 不应 import lib/cached（应接收数据）");
    assert.doesNotMatch(src, /getDb|better-sqlite3/, f + " 不应直接查库");
    assert.doesNotMatch(src, /^"use client"/m, f + " 不需要 use client（纯展示）");
  }
});

test("B-8 rb-block 从 9 处降到 ≤4 处，且只在两个文件里", () => {
  /**
   * 路线图的验收标准写的是「从 9 处降到 4 处」
   * （SidebarBlock 壳 1 + FriendLinks 2 + RightBar 的目录块 1）。
   *
   * 实际做得更彻底：FriendLinks 的两处也被 `SidebarBlock` 吸收了，
   * 只剩 **2 处**（SidebarBlock 壳 1 + RightBar 的目录块 1）。
   *
   * 断言用「≤4 且只在允许的两个文件里」而不是「恰好等于 N」：
   * 数量继续下降是好事（说明收敛更彻底），不该因此报红；
   * 但**出现在不该出现的文件里**一定是回退，必须抓住。
   */
  const files = ["components/rightbar/Blocks.tsx", "components/FriendLinks.tsx", "components/RightBar.tsx", "components/MobileSidebar.tsx"];
  const counts: Record<string, number> = {};
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    counts[f] = (read(f).match(/className="rb-block"/g) || []).length;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(
    total <= 4,
    "rb-block 应 ≤4 处（原 9 处），实际 " + total + " 处：" + JSON.stringify(counts)
  );
  assert.equal(counts["components/MobileSidebar.tsx"] || 0, 0, "MobileSidebar 不应再手写 rb-block");
  assert.equal(counts["components/FriendLinks.tsx"] || 0, 0, "FriendLinks 应改用 SidebarBlock 壳");
  assert.equal(counts["components/RightBar.tsx"], 1, "RightBar 只应剩目录块那 1 处");
  assert.equal(counts["components/rightbar/Blocks.tsx"], 1, "SidebarBlock 壳本身 1 处");
});

test("B-8 桌面右栏与手机抽屉共用同一批区块组件", () => {
  /**
   * 注意桌面用的是 `<FriendLinks />`（自带取数的包装），手机用的是
   * `<FriendLinkBlocks>`（纯展示，数据由抽屉统一查）。两者内部渲染的
   * 是同一个 `FriendLinkBlocks` —— 结构仍然单源，只是取数位置不同：
   * 桌面右栏只渲染友链这一块，单独查一次更直接；手机抽屉本来就要并发
   * 查三样，合并成一次 Promise.all 更省。
   */
  const rightbar = read("components/RightBar.tsx");
  const mobile = read("components/MobileSidebar.tsx");

  for (const comp of ["StatsBlock", "TagCloudBlock"]) {
    assert.ok(rightbar.includes("<" + comp), "RightBar 应使用 " + comp);
    assert.ok(mobile.includes("<" + comp), "MobileSidebar 应使用 " + comp);
  }
  assert.ok(rightbar.includes("<FriendLinks"), "RightBar 应使用 FriendLinks（取数包装）");
  assert.ok(mobile.includes("<FriendLinkBlocks"), "MobileSidebar 应使用 FriendLinkBlocks（纯展示）");

  // FriendLinks 内部必须落到 FriendLinkBlocks，否则两边结构还是两份
  const fl = read("components/FriendLinks.tsx");
  assert.match(fl, /<FriendLinkBlocks/, "FriendLinks 应渲染 FriendLinkBlocks");
});

test("B-8 桌面与移动的区块顺序一致（统计 → 友链 → 标签云）", () => {
  /**
   * 顺序不一致会让人"换个设备就找不到东西"。这里比较三个组件名
   * 在各自文件里首次出现的位置。
   */
  const order = (src: string) =>
    [
      { c: "StatsBlock", at: src.indexOf("<StatsBlock") },
      { c: "FriendLinkBlocks", at: Math.max(src.indexOf("<FriendLinks"), src.indexOf("<FriendLinkBlocks")) },
      { c: "TagCloudBlock", at: src.indexOf("<TagCloudBlock") },
    ]
      .sort((a, b) => a.at - b.at)
      .map((x) => x.c);
  const r = order(read("components/RightBar.tsx"));
  const m = order(read("components/MobileSidebar.tsx"));
  assert.deepEqual(r, ["StatsBlock", "FriendLinkBlocks", "TagCloudBlock"], "RightBar 顺序不对：" + r);
  assert.deepEqual(m, ["StatsBlock", "FriendLinkBlocks", "TagCloudBlock"], "MobileSidebar 顺序不对：" + m);
});

test("B-8 图标字符只在 FriendLinks.tsx 出现一次（不再手抄）", () => {
  /**
   * 原来 `🚇` / `🔗` / `↗` 在 FriendLinks.tsx 与 MobileSidebar.tsx
   * 各写了一遍。抽组件后只应留在 HubCard / LinkRow / SidebarBlock 里。
   */
  const mobile = read("components/MobileSidebar.tsx");
  for (const icon of ["🚇", "🔗", "↗"]) {
    assert.ok(!mobile.includes(icon), "MobileSidebar 不应再硬编码图标 " + icon);
  }
});
