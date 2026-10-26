/**
 * 浏览器侧图片预处理（只在客户端跑，依赖 DOM / canvas）。
 *
 * 安全边界不变：服务端仍然只信 magic bytes，这里只是把"用户设备上的格式"
 * 统一成服务端认得的位图格式。所以即使这段代码被绕过，上传接口该拒的照样拒。
 */

import {
  planUpload,
  shouldReencode,
  outputMimeFor,
  formatBytes,
  type UploadPlan,
} from "./image-plan";

export type PrepareResult = {
  file: File;
  /** 为了给用户看：原始 -> 处理后 */
  note: string;
  changed: boolean;
};

/** 解码：优先 createImageBitmap（快且不在主线程解码大图），失败退回 <img> */
async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Safari 对某些格式不支持，走下面的 <img>
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("图片解码失败"));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** 用 canvas 重编码。canvas 不保留任何元数据，EXIF/GPS 就此丢掉。 */
async function reencode(
  blob: Blob,
  target: { width: number; height: number },
  mime: "image/png" | "image/jpeg",
  quality: number
): Promise<Blob> {
  const decoded = await decode(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 canvas");
    if (mime === "image/jpeg") {
      // JPEG 没有透明通道，先铺白底，避免透明区域变黑
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

    const out = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, mime, mime === "image/jpeg" ? quality : undefined)
    );
    if (!out) throw new Error("图片编码失败");
    return out;
  } finally {
    decoded.close();
  }
}

type Heic2Any = (o: { blob: Blob; toType?: string; quality?: number }) => Promise<Blob | Blob[]>;

/**
 * HEIC/HEIF 转码：动态 import，避免把 1.3MB 的 libheif 塞进后台首屏。
 *
 * 互操作要小心：heic2any 是 UMD（module.exports = fn）。
 * 不同打包器的处理不同 —— 可能给 { default: fn }，也可能直接给 fn。
 * 只取 .default 会在后一种情况下拿到 undefined，表现是"选了 HEIC 毫无反应"，
 * 所以这里两种都认。
 */
async function convertHeic(file: File): Promise<Blob> {
  const mod: unknown = await import("heic2any");
  const candidate = mod as { default?: unknown };
  const fn = (typeof candidate.default === "function" ? candidate.default : mod) as Heic2Any;
  if (typeof fn !== "function") throw new Error("HEIC 转码模块加载异常");

  const out = await fn({ blob: file, toType: "image/jpeg", quality: 0.82 });
  const blob = Array.isArray(out) ? out[0] : out;
  if (!blob) throw new Error("HEIC 转码没有返回数据");
  return blob;
}

/** 改扩展名：服务端反正按 magic bytes 定类型，但文件名保留正确后缀便于本地排查 */
function renameFor(name: string, mime: string): string {
  const base = (name || "image").replace(/\.[^.]+$/, "") || "image";
  return base + (mime === "image/png" ? ".png" : ".jpg");
}

/**
 * 上传前统一处理。永不抛错：
 *   - 转码失败就原样返回原文件，交给服务端给出准确报错（用户至少知道发生了什么）
 */
export async function prepareForUpload(raw: File): Promise<PrepareResult> {
  const plan: UploadPlan = planUpload({ name: raw.name, type: raw.type, size: raw.size });

  try {
    let blob: Blob = raw;
    let sourceMime = raw.type;
    let isHeicSource = false;

    if (plan.kind === "heic") {
      blob = await convertHeic(raw);
      sourceMime = "image/jpeg";
      isHeicSource = true;
    }

    // 拿真实宽高，决定要不要缩/重编码
    const dims = await (async () => {
      const d = await decode(blob);
      try {
        return { width: d.width, height: d.height };
      } finally {
        d.close();
      }
    })();

    // HEIC 转出来的 JPEG 体积要参与判断：已经够小就不该再压一遍
    const { reencode: needReencode, target } = shouldReencode(plan, dims, blob.size);
    if (needReencode) {
      const outMime = outputMimeFor(sourceMime, isHeicSource);
      const out = await reencode(blob, target, outMime, plan.quality);
      // 重编码反而更大就不值当（小图 PNG 转 JPEG 有时会涨）；
      // 但"缩过尺寸"必须采用，否则等于没缩。
      const mustUse = target.width !== dims.width || target.height !== dims.height;
      if (mustUse || out.size < blob.size) {
        blob = out;
        sourceMime = outMime;
      }
    }

    if (blob === raw) return { file: raw, note: "", changed: false };

    const outMime = blob.type || sourceMime || "image/jpeg";
    const prepared = new File([blob], renameFor(raw.name, outMime), {
      type: outMime,
      lastModified: Date.now(),
    });

    const parts: string[] = [];
    if (plan.kind === "heic") parts.push("HEIC 已转为 JPEG");
    if (target.width !== dims.width || target.height !== dims.height) {
      parts.push("缩放到 " + target.width + "×" + target.height);
    }
    if (prepared.size < raw.size) {
      parts.push(formatBytes(raw.size) + " → " + formatBytes(prepared.size));
    }
    return { file: prepared, note: parts.join("，"), changed: true };
  } catch (e) {
    // 转码失败不阻断上传：原文件交给服务端，报错更准确
    console.warn("[prepareForUpload] 预处理失败，按原文件上传:", (e as Error).message);
    return { file: raw, note: "", changed: false };
  }
}
