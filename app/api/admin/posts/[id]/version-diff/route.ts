import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guards";
import { db, handleWrite, noStoreJson, parsePostId } from "@/lib/admin-route";
import { customExcerptOf } from "@/lib/post-writes";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/posts/:id/version-diff?from=<revision>&to=<revision>
 *
 * 取两份历史快照用于对比（方案 §9.2「版本对比」）。
 *
 * 为什么单独一个接口而不是让前端把两个版本各拉一遍：
 * 对比时两份内容必须**来自同一次读取**。分两次请求，中间如果又发布了一版，
 * 用户看到的 diff 就是"旧版 A 对 新版 C"，但他以为在看 A 对 B ——
 * 这种错位在 diff 界面上完全看不出来，却会导致据此做的决定是错的。
 *
 * `to=current` 表示与当前草稿（没有草稿则与线上内容）比较。
 */
export const GET = handleWrite(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  await requireAdmin(req);
  const postId = parsePostId((await params).id);
  const sp = req.nextUrl.searchParams;
  const fromRaw = sp.get("from") ?? "";
  const toRaw = sp.get("to") ?? "current";

  const conn = db();
  const post = conn.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as
    | { id: number; revision: number; title: string; content: string; slug: string; excerpt: string;
        categories: string; tags: string; cover: string | null; comments_enabled: number; type: string }
    | undefined;
  if (!post) return noStoreJson({ error: "文章不存在", code: "POST_NOT_FOUND", status: 404 }, { status: 404 });

  function readRevision(rev: number): { revision: number; snapshot: unknown; createdAt: string; reason: string } | null {
    const r = conn.prepare(
      "SELECT revision, snapshot_json, created_at, reason FROM post_revisions WHERE post_id = ? AND revision = ?"
    ).get(postId, rev) as { revision: number; snapshot_json: string; created_at: string; reason: string } | undefined;
    if (!r) return null;
    return { revision: r.revision, snapshot: JSON.parse(r.snapshot_json), createdAt: r.created_at, reason: r.reason };
  }

  const fromRev = Number(fromRaw);
  if (!Number.isInteger(fromRev) || fromRev <= 0) {
    return noStoreJson({ error: "from 必须是有效的版本号", code: "REVISION_REQUIRED", status: 400 }, { status: 400 });
  }
  const left = readRevision(fromRev);
  if (!left) {
    return noStoreJson({ error: "该版本不存在", code: "POST_NOT_FOUND", status: 404 }, { status: 404 });
  }

  // 右侧：current = 当前草稿优先，没有草稿则用线上内容
  let right: { revision: number | "current"; snapshot: unknown; label: string };
  if (toRaw === "current") {
    const draft = conn.prepare("SELECT snapshot_json, draft_revision FROM post_drafts WHERE post_id = ?").get(postId) as
      | { snapshot_json: string; draft_revision: number }
      | undefined;
    if (draft) {
      right = { revision: "current", snapshot: JSON.parse(draft.snapshot_json), label: "当前草稿 v" + draft.draft_revision };
    } else {
      // 没有草稿：与线上内容比。这里构造一个与快照同形状的对象，
      // 否则 diff 会因字段名不同（content vs snapshot.content）而全部标红。
      right = {
        revision: "current",
        snapshot: {
          type: post.type, title: post.title, slug: post.slug, content: post.content,
          // 与 snapshotFromPost 同口径：自动截取的摘要不冒充"用户自定义"
          excerpt: customExcerptOf(post),
          cover: post.cover,
          categories: safeParse(post.categories), tags: safeParse(post.tags),
          comments_enabled: post.comments_enabled ? 1 : 0,
        },
        label: "当前线上内容 v" + post.revision,
      };
    }
  } else {
    const toRev = Number(toRaw);
    if (!Number.isInteger(toRev) || toRev <= 0) {
      return noStoreJson({ error: "to 必须是有效版本号或 current", code: "REVISION_REQUIRED", status: 400 }, { status: 400 });
    }
    const r = readRevision(toRev);
    if (!r) return noStoreJson({ error: "该版本不存在", code: "POST_NOT_FOUND", status: 404 }, { status: 404 });
    right = { revision: r.revision, snapshot: r.snapshot, label: r.reason === "baseline" ? "初始基线" : "发布 v" + r.revision };
  }

  return noStoreJson({
    postId,
    from: { revision: left.revision, snapshot: left.snapshot, label: left.reason === "baseline" ? "初始基线" : "发布 v" + left.revision, createdAt: left.createdAt },
    to: right,
  });
});

function safeParse(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}
