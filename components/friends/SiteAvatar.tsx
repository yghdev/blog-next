"use client";
import { useState } from "react";

/**
 * 友链站点头像。
 *
 * 数据现实：friend_links 表只有名称/地址/描述/分类，没有头像字段。
 * 所以这里按「站点自己的 /favicon.ico → 名称首字」两级降级：
 *   1) 头像地址由服务端算好传入（绝对 https 地址才给，避免混合内容）
 *   2) 加载失败时换成首字方块 —— 固定尺寸容器，不产生 CLS
 *
 * 首字底色从现有分类色板（--cat-*）里按名称稳定取一档，不新增配色。
 * 头像本身是装饰：名称就在旁边，alt 留空、外层对读屏隐藏。
 */
export function SiteAvatar({
  src,
  name,
  size = 48,
  className = "",
}: {
  src?: string | null;
  name: string;
  size?: 48 | 56;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const letter = firstLetter(name);
  const tint = tintIndex(name);
  const showImage = !!src && !failed;

  return (
    <span
      className={`fr-avatar fr-avatar-${size} fr-tint-${tint}${className ? " " + className : ""}`}
      aria-hidden="true"
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src as string}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="fr-avatar-letter">{letter}</span>
      )}
    </span>
  );
}

/** 取第一个字符（用 Array.from 避免把 emoji 的代理对拆成半个） */
function firstLetter(name: string): string {
  const chars = Array.from((name || "").trim());
  return (chars[0] || "·").toUpperCase();
}

function tintIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % 4;
}
