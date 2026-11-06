"use client";

import { useState } from "react";

/**
 * 聚合站的小图标（2026-11-06）。
 *
 * ## 为什么不再用固定的 🚇
 *
 * 右侧栏「聚合」区块此前对每个聚合站都渲染同一个 `🚇` emoji —— 多个聚合站
 * 排在一起时分不出谁是谁。现在按站点取图标：
 *
 *   1) `https://<站点 origin>/favicon.ico` —— 浏览器请求该站自己的图标；
 *   2) 加载失败（404 / 跨域被拦 / 无网络）→ 退回**名称首字**方块。
 *
 * 不用第三方 favicon 服务（Google S2 / DuckDuckGo 之类）：那会把访客的
 * 浏览行为（访问了本站即访问了哪些聚合站）泄露给第三方，也依赖外网可用性。
 *
 * ## 为什么首字是可靠的降级
 *
 * `onError` 是 `<img>` 自己触发的，不依赖 fetch 的 CORS 判定；失败时切成
 * 固定尺寸的首字方块，容器尺寸不变 —— 不会产生 CLS。
 * 图标本身是装饰：`aria-hidden`，名称就在旁边。
 */
export function HubAvatar({ name, url }: { name: string; url: string }) {
  const [failed, setFailed] = useState(false);
  const icon = faviconUrl(url);
  const letter = firstLetter(name);

  return (
    <span className="hub-avatar" aria-hidden="true">
      {icon && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={icon}
          alt=""
          width={18}
          height={18}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="hub-avatar-letter">{letter}</span>
      )}
    </span>
  );
}

/**
 * 站点图标的候选地址：只看 origin，不带路径/查询串。
 * 非 http(s) 的 URL（后台允许填任意字符串）直接返回 null → 走首字。
 */
function faviconUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + "/favicon.ico";
  } catch {
    return null;
  }
}

/** 取第一个字符；`Array.from` 避免把 emoji / 代理对拆成半个 */
function firstLetter(name: string): string {
  const chars = Array.from((name || "").trim());
  return (chars[0] || "·").toUpperCase();
}
