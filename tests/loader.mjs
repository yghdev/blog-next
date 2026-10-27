import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

// node --test 的解析钩子：让测试能加载 Next 风格的 import。
//   1) "@/lib/x"                 -> <root>/lib/x(.ts)
//   2) 相对路径且无扩展名        -> 补 .ts / .tsx / /index.ts
// Next 自身有这些能力，生产构建不需要这个钩子，仅测试使用。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_EXTS = [".ts", ".tsx", ".mjs", ".js"];

function firstExisting(base) {
  for (const e of CANDIDATE_EXTS) {
    const p = base + e;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const e of CANDIDATE_EXTS) {
      const p = path.join(base, "index" + e);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === "next/server") return next("next/server.js", context);
  if (specifier === "next/headers" || specifier === "next/cache") {
    if (!process.env.BLOG_TEST_NEXT_STUBS) throw new Error("Set BLOG_TEST_NEXT_STUBS=1 only for isolated route tests");
    return { url: "test-next-request:" + specifier, shortCircuit: true };
  }

  try {
    return await next(specifier, context);
  } catch (err) {
    let target = null;
    if (specifier.startsWith("@/")) {
      target = firstExisting(path.join(ROOT, specifier.slice(2)));
    } else if (specifier.startsWith(".")) {
      const parentDir = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : ROOT;
      target = firstExisting(path.resolve(parentDir, specifier));
    }
    if (!target) throw err;
    // 交回默认解析，让 Node 自己决定 format（类型剥离需要它）
    return next(pathToFileURL(target).href, { ...context, parentURL: context.parentURL });
  }
}

export async function load(url, context, next) {
  if (url.startsWith("test-next-request:")) {
    const which = url.slice("test-next-request:".length);
    return {
      format: "module",
      shortCircuit: true,
      source: `globalThis.__blogTestNext ??= { cookies: () => ({ get: () => undefined }), headers: async () => ({ get: () => null }), revalidateTag() {}, revalidatePath() {} };\n` + (which === "next/headers"
        ? "export const cookies = () => globalThis.__blogTestNext.cookies(); export const headers = () => globalThis.__blogTestNext.headers();"
        : "export const revalidateTag = (...a) => globalThis.__blogTestNext.revalidateTag(...a); export const revalidatePath = (...a) => globalThis.__blogTestNext.revalidatePath(...a); export const unstable_cache = (fn) => fn; export const unstable_noStore = () => {};" ),
    };
  }
  return next(url, context);
}

