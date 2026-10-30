"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Empty, Badge } from "./ui";
import { MediaLightbox } from "./MediaLightbox";
import { IconCloudUp, IconCopy, IconExternal, IconMore, IconTrash } from "./editor-icons";
import { formatBytes } from "@/lib/image-plan";
import { MEDIA_SORTS, mediaSortLabel, type MediaSort } from "@/lib/media-sort";

/**
 * 媒体库（阶段 02-4 / 02-6）。
 *
 * 这一轮解决三个真实的日常痛点：
 *
 *  1) **没有批量操作**。清理未引用图片只能一张张点，一张张确认。
 *     现在每张卡片左上角有选择框，选中后底部浮出批量条（数量 + 批量删除 +
 *     迁移至 CDN + 取消选择）。批量删除仍逐项检查引用，被引用的跳过并报告，
 *     不会因为"混选"整批失败。
 *
 *  2) **卡片信息过载**。复制/删除两个按钮常驻，每张卡片底部都是两枚控件，
 *     48 张就是 96 个按钮。现在收进右上角「更多」菜单，hover / 键盘聚焦时浮现；
 *     卡片只留文件名、体积/尺寸、存储来源三行。
 *
 *  3) **没有排序**。清理大文件要靠肉眼翻页。现在搜索框旁有排序选择
 *     （最新 / 最早 / 最大 / 最小），排序值落到 URL，可分享可回退。
 *
 * 另外：点击缩略图打开大图预览，左右键在当前页内切换。
 *
 * 保留不动的既有契约：筛选/搜索/分页全部走 URL；被引用的图不能删（服务端
 * 仍是最终判定，前端只是提前禁用）；裂图与孤儿分块呈现；手机 44dp 热区。
 */

