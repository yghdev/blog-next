import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageHeader, Empty, Badge } from "@/components/admin/ui";
import { formatIn } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "操作日志" };

const PAGE_SIZE = 100;

/**
 * 操作日志（阶段 02-5）。
 *
 * 改掉的四个真问题：
 *
 *  1) **动作筛选是个自由输入框**（placeholder「如 post.delete」）。你得先知道
 *     内部动作名才能筛 —— 而这个名字只出现在这里列出的行里。现在改成
 *     按「前缀分组」的链接（文章/评论/媒体/设置/存储/外链/账号），
 *     一次点击直达，且 URL 可分享。仍然保留自由搜索框给模糊查。
 *
 *  2) **分页链接丢掉了 action 参数**。原来只拼 page 和 q，一旦用动作筛选
 *     再翻页，筛选就被静默丢弃 —— 看起来像"翻页后数据变多了"。
 *     现在统一用 URLSearchParams 构造，所有维度都带上。
 *
 *  3) **多了一条脏数据看不出来**：meta_json 直接 slice(0,220) 打印，
 *     截断处没有任何标记。现在截断时补省略号，并把完整 JSON 放进 title。
 *
 *  4) 行内 ~12 个魔法数字收进 `.log-*` 类名；动作名用等宽字体并加
 *     语义色点（删除/失败类危险色，登录/创建类正常色），扫读时先看颜色。
 */

/** 动作前缀 → 人话分组。用前缀而不是枚举全量动作名，新增动作自动归队。 */
const GROUPS: { key: string; label: string }[] = [
  { key: "post", label: "文章" },
  { key: "comment", label: "评论" },
  { key: "media", label: "媒体" },
  { key: "settings", label: "设置" },
  { key: "storage", label: "存储" },
  { key: "links", label: "外链" },
  { key: "login", label: "登录" },
  { key: "totp", label: "两步验证" },
  { key: "session", label: "会话" },
];

/** 破坏性 / 失败类动作：给危险色，让"谁删了什么"一眼可见 */
const isDanger = (action: string) =>
  /(delete|purge|fail|disable|revoke|spam|bulk)/.test(action);

