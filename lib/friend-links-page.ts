import {
  isSafeUrl,
  type FriendLinkView,
} from "./friend-links-shared";

/**
 * Friends 专题页的**纯数据函数**（不碰数据库，可在单测里直接跑）。
 *
 * 这里解决一个真实的数据现状：本站的友链有两个来源。
 *
 *   1) `friend_links` 表 —— 2026-10-23 起后台 /admin/links 管理的主数据源，
 *      有名称/地址/描述/分类/排序/显隐。侧栏、手机抽屉、本页都读它。
 *   2) `content/pages/friend-links.md` —— 更早的页面正文，里面「## 朋友们」
 *      手写了一组友链，「## 申请要求」写着交换规则。
 *
 * 只读其中一个都会丢数据：只读表，页面正文里那 4 位朋友会从新页面消失；
 * 只读正文，后台后来加的聚合入口又进不来。所以本页以表为主、正文为兼容回退：
 *   - 同一条链接（按 host + path 归一）只出现一次，表里的字段优先；
 *   - 表里该条描述为空时，用正文里的描述补齐，不白丢文案；
 *   - 正文里不安全的 URL（非 http/https）一律过滤，和前台其它入口同一判据。
 *
 * 申请要求也只从正文的「## 申请要求」小节读取 —— 规则是作者写的，不在代码里
 * 另编一份，后台改页面正文即可更新本页展示。
 */

export type DirectoryEntry = FriendLinkView & {
  /** 来源：managed = friend_links 表；legacy = 页面正文 */
  source: "managed" | "legacy";
};

export type DirectoryGroups = {
  friends: DirectoryEntry[];
  hubs: DirectoryEntry[];
};

/** 表单/接口里的一条友链配置（复制给别人的格式） */
export type FriendConfig = {
  name: string;
  url: string;
  avatar: string;
  desc: string;
  kind: "friend";
};

/** `- **[名称](https://…)** —— 描述`；兼容加粗与不加粗、破折号长短 */
const LIST_LINK = /^\s*[-*+]\s+(?:\*\*)?\[([^\]]+)\]\(\s*(https?:\/\/[^\s)]+)\s*\)(?:\*\*)?\s*(.*)$/i;

/** 标题行：只认二级标题，避免把正文里的 ### 小标题当成新分区 */
const H2 = /^##\s+(.+?)\s*$/;

function stripInline(s: string): string {
  return s
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 取某个二级标题下的正文；找不到返回 null（与「空分区」区分开） */
function sectionBody(markdown: string, names: string[]): string | null {
  const lines = String(markdown || "").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = H2.exec(lines[i]);
    if (!m) continue;
    const title = m[1].trim();
    if (names.some((n) => title === n || title.includes(n))) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (H2.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/**
 * 从旧页面正文里解析「朋友们」清单。
 * 没有该小节、或整节都没有合法链接时返回 []（页面会显示空状态，不报错）。
 */
export function parseLegacyFriends(markdown: string): FriendLinkView[] {
  const body = sectionBody(markdown, ["朋友们", "友链", "Friends"]);
  if (!body) return [];

  const out: FriendLinkView[] = [];
  let seq = 0;
  for (const line of body.split(/\r?\n/)) {
    const m = LIST_LINK.exec(line);
    if (!m) continue;
    const name = stripInline(m[1]);
    const url = m[2].trim();
    if (!name || !isSafeUrl(url)) continue;
    const desc = stripInline(m[3].replace(/^\s*(?:——|—|–|-)\s*/, ""));
    out.push({
      // 负数 id：正文条目没有数据库主键，和 friend_links 的正数 id 不会撞 key
      id: -(++seq),
      name,
      url,
      desc,
      kind: "friend",
    });
  }
  return out;
}

/**
 * 从旧页面正文里解析「申请要求」。
 * 优先取列表项；整节是段落时退回段落文本。空节返回 []。
 */
export function parseFriendRequirements(markdown: string): string[] {
  const body = sectionBody(markdown, ["申请要求", "友链要求"]);
  if (!body) return [];

  const bullets: string[] = [];
  const paragraphs: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (H2.test(line) || /^###\s+/.test(line)) continue;
    const bullet = /^[-*+]\s+(.+)$/.exec(line) ?? /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet) {
      const text = stripInline(bullet[1]);
      if (text) bullets.push(text);
    } else {
      const text = stripInline(line);
      if (text) paragraphs.push(text);
    }
  }
  return bullets.length > 0 ? bullets : paragraphs;
}

/** 归一化用于判重的键：协议/查询串/哈希不参与，www 前缀忽略，末尾斜杠忽略 */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return host + path + (u.search || "");
  } catch {
    return String(url || "").trim().toLowerCase();
  }
}

export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * 卡片头像：没有头像字段时，用站点自己的 /favicon.ico。
 * 只对 https 站点尝试 —— 页面在 https 下，http 图标会被浏览器按混合内容拦掉，
 * 发出去只会多一条控制台报错。拿不到时组件退回首字母图形。
 */
export function faviconFor(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return u.origin + "/favicon.ico";
  } catch {
    return null;
  }
}

/**
 * 合并两个来源：表里的条目优先且保持顺序，正文条目追加在后。
 * 同 URL 的重复项只保留第一条，但空描述/空名称会用后一条补齐。
 */
