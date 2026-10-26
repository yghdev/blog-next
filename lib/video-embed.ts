/**
 * 视频外链嵌入（方案 A）。
 *
 * 为什么不自己托管视频：
 *   · 这台 ECS 是 2C/1.6G，可用内存常年 500MB 左右，出口带宽实测 400~700KB/s
 *     且 4 路并行**不叠加**（聚合仍约 550KB/s）—— 一个 20MB 的片段要等 40 秒；
 *   · 每日 blog-backup 会把 /var/www/blog-images 整个打包同步到坚果云，
 *     往里放视频会让备份量翻几十倍。
 * 所以只做"贴链接 -> 生成 iframe"，视频由平台托管，本站零带宽零磁盘。
 *
 * 安全：插入的 iframe src **只能由白名单平台的 ID 重新拼出来**，
 * 绝不把用户输入原样塞进 src。直接粘贴 <iframe> 也只接受白名单域，
 * 其余一律拒绝 —— 避免后台成为任意第三方内容的注入点。
 */

export type VideoPlatform = "bilibili" | "youtube" | "vimeo" | "tencent" | "youku";

export type ParsedVideo = {
  platform: VideoPlatform;
  /** 平台展示名，用于提示与 iframe 的 title */
  label: string;
  /** 已由本模块按白名单拼出的嵌入地址，可直接放进 iframe */
  embedUrl: string;
  /** 从输入里提取到的原始标识（BV 号 / 视频 ID / av 号） */
  id: string;
};

/** 允许嵌入的域名（iframe src 的 host 必须命中其中之一，或为其子域） */
export const EMBED_HOSTS = [
  "player.bilibili.com",
  "www.youtube.com",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "v.qq.com",
  "player.youku.com",
] as const;

const LABELS: Record<VideoPlatform, string> = {
  bilibili: "哔哩哔哩",
  youtube: "YouTube",
  vimeo: "Vimeo",
  tencent: "腾讯视频",
  youku: "优酷",
};

/** 以 https 开头的 URL，或裸 ID（后面按平台各自校验） */
function asUrl(input: string): URL | null {
  const s = input.trim();
  if (!s) return null;
  try {
    // 只给了 BVxxx / av123 / 11 位 YouTube ID 时，这里会抛错，交给调用方按平台处理
    return new URL(s.startsWith("http") ? s : "https://" + s);
  } catch {
    return null;
  }
}

/* ------------------------------ 哔哩哔哩 ------------------------------ */

const BV_RE = /^BV[0-9A-Za-z]{10}$/;
const AV_RE = /^av(\d+)$/i;

function parseBilibili(input: string): ParsedVideo | null {
  const raw = input.trim();

  // 直接贴 BV 号 / av 号
  if (BV_RE.test(raw)) {
    return {
      platform: "bilibili",
      label: LABELS.bilibili,
      id: raw,
      embedUrl: "https://player.bilibili.com/player.html?bvid=" + raw + "&page=1&autoplay=0&danmaku=0",
    };
  }
  const av = raw.match(AV_RE);
  if (av) {
    return {
      platform: "bilibili",
      label: LABELS.bilibili,
      id: raw.toLowerCase(),
      embedUrl: "https://player.bilibili.com/player.html?aid=" + av[1] + "&page=1&autoplay=0&danmaku=0",
    };
  }

  const u = asUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)bilibili\.com$/.test(host)) return null;

  // https://www.bilibili.com/video/BV1xx411c7mD?p=2
  const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
  if (!m) return null;
  const id = m[1];
  const page = u.searchParams.get("p") ?? "1";
  const key = /^bv/i.test(id) ? "bvid=" + id : "aid=" + id.replace(/^av/i, "");
  return {
    platform: "bilibili",
    label: LABELS.bilibili,
    id,
    embedUrl:
      "https://player.bilibili.com/player.html?" + key +
      "&page=" + (Number(page) >= 1 ? Number(page) : 1) +
      "&autoplay=0&danmaku=0",
  };
}

/* ------------------------------- YouTube ------------------------------ */

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseYouTube(input: string): ParsedVideo | null {
  const raw = input.trim();
  if (YT_ID_RE.test(raw)) {
    return {
      platform: "youtube",
      label: LABELS.youtube,
      id: raw,
      embedUrl: "https://www.youtube-nocookie.com/embed/" + raw,
    };
  }
  const u = asUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  let id: string | null = null;

  if (/(^|\.)youtu\.be$/.test(host)) {
    // https://youtu.be/<id>
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (seg) id = seg;
  } else if (/(^|\.)youtube\.com$/.test(host) || /(^|\.)youtube-nocookie\.com$/.test(host)) {
    if (u.pathname.startsWith("/watch")) id = u.searchParams.get("v");
    else if (u.pathname.startsWith("/embed/")) id = u.pathname.split("/")[2] ?? null;
    else if (u.pathname.startsWith("/shorts/")) id = u.pathname.split("/")[2] ?? null;
  }
  if (!id || !YT_ID_RE.test(id)) return null;
  return {
    platform: "youtube",
    label: LABELS.youtube,
    id,
    embedUrl: "https://www.youtube-nocookie.com/embed/" + id,
  };
}

/* -------------------------------- Vimeo ------------------------------- */

