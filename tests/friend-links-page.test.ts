import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLegacyFriends,
  parseFriendRequirements,
  parseSiteInfo,
  resolveSiteInfo,
  mergeDirectoryLinks,
  faviconFor,
  urlKey,
  buildFriendConfig,
  pad2,
} from "../lib/friend-links-page.ts";
import type { FriendLinkView } from "../lib/friend-links-shared.ts";

const SAMPLE = `欢迎交换友链。如果你也有博客，可以在下方评论区留下你的站点，我会尽快加上。

## 朋友们

- **[xaoxuu](https://xaoxuu.com)** —— For all time, always.
- **[字节星球](https://www.bytecho.net/)** —— 分享前后端开发等计算机科学与技术内容及个人生活日常。
- [Xuan's blog](https://blog.ybyq.wang) - 分享技术教程和学习笔记
- [坏链](javascript:alert(1)) —— 不该出现

## 本站信息

- **名称**：flechazo's blog
- **地址**：https://blog.yghsite.cn
- **描述**：记录 AI、开发与折腾的日常

## 申请要求

- 站点内容健康，以原创为主
- 已稳定运行一段时间，访问正常
- 在评论区提交时请附上：站点名称、地址、一句话描述
`;

test("解析旧正文的友链清单：名称/地址/描述，过滤不安全 URL", () => {
  const links = parseLegacyFriends(SAMPLE);
  assert.equal(links.length, 3, "javascript: 条目必须被过滤");
  assert.deepEqual(links.map((l) => l.name), ["xaoxuu", "字节星球", "Xuan's blog"]);
  assert.equal(links[0].url, "https://xaoxuu.com");
  assert.equal(links[0].desc, "For all time, always.", "应剥掉破折号前缀");
  assert.equal(links[2].desc, "分享技术教程和学习笔记", "短横线也算前缀");
  assert.ok(links.every((l) => l.id < 0), "正文条目用负数 id，避免与表主键冲突");
  assert.ok(links.every((l) => l.kind === "friend"));
});

test("解析旧正文：没有「朋友们」小节时返回空数组（不误抓其它链接）", () => {
  assert.deepEqual(parseLegacyFriends("## 关于\n\n- [某站](https://a.com)\n"), []);
  assert.deepEqual(parseLegacyFriends(""), []);
});

test("解析申请要求：按列表项返回，保持原文，不改写规则", () => {
  const rules = parseFriendRequirements(SAMPLE);
  assert.equal(rules.length, 3);
  assert.equal(rules[0], "站点内容健康，以原创为主");
  assert.match(rules[2], /站点名称、地址、一句话描述$/);
});

test("解析申请要求：没有列表时退回段落；没有该小节返回空", () => {
  assert.deepEqual(parseFriendRequirements("## 申请要求\n\n请先来信说明站点情况。\n"), ["请先来信说明站点情况。"]);
  assert.deepEqual(parseFriendRequirements("## 朋友们\n- x"), []);
});

test("解析本站信息，并把相对头像补成绝对地址", () => {
  const info = parseSiteInfo(SAMPLE);
  assert.equal(info.name, "flechazo's blog");
  assert.equal(info.url, "https://blog.yghsite.cn");
  assert.equal(info.desc, "记录 AI、开发与折腾的日常");

  const resolved = resolveSiteInfo(SAMPLE, {
    siteTitle: "should-not-win",
    siteDescription: "should-not-win",
    siteUrl: "https://blog.yghsite.cn",
  });
  assert.equal(resolved.name, "flechazo's blog", "正文优先于 settings");
  assert.equal(resolved.avatar, "https://blog.yghsite.cn/avatar.jpg", "默认头像要绝对化");

  const fallback = resolveSiteInfo("", {
    siteTitle: "站点名",
    siteDescription: "站点描述",
    siteUrl: "https://example.com/",
  });
  assert.deepEqual(fallback, {
    name: "站点名",
    url: "https://example.com",
    avatar: "https://example.com/avatar.jpg",
    desc: "站点描述",
  });
});

test("合并数据源：表优先、正文补齐，重复链接只出现一次", () => {
  const managed: FriendLinkView[] = [
    { id: 1, name: "开往", url: "https://www.travellings.cn/go.html", desc: "友链接力", kind: "hub" },
    { id: 2, name: "xaoxuu", url: "https://xaoxuu.com/", desc: "", kind: "friend" },
  ];
  const legacy = parseLegacyFriends(SAMPLE);
  const { friends, hubs } = mergeDirectoryLinks(managed, legacy);

  assert.equal(hubs.length, 1, "hub 单独分组");
  assert.equal(friends.length, 3, "xaoxuu 重复（末尾斜杠不同）应合并，只剩 3 条友链");
  const xaoxuu = friends.find((f) => f.name === "xaoxuu")!;
  assert.equal(xaoxuu.source, "managed");
  assert.equal(xaoxuu.desc, "For all time, always.", "表里描述为空时用正文补齐");
  assert.deepEqual(friends.map((f) => f.name), ["xaoxuu", "字节星球", "Xuan's blog"], "保持表的顺序在前");
});

test("合并数据源：只有正文数据时全部来自 legacy；非法 URL 被丢弃", () => {
  const { friends } = mergeDirectoryLinks([], [
    { id: -1, name: "A", url: "https://a.com", desc: "", kind: "friend" },
    { id: -2, name: "B", url: "javascript:alert(1)", desc: "", kind: "friend" },
  ]);
  assert.equal(friends.length, 1);
  assert.equal(friends[0].source, "legacy");
});

test("urlKey 忽略协议、www、末尾斜杠与大小写", () => {
  assert.equal(urlKey("https://www.Example.com/a/"), urlKey("http://example.com/a"));
  assert.notEqual(urlKey("https://example.com/a"), urlKey("https://example.com/b"));
});

test("faviconFor 只对 https 站点给地址，http 返回 null（避免混合内容）", () => {
  assert.equal(faviconFor("https://blog.example.com/posts/1"), "https://blog.example.com/favicon.ico");
  assert.equal(faviconFor("http://example.com"), null);
  assert.equal(faviconFor("not a url"), null);
});

test("复制的友链配置是合法 JSON，字段与 friend_links 兼容", () => {
  const text = buildFriendConfig({
    name: "flechazo's blog",
    url: "https://blog.yghsite.cn",
    avatar: "https://blog.yghsite.cn/avatar.jpg",
    desc: "记录 AI、开发与折腾的日常",
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.name, "flechazo's blog");
  assert.equal(parsed.url, "https://blog.yghsite.cn");
  assert.equal(parsed.avatar, "https://blog.yghsite.cn/avatar.jpg");
  assert.equal(parsed.desc, "记录 AI、开发与折腾的日常");
  assert.equal(parsed.kind, "friend");
});

test("pad2 生成两位编辑式编号", () => {
  assert.equal(pad2(4), "04");
  assert.equal(pad2(12), "12");
  assert.equal(pad2(0), "00");
  assert.equal(pad2(-3), "00");
});
