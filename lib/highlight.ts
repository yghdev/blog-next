/**
 * 搜索命中：词拆分、边界匹配、打分、片段截取（P0-6，2026-11-07）。
 *
 * 为什么单独一个纯函数模块：
 *   "高亮"不只是画个 `<mark>`。同一套匹配规则同时决定三件事，分散写必然漂移：
 *     1) 哪些结果算命中（`AI` 不该命中 `email` 里的 `ai`）；
 *     2) 结果怎么排序（标题里出现 1 次 > 正文里出现 10 次）；
 *     3) 摘要从哪截（原来的 makeExcerpt 永远取正文开头 90 字 —— 命中词在
 *        第 3 段时，用户看到的摘要里根本没有关键词，高亮自然也无处可标）。
 *
 * 所以这里只做字符串处理，不碰数据库、不碰 React，可被单元测试逐条钉住
 * （tests/highlight.test.ts）。
 */

export type Segment = { text: string; hit: boolean };

/** 术语来源既接受原始查询串，也接受已拆好的数组（页面/接口两种调用形态） */
export type TermInput = string | string[];

/**
 * 纯 ASCII 字母数字构成的词需要"词边界"。
 *
 * 反例（线上实测）：搜 `AI` 时 LIKE `%AI%` 会命中 `email`、`main`、`again` ——
 * 整页结果全是无关文章。中文没有词边界，只能按子串匹配（`变换` 命中
 * `霍夫变换`），所以边界规则只对 ASCII 词生效。
 */
function isAsciiWord(term: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+#-]*$/.test(term);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把查询串拆成去重（忽略大小写）、长词优先的词表 */
export function highlightTerms(input: TermInput): string[] {
  const raw = Array.isArray(input) ? input : input.split(/\s+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const t = item.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  // 长词优先：否则 "deepseek" 会先被 "deep" 吃掉，高亮被切碎
  return out.sort((a, b) => b.length - a.length);
}

/**
 * 构造匹配器。返回 null 表示没有可用的词（空查询）。
 *
 * `gi` 而不是 `g`：搜索对大小写不敏感（`AI` 应命中 `ai`），但高亮必须
 * 保留原文大小写 —— 所以用的是匹配位置，而不是把词替换成查询串。
 */
export function buildMatcher(input: TermInput): RegExp | null {
  const terms = highlightTerms(input);
  if (terms.length === 0) return null;
  const parts = terms.map((t) =>
    isAsciiWord(t)
      // 前后不能紧邻 ASCII 字母数字：AI 命中 "AI 工具" / "(AI)"，不命中 "email"
      ? `(?<![A-Za-z0-9])${escapeRegExp(t)}(?![A-Za-z0-9])`
      : escapeRegExp(t)
  );
  return new RegExp(parts.join("|"), "gi");
}

/**
 * 文本是否命中任一词。
 *
 * 为什么要这个 3 行的包装：`buildMatcher` 返回的是 **带 g 标志** 的正则
 * （`matchAll` 需要），而 `re.test()` 会推进 lastIndex —— 连续调用
 * `re.test()` 的结果会随调用次数变化。测试里已经踩过一次：前一次 true、
 * 后一次 false，看起来像"边界规则坏了"。对外只暴露这个无状态的判断。
 */
export function isHit(text: string, input: TermInput): boolean {
  const re = buildMatcher(input);
  return re ? re.test(text) : false;
}

/** 统计命中的"词次数"（同名多次出现只算多次，用于打分） */
export function countMatches(text: string, input: TermInput): number {
  const re = buildMatcher(input);
  if (!re) return 0;
  let n = 0;
  // matchAll 要求全局标志，buildMatcher 已带 g
  for (const _ of text.matchAll(re)) n++;
  return n;
}

/**
 * 命中打分：标题权重 10。
 *
 * 不做 TF-IDF 这类"学究式"排序 —— 站内搜索只有几十篇，
 * 用户要的是"标题里带这个词的排前面"，而不是 BM25 分数更漂亮。
 */
export function scoreHit(title: string, body: string, input: TermInput): number {
  return countMatches(title, input) * 10 + countMatches(body, input);
}

/** 英文单词的字符（用于"别从单词中间切"） */
function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

/**
 * 把窗口边界挪到英文单词之外。
 *
 * 中文没有空格，切在哪里都成立；但英文摘要从 `…gent 中钩子` 这种位置开
 * 头会显得像乱码（截图里一眼就能看到）。只在"边界落在 ASCII 单词内部"
 * 时调整，且最多让出一个短词的距离（12 字符），否则宁可直接截断 ——
 * 为了一个长单词把命中词挤出窗口是更糟的取舍。
 */
function snapToWordEdge(plain: string, start: number, end: number): { start: number; end: number } {
  const LIMIT = 12;
  if (start > 0 && isWordChar(plain[start - 1]) && isWordChar(plain[start])) {
    const space = plain.indexOf(" ", start);
    if (space !== -1 && space - start <= LIMIT) start = space + 1;
  }
  if (end < plain.length && isWordChar(plain[end - 1]) && isWordChar(plain[end])) {
    const space = plain.lastIndexOf(" ", end - 1);
    if (space !== -1 && end - space <= LIMIT) end = space;
  }
  return { start, end };
}

/** 从代理对中间切开会得到半个 emoji（终端/浏览器的经典乱码来源） */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function truncate(plain: string, len: number): string {
  const chars = Array.from(plain);
  return chars.length > len ? chars.slice(0, len).join("") + "…" : plain;
}

/**
 * 以**首个命中位置**为中心截取摘要，而不是永远从正文开头截。
 *
 * 长度按 UTF-16 计（与 CSS 行宽无关，只是"大约 90 字"）；
 * 命中在开头就不加前导省略号，命中在结尾就不加尾随省略号。
 */
export function snippetAround(text: string, input: TermInput, len = 90): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const re = buildMatcher(input);
  const m = re ? re.exec(plain) : null;
  if (!m) return truncate(plain, len);

  const at = m.index;
  // 命中词前面留 1/3 上下文，用户才看得出"为什么这条命中"
  let start = Math.max(0, at - Math.floor(len / 3));
  let end = Math.min(plain.length, start + len);
  // 命中靠近结尾时向前补足长度，避免摘要只剩几个字
  if (end - start < len) start = Math.max(0, end - len);
  // 别从英文单词中间开始/结束（中文不受影响）
  ({ start, end } = snapToWordEdge(plain, start, end));
  // 别在代理对中间切开
  if (start > 0 && isLowSurrogate(plain.charCodeAt(start))) start++;
  if (end < plain.length && isLowSurrogate(plain.charCodeAt(end))) end++;
  if (end <= start) return truncate(plain, len);

  const body = plain.slice(start, end).trim();
  return (start > 0 ? "…" : "") + body + (end < plain.length ? "…" : "");
}

/** 把一段纯文本切成"命中/非命中"片段，供 React 渲染 `<mark>`（不生成 HTML 字符串，天然免疫 XSS） */
export function splitHighlights(text: string, input: TermInput): Segment[] {
  const re = buildMatcher(input);
  if (!re) return [{ text, hit: false }];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (m[0].length === 0) continue;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
