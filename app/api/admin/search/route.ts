import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { db, handleWrite, noStoreJson } from "@/lib/admin-route";
import { adminSearch, type AdminSearchType } from "@/lib/admin-search";

export const dynamic = "force-dynamic";

const TYPES: AdminSearchType[] = ["post", "page", "shuoshuo"];

/**
 * GET /api/admin/search?q=<关键词>&type=<post|page|shuoshuo>
 *
 * 命令面板的数据源（阶段 04）。三条硬要求：
 *   1. `requireAdmin` —— 后台数据（含草稿标题）绝不能被未登录者搜到
 *   2. `no-store` —— 搜索结果必须反映"我刚改的内容"，不能吃缓存
 *   3. 不返回正文 —— 只给定位用的元信息
 *
 * 空查询返回空数组而不是报错：命令面板在用户还没输入时会调它，
 * 那时"没有结果"是正常状态，不该在界面上显示错误。
 */
export const GET = handleWrite(async (req: NextRequest) => {
  await requireAdmin(req);

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  const rawType = sp.get("type") ?? "";
  const type = TYPES.includes(rawType as AdminSearchType) ? (rawType as AdminSearchType) : "";

  if (!q) return noStoreJson({ q, hits: [], total: 0 });

  const hits = adminSearch(db(), q, { limit: 20, type });
  return noStoreJson({ q, total: hits.length, hits });
});