type Item = {
  id: number; path: string; filename: string; mime: string; size: number;
  created_at: string; width: number | null; height: number | null; refs: number;
  /** 图片实际存在哪：七牛（CDN 直链）还是本机磁盘（历史存量） */
  storage: "qiniu" | "local";
  /** 服务端按展示时区格式化好的上传日期，避免客户端时区导致日期不同 */
  uploadedAt: string;
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

type BulkOutcome = {
  id: number;
  ok: boolean;
  outcome: "deleted" | "migrated" | "skipped" | "conflict" | "notFound";
  code?: string;
  message?: string;
  to?: string;
};

type BulkSummary = { total: number; succeeded: number; skipped: number; failed: number };

export function MediaGrid({ items, total, page, pages, filter, q, sort, storageConfigured, cdnDomain }: {
  items: Item[];
  total: number;
  page: number;
  pages: number;
  filter: string;
  q: string;
  sort: MediaSort;
  storageConfigured: boolean;
  cdnDomain: string;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState<Item | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkPending, setBulkPending] = useState<null | "delete" | "migrate">(null);
  /** 单卡菜单发起的迁移：取消时把临时选中一起清掉，不留一条看不见的批量选择 */
  const [bulkFromCard, setBulkFromCard] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ summary: BulkSummary; problems: { id: number; message: string }[] } | null>(null);
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [previewId, setPreviewId] = useState<number | null>(null);
  /* 复制反馈自熄：记录刚复制的那一项，2.5s 后自动淡出恢复 */
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  /**
   * 选中项只保留当前页存在的 id。
   * 翻页/改筛选后组件不会卸载，旧的 id 若留在 state 里，批量条会显示一个
   * 屏幕上根本不存在的数量 —— 用户点删除却看不到删的是谁。
   */
  useEffect(() => {
    setSelected((prev) => {
      const next = prev.filter((id) => items.some((it) => it.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [items]);

  const allOn = items.length > 0 && selected.length === items.length;
  const someOn = selected.length > 0 && !allOn;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someOn;
  }, [someOn]);

  const clearBanner = () => { setMsg(""); setErr(""); };

  const copy = useCallback(async (p: string) => {
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
  }, []);

  const remove = async (item: Item) => {
    clearBanner(); setBusy(true); setPending(null);
    const res = await fetch("/api/admin/media/" + item.id, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setMsg("已删除「" + item.filename + "」");
      setSelected((s) => s.filter((id) => id !== item.id));
      router.refresh();
    } else setErr(d.error || "删除失败");
  };

  /**
   * 批量操作：逐项结果由服务端返回，界面把"成功/跳过/失败"分开呈现。
   * 不用一句"操作完成"糊过去 —— 混选时必然有被引用的图被跳过，
   * 用户需要知道是哪几张、为什么。
   */
  const runBulk = async (action: "delete" | "migrate-cdn") => {
    if (!selected.length) { setErr("请先选择图片"); return; }
    clearBanner(); setBusy(true);
    try {
      const res = await fetch("/api/admin/media/bulk", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: selected, ...(code ? { totp: code } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 428) {
        if (d.code === "STEP_UP_RELOGIN") {
          setBulkPending(null);
          setErr("这次操作需要重新登录后才能执行（未启用两步验证时，敏感操作只允许在登录后 10 分钟内进行）。");
        } else {
          setNeedCode(true);
          setErr("该操作需要两步验证码，请在下方输入后重新执行");
        }
        return;
      }
      if (!res.ok) { setErr(d.error || "操作失败"); return; }
      const results = (d.results ?? []) as BulkOutcome[];
      setBulkResult({
        summary: d.summary ?? { total: results.length, succeeded: 0, skipped: 0, failed: 0 },
        problems: results.filter((r) => !r.ok).map((r) => ({ id: r.id, message: r.message || r.code || "未处理" })),
      });
      setBulkPending(null);
      setNeedCode(false); setCode(""); setBulkFromCard(false);
      setSelected([]);
      router.refresh();
    } catch {
      setErr("网络错误，操作没有发出去");
    } finally {
      setBusy(false);
    }
  };

  /**
   * 把七牛空间里未被登记的对象导入 media 表。
   * 历史遗留：这些图是别的客户端传的，图库看不见也管不了。
   */
  const importQiniu = async () => {
    clearBanner(); setBusy(true);
    try {
      const res = await fetch("/api/admin/media", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import-qiniu" }),
      });
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
      const res = await fetch("/api/admin/media", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan-orphans" }),
      });
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

  /** 筛选、搜索、排序、分页统一用 URLSearchParams，避免拼出 "?storage=&page=2" 这种脏 URL */
  const href = (next: { storage?: string; q?: string; sort?: MediaSort; page?: number }) => {
    const u = new URLSearchParams();
    const s = next.storage !== undefined ? next.storage : filter;
    const query = next.q !== undefined ? next.q : q;
    const order = next.sort !== undefined ? next.sort : sort;
    if (s) u.set("storage", s);
    if (query) u.set("q", query);
    if (order !== "newest") u.set("sort", order);
    if (next.page && next.page > 1) u.set("page", String(next.page));
    const qs = u.toString();
    return "/admin/media" + (qs ? "?" + qs : "");
  };

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const selectedItems = items.filter((it) => selected.includes(it.id));
  const selectedLocal = selectedItems.filter((it) => it.storage === "local").length;
  const selectedBlocked = selectedItems.filter((it) => it.refs > 0).length;
  const selectedDeletable = selectedItems.length - selectedBlocked;

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
          {sort !== "newest" ? <input type="hidden" name="sort" value={sort} /> : null}
          <label>
            <span className="sr-only">搜索文件名或路径</span>
            <input className="input" type="search" name="q" defaultValue={q} placeholder="搜索文件名或路径" />
          </label>
          <button className="btn btn-sm" type="submit">搜索</button>
          {q ? <Link className="media-clear" href={href({ q: "", page: 1 })}>清除</Link> : null}
        </form>

        <label className="media-sort">
          <span className="sr-only">排序方式</span>
          <select
            className="input"
            value={sort}
            onChange={(e) => router.push(href({ sort: e.target.value as MediaSort, page: 1 }))}
            aria-label="排序方式"
          >
            {MEDIA_SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
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

      {bulkResult ? (
        <div className="bulk-result-bar" role="status">
          <span className="bulk-result-stat">共 <span className="bulk-result-num">{bulkResult.summary.total}</span> 张</span>
          <span className="bulk-result-stat">成功 <span className="bulk-result-num ok">{bulkResult.summary.succeeded}</span></span>
          {bulkResult.summary.skipped > 0 ? (
            <span className="bulk-result-stat">跳过 <span className="bulk-result-num warn">{bulkResult.summary.skipped}</span></span>
          ) : null}
          {bulkResult.summary.failed > 0 ? (
            <span className="bulk-result-stat">失败 <span className="bulk-result-num danger">{bulkResult.summary.failed}</span></span>
          ) : null}
          {bulkResult.problems.length ? (
            <span className="cmdk-meta" title={bulkResult.problems.map((p) => "ID " + p.id + "：" + p.message).join("\n")}>
              未完成：{bulkResult.problems.slice(0, 2).map((p) => "ID " + p.id + "（" + p.message + "）").join("；")}
              {bulkResult.problems.length > 2 ? " …等 " + bulkResult.problems.length + " 条" : ""}
            </span>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={() => setBulkResult(null)} style={{ marginLeft: "auto" }}>
            知道了
          </button>
        </div>
      ) : null}

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
        <>
          <div className="media-list-meta">
            <label className="select-all">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allOn}
                onChange={() => setSelected(allOn ? [] : items.map((it) => it.id))}
              />
              <span>全选本页</span>
            </label>
            <span className="media-list-hint">
              共 {total} 张 · 当前按「{mediaSortLabel(sort)}」排序
            </span>
          </div>

          <div className="media-grid">
            {items.map((m) => (
              <MediaCard
                key={m.id}
                item={m}
                selected={selected.includes(m.id)}
                copied={copied === m.path}
                busy={busy}
                onToggle={() => toggle(m.id)}
                onPreview={() => setPreviewId(m.id)}
                onCopy={() => void copy(m.path)}
                onDelete={() => setPending(m)}
                onMigrate={() => {
                  setSelected([m.id]);
                  setBulkFromCard(true);
                  setBulkPending("migrate");
                }}
              />
            ))}
          </div>
        </>
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

      {/* 浮动批量条会盖住最后一行的下沿：选中有内容时补一块等高留白 */}
      {selected.length > 0 ? <div className="media-bulkbar-spacer" aria-hidden /> : null}

      {/* 批量条：未选择时完全不渲染（不占位、不进 Tab 序列） */}
      {selected.length > 0 ? (
        <div className="media-bulkbar" role="region" aria-label="批量操作">
          <span className="media-bulkbar-count">
            已选 <strong>{selected.length}</strong> 张
            {selectedBlocked > 0 ? <em className="media-bulkbar-warn">其中 {selectedBlocked} 张被引用，不能删除</em> : null}
          </span>
          <span className="media-bulkbar-fill" />
          <button
            className="btn btn-sm"
            disabled={busy || selectedLocal === 0}
            title={selectedLocal === 0 ? "选中的图片都已在 CDN 上" : "上传到七牛并改写文章里的引用"}
            onClick={() => { setNeedCode(false); setCode(""); setBulkFromCard(false); setBulkPending("migrate"); }}
          >
            迁移至 CDN{selectedLocal > 0 ? "（" + selectedLocal + "）" : ""}
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={busy || selectedDeletable === 0}
            title={selectedDeletable === 0 ? "选中的图片都仍被文章引用，不能删除" : "删除未被引用的图片"}
            onClick={() => { setNeedCode(false); setCode(""); setBulkFromCard(false); setBulkPending("delete"); }}
          >
            批量删除
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setSelected([])}>取消选择</button>
        </div>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        title={"删除图片「" + (pending?.filename ?? "") + "」？"}
        description={
          <>
            文件会从磁盘和 media 表里一起移除，<strong>不可撤销</strong>。
            仍被文章引用的图片无法删除（菜单项置灰并写明引用篇数）—— 请先改掉正文里的引用。
          </>
        }
        confirmLabel="删除图片"
        danger
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => { if (pending) void remove(pending); }}
      />

      <ConfirmDialog
        open={bulkPending === "delete"}
        title={"删除选中的 " + selectedDeletable + " 张图片？"}
        description={
          <>
            未被引用的 {selectedDeletable} 张会被删除，<strong>不可撤销</strong>。
            {selectedBlocked > 0 ? (
              <>
                <br />
                另有 {selectedBlocked} 张仍被文章引用，会<strong>自动跳过</strong>，不会影响正文。
              </>
            ) : null}
            {selectedLocal > 0 ? <><br />其中 {selectedLocal} 张在本机磁盘，会同时删除磁盘文件。</> : null}
          </>
        }
        confirmLabel={"删除 " + selectedDeletable + " 张"}
        danger
        busy={busy}
        maskClosable={!needCode}
        onCancel={() => { setBulkPending(null); setNeedCode(false); setCode(""); }}
        onConfirm={() => void runBulk("delete")}
      >
        {needCode ? (
          <div className="media-code-row">
            <label htmlFor="media-bulk-code">两步验证码</label>
            <input
              id="media-bulk-code"
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              placeholder="6 位数字或恢复码"
            />
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={bulkPending === "migrate"}
        title={"把 " + selectedLocal + " 张本机图片迁移到 CDN？"}
        description={
          <>
            图片会上传到七牛，文章正文与封面里的旧路径会被改写成 CDN 直链（相关文章 revision +1）。
            本机原文件<strong>保留不删</strong>，历史版本仍能打开，因此这一步可以回退。
            {selectedItems.length - selectedLocal > 0 ? (
              <><br />另有 {selectedItems.length - selectedLocal} 张已在 CDN 上，会自动跳过。</>
            ) : null}
            <br />迁移后请打开一篇文章确认图片正常显示。
          </>
        }
        confirmLabel={"迁移 " + selectedLocal + " 张"}
        busy={busy}
        onCancel={() => {
          setBulkPending(null);
          if (bulkFromCard) { setSelected([]); setBulkFromCard(false); }
        }}
        onConfirm={() => void runBulk("migrate-cdn")}
      />

      <MediaLightbox
        items={items}
        id={previewId}
        onClose={() => setPreviewId(null)}
        onNavigate={setPreviewId}
        onCopy={(p) => void copy(p)}
      />
    </>
  );
}

/* ------------------------------ 单张卡片 ------------------------------ */

/**
 * 卡片本身是"缩略图 + 三行元信息"，操作收进右上角更多菜单。
 *
 * 菜单为什么自己管开合：一张 48 项的网格里让父组件持有 openMenuId 会
 * 触发整页重渲染；单卡自管后，打开菜单只重渲染这一张。点其他卡片的
 * 触发键时，document 的 mousedown 会先关掉上一张 —— 同一时刻仍只有
 * 一个菜单打开。
 */
function MediaCard({ item, selected, copied, busy, onToggle, onPreview, onCopy, onDelete, onMigrate }: {
  item: Item;
  selected: boolean;
  copied: boolean;
  busy: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onMigrate: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenuOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /**
   * 菜单键盘导航：role="menu" 就必须支持上下键，否则读屏用户听到的是
   * "菜单"却只能用 Tab 一格格挪，语义与行为不一致。
   */
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const nodes = [...(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))]
      .filter((n) => !(n as HTMLButtonElement).disabled);
    if (!nodes.length) return;
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      e.preventDefault();
      nodes[(next + nodes.length) % nodes.length].focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(nodes.length - 1);
  };

  const referenced = item.refs > 0;

  return (
    <figure ref={rootRef} className={"media-card" + (selected ? " is-selected" : "") + (menuOpen ? " is-menu-open" : "")}>
      <div className="media-thumb">
        <button
          type="button"
          className="media-thumb-btn"
          onClick={onPreview}
          aria-label={"预览「" + item.filename + "」"}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.path} alt={item.filename} loading="lazy" decoding="async" />
        </button>

        <label className="media-check" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={"选择「" + item.filename + "」"}
          />
        </label>

        {referenced ? (
          /* 引用数常驻：它决定这张图能不能删，属于安全信息，不随 hover 隐藏 */
          <span className="media-refs">引用 {item.refs}</span>
        ) : null}



        <div className="media-actions">
          <button
            ref={triggerRef}
            type="button"
            className="media-kebab"
            aria-label={"「" + item.filename + "」的更多操作"}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconMore size={16} />
          </button>

          {menuOpen ? (
            <div className="media-menu" role="menu" aria-label={"「" + item.filename + "」的操作"} onKeyDown={onMenuKeyDown}>
              <button type="button" role="menuitem" className="media-menu-item" onClick={() => { setMenuOpen(false); onCopy(); }}>
                <IconCopy size={15} />
                <span>{copied ? "已复制 Markdown" : "复制 Markdown"}</span>
              </button>
              <a
                role="menuitem"
                className="media-menu-item"
                href={item.path}
                target="_blank"
                rel="noreferrer"
                onClick={() => setMenuOpen(false)}
              >
                <IconExternal size={15} />
                <span>打开原图</span>
              </a>
              {item.storage === "local" ? (
                <button
                  type="button"
                  role="menuitem"
                  className="media-menu-item"
                  disabled={busy}
                  onClick={() => { setMenuOpen(false); onMigrate(); }}
                >
                  <IconCloudUp size={15} />
                  <span>迁移至 CDN</span>
                </button>
              ) : null}
              <span className="media-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="media-menu-item is-danger"
                disabled={busy || referenced}
                title={referenced ? "仍被 " + item.refs + " 篇文章引用，不能删除" : "删除这张图"}
                onClick={() => { setMenuOpen(false); onDelete(); }}
              >
                <IconTrash size={15} />
                <span>{referenced ? "被引用，不能删除" : "删除图片"}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <figcaption className="media-meta">
        <div className="media-name" title={item.filename}>{item.filename}</div>
        <div className="media-sub">
          {formatBytes(item.size)}
          {item.width ? " · " + item.width + "×" + item.height : ""}
        </div>
        {item.uploadedAt ? <div className="media-date">{item.uploadedAt}</div> : null}
        <div className="media-tags">
          <Badge tone={item.storage === "qiniu" ? "ok" : "neutral"}>
            {item.storage === "qiniu" ? "七牛 CDN" : "本机磁盘"}
          </Badge>
          {referenced ? null : <span className="media-free">未引用</span>}
        </div>
      </figcaption>
    </figure>
  );
}