export function mergeDirectoryLinks(
  managed: FriendLinkView[],
  legacy: FriendLinkView[]
): DirectoryGroups {
  const legacyByKey = new Map<string, FriendLinkView>();
  for (const l of legacy) {
    const k = urlKey(l.url);
    if (!legacyByKey.has(k)) legacyByKey.set(k, l);
  }

  const friends: DirectoryEntry[] = [];
  const hubs: DirectoryEntry[] = [];
  const seen = new Set<string>();

  for (const [i, link] of [...managed, ...legacy].entries()) {
    if (!isSafeUrl(link.url)) continue;
    const k = urlKey(link.url);
    if (seen.has(k)) continue;
    seen.add(k);

    const fallback = legacyByKey.get(k);
    const entry: DirectoryEntry = {
      ...link,
      id: link.id > 0 ? link.id : -(i + 1),
      name: link.name.trim() || fallback?.name || link.url,
      desc: link.desc.trim() || fallback?.desc || "",
      source: link.id > 0 ? "managed" : "legacy",
    };
    if (entry.kind === "hub") hubs.push(entry);
    else friends.push(entry);
  }

  return { friends, hubs };
}

/* ────────────────────────── 本站信息 ────────────────────────── */

export type SiteInfo = {
  name: string;
  url: string;
  avatar: string;
  desc: string;
};

const SITE_FIELD_LINE = /^\s*[-*+]\s*(?:\*\*)?([^：:]{1,12})(?:\*\*)?\s*[：:]\s*(.+)$/;
const MARKDOWN_LINK = /^\[([^\]]*)\]\(\s*([^)\s]+)\s*\)$/;

/**
 * 从旧页面正文的「本站信息」小节解析站点名片。
 * 只返回真正写了的字段（Partial），缺的由调用方用 settings 兜底 ——
 * 这样既能保留作者手写的信息，也不会在字段缺失时编造内容。
 */
export function parseSiteInfo(markdown: string): Partial<SiteInfo> {
  const body = sectionBody(markdown, ["本站信息", "站点信息", "关于本站"]);
  if (!body) return {};

  const out: Partial<SiteInfo> = {};
  for (const raw of body.split(/\r?\n/)) {
    const m = SITE_FIELD_LINE.exec(raw);
    if (!m) continue;
    const key = stripInline(m[1]);
    const rawValue = stripInline(m[2]);
    if (!rawValue) continue;

    let value = rawValue;
    const link = MARKDOWN_LINK.exec(rawValue);
    if (link) value = link[2];

    if (/名称|站名|名字/.test(key)) out.name = value;
    else if (/头像/.test(key)) out.avatar = value;
    else if (/地址|网址|链接/.test(key)) out.url = value;
    else if (/描述|简介/.test(key)) out.desc = value;
  }
  return out;
}

/** 把站内相对地址（/avatar.jpg）补成绝对地址；已是绝对地址则原样返回 */
export function absoluteUrl(value: string, base: string): string {
  const v = String(value || "").trim();
  if (!v) return "";
  try {
    return new URL(v, base.endsWith("/") ? base : base + "/").toString();
  } catch {
    return v;
  }
}

/**
 * 本站名片：正文优先，settings 兜底，头像最后落到站点自己的 /avatar.jpg。
 * 三者都是站内既有的真实数据，不会出现凭空编造的名称或地址。
 */
export function resolveSiteInfo(
  markdown: string,
  defaults: { siteTitle: string; siteDescription: string; siteUrl: string }
): SiteInfo {
  const parsed = parseSiteInfo(markdown);
  const base = defaults.siteUrl.replace(/\/+$/, "");
  const url = parsed.url && isSafeUrl(parsed.url) ? parsed.url : base;
  return {
    name: (parsed.name || defaults.siteTitle || "").trim(),
    url,
    avatar: absoluteUrl(parsed.avatar || "/avatar.jpg", base),
    desc: (parsed.desc || defaults.siteDescription || "").trim(),
  };
}

/**
 * 同源地址转回站内路径（/avatar.jpg）：
 * 展示时不需要再走一次域名解析，本地开发/离线预览也能正常出图。
 * 只对**与站点同源**的地址生效，外站头像原样返回。
 */
export function sameOriginPath(url: string, siteUrl: string): string {
  try {
    const a = new URL(url);
    const b = new URL(siteUrl);
    if (a.origin !== b.origin) return url;
    return a.pathname + a.search;
  } catch {
    return url;
  }
}

/** 两位计数：4 -> "04"（专题页的编辑式编号） */
export function pad2(n: number): string {
  return String(Math.max(0, Math.trunc(n))).padStart(2, "0");
}

/**
 * 复制给别人的本站友链配置。
 * 字段与 friend_links / 后台外链表单兼容（name/url/desc/kind），额外带头像地址 ——
 * 头像不是表字段，但交换友链时对方需要它；多一个键不会让现有导入方失效。
 */
export function buildFriendConfig(site: {
  name: string;
  url: string;
  avatar: string;
  desc: string;
}): string {
  const cfg: FriendConfig = {
    name: site.name,
    url: site.url,
    avatar: site.avatar,
    desc: site.desc,
    kind: "friend",
  };
  return JSON.stringify(cfg, null, 2);
}
