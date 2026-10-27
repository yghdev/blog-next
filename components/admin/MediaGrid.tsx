"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Empty, Badge } from "./ui";

/**
 * 媒体库（阶段 02-4）。
 *
 * 本轮改掉的（都是实际问题，不是"调观感"）：
 *
 *  1) **搜索与分页根本不存在**。页面硬编码 `LIMIT 120`，第 121 张图开始就
 *     永远看不见、也删不掉 —— 而 API 早就支持 q/limit/offset。现在筛选
 *     （全部/七牛/本机/未引用）、搜索、分页全部落到 URL 上，可分享、可回退。
 *
 *  2) **扫描结果里有 200 条上限，界面却当成全部**。API 用 slice(0,200) 截断，
 *     返回的是 orphanCount/missingCount；媒体页只看 orphans 数组，于是
 *     "孤儿 300 个"时只列 200 条且不说一句。现在按两个数字分别显示，明确
 *     写出"仅列前 200 个"。
 *
 *  3) **裂图（库里有、存储里没有）只是消息里一句话**。这是真正会让文章
 *     掉图的问题，却和"孤儿"混在同一行文案里。现在单独成块，列路径并给出
 *     处理方向（重新上传或改正文引用）。
 *
 *  4) 卡片全是行内样式（每个 tile 约 12 个魔法数字），收进 `.media-*` 类；
 *     图片按真实宽高比预览，不再一律裁成 110px 高的横条 —— 竖图被裁掉
 *     大半，等于看不到自己传的是什么。
 *
 *  5) "复制"的可达性：图标按钮只有 `复制` 两个字、无 aria-label、无键盘焦点
 *     样式。现在有 aria-label、`aria-live` 反馈、以及 title 说明复制内容。
 */

type Item = {
  id: number; path: string; filename: string; mime: string; size: number;
  created_at: string; width: number | null; height: number | null; refs: number;
  /** 图片实际存在哪：七牛（CDN 直链）还是本机磁盘（历史存量） */
  storage: "qiniu" | "local";
};

type ScanResult = {
  onDisk: number; qiniu: number; inDb: number;
  /** 存储里有、库里没有（可清理；API 只回前 200 条） */
  orphans: string[];
  /** 孤儿总数：可能大于 orphans.length */
  orphanCount: number;
  /** 库里有、存储里没有 —— 真·裂图 */
  missing: string[];
  missingCount: number;
};

