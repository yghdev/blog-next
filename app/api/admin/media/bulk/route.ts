import { NextRequest } from "next/server";
import { requireAdmin, requireStepUp, stepUpCodeFrom } from "@/lib/guards";
import { db, handleWrite, noStoreJson } from "@/lib/admin-route";
import { logAudit } from "@/lib/audit";
import { deleteMedia, countMediaRefs, migrateLocalToCdn } from "@/lib/media-ops";
import { invalidate } from "@/lib/purge";
import { TAGS } from "@/lib/posts";
import type { MediaRow } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 媒体批量操作（批量删除 / 批量迁移至 CDN）。
 *
 * 与内容批量接口同一套语义：逐项处理、逐项返回结果，允许部分成功。
 * 不能写成 `DELETE FROM media WHERE id IN (...)`，因为：
 *   1) 被文章引用的图必须逐条跳过并说明原因，而不是整批失败；
 *   2) 每条都要动对应的存储对象，失败项必须能被单独报告。
 *
 * 删除要求 step-up（与文章批量删除一致）；迁移不改可见性、且保留本机原文件，
 * 属于可回退的内容更新，走普通管理员鉴权 + 审计。
 */

type ItemResult = {
  id: number;
  ok: boolean;
  outcome: "deleted" | "migrated" | "skipped" | "conflict" | "notFound";
  code?: string;
  message?: string;
  to?: string;
};

const MAX_ITEMS = 100;

export const POST = handleWrite(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStoreJson({ error: "参数错误", code: "BAD_REQUEST", status: 400 }, { status: 400 });

  const action = String(body.action ?? "");
  if (action !== "delete" && action !== "migrate-cdn") {
    return noStoreJson({ error: "未知的批量操作", code: "BAD_REQUEST", status: 400 }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length) {
    return noStoreJson({ error: "请先选择图片", code: "BAD_REQUEST", status: 400 }, { status: 400 });
  }
  if (ids.length > MAX_ITEMS) {
    return noStoreJson({ error: "一次最多操作 " + MAX_ITEMS + " 张", code: "BAD_REQUEST", status: 400 }, { status: 400 });
  }

  if (action === "delete") {
    await requireStepUp(ctx, stepUpCodeFrom(req, body));
  }

  const conn = db();
  const results: ItemResult[] = [];

  for (const id of ids) {
    const row = conn.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined;
    if (!row) {
      results.push({ id, ok: false, outcome: "notFound", code: "MEDIA_NOT_FOUND", message: "图片记录不存在" });
      continue;
    }

    try {
      if (action === "delete") {
        const refs = countMediaRefs(conn, row.path);
        if (refs > 0) {
          results.push({
            id, ok: false, outcome: "skipped", code: "MEDIA_IN_USE",
            message: "仍被 " + refs + " 篇文章引用",
          });
          continue;
        }
        await deleteMedia(conn, row);
        results.push({ id, ok: true, outcome: "deleted" });
      } else {
        if (!row.path.startsWith("/images/")) {
          results.push({
            id, ok: false, outcome: "skipped", code: "ALREADY_CDN",
            message: "已在 CDN 上",
          });
          continue;
        }
        const r = await migrateLocalToCdn(conn, row, {
          userId: ctx.user.id, userName: ctx.user.username, ip: ctx.ip, userAgent: ctx.userAgent,
        });
        results.push({ id, ok: true, outcome: "migrated", to: r.to });
      }
    } catch (e) {
      results.push({ id, ok: false, outcome: "conflict", code: "OPERATION_FAILED", message: (e as Error).message });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  if (succeeded > 0) invalidate([TAGS.posts]);

  const summary = {
    total: results.length,
    succeeded,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    failed: results.filter((r) => r.outcome === "conflict" || r.outcome === "notFound").length,
  };

  // 批量只留一条汇总审计；逐条明细在 results 里，避免 N 条 media.delete 淹没日志。
  logAudit({
    action: "media.bulk",
    userId: ctx.user.id, userName: ctx.user.username,
    targetType: "media",
    meta: { action, ...summary },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });

  return noStoreJson({ ok: true, action, summary, results });
});
