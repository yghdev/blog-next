import { SiteAvatar } from "./SiteAvatar";

/**
 * 友链卡片（服务端组件）。
 *
 * 整卡是 <a>：点击卡片任意位置都能访问对方站点，外链在新标签页打开并带
 * rel="noopener noreferrer"（对方不能通过 window.opener 动本站）。
 * 描述与域名都是真实数据，没有就整行不渲染，不留空占位。
 */
export function FriendCard({
  name,
  url,
  desc,
  host,
  avatar,
}: {
  name: string;
  url: string;
  desc: string;
  host: string;
  avatar: string | null;
}) {
  return (
    <a
      className="fr-card"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={name}
    >
      <SiteAvatar src={avatar} name={name} size={48} />

      <span className="fr-card-main">
        <span className="fr-card-top">
          <span className="fr-card-name">{name}</span>
          <span className="fr-sr-only">（在新标签页打开）</span>
          <span className="fr-card-arrow" aria-hidden>
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path d="M7 17L17 7M9 7h8v8" fill="none" stroke="currentColor" strokeWidth="1.7"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
        {desc ? <span className="fr-card-desc">{desc}</span> : null}
        {host ? <span className="fr-card-host">{host}</span> : null}
      </span>
    </a>
  );
}
