import { test } from "node:test";
import assert from "node:assert/strict";
import {
  uriEncode, canonicalQueryString, signRequest, amzDates, sha256Hex,
  buildPath, resolveHost, publicUrl, parseListXml, explainError,
  isConfigured, EMPTY_CONFIG, type QiniuConfig,
} from "../lib/qiniu.ts";

/* ------------------------- SigV4：AWS 官方测试向量 ------------------------- */
/* 来源：AWS S3 SigV4 文档示例（GET Object，示例 bucket/凭证均为官方给出的公开值） */

test("SigV4：AWS 官方示例签名逐字节一致", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  // GET /test.txt 对象，region us-east-1，服务 s3
  const auth = signRequest({
    method: "GET",
    canonicalUri: "/test.txt",
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      "range": "bytes=0-9",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    amzDate: "20130524T000000Z",
    dateStamp: "20130524",
  });
  // 官方文档给出的期望签名
  assert.match(auth, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41/);
});

test("SigV4：官方 GET Bucket Lifecycle 向量（含 query）", () => {
  const auth = signRequest({
    method: "GET",
    canonicalUri: "/",
    query: { lifecycle: "" },
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    amzDate: "20130524T000000Z",
    dateStamp: "20130524",
  });
  assert.match(auth, /Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543/);
});

test("SigV4：官方 LIST Objects 向量", () => {
  const auth = signRequest({
    method: "GET",
    canonicalUri: "/",
    query: { "max-keys": 2, prefix: "J" },
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    amzDate: "20130524T000000Z",
    dateStamp: "20130524",
  });
  assert.match(auth, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7/);
});

test("Authorization 头格式正确", () => {
  const auth = signRequest({
    method: "PUT", canonicalUri: "/k.png",
    headers: { host: "h", "x-amz-content-sha256": "x", "x-amz-date": "d" },
    payloadHash: "x", accessKeyId: "AK",
    secretAccessKey: "SK", region: "cn-south-1",
    amzDate: "20261027T000000Z", dateStamp: "20261027",
  });
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AK\/20261027\/cn-south-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
});

/* ------------------------------ URI 编码 ------------------------------ */

test("uriEncode：RFC3986，特殊字符正确", () => {
  assert.equal(uriEncode("abc-._~"), "abc-._~", "非保留字符不编码");
  assert.equal(uriEncode("a b"), "a%20b", "空格编码成 %20 而不是 +");
  assert.equal(uriEncode("a+b"), "a%2Bb", "加号必须编码");
  assert.equal(uriEncode("中文"), "%E4%B8%AD%E6%96%87");
  assert.equal(uriEncode("a/b"), "a%2Fb", "默认斜杠被编码");
  assert.equal(uriEncode("a/b", true), "a/b", "allowSlash 时保留斜杠");
});

test("canonicalQueryString：按 key 排序且编码", () => {
  assert.equal(canonicalQueryString({ b: 2, a: 1 }), "a=1&b=2");
  assert.equal(canonicalQueryString({ prefix: "a b" }), "prefix=a%20b");
  assert.equal(canonicalQueryString({ "max-keys": 2, prefix: "J" }), "max-keys=2&prefix=J");
  assert.equal(canonicalQueryString({ a: undefined, b: 1 }), "b=1", "undefined 被跳过");
  assert.equal(canonicalQueryString({ lifecycle: "" }), "lifecycle=", "空值保留");
});

/* --------------------------- 路径与 URL 拼接 --------------------------- */

const cfg: QiniuConfig = {
  accessKeyId: "AK", secretAccessKey: "SK", bucket: "flechazo-blog",
  endpoint: "https://s3.cn-south-1.qiniucs.com", region: "cn-south-1",
  cdnDomain: "https://cdn.yghsite.cn",
};

test("虚拟主机式：host 带 bucket 前缀，路径不含 bucket", () => {
  const { host, protocol } = resolveHost(cfg);
  assert.equal(host, "flechazo-blog.s3.cn-south-1.qiniucs.com");
  assert.equal(protocol, "https:");
  assert.equal(buildPath(cfg, "2026/10/a.png"), "/2026/10/a.png");
});

test("路径式：host 不带 bucket，路径含 bucket", () => {
  const c = { ...cfg, pathStyle: true };
  assert.equal(resolveHost(c).host, "s3.cn-south-1.qiniucs.com");
  assert.equal(buildPath(c, "2026/10/a.png"), "/flechazo-blog/2026/10/a.png");
});

test("没有 key 时根路径为 /", () => {
  assert.equal(buildPath(cfg), "/");
  assert.equal(buildPath({ ...cfg, pathStyle: true }), "/flechazo-blog");
});

