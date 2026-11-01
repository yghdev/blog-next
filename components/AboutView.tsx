import { SiteShell } from "./SiteShell";
import { Animations } from "./Animations";
import { Lightbox } from "./Lightbox";
import { renderMarkdown } from "@/lib/markdown";
import { getSettingsCached } from "@/lib/cached";
import type { Post } from "@/lib/db";

/**
 * 关于页的版式（D-2，2026-11-01）。
 *
 * ## 内容全部来自 `content/pages/about.md`
 *
 * 需求文档 7.2–7.6 要求「顶部个人介绍」「关注方向」「正在做的事」
 * 「关于这个博客」「联系方式」五个部分。这些**文案**都在 md 里，
 * 组件只负责把它们排成版式 —— 没有一句话是写死在 JSX 里的。
 *
 * D.4 红线：「关于页若需要结构化区块，内容必须来自 content/pages/about.md
 * 或 settings，不允许写死在组件里」。
 *
 * ## Hero 是怎么来的
 *
 * `about.md` 的开头两段是问候语与自我介绍：
 *
 *     你好，我是 flechazo。
 *
 *     一个喜欢折腾技术、探索新事物的学生。
 *
 * 渲染成 HTML 后是 `<p>你好，我是 flechazo。</p><p>一个喜欢…</p>`。
 * 这里把**前两个 `<p>`** 提取出来单独渲染成 hero（配头像），
 * 剩下的正文照常走 `.prose`。
 *
 * 为什么不给 md 加 frontmatter 字段来标记「哪两句是 hero」：
 * 那会让内容维护者多记一个约定。而「开头两段是自我介绍」是**读一遍就懂**
 * 的自然结构，不需要额外元数据。
 *
 * ## 与 ArticleView 的差异
 *
 * - 不显示发布日期 / 阅读时长 / 浏览量（关于页不是文章）
 * - 顶部是 hero（头像 + 问候语 + 标签）而不是 `h1` 文章标题
 * - 保留右栏目录（需求 7.7）
 */
export async function AboutView({ doc }: { doc: Post }) {
  const { html, toc } = renderMarkdown(doc.content);
  const settings = await getSettingsCached();
  const author = (settings.author || "").trim() || "flechazo";

  /*
   * 把开头的两个 <p> 提出来做 hero。
   *
   * 用正则而不是完整的 HTML 解析器：md 渲染出的结构是可控的（marked 的
   * 输出里段落就是 `<p>…</p>`，没有嵌套），而且这个文件是我们自己维护的。
   * 引入 html parser 只为拆两个段落不划算。
   */
  const paraRe = /^<p>([\s\S]*?)<\/p>\s*/;
  const m1 = html.match(paraRe);
  const greeting = m1 ? m1[1] : "";
  const rest1 = m1 ? html.slice(m1[0].length) : html;
  const m2 = rest1.match(paraRe);
  const tagline = m2 ? m2[1] : "";
  const body = m2 ? rest1.slice(m2[0].length) : rest1;

  /**
   * 把正文按 `<h2>` 切成小节。
   *
   * 为什么要切：需求 7.3 的「关注方向」要做成顶部标签，而它在 md 里是
   * 独立的一节。顶部已经展示过，正文再列一遍就是同一份信息出现两次
   * （第一次跑出来时肉眼可见地重复，截图确认过）。
   *
   * ⚠️ **不硬编码章节标题**：原来写的是 `/我在关注什么/`，那样一改 md 的
   * 小标题，提取就静默失效（不报错，只是标签消失）。改成按"第几节"定位，
   * 标题文字仍然只存在于 md 里。
   */
  const sectionRe = /<h2[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g;
  const sections = [...body.matchAll(sectionRe)].map((m) => ({
    id: m[1],
    /** 标题的纯文本（可能含 <strong> 等内联标签，取 textContent 语义） */
    title: m[2].replace(/<[^>]+>/g, "").trim(),
    body: m[3],
    raw: m[0],
  }));

  /*
   * 第 1 节 = 需求 7.3 的「关注方向」。
   * 它的段落提出来做顶部标签，同时从正文里摘掉（避免重复）。
   */
  const focusSection = sections[0];
  const focusItems = focusSection
    ? [...focusSection.body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]).filter(Boolean).slice(0, 6)
    : [];
  const bodyWithoutFocus = focusSection ? body.replace(focusSection.raw, "") : body;

  /*
   * 目录同步：剔掉被摘掉的那一节。
   * 不同步的话目录里会留一个指向不存在锚点的链接，点了没反应
   * （第一次截图时就是这样：目录 4 项、正文 3 节）。
   */
  const visibleToc = focusSection ? toc.filter((t) => t.text.trim() !== focusSection.title) : toc;

  return (
    <>
      <Animations />
      <Lightbox />
      <SiteShell variant="three-col" toc={visibleToc}>
        <article className="about">
          {/*
            h1：视觉上不显示，但必须存在。
            页面没有 h1 是明确的可访问性缺陷 —— 读屏用户靠 h1 判断"这是什么页"，
            搜索引擎也靠它。这里用 sr-only 而不是 display:none（后者会让它从
            可访问性树里消失）。
          */}
          <h1 className="sr-only">{doc.title}</h1>

          <header className="about-hero">
            {/*
              头像：**不放 hero 里**。
              左栏品牌区已经有同一个头像（.brand-photo），hero 再放一个
              就是同屏两个一样的头像 —— 第一次截图时发现的。
              这里改用一个小小的强调符号，避免重复视觉元素。
            */}
            <div className="about-hero-text">
              {greeting ? (
                <p className="about-greeting" dangerouslySetInnerHTML={{ __html: greeting }} />
              ) : null}
              {tagline ? (
                <p className="about-tagline" dangerouslySetInnerHTML={{ __html: tagline }} />
              ) : null}
              {focusItems.length > 0 ? (
                <ul className="about-focus" aria-label="关注方向">
                  {focusItems.map((t, i) => (
                    <li key={i} className="about-focus-item" dangerouslySetInnerHTML={{ __html: t }} />
                  ))}
                </ul>
              ) : null}
            </div>
          </header>

          <div className="prose about-body" dangerouslySetInnerHTML={{ __html: bodyWithoutFocus }} />
        </article>
      </SiteShell>
    </>
  );
}