function parseVimeo(input: string): ParsedVideo | null {
  const raw = input.trim();
  if (/^\d{5,}$/.test(raw)) {
    return {
      platform: "vimeo",
      label: LABELS.vimeo,
      id: raw,
      embedUrl: "https://player.vimeo.com/video/" + raw,
    };
  }
  const u = asUrl(raw);
  if (!u) return null;
  if (!/(^|\.)vimeo\.com$/.test(u.hostname.toLowerCase())) return null;
  const m = u.pathname.match(/\/(\d{5,})/);
  if (!m) return null;
  return {
    platform: "vimeo",
    label: LABELS.vimeo,
    id: m[1],
    embedUrl: "https://player.vimeo.com/video/" + m[1],
  };
}

/* ------------------------------ 腾讯 / 优酷 ---------------------------- */

function parseTencent(input: string): ParsedVideo | null {
  const u = asUrl(input.trim());
  if (!u) return null;
  if (!/(^|\.)qq\.com$/.test(u.hostname.toLowerCase())) return null;
  // https://v.qq.com/x/page/<vid>.html  /  https://v.qq.com/x/cover/<cid>/<vid>.html
  const m = u.pathname.match(/([A-Za-z0-9]{11,})\.html?$/);
  if (!m) return null;
  return {
    platform: "tencent",
    label: LABELS.tencent,
    id: m[1],
    embedUrl: "https://v.qq.com/txp/iframe/player.html?vid=" + m[1],
  };
}

function parseYouku(input: string): ParsedVideo | null {
  const u = asUrl(input.trim());
  if (!u) return null;
  if (!/(^|\.)youku\.com$/.test(u.hostname.toLowerCase())) return null;
  // https://v.youku.com/v_show/id_XNTk1MjM4NzY4.html
  const m = u.pathname.match(/id_([A-Za-z0-9=]+)\.html?$/);
  if (!m) return null;
  return {
    platform: "youku",
    label: LABELS.youku,
    id: m[1],
    embedUrl: "https://player.youku.com/embed/" + m[1],
  };
}

/**
 * 把用户给的链接/编号解析成可嵌入的视频。
 * 识别不出返回 null —— 调用方据此给出"支持哪些平台"的提示。
 */
export function parseVideo(input: string): ParsedVideo | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  return (
    parseBilibili(s) ??
    parseYouTube(s) ??
    parseVimeo(s) ??
    parseTencent(s) ??
    parseYouku(s)
  );
}

/** 域名是否在白名单里（含子域） */
export function isAllowedEmbedHost(host: string): boolean {
  const h = (host ?? "").toLowerCase();
  return EMBED_HOSTS.some((allowed) => h === allowed || h.endsWith("." + allowed));
}

/* ------------------------------ 生成 iframe ---------------------------- */

/**
 * 生成可直接粘进 Markdown 的嵌入代码。
 *
 * 用 <div class="video-container"> 包一层，而不是靠 iframe 自身的内联样式：
 * globals.css 里 .prose .video-container 已有 aspect-ratio:16/9 +
 * overflow:hidden，.video-container iframe 会 inset:0 铺满，
 * 所以这里不需要（也不该）写 position:absolute —— 那套只用于兼容
 * 从 WordPress 迁移过来的历史数据。
 */
export function buildVideoEmbed(embedUrl: string, title = "嵌入视频"): string {
  let host = "";
  try {
    host = new URL(embedUrl).hostname;
  } catch {
    throw new Error("嵌入地址不合法");
  }
  if (!isAllowedEmbedHost(host)) {
    throw new Error("不支持的视频平台：" + host);
  }
  const safeTitle = String(title).replace(/["<>]/g, "");
  return (
    '<div class="video-container">' +
    '<iframe src="' + embedUrl + '" title="' + safeTitle + '" ' +
    'scrolling="no" frameborder="0" framespacing="0" ' +
    'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
    "allowfullscreen></iframe>" +
    "</div>"
  );
}

/** 一步到位：链接 -> 嵌入代码。识别不出返回 null */
export function videoToEmbed(input: string): { embed: string; video: ParsedVideo } | null {
  const video = parseVideo(input);
  if (!video) return null;
  return { embed: buildVideoEmbed(video.embedUrl, video.label + " 视频"), video };
}

/* --------------------------- 直接粘贴的 iframe -------------------------- */

/** 从一段 HTML 里取出 iframe 的 src */
export function extractIframeSrc(html: string): string | null {
  const m = String(html ?? "").match(/<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/**
 * 校验并规范化"直接粘贴的嵌入代码"。
 *
 * 管理员有时会从 B 站复制整段 <iframe>，里面带一堆平台特有属性。
 * 这里只保留 src（校验域名）并重新生成结构，丢掉其余属性 ——
 * 这样既能用，又不会把任意属性/脚本带进正文。
 */
export function normalizePastedIframe(input: string): string | null {
  const src = extractIframeSrc(input);
  if (!src) return null;
  let host: string;
  try {
    const u = new URL(src);
    if (u.protocol !== "https:") return null;
    host = u.hostname;
  } catch {
    return null;
  }
  if (!isAllowedEmbedHost(host)) return null;
  return buildVideoEmbed(src);
}

/** 给用户的"支持什么"提示，UI 与报错共用一份文案 */
export const SUPPORTED_HINT =
  "支持：B站（BV 号或视频链接）、YouTube、Vimeo、腾讯视频、优酷；也可以直接粘贴这些平台的 <iframe> 代码";
