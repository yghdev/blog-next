import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { listAudit } from "@/lib/audit";
import { PageHeader, Badge, Empty } from "@/components/admin/ui";
import { formatIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "操作日志" };

const PAGE_SIZE = 100;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string; action?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const q = (sp.q ?? "").trim();
  const action = (sp.action ?? "").trim();

  const { rows, total } = listAudit({ q, action, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = !!(q || action);

  return (
    <AdminShell active="audit" username={user.username}>
      <PageHeader
        title="操作日志"
        sub="谁在什么时候动了什么。发布、删除、改设置都会留痕，排查问题先看这里。"
      />

      <form method="get" className="filter-bar">
        <input
          className="input" name="q" defaultValue={q}
          placeholder="搜索操作人 / 动作 / 详情" aria-label="搜索日志"
          style={{ maxWidth: 280, flex: "1 1 200px" }}
        />
        <input
          className="input" name="action" defaultValue={action}
          placeholder="动作，如 post.delete" aria-label="按动作筛选"
          style={{ maxWidth: 200, flex: "1 1 160px" }}
        />
        <button className="btn btn-sm" type="submit">筛选</button>
        {filtered ? <Link className="btn btn-sm btn-ghost" href="/admin/audit">清除</Link> : null}
      </form>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <Badge>{total} 条记录</Badge>
      </div>

      {rows.length === 0 ? (
        <Empty
          title={filtered ? "没有匹配的记录" : "还没有操作记录"}
          hint={filtered
            ? "换个关键词，或者清掉筛选条件看全量。"
            : "首次执行写操作（发布、删除、改设置）后这里才会有内容。"}
          actions={filtered ? <Link className="btn btn-sm" href="/admin/audit">清除筛选</Link> : undefined}
        />
      ) : (
        <div className="data-panel">
          {rows.map((r) => (
            <div key={r.id} style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", fontSize: ".8rem" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-p0)", fontSize: ".78rem" }}>{r.action}</span>
                <span style={{ color: "var(--text-p3)" }}>{r.actor_name || "—"}</span>
                {r.target_type ? (
                  <span style={{ color: "var(--text-p4)", fontSize: ".74rem" }}>{r.target_type} #{r.target_id}</span>
                ) : null}
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--text-p4)", fontSize: ".74rem", fontVariantNumeric: "tabular-nums" }}>{r.ip}</span>
                <span style={{ color: "var(--text-p4)", fontSize: ".74rem", fontVariantNumeric: "tabular-nums" }}>
                  {formatIn(r.created_at, "datetime")}
                </span>
              </div>
              {r.meta_json && r.meta_json !== "{}" ? (
                <div style={{
                  fontFamily: "var(--font-mono)", fontSize: ".72rem", color: "var(--text-p4)",
                  marginTop: 4, wordBreak: "break-all", lineHeight: 1.6,
                }}>
                  {r.meta_json.slice(0, 220)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {pages > 1 ? (
        <div className="pager" style={{ marginTop: 16 }}>
          {page > 1 ? <Link className="btn btn-sm" href={"/admin/audit?page=" + (page - 1) + "&q=" + encodeURIComponent(q)}>上一页</Link> : null}
          <span className="btn btn-sm" style={{ pointerEvents: "none", opacity: .6 }}>{page} / {pages}</span>
          {page < pages ? <Link className="btn btn-sm" href={"/admin/audit?page=" + (page + 1) + "&q=" + encodeURIComponent(q)}>下一页</Link> : null}
        </div>
      ) : null}
    </AdminShell>
  );
}