export function MediaGrid({ items, total, page, pages, filter, q, storageConfigured, cdnDomain, scanAction }: {
  items: Item[];
  total: number;
  page: number;
  pages: number;
  filter: string;
  q: string;
  storageConfigured: boolean;
  cdnDomain: string;
  /** 扫描/登记需要 POST /api/admin/media，这个组件本身是 client，直接 fetch */
  scanAction?: (body: Record<string, unknown>) => Promise<Response>;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState<Item | null>(null);
  /* 复制反馈自熄：记录刚复制的那一项，2.5s 后自动淡出恢复 */
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const post = scanAction ?? (async (body) => fetch("/api/admin/media", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));

  const clearBanner = () => { setMsg(""); setErr(""); };

  const copy = async (p: string) => {
    // 重复点击先清计时器：不叠加、不闪烁、不提前熄灭
    if (copyTimer.current) { clearTimeout(copyTimer.current); copyTimer.current = null; }
    try {
      await navigator.clipboard.writeText("![](" + p + ")");
      setCopied(p);
      setMsg("已复制 Markdown 引用：" + p);
      copyTimer.current = setTimeout(() => {
        setCopied(null);
        setMsg("");
        copyTimer.current = null;
      }, 2500);
    } catch {
      setErr("复制失败，请手动选取");
    }
  };

  const remove = async (item: Item) => {
    clearBanner(); setBusy(true); setPending(null);
    const res = await fetch("/api/admin/media/" + item.id, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg("已删除「" + item.filename + "」"); router.refresh(); }
    else setErr(d.error || "删除失败");
  };

  /**
   * 把七牛空间里未被登记的对象导入 media 表。
   * 历史遗留：这些图是别的客户端传的，图库看不见也管不了。
   */
  const importQiniu = async () => {
    clearBanner(); setBusy(true);
    try {
      const res = await post({ action: "import-qiniu" });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg(d.inserted > 0
          ? "已扫描 " + d.scanned + " 个七牛对象，新登记 " + d.inserted + " 个到媒体库"
          : "已扫描 " + d.scanned + " 个七牛对象，全部已在库中，无需登记");
        router.refresh();
      } else setErr(d.error || "登记失败");
    } catch { setErr("网络错误"); }
    finally { setBusy(false); }
  };

  const runScan = async () => {
    clearBanner(); setBusy(true);
    try {
      const res = await post({ action: "scan-orphans" });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setScan({
          onDisk: d.onDisk ?? 0, qiniu: d.qiniu ?? 0, inDb: d.inDb ?? 0,
          orphans: d.orphans ?? [], orphanCount: d.orphanCount ?? (d.orphans ?? []).length,
          missing: d.missing ?? [], missingCount: d.missingCount ?? (d.missing ?? []).length,
        });
      } else setErr(d.error || "扫描失败");
    } catch { setErr("网络错误"); }
    finally { setBusy(false); }
  };

  /** 筛选链接统一用 URLSearchParams，避免拼出 "?storage=&page=2" 这种脏 URL */
  const href = (next: { storage?: string; q?: string; page?: number }) => {
    const u = new URLSearchParams();
    const s = next.storage !== undefined ? next.storage : filter;
    const query = next.q !== undefined ? next.q : q;
    if (s) u.set("storage", s);
    if (query) u.set("q", query);
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const qs = u.toString();
    return "/admin/media" + (qs ? "?" + qs : "");
  };

  const ratio = (m: Item) => {
    // 有真实宽高就按真实比例预览（竖图不再被裁成横条）；缺宽高退回 4:3
    if (m.width && m.height) return m.width + " / " + m.height;
    return "4 / 3";
  };

  return (
    <>
      <div className="media-toolbar">
        <nav className="seg-tabs" aria-label="按存储位置筛选">
          {[
            { key: "", label: "全部" },
            { key: "qiniu", label: "七牛 CDN" },
            { key: "local", label: "本机磁盘" },
            { key: "unused", label: "未引用" },
          ].map((t) => {
            const active = filter === t.key;
            return (
              <Link key={t.key || "all"} href={href({ storage: t.key, page: 1 })}
                    className={active ? "is-active" : undefined}
                    aria-current={active ? "true" : undefined}>
                {t.label}
              </Link>
            );
          })}
        </nav>

        <form className="media-search" action="/admin/media" method="get">
          {filter ? <input type="hidden" name="storage" value={filter} /> : null}
          <label>
            <span className="sr-only">搜索文件名或路径</span>
            <input className="input" type="search" name="q" defaultValue={q} placeholder="搜索文件名或路径" />
          </label>
          <button className="btn btn-sm" type="submit">搜索</button>
          {q ? <Link className="media-clear" href={href({ q: "" })}>清除</Link> : null}
        </form>
      </div>

      <div className="media-toolbar">
        <button className="btn btn-sm" onClick={runScan} disabled={busy}>扫描孤儿文件</button>
        {storageConfigured ? (
          <button className="btn btn-sm" onClick={importQiniu} disabled={busy}
                  title="把七牛空间里已有、但媒体库还没登记的对象导入进来">
            登记七牛对象
          </button>
        ) : null}
        <span className={storageConfigured ? "badge badge-ok" : "badge badge-warn"}>
          {storageConfigured
            ? "新图写入七牛 · " + (cdnDomain || "CDN 未填")
            : "七牛未配置 · 新图写入本机磁盘"}
        </span>
      </div>

      {msg ? <div className="notice notice-ok" role="status">{msg}</div> : null}
      {err ? <div className="notice notice-error" role="alert">{err}</div> : null}

      {scan ? (
        <section className="media-scan" aria-label="扫描结果">
          <div className="media-scan-head">
            <strong>扫描结果</strong>
            <span className="media-scan-stat">
              本机 {scan.onDisk} 个 · 七牛 {scan.qiniu} 个 · 库内 {scan.inDb} 条
            </span>
            <button className="btn btn-sm" onClick={() => setScan(null)}>关闭</button>
          </div>

          {scan.missingCount > 0 ? (
            <div className="media-scan-block is-missing">
              {/* 裂图是会让文章真掉图的问题，必须优先且单独说 */}
              <div className="media-scan-title">
                库里有、存储里没有（裂图）· {scan.missingCount} 个
              </div>
              <div className="media-scan-hint">
                这些记录指向的文件已经不在磁盘/七牛上，文章里的图会显示不出来。
                要么重新上传同名文件，要么把正文里的引用改掉。媒体库本身不自动删除这些记录。
              </div>
              <ul className="media-scan-list">
                {scan.missing.slice(0, 50).map((o) => <li key={o}>{o}</li>)}
              </ul>
              {scan.missingCount > 50 ? (
                <div className="media-scan-more">仅列前 50 个，共 {scan.missingCount} 个。</div>
              ) : null}
            </div>
          ) : null}

          <div className="media-scan-block">
            <div className="media-scan-title">存储里有、库里没有 · {scan.orphanCount} 个</div>
            <div className="media-scan-hint">
              多为历史上传（别的客户端传的）未登记。可以点上方「登记七牛对象」导入，
              本机磁盘上的不自动删除。
            </div>
            {scan.orphans.length ? (
              <ul className="media-scan-list">
                {scan.orphans.slice(0, 50).map((o) => <li key={o}>{o}</li>)}
              </ul>
            ) : <div className="media-scan-hint">没有孤儿文件。</div>}
            {scan.orphans.length > 50
              ? <div className="media-scan-more">仅列前 50 个（本次回传 {scan.orphans.length} 条，总计 {scan.orphanCount} 个）。</div>
              : null}
          </div>
        </section>
      ) : null}

      {items.length === 0 ? (
        q || filter ? (
          <Empty
            title="没有匹配的图片"
            hint={"当前筛选：" + (filter || "全部") + (q ? " · 搜索「" + q + "」" : "") + "。换个条件或清除筛选试试。"}
            actions={<Link className="btn btn-sm" href="/admin/media">看全部图片</Link>}
          />
        ) : (
          <Empty
            title="还没有图片"
            hint="在编辑器里粘贴或拖入图片就会自动上传到这里。历史文章里引用过但没登记的图片，可以用上方「扫描孤儿文件」找出来。"
            actions={<Link className="btn btn-sm" href="/admin/new">去写文章</Link>}
          />
        )
      ) : (
        <div className="media-grid">
          {items.map((m) => (
            <figure key={m.id} className="media-card">
              <div className="media-thumb" style={{ aspectRatio: ratio(m) }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.path} alt={m.filename} loading="lazy" decoding="async" />
                {m.refs > 0 ? <span className="media-refs">引用 {m.refs}</span> : null}
              </div>
              <figcaption className="media-meta">
                <div className="media-name" title={m.filename}>{m.filename}</div>
                <div className="media-sub">
                  {(m.size / 1024).toFixed(0)} KB
                  {m.width ? " · " + m.width + "×" + m.height : ""}
                </div>
                <div className="media-tags">
                  <Badge tone={m.storage === "qiniu" ? "ok" : "neutral"}>
                    {m.storage === "qiniu" ? "七牛 CDN" : "本机磁盘"}
                  </Badge>
                  {m.refs > 0 ? <Badge tone="info">被引用</Badge> : null}
                </div>
                <div className="media-actions">
                  <button
                    className="btn btn-sm media-copy"
                    onClick={() => copy(m.path)}
                    aria-label={"复制「" + m.filename + "」的 Markdown 引用"}
                    aria-live="polite"
                  >{copied === m.path ? "已复制" : "复制"}</button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy || m.refs > 0}
                    title={m.refs > 0 ? "仍被 " + m.refs + " 篇文章引用，不能删除" : "删除这张图"}
                    aria-label={m.refs > 0 ? "删除「" + m.filename + "」（被引用，已禁用）" : "删除「" + m.filename + "」"}
                    onClick={() => setPending(m)}
                  >删除</button>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="media-foot">
        <span className="media-count">
          共 {total} 张{filter || q ? "（当前筛选后）" : ""}
        </span>
        {pages > 1 ? (
          <div className="pager">
            {page > 1 ? <Link className="btn btn-sm" href={href({ page: page - 1 })}>上一页</Link> : null}
            <span className="pager-current" aria-current="page">{page} / {pages}</span>
            {page < pages ? <Link className="btn btn-sm" href={href({ page: page + 1 })}>下一页</Link> : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={"删除图片「" + (pending?.filename ?? "") + "」？"}
        description={
          <>
            文件会从磁盘和 media 表里一起移除，<strong>不可撤销</strong>。
            若这张图仍被任何文章引用，按钮是禁用状态 —— 请先改掉正文里的引用。
          </>
        }
        confirmLabel="删除图片"
        danger
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => { if (pending) void remove(pending); }}
      />
    </>
  );
}
