import Link from "next/link";
import { SidebarBlock } from "./Blocks";

/**
 * 标签云（B-8，2026-11-01）。
 *
 * 原先 `RightBar.tsx:51-71` 与 `MobileSidebar.tsx:88-108` 各写一遍。
 * 只有一处细微差别：桌面写 `` `${t.count} 篇文章` ``，移动写
 * `t.count + " 篇文章"` —— 同义但字面不同，属于典型的"抄两遍必漂移"。
 *
 * `tags` 为空时**整块不渲染**（与原实现一致）：空标签云只会让人以为加载失败。
 */
export type TagItem = { name: string; count: number };

export function TagCloudBlock({ tags }: { tags: TagItem[] }) {
  if (tags.length === 0) return null;

  return (
    <SidebarBlock title="标签云" count={tags.length}>
      <div className="tag-cloud">
        {tags.map((t) => (
          <Link
            key={t.name}
            href={"/tags/" + encodeURIComponent(t.name)}
            className="tag-pill"
            title={t.count + " 篇文章"}
          >
            <span className="tag-hash">#</span>
            {t.name}
            <span className="tag-num">{t.count}</span>
          </Link>
        ))}
      </div>
    </SidebarBlock>
  );
}
