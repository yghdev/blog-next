/**
 * 行级 diff（方案 §9.2「版本对比」）。
 *
 * 为什么自己写而不引依赖：本项目全程零新依赖（校验层也是自实现），
 * 而这个需求只需要"按行比较"。引入 diff 库会带来配色、渲染、体积三处
 * 额外决策，却换不到更准的结果 —— 行级 LCS 足够看出"哪几段被改了"。
 *
 * 关键取舍：**按行比较，不按字符**。Markdown 正文里一行就是一个语义单元
 * （标题、列表项、代码块内的一行），字符级 diff 会把"改了两个字"渲染成
 * 一片碎片高亮，反而看不清改了什么。
 */

export type DiffOp = "equal" | "insert" | "delete";

export type DiffLine = {
  op: DiffOp;
  /** 该行内容（不含换行符） */
  text: string;
  /** 左侧（from）行号，从 1 开始；insert 时为 null */
  leftNo: number | null;
  /** 右侧（to）行号，从 1 开始；delete 时为 null */
  rightNo: number | null;
};

export type DiffResult = {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** 两侧内容完全一致（含行序）。退出门槛「复杂文章 diff 为空」直接看它 */
  identical: boolean;
};

function splitLines(s: string): string[] {
  // 统一按 \n 切；保留空行（空行在 Markdown 里是段落分隔，是有意义的信息）。
  // 末尾的单个空串来自结尾换行，去掉它，避免"每篇都多个空行差异"的噪声。
  const lines = s.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 行级 LCS diff。
 *
 * 复杂度 O(n*m) 空间用两行滚动数组求长度，再回溯生成操作序列。
 * 正文通常几百到几千行，直接跑不会卡；超长文本由调用方截断（见下方 maxLines）。
 */
export function diffLines(leftText: string, rightText: string, opts: { maxLines?: number } = {}): DiffResult {
  const maxLines = opts.maxLines ?? 4000;
  let a = splitLines(leftText);
  let b = splitLines(rightText);

  // 超长保护：不是"算不动"，而是 diff 界面本身在几千行时没有可读性，
  // 与其渲染一片红绿噪点，不如明确告诉用户"太长、请只比某一版"。
  let truncated = false;
  if (a.length > maxLines) { a = a.slice(0, maxLines); truncated = true; }
  if (b.length > maxLines) { b = b.slice(0, maxLines); truncated = true; }

  const n = a.length;
  const m = b.length;

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ op: "equal", text: a[i], leftNo: i + 1, rightNo: j + 1 });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ op: "delete", text: a[i], leftNo: i + 1, rightNo: null });
      removed++; i++;
    } else {
      lines.push({ op: "insert", text: b[j], leftNo: null, rightNo: j + 1 });
      added++; j++;
    }
  }
  while (i < n) { lines.push({ op: "delete", text: a[i], leftNo: i + 1, rightNo: null }); removed++; i++; }
  while (j < m) { lines.push({ op: "insert", text: b[j], leftNo: null, rightNo: j + 1 }); added++; j++; }

  return {
    lines,
    added,
    removed,
    identical: added === 0 && removed === 0 && !truncated,
  };
}

/**
 * 把连续的同类型行压成块，便于渲染与计数。
 * 界面上一行一条 <div> 在几百行时会产生上万节点，压块后显著变快。
 */
export type DiffHunk = { op: DiffOp; lines: DiffLine[] };

export function groupHunks(lines: DiffLine[]): DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && last.op === line.op) last.lines.push(line);
    else out.push({ op: line.op, lines: [line] });
  }
  return out;
}

/** 快照之间的元数据差异（标题/slug/分类等），正文单独走 diffLines */
export type Snapshot = {
  type?: "post" | "page" | "shuoshuo";
  title?: string;
  slug?: string;
  content?: string;
  excerpt?: string;
  cover?: string | null;
  categories?: string[];
  tags?: string[];
  comments_enabled?: number;
};

export type FieldDiff = { field: string; label: string; from: string; to: string; changed: boolean };

export function diffSnapshotFields(a: Snapshot, b: Snapshot): FieldDiff[] {
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return "(空)";
    if (Array.isArray(v)) return v.length ? v.join("、") : "(空)";
    if (typeof v === "number") return v === 1 ? "开启" : "关闭";
    const s = String(v);
    return s === "" ? "(空)" : s;
  };
  const rows: FieldDiff[] = [
    { field: "title", label: "标题", from: fmt(a.title), to: fmt(b.title), changed: a.title !== b.title },
    { field: "slug", label: "URL 路径", from: fmt(a.slug), to: fmt(b.slug), changed: a.slug !== b.slug },
    {
      field: "excerpt", label: "摘要",
      from: fmt(a.excerpt), to: fmt(b.excerpt),
      changed: (a.excerpt ?? "") !== (b.excerpt ?? ""),
    },
    { field: "cover", label: "封面", from: fmt(a.cover), to: fmt(b.cover), changed: (a.cover ?? null) !== (b.cover ?? null) },
    { field: "categories", label: "分类", from: fmt(a.categories), to: fmt(b.categories), changed: fmt(a.categories) !== fmt(b.categories) },
    { field: "tags", label: "标签", from: fmt(a.tags), to: fmt(b.tags), changed: fmt(a.tags) !== fmt(b.tags) },
    {
      field: "comments_enabled", label: "允许评论",
      from: fmt(a.comments_enabled), to: fmt(b.comments_enabled),
      changed: a.comments_enabled !== b.comments_enabled,
    },
  ];
  return rows;
}