export default async function AuditPage({ searchParams }: {
  searchParams: Promise<{ page?: string; q?: string; group?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/admin/login");

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const q = (sp.q ?? "").trim();
  // 兼容旧的 ?action=post.delete：有 action 时按精确动作筛，否则按前缀分组
  const action = (sp as { action?: string }).action?.trim() ?? "";
  const group = GROUPS.some((g) => g.key === (sp.group ?? "")) ? sp.group! : "";

  /**
   * 为什么要绕过 listAudit 自己写查询：
   * listAudit 只支持**精确** action 匹配，而分组筛选要的是前缀
   * （action LIKE 'post.%'）。若先用 listAudit 取一页再在内存里过滤前缀，
   * total 会算成"整页 100 条"，而实际命中的可能只有 3 条 —— 分页器直接是错的。
   * 所以这里用同一条 SQL 语义（q 与 group 作为 AND 条件）各算一次 count 与分页。
   * targetType/targetId 这些 listAudit 支持的能力本页没有用到，不需要保留。
   */
  const db = (await import("@/lib/db")).getDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (action) { where.push("action = ?"); args.push(action); }
  else if (group) { where.push("action LIKE ?"); args.push(group + ".%"); }
  if (q) {
    where.push("(actor_name LIKE ? OR action LIKE ? OR meta_json LIKE ? OR ip LIKE ?)");
    const like = "%" + q + "%";
    args.push(like, like, like, like);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (db.prepare("SELECT COUNT(*) c FROM audit_log " + whereSql).get(...args) as { c: number }).c;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = db.prepare(
    "SELECT * FROM audit_log " + whereSql + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
  ).all(...args, PAGE_SIZE, (current - 1) * PAGE_SIZE) as {
    id: number; action: string; actor_name: string | null; target_type: string | null;
    target_id: string | null; meta_json: string | null; ip: string | null;
    user_agent: string | null; created_at: string;
  }[];

  const filtered = !!(q || action || group);

  /** 统一构造链接：任何维度都不会在翻页时被静默丢掉 */
  const link = (next: { group?: string; action?: string; q?: string; page?: number }) => {
    const u = new URLSearchParams();
    const g = next.group !== undefined ? next.group : group;
    const a = next.action !== undefined ? next.action : action;
    const query = next.q !== undefined ? next.q : q;
    if (a) u.set("action", a);
    else if (g) u.set("group", g);
    if (query) u.set("q", query);
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const qs = u.toString();
    return "/admin/audit" + (qs ? "?" + qs : "");
  };

  return (
    <AdminShell active="audit" username={user.username}>
      <PageHeader
        title="操作日志"
        sub="谁在什么时候动了什么。发布、删除、改设置都会留痕，排查问题先看这里。保留 180 天。"
      />

      <div className="log-toolbar">
        <nav className="seg-tabs" aria-label="按动作分组筛选">
          <Link href={link({ group: "", action: "", page: 1 })}
                className={!group && !action ? "is-active" : undefined}
                aria-current={!group && !action ? "page" : undefined}>全部</Link>
          {GROUPS.map((g) => {
            const active = group === g.key && !action;
            return (
              <Link key={g.key} href={link({ group: g.key, action: "", page: 1 })}
                    className={active ? "is-active" : undefined}
                    aria-current={active ? "page" : undefined}>{g.label}</Link>
            );
          })}
        </nav>

        <form className="log-search" action="/admin/audit" method="get">
          {group ? <input type="hidden" name="group" value={group} /> : null}
          {action ? <input type="hidden" name="action" value={action} /> : null}
          <label>
            <span className="sr-only">搜索操作人、动作、详情或 IP</span>
            <input className="input" type="search" name="q" defaultValue={q}
                   placeholder="搜索操作人 / 动作 / 详情 / IP" />
          </label>
          <button className="btn btn-sm" type="submit">搜索</button>
          {q ? <Link className="log-clear" href={link({ q: "" })}>清除</Link> : null}
        </form>
      </div>

      <div className="log-summary">
        <Badge>{total} 条记录</Badge>
        {action ? <span className="log-summary-filter">动作：{action}</span> : null}
        {!action && group ? (
          <span className="log-summary-filter">
            分组：{GROUPS.find((g) => g.key === group)?.label ?? group}
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Empty
          title={filtered ? "没有匹配的记录" : "还没有操作记录"}
          hint={filtered
            ? "换个分组或清掉搜索词看看。日志只记写操作，纯浏览不会留痕。"
            : "首次执行写操作（发布、删除、改设置）后这里才会有内容。登录成功与失败也会记录。"}
          actions={filtered
            ? <Link className="btn btn-sm" href="/admin/audit">看全部日志</Link>
            : <Link className="btn btn-sm" href="/admin">回到内容列表</Link>}
        />
      ) : (
        <div className="data-panel">
          {rows.map((r) => {
            const meta = r.meta_json && r.meta_json !== "{}" ? r.meta_json : null;
            const long = !!meta && meta.length > 220;
            return (
              <div key={r.id} className="log-row">
                <div className="log-head">
                  <span className={isDanger(r.action) ? "log-action is-danger" : "log-action"}>
                    {r.action}
                  </span>
                  <span className="log-actor">{r.actor_name || "—"}</span>
                  {r.target_type ? (
                    <span className="log-target">{r.target_type} #{r.target_id}</span>
                  ) : null}
                  <span className="log-fill" />
                  <span className="log-meta">{r.ip || "—"}</span>
                  <time className="log-meta" dateTime={r.created_at}>
                    {formatIn(r.created_at, "datetime")}
                  </time>
                </div>
                {meta ? (
                  <div className="log-meta-json" title={meta}>
                    {long ? meta.slice(0, 220) + " …" : meta}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {pages > 1 ? (
        <div className="pager list-pager">
          {current > 1 ? <Link className="btn btn-sm" href={link({ page: current - 1 })}>上一页</Link> : null}
          <span className="pager-current" aria-current="page">{current} / {pages}</span>
          {current < pages ? <Link className="btn btn-sm" href={link({ page: current + 1 })}>下一页</Link> : null}
        </div>
      ) : null}
    </AdminShell>
  );
}
