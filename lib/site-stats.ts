import fs from "node:fs";
import Database from "better-sqlite3";
import { getDb, ftsAvailable } from "./db";
import { dateKeyIn } from "./time";
import * as visitor from "./visitor-stats";

export type Stat = { label: string; value: string; icon: string };

/**
 * 站点统计（方案 C11，2026-10-30 改数据源）。
 *
 * ## 历史包袱：为什么注释里到处是 Umami
 *
 * 原实现在**文章页 SSR 路径里同步 await 一次外部 HTTP**（Umami），
 * Umami 一慢文章页就慢、一挂文章页就 500。后来改成 systemd timer 拉数据
 * 写进 settings 的 KV（scripts/sync-umami.mjs）。
 *
 * 那个方案能跑，但天花板很低：只有聚合后的 PV，没有时间维度、算不了 UV、
 * 做不了来源归因；而且 `sync-umami.mjs` 拉的是「近 365 天」窗口，
 * 站龄满一年后「访问」会开始往下掉，标签却还写着「访问」。
 *
 * 现在浏览量由 lib/visitor-stats.ts 直接查 hits 表 —— 同一个 blog.db，
 * 自动进每日备份，也不再依赖 344MB 的 Docker 邻居。
 *
 * 旧的 `umami:*` 设置项**没有被删**：它们是上线前的历史基线，
 * 迁移 0013 已把它们冻结成 `stats:baseline:*`，读取时与新增数据相加。
 * 删掉只会让所有文章的浏览量归零。
 */

/**
 * 评论数只读 Artalk 的 SQLite。
 *
 * 为什么不用定时同步：
 *   · 评论低频变化，外层已有 unstable_cache 兜 300 秒，实际查询极少
 *   · Artalk 用 journal_mode=delete（非 WAL），只读连接不与之争锁
 * 代价是博客对 Artalk 多一层弱耦合，用下面的兜底隔离：
 * 文件缺失 / 打不开 / schema 变更一律返回 null，显示「—」，
 * 而不是假装 0（区分「真的没有评论」与「读不到」）。
 */
const ARTALK_DB = process.env.ARTALK_DB || "/opt/artalk/data/artalk.db";
const ARTALK_SITE = process.env.NEXT_PUBLIC_ARTALK_SITE || "flechazo blog";

/** undefined = 未尝试，null = 试过但不可用，对象 = 可用 */
let _artalk: Database.Database | null | undefined;

function getArtalkDb(): Database.Database | null {
  if (_artalk !== undefined) return _artalk;
  try {
    if (!fs.existsSync(ARTALK_DB)) { _artalk = null; return null; }
    const db = new Database(ARTALK_DB, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    _artalk = db;
    return db;
  } catch (e) {
    console.warn("[stats] Artalk 库打不开，评论数显示「—」:", (e as Error).message);
    _artalk = null;
    return null;
  }
}

/** Artalk 已审核且未删除的评论数；null = 读不到 */
export function getArtalkCommentCount(): number | null {
  const db = getArtalkDb();
  if (!db) return null;
  try {
    // Artalk 用软删除（deleted_at）+ 待审标记（is_pending），两者都要排除
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM comments " +
      "WHERE deleted_at IS NULL AND (is_pending = 0 OR is_pending IS NULL) AND site_name = ?"
    ).get(ARTALK_SITE) as { c: number } | undefined;
    return row ? row.c : null;
  } catch (e) {
    console.warn("[stats] Artalk 评论查询失败:", (e as Error).message);
    return null;
  }
}

/**
 * 侧栏的站点统计。
 *
 * ⚠️ 2026-10-30 起**不再显示「访问」**。
 * 那个数字的口径换过三次（实时 Umami → 近 365 天滚动窗口 → 自建），
 * 而标签只有「访问」两个字，读者无从判断它到底是什么。
 * 与其放一个解释不清的数字，不如先拿掉 —— 等访客页跑稳了，
 * 在专门页面里给完整口径（PV / UV / 访问次数分开写）。
 */
export function getSiteStats(): Stat[] {
  const db = getDb();
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;

  const posts = c("SELECT COUNT(*) c FROM posts WHERE type = 'post' AND status = 'published' AND deleted_at IS NULL");
  const shuo = c("SELECT COUNT(*) c FROM posts WHERE type = 'shuoshuo' AND status = 'published' AND deleted_at IS NULL");
  // 评论以 Artalk 为准；读不到时退回博客自建表（历史数据），再不行显示 —
  const artalkComments = getArtalkCommentCount();
  const commentsText = artalkComments !== null
    ? String(artalkComments)
    : String(c("SELECT COUNT(*) c FROM comments WHERE status = 'approved'"));

  const first = db.prepare(
    "SELECT MIN(published_at) m FROM posts WHERE type = 'post' AND status = 'published' AND deleted_at IS NULL"
  ).get() as { m: string | null };
  let days = 0;
  if (first?.m) {
    const start = new Date(first.m).getTime();
    if (!isNaN(start)) days = Math.max(1, Math.floor((Date.now() - start) / 86400000));
  }

  return [
    { label: "文章", value: String(posts), icon: "📝" },
    { label: "说说", value: String(shuo), icon: "💬" },
    { label: "评论", value: commentsText, icon: "🗨" },
    { label: "运行", value: days + "天", icon: "⏳" },
  ];
}

/* --------------------------- 浏览量（新数据源） --------------------------- */

/**
 * 单篇浏览量：hits 表 + 上线前的历史基线。
 * 签名保留 `(path, postId?)` —— postId 优先（slug 会改，id 不会）。
 */
export function getPageViews(pagePath: string, postId?: number | null): number | null {
  return visitor.getPageViews(pagePath, postId);
}

/** 首页批量取浏览量：一次查询拿全，key 是 post_id（不是路径，避开中文编码问题） */
export function getViewsMap(): Map<number, number> {
  return visitor.getViewsMap();
}

export type TagItem = { name: string; count: number; size: number };

/** 标签云：按出现次数映射字号（0.72 ~ 1.0 rem） */
export function getTagCloud(limit = 18): TagItem[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT tags FROM posts WHERE type = 'post' AND status = 'published' AND deleted_at IS NULL"
  ).all() as { tags: string }[];

  const counter = new Map<string, number>();
  for (const r of rows) {
    let arr: string[] = [];
    try {
      const v = JSON.parse(r.tags || "[]");
      if (Array.isArray(v)) arr = v.map(String);
    } catch {
      // 脏数据跳过，不让标签云整块消失
    }
    for (const t of arr) {
      const name = t.trim();
      if (!name) continue;
      counter.set(name, (counter.get(name) || 0) + 1);
    }
  }

  const list = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = list[0]?.[1] || 1;
  return list.map(([name, count]) => ({ name, count, size: 0.72 + (count / max) * 0.28 }));
}

export function searchReady(): boolean {
  return ftsAvailable();
}

export { dateKeyIn };
