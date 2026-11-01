import { getSiteStatsCached, getTagCloudCached } from "@/lib/cached";
import { FriendLinks } from "./FriendLinks";
import { StatsBlock } from "./rightbar/StatsBlock";
import { TagCloudBlock } from "./rightbar/TagCloudBlock";

type Toc = { level: number; text: string; id: string }[];

/**
 * 桌面端右侧栏（B-8 重构）。
 *
 * 这里**只负责取数 + 组合**，具体区块的结构全部来自
 * `components/rightbar/` 与 `FriendLinks.tsx` 里的纯展示组件 ——
 * 手机抽屉（`MobileSidebarContent`）用的是同一批组件，
 * 所以两端的统计块、友链、标签云结构天然一致，不会再出现
 * "桌面改了手机没改"。
 *
 * 目录块仍留在这里：它是文章页专属的（只有 ArticleView 传 `toc`），
 * 手机端不显示目录（抽屉里没有这个需求），所以没有共用的必要。
 */
export async function RightBar({ toc }: { toc?: Toc }) {
  const stats = await getSiteStatsCached();
  const tags = await getTagCloudCached(14);

  return (
    <aside className="rightbar">
      {toc && toc.length > 0 ? (
        <section className="rb-block">
          <header className="rb-head">
            <span className="rb-title">本文目录</span>
            <span className="rb-badge">{toc.length}</span>
          </header>
          <ul className="toc-list">
            {toc.map((t, i) => (
              <li key={i} className={t.level === 3 ? "lv3" : ""}>
                <a href={"#" + t.id}>{t.text}</a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <StatsBlock stats={stats} />

      {/* 聚合站 / 友链：自带取数（数据来自 friend_links 表，后台可增删） */}
      <FriendLinks />

      <TagCloudBlock tags={tags} />
    </aside>
  );
}
