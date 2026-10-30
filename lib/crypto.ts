import crypto from "node:crypto";

/** 生成 URL 安全的随机 token（hex） */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** 会话/恢复码一律只存哈希：库里没有明文，备份外流也无法直接重放 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * 带密钥的哈希，用于「不可逆但可复现」的访客标识（lib/visitor-stats.ts）。
 *
 * 为什么不能用上面的 hashToken（裸 SHA-256）：
 * IPv4 只有 2^32 种取值，UA 的取值空间也远小于穷举成本 ——
 * 裸哈希可以在几分钟内把一张 visitor 表反查成真实 IP 列表。
 * HMAC 把密钥作为唯一未知量，没有 settings 里的 stats:secret 就无法反查。
 */
export function hmac(key: string, data: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

/** 恢复码：人可抄写的分组格式（大写字母 + 数字，去除易混字符） */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateRecoveryCode(): string {
  const pick = () => ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = "";
    for (let i = 0; i < 4; i++) s += pick();
    groups.push(s);
  }
  return groups.join("-");
}

/** 归一化用户输入的恢复码，忽略大小写与分隔符 */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 常数时间比较，避免按字节泄露长度/前缀 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 用户不存在时也要跑一次 bcrypt，避免响应时间差暴露用户名是否存在。
 * （原先 getUser 未命中直接返回 401，等于免费送一个用户名枚举通道）
 */
export const DUMMY_HASH = "$2a$12$EhlyaN2v4oiZvwUwN.UjcuSPT8co4Zco93COjaJZN17Gs0h2dUfAS";
