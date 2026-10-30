import type { Metadata } from "next";
import { Sidebar } from "@/components/Sidebar";
import { CommentSection } from "@/components/CommentSection";
import { listFriendLinksCached } from "@/lib/cached";
import { getSettings } from "@/lib/settings";
import { loadFriendLinksPage } from "@/lib/friend-links-page-source";
import {
  buildFriendConfig,
  faviconFor,
  linkHost,
  mergeDirectoryLinks,
  pad2,
  parseFriendRequirements,
  parseLegacyFriends,
  resolveSiteInfo,
  sameOriginPath,
} from "@/lib/friend-links-page";
import { FriendCard } from "@/components/friends/FriendCard";
import { SiteAvatar } from "@/components/friends/SiteAvatar";
import { CopyFriendConfig } from "@/components/friends/CopyFriendConfig";
import { JumpToComments } from "@/components/friends/JumpToComments";
import "./friends.css";

/**
 * Friends 专题页（/friend-links）。
 *
 * 这一页原来是 posts 表里的一个普通 page，靠 [slug] 模板渲染出「标题 + 段落 +
 * 评论区」。改版后成为独立路由，但仍然沿用原来的数据，不复制、不改写：
 *
 *   friend_links 表      -> 卡片数据（后台 /admin/links 维护，保存即生效）
 *   页面正文 Markdown    -> 早期手写的友链、申请要求、本站信息
 *   settings 表          -> 站名/描述兜底、全站评论开关
 *   Artalk（CommentSection） -> 评论区，pageKey 仍是 "/friend-links"，
 *                          历史评论不会因为换了模板而失联
 *
 * 页面上所有可见文案要么来自这些数据源，要么是本次改版指定的固定文案；
 * 没有任何一条友链或站点信息是写死在组件里的。
 */

export const dynamic = "force-dynamic";

const SITE = (process.env.SITE_URL || "https://blog.yghsite.cn").replace(/\/+$/, "");

const HERO_TITLE_1 = "互联网的另一端，";
const HERO_TITLE_2 = "也有有趣的人。";
const HERO_EN = "FRIENDS & CONNECTIONS";
const HERO_DESC = "这里收藏着一些有趣的个人博客。每一个链接，都是一次跨越屏幕的相遇。";

/**
 * 站点设置这里刻意用 getSettings() 而不是 getSettingsCached()。
 *
 * 原因：getSettings 自己带 10s 进程内缓存，而 getSettingsCached 外面又套了一层
 * unstable_cache(300s)。后台改设置 -> revalidateTag 只冲掉外层；外层重建时
 * 读到的可能仍是进程内那一份旧值，旧值于是被重新固化 300s（双层缓存的
 * 失效竞态）。评论开关属于「后台一改就应该看到」的配置，这一页直接读
 * 内层缓存，代价是每请求一次 SQLite（10s 才真正查一次），可以接受。
 */
export async function generateMetadata(): Promise<Metadata> {
  const [doc, links, settings] = await Promise.all([
    loadFriendLinksPage(),
    listFriendLinksCached(),
    getSettings(),
  ]);
  const { friends, hubs } = mergeDirectoryLinks(links, parseLegacyFriends(doc.content));
  const total = friends.length + hubs.length;

  return {
    title: "友链",
    description: HERO_DESC,
    keywords: ["友链", "个人博客", "独立博客", "朋友们"],
    alternates: { canonical: "/friend-links" },
    openGraph: {
      type: "website",
      title: HERO_TITLE_1 + HERO_TITLE_2 + " · " + settings.siteTitle,
      description: HERO_DESC,
      url: "/friend-links",
      siteName: settings.siteTitle,
    },
    twitter: {
      card: "summary",
      title: "友链 · " + settings.siteTitle,
      description: HERO_DESC,
    },
  };
}

