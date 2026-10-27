import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { db, handleWrite, noStoreJson, parsePostId } from "@/lib/admin-route";
import { findPublishResult } from "@/lib/post-writes";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/posts/:id/publish-result?requestId=<uuid> —— 发布结果核对（方案 §5.4）。
 *
 * 为什么需要它：发布请求的响应可能丢失（网络超时、进程重启、用户关页面），
 * 而"响应丢失"不等于"服务端没提交"。此时客户端不能盲目重试（可能重复发布），
 * 也不能宣告失败（可能其实成功了）—— 只能拿 publishRequestId 回来问结果。
 *
 * 返回 found=false 表示该请求确实没有成功过，可以安全重试。
 */
export const GET = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  await requireAdmin(req);
  const postId = parsePostId((await params).id);
  const requestId = req.nextUrl.searchParams.get("requestId") ?? "";
  if (!requestId) return noStoreJson({ error: "缺少 requestId", code: "REVISION_REQUIRED", status: 400 }, { status: 400 });

  const conn = db();
  const result = findPublishResult(conn, postId, requestId);
  if (!result) return noStoreJson({ found: false, postId, requestId });

  const post = conn.prepare("SELECT slug, status FROM posts WHERE id = ?").get(postId) as
    | { slug: string; status: string }
    | undefined;

  return noStoreJson({
    found: true,
    postId,
    requestId,
    revision: result.revision,
    slug: post?.slug ?? null,
    status: post?.status ?? null,
    snapshotHash: result.snapshotHash,
  });
});
