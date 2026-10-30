import { NextResponse } from "next/server";
import { getDb, dbPath } from "@/lib/db";
import { currentVersion, hasFts } from "@/lib/migrations";
import { getSettings } from "@/lib/settings";
import { getBuildInfo } from "@/lib/build-info";

export const dynamic = "force-dynamic";

/**
 * 健康检查（P2-3）。
 * 用于部署后的探活、外部监控、以及"发布是否真的生效"的判据。
 * 刻意不返回任何敏感信息（不含路径以外的配置、不含用户名）。
 */
export async function GET() {
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    const s = getSettings();
    const mem = process.memoryUsage();

    // 版本戳：让"线上跑的是哪次提交"可被外部查证。
    // 缺 .build-info.json 时为 null，不影响探活。
    const build = getBuildInfo();

    return NextResponse.json({
      ok: true,
      time: new Date().toISOString(),
      commit: build?.shortCommit ?? null,
      commitFull: build?.commit ?? null,
      branch: build?.branch ?? null,
      // false = 构建时有未提交改动，产物无法用 git 复现
      reproducible: build?.reproducible ?? null,
      builtAt: build?.builtAt ?? null,
      schema: currentVersion(db),
      fts: hasFts(db),
      posts: c("SELECT COUNT(*) c FROM posts WHERE status = 'published' AND deleted_at IS NULL"),
      comments: c("SELECT COUNT(*) c FROM comments WHERE status = 'approved'"),
      // 访客事件总数：部署后核对「埋点是否真的在写」用，
      // 比去后台翻页面快，也不暴露任何访客信息
      hits: c("SELECT COUNT(*) c FROM hits"),
      db: dbPath(),
      site: s.siteTitle,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
