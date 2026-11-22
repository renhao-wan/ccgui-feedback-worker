import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_LIMIT,
  BURST_LIMIT,
  BURST_WINDOW_MS,
  utcDay,
  clientKey,
  decideLimit,
  nextResetAt,
  normaliseClientText,
  buildMailSubject,
  buildMailBody,
} from "../src/ratelimit.mjs";

test("utcDay 按 UTC 切日，跨时区不漂移", () => {
  assert.equal(utcDay(new Date("2026-11-22T23:59:59Z")), "2026-11-22");
  assert.equal(utcDay(new Date("2026-11-22T00:00:00Z")), "2026-11-22");
  assert.equal(utcDay(new Date("2026-11-23T00:00:01Z")), "2026-11-23");
});

test("nextResetAt 指向次日 UTC 零点", () => {
  const now = new Date("2026-11-22T13:05:00Z").getTime();
  assert.equal(nextResetAt(now), Date.parse("2026-11-23T00:00:00Z"));
});

test("clientKey 不含插件名——额度是所有插件共享的一个池", () => {
  const a = clientKey("1.2.3.4");
  const b = clientKey("1.2.3.4");
  assert.equal(a, b, "同一 IP 必须得到同一个键");
  assert.notEqual(a, clientKey("1.2.3.5"));
  // 键里不能出现插件标识，否则每个插件会各有一份额度。
  assert.doesNotMatch(a, /github-trending|worklog/);
});

test("clientKey 对 IP 做哈希，不落明文", () => {
  const key = clientKey("203.0.113.9");
  assert.doesNotMatch(key, /203\.0\.113\.9/, "键里不应保留明文 IP");
  assert.match(key, /^[0-9a-f]{16}$/);
});

test("decideLimit 首次发送放行并返回剩余", () => {
  const r = decideLimit({ used: 0, burst: [] }, 1000);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, DAILY_LIMIT - 1);
});

test("decideLimit 用完日额度后拒绝", () => {
  const r = decideLimit({ used: DAILY_LIMIT, burst: [] }, 1000);
  assert.equal(r.allowed, false);
  assert.equal(r.kind, "daily");
  assert.equal(r.remaining, 0);
});

test("decideLimit 第三条之后触发突发保护", () => {
  const now = 100_000;
  // 窗口内已有 BURST_LIMIT 条，这条就该被拒。留 1 条日额度，确保拒的原因
  // 是突发而不是日额度——两种 kind 的文案不同。
  const burst = [now - 1000, now - 800, now - 600];
  const r = decideLimit({ used: BURST_LIMIT, burst }, now);
  assert.equal(r.allowed, false);
  assert.equal(r.kind, "burst");
});

test("decideLimit 窗口外的旧记录不算数", () => {
  const now = 1_000_000;
  const burst = [now - BURST_WINDOW_MS - 1, now - BURST_WINDOW_MS - 2];
  const r = decideLimit({ used: 2, burst }, now);
  assert.equal(r.allowed, true);
});

test("decideLimit 额度边界：剩一条时还能发", () => {
  const r = decideLimit({ used: DAILY_LIMIT - 1, burst: [] }, 1000);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 0);
});

test("decideLimit 突发保护不会超过日额度判断", () => {
  // 日额度已用完时，就算窗口里没记录也必须拒绝。
  const r = decideLimit({ used: DAILY_LIMIT, burst: [] }, 1000);
  assert.equal(r.kind, "daily");
});

test("normaliseClientText 收敛并限长", () => {
  assert.equal(normaliseClientText("  a\n\nb  "), "a b");
  assert.equal(normaliseClientText(null), "");
  assert.equal(normaliseClientText("x".repeat(5000)).length, 1000);
});

test("buildMailSubject 带上插件名，不含换行", () => {
  const s = buildMailSubject({ pluginId: "github-trending", text: "第一行\n第二行" });
  assert.match(s, /github-trending/);
  assert.doesNotMatch(s, /[\r\n]/);
  assert.ok(s.length <= 120);
});

test("buildMailBody 保留正文并附上版本信息", () => {
  const body = buildMailBody({
    text: "界面有点卡",
    pluginId: "github-trending",
    pluginVersion: "0.1.0",
    hostVersion: "1.2.4",
    ts: 1795000000000,
  });
  assert.match(body, /界面有点卡/);
  assert.match(body, /0\.1\.0/);
  assert.match(body, /1\.2\.4/);
  assert.match(body, /2026-11-18/);
});

test("BURST_LIMIT 小于 DAILY_LIMIT——否则突发限制永远先不触发", () => {
  assert.ok(BURST_LIMIT < DAILY_LIMIT);
});
