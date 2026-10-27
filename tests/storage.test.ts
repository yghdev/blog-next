import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, normalizeEndpoint, buildKey, keyFromUrl } from "../lib/storage.ts";
import { publicUrl } from "../lib/qiniu.ts";

/* ------------------------- 密钥加密（settings 表会进每日备份） ------------------------- */

test("AK/SK 加密后落库，密文不含明文", () => {
  const sk = "SECRET_KEY_1234567890";
  const enc = encryptSecret(sk);
  assert.ok(enc.startsWith("v1:"), "要有版本前缀，便于以后换算法");
  assert.ok(!enc.includes(sk), "密文里不能出现明文");
  assert.equal(decryptSecret(enc), sk, "能解回原文");
});

test("同一明文两次加密结果不同（随机 IV）", () => {
  const a = encryptSecret("same");
  const b = encryptSecret("same");
  assert.notEqual(a, b, "IV 必须随机，否则会泄露「两个密钥相同」这一信息");
  assert.equal(decryptSecret(a), "same");
  assert.equal(decryptSecret(b), "same");
});

test("空值不进加密路径", () => {
  assert.equal(encryptSecret(""), "");
  assert.equal(decryptSecret(""), "");
});

test("兼容手工写入的明文（旧数据/用 SQL 配过）", () => {
  assert.equal(decryptSecret("plaintext_sk"), "plaintext_sk", "不带 v1: 前缀视为明文原样返回");
});

test("密文被篡改时不抛错，返回空（上层判为未配置）", () => {
  const enc = encryptSecret("abc");
  const parts = enc.split(":");
  parts[3] = "AAAA" + parts[3].slice(4);
  assert.equal(decryptSecret(parts.join(":")), "", "GCM 校验失败应安全降级");
  assert.equal(decryptSecret("v1:bad"), "", "格式不对也不崩");
});

/* ------------------------------ endpoint 归一化 ------------------------------ */

test("补协议、去尾斜杠", () => {
  assert.equal(normalizeEndpoint("s3.cn-south-1.qiniucs.com"), "https://s3.cn-south-1.qiniucs.com");
  assert.equal(normalizeEndpoint("https://s3.cn-south-1.qiniucs.com/"), "https://s3.cn-south-1.qiniucs.com");
  assert.equal(normalizeEndpoint("  https://s3.cn-south-1.qiniucs.com//  "), "https://s3.cn-south-1.qiniucs.com");
});

test("误把 bucket 前缀写进 endpoint 时自动纠正", () => {
  assert.equal(
    normalizeEndpoint("https://flechazo-blog.s3.cn-south-1.qiniucs.com"),
    "https://s3.cn-south-1.qiniucs.com",
    "用户常把 bucket 一起贴进来，要能纠正，否则签名 host 拼错"
  );
});

test("空值原样返回", () => {
  assert.equal(normalizeEndpoint(""), "");
  assert.equal(normalizeEndpoint("   "), "");
});

/* ------------------------------ 对象 key 规则 ------------------------------ */

test("buildKey：年月/时间戳-随机.扩展名，与旧的本地规则一致", () => {
  const k = buildKey(".png", new Date("2026-10-27T03:00:00Z"));
  assert.match(k, /^2026\/10\/\d+-[0-9a-f]{8}\.png$/);
});

test("buildKey 两次不重名", () => {
  assert.notEqual(buildKey(".png"), buildKey(".png"));
});

/* --------------------- URL → key 反解（删除时要靠它定位对象） --------------------- */

const cfg = {
  accessKeyId: "AK", secretAccessKey: "SK", bucket: "b",
  endpoint: "https://s3.cn-south-1.qiniucs.com", region: "cn-south-1",
  pathStyle: false, cdnDomain: "https://cdn.yghsite.cn",
};

test("CDN 直链能反解出 key", () => {
  assert.equal(keyFromUrl("https://cdn.yghsite.cn/2026/10/a.png", cfg), "2026/10/a.png");
});

test("本机磁盘路径返回 null（不归七牛管，删的时候走磁盘分支）", () => {
  assert.equal(keyFromUrl("/images/2026/10/a.png", cfg), null);
});

test("其他域名的 URL 返回 null，避免误删别人空间的对象", () => {
  assert.equal(keyFromUrl("https://evil.com/a.png", cfg), null);
  assert.equal(keyFromUrl("https://cdn.yghsite.cn.evil.com/a.png", cfg), null);
  assert.equal(keyFromUrl("", cfg), null);
});

test("CDN 域名带尾斜杠时也能反解", () => {
  assert.equal(keyFromUrl("https://cdn.yghsite.cn/a.png", { ...cfg, cdnDomain: "https://cdn.yghsite.cn/" }), "a.png");
});

test("key 含中文时正确解码", () => {
  const url = publicUrl(cfg, "2026/10/中文.png");
  assert.equal(keyFromUrl(url, cfg), "2026/10/中文.png");
});
