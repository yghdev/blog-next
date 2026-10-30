import fs from "node:fs";
import path from "node:path";
import { getPageBySlugCached } from "./cached";
import { getPageBySlug } from "./posts";

/**
 * Friends 专题页的**页面级数据入口**（仅服务端使用）。
 *
 * 为什么不是简单地 getPageBySlugCached("friend-links") 就完事：
 *
 *   - 线上这一页是 posts 表里的 page（type=page, slug=friend-links），
 *     正文里写着「申请要求」「本站信息」，以及更早的一批友链。
 *     这些是作者的真实内容，不能因为改版就丢掉，所以继续以它为准。
 *   - 全新安装 / 本地开发库还没有种子页时（posts 表为空），退回仓库里的
 *     content/pages/friend-links.md —— 它本来就是这一页的种子文件，
 *     内容与线上一致，不是另写一份。
 *   - 页面被作者删除或退回草稿时**不**用种子文件复活内容：
 *     只有「一行都没有」才走 bootstrap，尊重后台的删除/草稿状态。
 *
 * 这个模块读文件、连数据库，只能在 Server Component / Route Handler 里引用。
 */

export type FriendLinksPageDoc = {
  /** 页面正文（Markdown）。用于解析友链、申请要求、本站信息。 */
  content: string;
  /** posts.id；页面不存在时为 null。评论只把它当 data 属性用，key 仍是 /friend-links。 */
  pageId: number | null;
  /** 该页是否开启评论（全站开关在页面里再与 settings 合并） */
  commentsEnabled: boolean;
};

const LEGACY_REL = path.join("content", "pages", "friend-links.md");

/**
 * 找到仓库里的种子页。
 *
 * 为什么向上找几层：`next build` 的 standalone 产物以 `.next/standalone` 为
 * 运行目录，那里默认没有 content/（只有 `build:dist` 打包时才会复制进去）。
 * 本地开发、集成测试直接跑 standalone 时，cwd 会在 `.next/standalone`，
 * 种子文件其实还在项目根。最多上溯 3 层，找不到就正常降级为空正文。
 */
function legacySeedPath(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, LEGACY_REL);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readLegacySeed(): string {
  const file = legacySeedPath();
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    // 文件缺失不是错误：页面会以「只有 friend_links 表数据」的形态正常渲染
    return "";
  }
}

/** 去掉 seed 文件头部的 YAML front matter，只留正文 */
function stripFrontMatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw;
  return raw.slice(raw.indexOf("\n", end + 1) + 1);
}

export async function loadFriendLinksPage(): Promise<FriendLinksPageDoc> {
  const published = await getPageBySlugCached("friend-links");
  if (published) {
    return {
      content: published.content || "",
      pageId: published.id,
      commentsEnabled: published.comments_enabled !== 0,
    };
  }

  // 草稿 / 回收站里存在这一页 -> 说明作者确实处理过它，不要用种子内容复活
  const existing = getPageBySlug("friend-links", { includeDrafts: true });
  if (existing) {
    return {
      content: "",
      pageId: existing.id,
      commentsEnabled: existing.comments_enabled !== 0,
    };
  }

  return {
    content: stripFrontMatter(readLegacySeed()),
    pageId: null,
    commentsEnabled: true,
  };
}
