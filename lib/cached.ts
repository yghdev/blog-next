import { unstable_cache } from "next/cache";
import { TAGS } from "./posts";
import * as posts from "./posts";
import * as stats from "./site-stats";
import { getSettings, type Settings } from "./settings";
import { listVisibleFriendLinks } from "./friend-links";

/**
 * 数据层缓存（方案 P4）。
 *
 * ⚠️ 为什么不做整页 ISR（这是实测出来的结论，不是保守）
 * ────────────────────────────────────────────────────────
 * 这些页面直读 SQLite。若改成 `export const revalidate = 60`，Next 会在
 * **next build 时**预渲染它们 —— 而构建在开发机/CI 上跑，那里读的是
 * 本地 data/blog.db（31 篇旧文章），不是线上的 32 篇。
 * 结果：产物里冻住一份错误内容，线上要等到第一次 revalidate 才会自愈，
 * 期间访客看到的是开发库的内容。这比慢一点严重得多。
 *
 * 所以正确做法是：**页面保持动态渲染（force-dynamic），只把数据读取缓存起来**。
 * 好处：
 *   - 不改变渲染模型，不存在构建期读库的问题
 *   - 每请求的 8~11 次 SQLite 查询降到 0~1 次（命中缓存时）
 *   - 后台保存时通过 revalidateTag 精准失效，发布后立即可见
 *
 * 失效策略：
 *   TAGS.posts     —— 任何文章增删改/发布
 *   TAGS.post(id)  —— 单篇文章
 *   TAGS.comments  —— 评论审核
 *   TAGS.stats     —— 站点统计（umami 同步、设置变更）
 */

/** 兜底 TTL：即使某处忘记 revalidate，最多 5 分钟后也会自愈 */
const TTL = 300;

/* ------------------------------- 文章列表 ------------------------------- */

export const listPostsCached = unstable_cache(
  async (limit: number, offset: number) => posts.listPosts({ limit, offset }),
  ["posts:list"],
  { revalidate: TTL, tags: [TAGS.posts] }
);

export const countPostsCached = unstable_cache(
  async () => posts.countPosts(),
  ["posts:count"],
  { revalidate: TTL, tags: [TAGS.posts] }
);

export const listShuoshuoCached = unstable_cache(
  async (limit: number) => posts.listShuoshuo(limit),
  ["shuoshuo:list"],
  { revalidate: TTL, tags: [TAGS.posts] }
);

export const listArchivesCached = unstable_cache(
  async () => posts.listArchives(),
  ["posts:archives"],
  { revalidate: TTL, tags: [TAGS.posts] }
);

/* -------------------------------- 单篇 -------------------------------- */

/** 按 slug 取文章（含别名解析）。keyParts 带上 slug，天然按路径缓存 */
export const resolveSlugCached = unstable_cache(
  async (slug: string) => posts.resolveSlug(slug),
  ["post:resolve"],
  { revalidate: TTL, tags: [TAGS.posts] }
);

export const getPageBySlugCached = unstable_cache(
  async (slug: string) => posts.getPageBySlug(slug),
  ["page:get"],
  { revalidate: TTL, tags: [TAGS.posts] }
);

/** 按 id 取文章/页面：`/p/<id>` 的规范地址走这里（id 是主键，天然稳定） */
export const getPostByIdCached = unstable_cache(
  async (rawId: string | number) => posts.getPostById(rawId),
  ["post:by-id"],
  { revalidate: TTL, tags: [TAGS.posts] }
);

/* -------------------------------- 统计 -------------------------------- */

export const getSiteStatsCached = unstable_cache(
  async () => stats.getSiteStats(),
  ["stats:site"],
  { revalidate: TTL, tags: [TAGS.stats] }
);

export const getTagCloudCached = unstable_cache(
  async (limit: number) => stats.getTagCloud(limit),
  ["stats:tags"],
  { revalidate: TTL, tags: [TAGS.posts] }
);

export const getViewsMapCached = unstable_cache(
  async () => {
    const m = stats.getViewsMap();
    // Map 不能跨进程序列化，转成数组。key 是 post_id（不是路径）：
    // 路径有中文编码的两种形态，id 没有。
    return [...m.entries()];
  },
  ["stats:views"],
  // 浏览量单独 60 秒：内容缓存是 300 秒，但「我刚发的文章 5 分钟没数字」
  // 看起来就像统计坏了。其余统计数据仍走 300 秒。
  { revalidate: 60, tags: [TAGS.stats] }
);

export const getPageViewsCached = unstable_cache(
  async (path: string, postId?: number | null) => stats.getPageViews(path, postId),
  ["stats:pageviews"],
  { revalidate: 60, tags: [TAGS.stats] }
);

/* -------------------------------- 设置 -------------------------------- */

export const getSettingsCached = unstable_cache(
  async () => getSettings(),
  ["settings:all"],
  { revalidate: TTL, tags: [TAGS.stats] }
);

/* ------------------------------ 友链/外链 ------------------------------ */

/**
 * 前台侧栏的友链 + 聚合外链。
 * 挂在 TAGS.stats 下：它和站点统计同属"侧栏展示数据"，后台一保存就整块失效。
 */
export const listFriendLinksCached = unstable_cache(
  async () => listVisibleFriendLinks(),
  ["friend-links:visible"],
  { revalidate: TTL, tags: [TAGS.stats] }
);

export type { Settings };
