import { notFound, permanentRedirect } from "next/navigation";
import { resolveLegacyPath } from "@/lib/legacy-path";
import { postHref } from "@/lib/posts";

export const dynamic = "force-dynamic";

/**
 * 旧 WordPress 日期路径的兜底入口（`/2026/06/07/imghub`）。
 *
 * 为什么放在根级 catch-all，而不是给 `[slug]` 加正则：
 *   1. 旧路径是**多段**的，`app/[slug]` 只匹配单段，写不进同一个路由
 *   2. 单段旧地址（`/中文slug`）已经有 `app/[slug]/page.tsx` 处理，
 *      两者深度不同、不会互相遮挡：Next 的路由优先级是
 *      静态段 > 动态段 > catch-all
 *
 * 解析与匹配规则都在 `lib/legacy-path.ts`，这里只负责「查不到就 404、
 * 查到就 308」。用 308 而不是 307：与 `[slug]` 兼容层保持一致，
 * 让搜索引擎把权重转移到 `/p/<id>` 这个规范地址上。
 */
export default async function LegacyPathPage({ params }: { params: Promise<{ legacy: string[] }> }) {
  const { legacy } = await params;
  const target = resolveLegacyPath(legacy ?? []);
  if (!target) notFound();
  if (target.kind === "archive") permanentRedirect("/archives");
  permanentRedirect(postHref(target.post));
}