export default async function FriendLinksPage() {
  const [doc, links, settings] = await Promise.all([
    loadFriendLinksPage(),
    listFriendLinksCached(),
    getSettings(),
  ]);

  const { friends, hubs } = mergeDirectoryLinks(links, parseLegacyFriends(doc.content));
  const requirements = parseFriendRequirements(doc.content);
  const site = resolveSiteInfo(doc.content, {
    siteTitle: settings.siteTitle,
    siteDescription: settings.siteDescription,
    siteUrl: SITE,
  });
  const friendConfig = buildFriendConfig(site);
  const commentsOn = settings.commentEnabled && doc.commentsEnabled;
  const total = friends.length + hubs.length;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "友链 · " + settings.siteTitle,
    description: HERO_DESC,
    url: SITE + "/friend-links",
    inLanguage: "zh-CN",
    isPartOf: { "@type": "WebSite", name: settings.siteTitle, url: SITE },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: total,
      itemListElement: [...friends, ...hubs].map((l, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: l.name,
        url: l.url,
        description: l.desc || undefined,
      })),
    },
  };

  return (
    <div className="friends-page">
      <div className="site-shell fr-shell">
        <Sidebar active="/friend-links" />

        <main className="content fr-main">
          {/* ── 专题头部 ─────────────────────────────────── */}
          <header className="fr-hero">
            <div className="fr-hero-meta">
              <span className="fr-mono">{settings.author} / SOCIAL</span>
              <span className="fr-mono fr-hero-meta-right">01 — FRIENDS</span>
            </div>

            <h1 className="fr-hero-title">
              {HERO_TITLE_1}
              <br />
              <span className="fr-hero-accent">{HERO_TITLE_2}</span>
            </h1>

            <p className="fr-hero-en fr-mono">{HERO_EN}</p>
            <p className="fr-hero-desc">{HERO_DESC}</p>

            <div className="fr-hero-stats">
              <div className="fr-stat">
                <span className="fr-stat-num">{pad2(friends.length)}</span>
                <span className="fr-stat-label">
                  位朋友
                  <span className="fr-stat-sub fr-mono">FRIENDS</span>
                </span>
              </div>
              {hubs.length > 0 ? (
                <div className="fr-stat fr-stat-hub">
                  <span className="fr-stat-num">{pad2(hubs.length)}</span>
                  <span className="fr-stat-label">
                    个聚合站
                    <span className="fr-stat-sub fr-mono">HUBS</span>
                  </span>
                </div>
              ) : null}
              <span className="fr-hero-note fr-mono">FRIENDS AND THEIR LITTLE WORLDS</span>
            </div>
          </header>

          {/* ── 01 / 友链目录 ─────────────────────────────── */}
          <section className="fr-section" aria-labelledby="fr-directory-title">
            <div className="fr-section-head">
              <h2 id="fr-directory-title" className="fr-section-heading">
                <span className="fr-section-index fr-mono">01 / FRIEND DIRECTORY</span>
                <span className="fr-section-cn" aria-hidden="true">朋友们</span>
                <span className="fr-sr-only">朋友们</span>
              </h2>
            </div>

            {friends.length > 0 ? (
              <div className="fr-grid">
                {friends.map((l) => (
                  <FriendCard
                    key={l.id}
                    name={l.name}
                    url={l.url}
                    desc={l.desc}
                    host={linkHost(l.url)}
                    avatar={faviconFor(l.url)}
                  />
                ))}
              </div>
            ) : (
              <div className="fr-empty">
                <div className="fr-empty-title">这份名单还在等第一位朋友</div>
                <p className="fr-empty-hint">
                  友链数据来自后台「外链」管理，添加后这里会自动出现；也可以先在下方评论区留下你的站点。
                </p>
                <JumpToComments enabled={commentsOn} compact />
              </div>
            )}

            {hubs.length > 0 ? (
              <div className="fr-hubs">
                <div className="fr-hubs-head">
                  <span className="fr-hubs-title fr-mono">AGGREGATORS / 聚合</span>
                  <span className="fr-hubs-hint">友链接力与博客聚合入口</span>
                </div>
                <ul className="fr-hub-list">
                  {hubs.map((l) => (
                    <li key={l.id}>
                      <a
                        className="fr-hub"
                        href={l.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span className="fr-hub-dot" aria-hidden />
                        <span className="fr-hub-name">{l.name}</span>
                        {l.desc ? <span className="fr-hub-desc">{l.desc}</span> : null}
                        <span className="fr-hub-host fr-mono">{linkHost(l.url)}</span>
                        <span className="fr-hub-arrow" aria-hidden>
                          <svg viewBox="0 0 24 24" width="14" height="14">
                            <path d="M7 17L17 7M9 7h8v8" fill="none" stroke="currentColor"
                                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          {/* ── 02 / 交换友链 ─────────────────────────────── */}
          <section className="fr-section" aria-labelledby="fr-exchange-title">
            <div className="fr-section-head">
              <h2 id="fr-exchange-title" className="fr-section-heading">
                <span className="fr-section-index fr-mono">02 / EXCHANGE</span>
                <span className="fr-section-cn" aria-hidden="true">交换友链</span>
                <span className="fr-sr-only">交换友链</span>
              </h2>
            </div>

            <div className="fr-exchange">
              <h3 className="fr-exchange-title">让我们也成为彼此的链接。</h3>
              <p className="fr-exchange-desc">
                如果你也经营着一个有趣的小站，欢迎加入这份收藏。
              </p>

              <div className="fr-site-card">
                <div className="fr-site-head">
                  <SiteAvatar src={sameOriginPath(site.avatar, SITE)} name={site.name} size={56} />
                  <div className="fr-site-identity">
                    <div className="fr-site-name">{site.name}</div>
                    <p className="fr-site-desc">{site.desc}</p>
                  </div>
                  <CopyFriendConfig text={friendConfig} />
                </div>

                <dl className="fr-site-spec">
                  <div className="fr-spec-row">
                    <dt className="fr-mono">名称 / NAME</dt>
                    <dd>{site.name}</dd>
                  </div>
                  <div className="fr-spec-row">
                    <dt className="fr-mono">地址 / URL</dt>
                    <dd>
                      <a href={site.url} target="_blank" rel="noopener noreferrer">{site.url}</a>
                    </dd>
                  </div>
                  <div className="fr-spec-row">
                    <dt className="fr-mono">头像 / AVATAR</dt>
                    <dd className="fr-spec-avatar">{site.avatar}</dd>
                  </div>
                  <div className="fr-spec-row">
                    <dt className="fr-mono">描述 / DESC</dt>
                    <dd>{site.desc}</dd>
                  </div>
                </dl>

                <p className="fr-site-note">
                  复制的是 JSON 配置，字段与后台「外链」表单一致；拿到后可以直接存档，或按你站点自己的格式取用。
                </p>
              </div>
            </div>
          </section>

          {/* ── 申请友链 ─────────────────────────────────── */}
          <section className="fr-apply" aria-labelledby="fr-apply-title">
            <span className="fr-apply-index fr-mono">APPLY / 申请</span>
            <h2 id="fr-apply-title" className="fr-apply-title">想加入这份名单？</h2>
            <p className="fr-apply-desc">在下方评论区留下你的小站信息，期待与你相遇。</p>

            {requirements.length > 0 ? (
              <div className="fr-rules">
                <div className="fr-rules-label fr-mono">REQUIREMENTS / 申请要求</div>
                <ol className="fr-rules-list">
                  {requirements.map((r, i) => (
                    <li key={i}>
                      <span className="fr-rule-num fr-mono">{pad2(i + 1)}</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            <div className="fr-apply-action">
              <JumpToComments enabled={commentsOn} />
              <span className="fr-apply-hint">评论区在页面底部 · 无需注册</span>
            </div>
          </section>

          {/* ── 评论区（原有 Artalk，pageKey 不变） ───────── */}
          <section className="fr-comments" id="comments" tabIndex={-1} aria-label="留言与友链申请">
            <div className="fr-comments-head">
              <span className="fr-comments-index fr-mono">COMMENTS / 留言</span>
              <h2 className="fr-comments-title">留下你的小站</h2>
              <p className="fr-comments-desc">
                评论由 Artalk 提供，提交后会进入审核；通过后你的申请会出现在这里。
              </p>
            </div>
            {commentsOn ? (
              <CommentSection postId={doc.pageId ?? 0} pageKey="/friend-links" />
            ) : (
              <p className="fr-comments-off">评论功能当前已关闭，暂时无法提交申请。</p>
            )}
          </section>

          {/* ── 页面专属页脚（不重复全站备案信息） ────────── */}
          <footer className="fr-footer">
            <span className="fr-footer-mark fr-mono">FRIENDS &amp; CONNECTIONS</span>
            <p>感谢每一位愿意分享自己小世界的人。</p>
          </footer>
        </main>
      </div>

      <script
        type="application/ld+json"
        // 数据来自后台且经过 URL 白名单；仍然转义 < 防止提前闭合 script 标签
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
    </div>
  );
}
