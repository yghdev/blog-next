import { listFriendLinksCached, getSiteStatsCached, getTagCloudCached } from "@/lib/cached";
import { FriendLinkBlocks } from "./FriendLinks";
import { StatsBlock } from "./rightbar/StatsBlock";
import { TagCloudBlock } from "./rightbar/TagCloudBlock";

/**
 * 手机端侧栏的内容（2026-10-23，B-8 重构）。
 *
 * 桌面右栏容器 `.toc-col` 在 **≤1391px 就 display:none**，手机/平板看不到
 * 统计、聚合外链、友链、标签云。这里把同样内容做成可开合的右侧抽屉，
 * 数据走同一套 cached 函数，与桌面端天然一致。
 *
 * 只负责"内容"，外壳（触发按钮 / 遮罩 / 关闭逻辑）在 MobileNav 里，
 * 因为顶部栏和抽屉都是它渲染的，放一起才能避开 header 的
 * backdrop-filter 包含块问题。
 *
 * ## B-8：不再手写任何区块结构
 *
 * 原来这里把统计块、聚合/友链、标签云各抄了一遍（连图标字符都一样）。
 * 现在三个区块都用与桌面右栏**同一批**纯展示组件，本文件只做
 * 「一次并发取数 + 分组 + 组合」。
 */
export async function MobileSidebarContent() {
  const [stats, tags, links] = await Promise.all([
    getSiteStatsCached(),
    getTagCloudCached(14),
    listFriendLinksCached(),
  ]);

  return (
    <>
      <StatsBlock stats={stats} />
      <FriendLinkBlocks
        hubs={links.filter((l) => l.kind === "hub")}
        friends={links.filter((l) => l.kind !== "hub")}
      />
      <TagCloudBlock tags={tags} />
    </>
  );
}
