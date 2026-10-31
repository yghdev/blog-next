import { test } from "node:test";
import assert from "node:assert/strict";
import { toUtcIso, formatIn, dateKeyIn, monthKeyIn, yearKeyIn, nowIso } from "../lib/time.ts";

// 复现方案 B1：02:00 CST 发布 = UTC 前一天 18:00。旧实现落库 "2026-10-20 18:00:00"
// 并被 new Date() 按本地解析 -> 显示 10月20日（倒退一天）。
const naive = "2026-10-20 18:00:00";

test("naive 无标记串按 UTC 解释并补 Z", () => {
  assert.equal(toUtcIso(naive), "2026-10-20T18:00:00.000Z");
});

test("已带 Z 的串幂等", () => {
  assert.equal(toUtcIso("2026-10-20T18:00:00.000Z"), "2026-10-20T18:00:00.000Z");
});

test("T 分隔无标记同样处理", () => {
  assert.equal(toUtcIso("2026-10-20T18:00:00"), "2026-10-20T18:00:00.000Z");
});

test("带偏移的串换算到 UTC", () => {
  assert.equal(toUtcIso("2026-10-21T02:00:00+08:00"), "2026-10-20T18:00:00.000Z");
});

test("B1 回归：02:00 CST 发布，展示时区下仍是 10月21日", () => {
  assert.equal(formatIn(naive, "date", "Asia/Shanghai"), "2026年10月21日");
  assert.equal(dateKeyIn(naive, "Asia/Shanghai"), "2026-10-21");
});

test("UTC 展示时区下才是 10月20日（证明时区参数真的生效）", () => {
  assert.equal(formatIn(naive, "date", "UTC"), "2026年10月20日");
});

test("monthKey / yearKey", () => {
  assert.equal(monthKeyIn(naive, "Asia/Shanghai"), "2026-10");
  assert.equal(yearKeyIn(naive, "Asia/Shanghai"), "2026");
});

test("非法与空值不抛异常", () => {
  assert.equal(toUtcIso("not a date"), null);
  assert.equal(toUtcIso(null), null);
  assert.equal(toUtcIso(""), null);
  assert.equal(formatIn("garbage", "date"), "");
});

test("nowIso 产出带 Z 的完整 ISO（可被 toUtcIso 幂等往返）", () => {
  const s = nowIso();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(toUtcIso(s), s);
});

/* ══════════════════════════════════════════════════════════════════
   A-1：dateKeyIn / monthKeyIn / yearKeyIn 必须输出**补零**的 ISO 形态。

   背景：原实现用 Intl 的 month:"numeric" / day:"numeric"，1–9 月得到
   `2026-8-5`；于是 monthKeyIn 变成 `2026-8-`，lib/posts.ts 的
   `Number(ym.slice(5,7))` 得到 NaN，归档页渲染成「NaN 月」。
   而 10–12 月恰好两位，所以旧测试只断言 10 月（下方 monthKey 那条），
   把 bug 完整地漏了过去。

   这组用例刻意覆盖 01 / 08 / 09 / 11 四个月份：
     - 01 / 08 / 09 验证「月份必须补零」
     - 11 验证「两位数月份不被误伤」（防止把补零写成截断）
   每条都同时断言日（day）也补零，因为归档条目日期要显示成 08/05。
   ══════════════════════════════════════════════════════════════════ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

test("A-1 01 月：dateKeyIn 补零为 YYYY-MM-DD", () => {
  const v = "2026-01-03T02:00:00.000Z";
  assert.equal(dateKeyIn(v, "Asia/Shanghai"), "2026-01-03");
  assert.match(dateKeyIn(v, "Asia/Shanghai"), ISO_DATE);
  assert.equal(monthKeyIn(v, "Asia/Shanghai"), "2026-01");
  assert.equal(yearKeyIn(v, "Asia/Shanghai"), "2026");
});

test("A-1 08 月：dateKeyIn 补零为 YYYY-MM-DD", () => {
  const v = "2026-08-05T02:00:00.000Z";
  assert.equal(dateKeyIn(v, "Asia/Shanghai"), "2026-08-05");
  assert.match(dateKeyIn(v, "Asia/Shanghai"), ISO_DATE);
  assert.equal(monthKeyIn(v, "Asia/Shanghai"), "2026-08");
});

test("A-1 09 月：dateKeyIn 补零为 YYYY-MM-DD", () => {
  const v = "2026-09-08T02:00:00.000Z";
  assert.equal(dateKeyIn(v, "Asia/Shanghai"), "2026-09-08");
  assert.match(dateKeyIn(v, "Asia/Shanghai"), ISO_DATE);
  assert.equal(monthKeyIn(v, "Asia/Shanghai"), "2026-09");
});

test("A-1 11 月：两位数月份不被误伤，日仍补零", () => {
  const v = "2026-11-01T02:00:00.000Z";
  assert.equal(dateKeyIn(v, "Asia/Shanghai"), "2026-11-01");
  assert.match(dateKeyIn(v, "Asia/Shanghai"), ISO_DATE);
  assert.equal(monthKeyIn(v, "Asia/Shanghai"), "2026-11");
});

test("A-1 12 月跨年边界：按展示时区切日，仍补零", () => {
  // 2026-12-31T20:00Z = 上海 2027-01-01 04:00 → 年份进位，月份回到 01
  const v = "2026-12-31T20:00:00.000Z";
  assert.equal(dateKeyIn(v, "Asia/Shanghai"), "2027-01-01");
  assert.equal(monthKeyIn(v, "Asia/Shanghai"), "2027-01");
  assert.equal(yearKeyIn(v, "Asia/Shanghai"), "2027");
});

test("A-1 monthKeyIn 一定是 7 位（NaN 月的直接防线）", () => {
  for (const v of [
    "2026-01-03T02:00:00.000Z",
    "2026-08-05T02:00:00.000Z",
    "2026-09-08T02:00:00.000Z",
    "2026-11-01T02:00:00.000Z",
  ]) {
    const ym = monthKeyIn(v, "Asia/Shanghai");
    assert.equal(ym.length, 7, "monthKeyIn 必须是 YYYY-MM：" + ym);
    // lib/posts.ts 用 Number(ym.slice(5,7)) 生成「N 月」标签，必须是数字
    assert.ok(Number.isFinite(Number(ym.slice(5, 7))), "月份段必须是数字：" + ym);
  }
});

test("A-1 补零后的月份可以用来稳定排序（10 月不再排到最后）", () => {
  const months = [
    dateKeyIn("2026-01-03T02:00:00.000Z", "Asia/Shanghai"),
    dateKeyIn("2026-08-05T02:00:00.000Z", "Asia/Shanghai"),
    dateKeyIn("2026-09-08T02:00:00.000Z", "Asia/Shanghai"),
    dateKeyIn("2026-10-29T02:00:00.000Z", "Asia/Shanghai"),
    dateKeyIn("2026-11-01T02:00:00.000Z", "Asia/Shanghai"),
  ].map((d) => d.slice(0, 7));
  assert.deepEqual(
    [...months].sort((a, b) => b.localeCompare(a)),
    ["2026-11", "2026-10", "2026-09", "2026-08", "2026-01"]
  );
});

test("A-1 非法/空值仍返回空串（补零不能引入新的假值）", () => {
  assert.equal(dateKeyIn(null), "");
  assert.equal(dateKeyIn(""), "");
  assert.equal(dateKeyIn("garbage"), "");
  assert.equal(monthKeyIn("garbage"), "");
  assert.equal(yearKeyIn("garbage"), "");
});
