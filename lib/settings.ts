import { getDb } from "./db";

/**
 * 站点设置（方案 C4）。
 *
 * 背景：settings 表早就建了，但**全库 0 处引用** —— 站名、描述、页脚、友链
 * 全部硬编码在 layout.tsx / rss.xml / sitemap.ts 里，改一个字要重新构建。
 * 这里把它变成真的可用配置。
 */
export type Settings = {
  siteTitle: string;
  siteSubtitle: string;
  siteDescription: string;
  author: string;
  footerText: string;
  icp: string;
  friendLinks: string;
  timezone: string;
  commentEnabled: boolean;
  rssEnabled: boolean;
  umamiTotal: string;
};

export const DEFAULT_SETTINGS: Settings = {
  siteTitle: "flechazo's blog",
  siteSubtitle: "扬帆起航",
  siteDescription: "记录 AI、开发与折腾的日常。",
  author: "flechazo",
  footerText: "",
  icp: "",
  friendLinks: "",
  timezone: "Asia/Shanghai",
  commentEnabled: true,
  rssEnabled: true,
  umamiTotal: "",
};

const KEY_MAP: Record<string, keyof Settings> = {
  site_title: "siteTitle",
  site_subtitle: "siteSubtitle",
  site_description: "siteDescription",
  author: "author",
  footer_text: "footerText",
  icp: "icp",
  friend_links: "friendLinks",
  timezone: "timezone",
  comment_enabled: "commentEnabled",
  rss_enabled: "rssEnabled",
  umami_total: "umamiTotal",
  "umami:total": "umamiTotal",
};

const REVERSE: Record<keyof Settings, string> = Object.fromEntries(
  Object.entries(KEY_MAP).map(([k, v]) => [v, k])
) as Record<keyof Settings, string>;

/**
 * 读站点设置：**每次直查库，不做进程内缓存**。
 *
 * 这里曾经有一个 10 秒 TTL 的进程内缓存（注释写的是"settings 读多写少"）。
 * 2026-11-07 实测发现它是**跨 chunk 不可失效**的：
 *
 *   Next 把 route handler 与页面渲染打包成两个入口，各自持有独立的模块实例。
 *   后台 PUT 里调 `invalidateSettingsCache()` 只清了 route 那一份，
 *   页面渲染那一份仍是旧值 —— 于是"后台改站名 → 前台最长 10 秒不变"；
 *   更糟的是这期间外层 `unstable_cache`（原 getSettingsCached，300s）
 *   若重建，会把这份旧值再固化 5 分钟（tests/layout-regression.mjs
 *   里曾把这个现象记为"既有问题"）。
 *
 * 现在每次直接查库：settings 表只有十几行，单次 <0.1ms，一页最多读 2~3 次。
 * 代价可以忽略，换来的是"后台改完，下一个请求就生效"这个可预期的语义 ——
 * 配套地，`getSettingsCached` 已删除（它只会把首帧变旧）。
 */
export function getSettings(): Settings {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const value: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    const field = KEY_MAP[r.key];
    if (!field) continue;
    if (field === "commentEnabled" || field === "rssEnabled") {
      (value[field] as boolean) = r.value === "1" || r.value === "true";
    } else {
      (value[field] as string) = r.value;
    }
  }
  return value;
}

export function updateSettings(patch: Partial<Settings>): void {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  db.transaction(() => {
    for (const [field, v] of Object.entries(patch)) {
      const key = REVERSE[field as keyof Settings];
      if (!key || v === undefined) continue;
      stmt.run(key, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
  })();
}

/** 供 Umami 定时任务写回，不经过后台（P4） */
export function setStatValue(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getRawSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