test("key 里的特殊字符被逐段编码", () => {
  assert.equal(buildPath(cfg, "a b/c+d.png"), "/a%20b/c%2Bd.png");
});

/* ------------------------------ 公开 URL ------------------------------ */

test("publicUrl 用 CDN 域名拼接", () => {
  assert.equal(publicUrl(cfg, "2026/10/a.png"), "https://cdn.yghsite.cn/2026/10/a.png");
});

test("publicUrl 容忍 CDN 域名尾斜杠", () => {
  assert.equal(publicUrl({ ...cfg, cdnDomain: "https://cdn.yghsite.cn/" }, "a.png"), "https://cdn.yghsite.cn/a.png");
  assert.equal(publicUrl({ ...cfg, cdnDomain: "https://cdn.yghsite.cn///" }, "a.png"), "https://cdn.yghsite.cn/a.png");
});

/* --------------------------- ListObjectsV2 解析 --------------------------- */

test("解析 ListObjectsV2：多对象 + 分页 token", () => {
  const xml = `<?xml version="1.0"?>
<ListBucketResult>
  <Contents>
    <Key>2026/10/a.png</Key>
    <LastModified>2026-10-27T03:00:00.000Z</LastModified>
    <ETag>&quot;abc123&quot;</ETag>
    <Size>174</Size>
  </Contents>
  <Contents>
    <Key>2026/10/b.png</Key>
    <LastModified>2026-10-27T03:01:00.000Z</LastModified>
    <ETag>&quot;def456&quot;</ETag>
    <Size>2048</Size>
  </Contents>
  <NextContinuationToken>tok_abc</NextContinuationToken>
</ListBucketResult>`;
  const r = parseListXml(xml);
  assert.equal(r.objects.length, 2);
  assert.deepEqual(r.objects[0], {
    key: "2026/10/a.png", size: 174,
    lastModified: "2026-10-27T03:00:00.000Z", etag: "abc123",
  });
  assert.equal(r.objects[1].size, 2048);
  assert.equal(r.nextToken, "tok_abc", "分页 token 要取到");
});

test("解析空列表不崩", () => {
  assert.deepEqual(parseListXml("<ListBucketResult></ListBucketResult>"), { objects: [], nextToken: null });
});

test("key 里的 XML 实体被还原", () => {
  const xml = "<ListBucketResult><Contents><Key>a&amp;b.png</Key><Size>1</Size></Contents></ListBucketResult>";
  assert.equal(parseListXml(xml).objects[0].key, "a&b.png");
});

/* ------------------------------ 错误翻译 ------------------------------ */

test("常见七牛错误码翻成中文且带原码", () => {
  const e1 = explainError(403, "<Error><Code>SignatureDoesNotMatch</Code><Message>x</Message></Error>");
  assert.match(e1, /签名校验失败/);
  assert.match(e1, /SignatureDoesNotMatch/);

  assert.match(explainError(404, "<Error><Code>NoSuchBucket</Code></Error>"), /空间不存在/);
  assert.match(explainError(403, "<Error><Code>InvalidAccessKeyId</Code></Error>"), /AccessKeyId 不存在/);
  assert.match(explainError(403, "<Error><Code>RequestTimeTooSkewed</Code></Error>"), /时间/);
});

test("未知错误码也给出状态码", () => {
  const e = explainError(500, "<Error><Code>Weird</Code><Message>boom</Message></Error>");
  assert.match(e, /Weird/);
  assert.match(e, /boom/);
});

test("空 body 不崩", () => {
  assert.ok(explainError(500, "").includes("500"));
});

/* ------------------------------ 配置校验 ------------------------------ */

test("isConfigured：缺任一项都为 false", () => {
  assert.equal(isConfigured(cfg), true);
  for (const k of ["accessKeyId", "secretAccessKey", "bucket", "endpoint", "region", "cdnDomain"] as const) {
    assert.equal(isConfigured({ ...cfg, [k]: "" }), false, "缺 " + k + " 应判为未配置");
  }
  assert.equal(isConfigured(null), false);
  assert.equal(isConfigured(EMPTY_CONFIG), false);
});

/* ------------------------------ 时间格式 ------------------------------ */

test("amzDates 产出 SigV4 要求的两种时间格式", () => {
  const { amz, date } = amzDates(new Date("2026-10-27T03:20:49.123Z"));
  assert.equal(amz, "20261027T032049Z");
  assert.equal(date, "20261027");
});

test("sha256Hex 与已知向量一致", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});
