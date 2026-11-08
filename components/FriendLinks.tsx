import { listFriendLinksCached } from "@/lib/cached";
import type { FriendLink } from "@/lib/friend-links";
import { SidebarBlock } from "./rightbar/Blocks";
import { HubAvatar } from "./HubAvatar";
import { Icon } from "./ui/Icon";

/**
 * 侧栏「友链 / 聚合」区块（2026-10-23，B-8 重构）。
 *
 * 数据来自 friend_links 表，后台可增删改（/admin/links）。
 * 分两块渲染：
 *   - 聚合站（kind=hub）做成卡片，带开往这类徽标，视觉上更重
 *   - 友链（kind=friend）紧凑列表
 * 没数据时整块不渲染，不占位。
 *
 * ## B-8：拆成「纯展示」+「取数」两层
 *
 * 原来这段结构在 `MobileSidebar.tsx:44-85` 又被完整抄了一遍（连
 * `🚇` / `🔗` / `↗` 都一字不差）。现在：
 *
 *   HubCard / LinkRow      —— 单个条目的纯展示（不查库）
 *   FriendLinkBlocks       —— 两块的纯展示（接收已分好组的数组）
 *   FriendLinks            —— 取数 + 分组 + 组合（服务端组件）
 *
 * 桌面右栏用 `<FriendLinks />`（自带取数），手机抽屉用
 * `<FriendLinkBlocks hubs={…} friends={…} />`（数据由抽屉统一查）。
 */

export function HubCard({ link }: { link: FriendLink }) {
  return (
    <a
      className="fl-hub"
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={link.desc || link.name}
    >
      {/* 2026-11-06：不再用固定的 🚇，改取站点自己的 favicon（失败退回首字） */}
      <HubAvatar name={link.name} url={link.url} />
      <span className="fl-body">
        <span className="fl-name">{link.name}</span>
        {link.desc ? <span className="fl-desc">{link.desc}</span> : null}
      </span>
      <span className="fl-out" aria-hidden>↗</span>
    </a>
  );
}

export function LinkRow({ link }: { link: FriendLink }) {
  return (
    <a
      className="fl-item"
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={link.desc || link.name}
    >
      <span className="fl-ico" aria-hidden><Icon name="link" size={15} /></span>
      <span className="fl-body">
        <span className="fl-name">{link.name}</span>
        {link.desc ? <span className="fl-desc">{link.desc}</span> : null}
      </span>
      <span className="fl-out" aria-hidden>↗</span>
    </a>
  );
}

/**
 * 聚合 + 友链两块（纯展示）。
 *
 * 调用方负责分组：`kind === "hub"` 的进 hubs，其余进 friends。
 * 两边都为空时返回 null（不渲染空壳）。
 */
export function FriendLinkBlocks({ hubs, friends }: { hubs: FriendLink[]; friends: FriendLink[] }) {
  if (hubs.length === 0 && friends.length === 0) return null;

  return (
    <>
      {hubs.length > 0 ? (
        <SidebarBlock title="聚合" count={hubs.length}>
          <div className="link-list">
            {hubs.map((l) => <HubCard key={l.id} link={l} />)}
          </div>
        </SidebarBlock>
      ) : null}

      {friends.length > 0 ? (
        <SidebarBlock title="友链" count={friends.length}>
          <div className="link-list">
            {friends.map((l) => <LinkRow key={l.id} link={l} />)}
          </div>
        </SidebarBlock>
      ) : null}
    </>
  );
}

/** 桌面右栏用：取数 + 分组 + 渲染。手机抽屉直接用 FriendLinkBlocks。 */
export async function FriendLinks() {
  const links = await listFriendLinksCached();
  return (
    <FriendLinkBlocks
      hubs={links.filter((l) => l.kind === "hub")}
      friends={links.filter((l) => l.kind !== "hub")}
    />
  );
}
