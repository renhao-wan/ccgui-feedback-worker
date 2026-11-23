import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COOLDOWN_MS,
  FALLBACK_DAILY_LIMIT,
  BURST_LIMIT,
  BURST_WINDOW_MS,
  utcDay,
  clientKey,
  cooldownKey,
  fallbackKey,
  decideCooldown,
  decideFallback,
  quotaView,
  nextResetAt,
  normaliseClientText,
  buildMailSubject,
  buildMailBody,
  safeIsoTime,
  textTooLong,
  MAX_BODY_BYTES,
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

test("冷却窗口正好是 48 小时", () => {
  assert.equal(COOLDOWN_MS, 48 * 60 * 60 * 1000);
});

test("clientKey 对 IP 做哈希，不落明文", () => {
  const key = clientKey("203.0.113.9");
  assert.doesNotMatch(key, /203\.0\.113\.9/, "键里不应保留明文 IP");
  assert.match(key, /^[0-9a-f]{16}$/);
});

test("clientKey 是加盐假名化，注释不能谎称不可逆", () => {
  // 不同盐必须给出不同键：否则拿 IP 全量枚举就能反查。
  const a = clientKey("1.2.3.4", "salt-one");
  const b = clientKey("1.2.3.4", "salt-two");
  assert.notEqual(a, b, "换盐必须改变键");
  assert.equal(clientKey("1.2.3.4", "s"), clientKey("1.2.3.4", "s"));
});

test("冷却键按插件隔离，且不含明文 IP", () => {
  const ipKey = clientKey("203.0.113.9");
  const a = cooldownKey(ipKey, "github-trending");
  const b = cooldownKey(ipKey, "worklog");
  assert.notEqual(a, b, "不同插件必须是不同的冷却键");
  assert.match(a, /github-trending/, "冷却键带插件名，便于排查");
  assert.doesNotMatch(a, /203\.0\.113\.9/, "冷却键里不能出现明文 IP");
  // 同 IP 同插件稳定。
  assert.equal(a, cooldownKey(ipKey, "github-trending"));
});

test("兜底池键跨插件共享——换插件刷同一份池", () => {
  const ipKey = clientKey("203.0.113.9");
  const day = "2026-11-23";
  // 键里刻意不带插件名：换了插件也吃同一份额度。
  assert.doesNotMatch(fallbackKey(ipKey, day), /github-trending|worklog/);
  assert.equal(fallbackKey(ipKey, day), fallbackKey(ipKey, day));
  assert.notEqual(fallbackKey(ipKey, day), fallbackKey(ipKey, "2026-11-24"));
});

test("decideCooldown 无记录时放行", () => {
  const r = decideCooldown(0, 1000);
  assert.equal(r.available, true);
  assert.equal(r.retryAt, 0);
});

test("decideCooldown 脏数据当作无记录，不误拦", () => {
  for (const bad of [undefined, null, NaN, -1, "abc", Infinity]) {
    assert.equal(decideCooldown(bad, 1000).available, true, String(bad));
  }
});

test("decideCooldown 满 48 小时前拒绝、到点放行", () => {
  const last = 1_000_000;
  // 差 1 毫秒满 48 小时：仍冷却中。
  const justBefore = decideCooldown(last, last + COOLDOWN_MS - 1);
  assert.equal(justBefore.available, false);
  assert.equal(justBefore.retryAt, last + COOLDOWN_MS);
  // 正好 48 小时：放行。
  assert.equal(decideCooldown(last, last + COOLDOWN_MS).available, true);
  assert.equal(decideCooldown(last, last + COOLDOWN_MS + 1).available, true);
});

test("decideFallback 首次动用兜底放行", () => {
  const r = decideFallback({ used: 0, burst: [] }, 1000);
  assert.equal(r.allowed, true);
  assert.equal(r.kind, "ok");
  assert.equal(r.remaining, FALLBACK_DAILY_LIMIT - 1);
});

test("decideFallback 兜底池用完就拒", () => {
  const r = decideFallback({ used: FALLBACK_DAILY_LIMIT, burst: [] }, 1000);
  assert.equal(r.allowed, false);
  assert.equal(r.kind, "fallback");
  assert.equal(r.remaining, 0);
});

test("decideFallback 边界：还剩一条时能发", () => {
  const r = decideFallback({ used: FALLBACK_DAILY_LIMIT - 1, burst: [] }, 1000);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 0);
});

test("decideFallback 第三条之后触发突发保护", () => {
  const now = 100_000;
  const burst = [now - 1000, now - 800, now - 600];
  const r = decideFallback({ used: BURST_LIMIT, burst }, now);
  assert.equal(r.allowed, false);
  assert.equal(r.kind, "burst");
  // 突发被拒时兜底池其实还有剩，不能谎报 0。
  assert.equal(r.remaining, FALLBACK_DAILY_LIMIT - BURST_LIMIT);
});

test("decideFallback 窗口外的旧记录不算数", () => {
  const now = 1_000_000;
  const burst = [now - BURST_WINDOW_MS - 1, now - BURST_WINDOW_MS - 2];
  const r = decideFallback({ used: 2, burst }, now);
  assert.equal(r.allowed, true);
});

test("quotaView 冷却中 remaining=0，并给出重试时刻", () => {
  const last = 1_000_000;
  const now = last + 1000;
  const v = quotaView({ cooldownLast: last, fallback: { used: 0 }, now });
  assert.equal(v.remaining, 0);
  assert.equal(v.dailyLimit, 1);
  assert.equal(v.resetAt, last + COOLDOWN_MS);
  assert.equal(v.fallbackRemaining, FALLBACK_DAILY_LIMIT);
});

test("quotaView 未冷却 remaining=1", () => {
  const now = 1_000_000;
  const v = quotaView({ cooldownLast: 0, fallback: { used: 1 }, now });
  assert.equal(v.remaining, 1);
  assert.equal(v.fallbackRemaining, FALLBACK_DAILY_LIMIT - 1);
});

test("quotaView 兜底池用尽时 fallbackRemaining=0，不出现负数", () => {
  const v = quotaView({ cooldownLast: 0, fallback: { used: 99 }, now: 1000 });
  assert.equal(v.fallbackRemaining, 0);
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

test("BURST_LIMIT 小于 FALLBACK_DAILY_LIMIT——否则突发限制永远先不触发", () => {
  assert.ok(BURST_LIMIT < FALLBACK_DAILY_LIMIT);
});

test("safeIsoTime 挡住越界时间戳，不让 toISOString 抛错", () => {
  const now = 1795000000000;
  assert.equal(safeIsoTime(1e16, now), new Date(now).toISOString());
  assert.equal(safeIsoTime(-1e16, now), new Date(now).toISOString());
  assert.equal(safeIsoTime(8.64e15 * 2, now), new Date(now).toISOString());
  assert.equal(safeIsoTime(Infinity, now), new Date(now).toISOString());
  assert.equal(safeIsoTime(NaN, now), new Date(now).toISOString());
  assert.equal(safeIsoTime("abc", now), new Date(now).toISOString());
  assert.equal(safeIsoTime(null, now), new Date(now).toISOString());
  assert.equal(safeIsoTime(1795000000000, now), new Date(1795000000000).toISOString());
});

test("buildMailBody 遇到越界 ts 不抛错", () => {
  assert.doesNotThrow(() => buildMailBody({ text: "hi", ts: 1e16 }));
  assert.match(buildMailBody({ text: "hi", ts: 1e16 }), /时间：/);
});

test("textTooLong 用字节数而不是字符数判断——中文一个字符 3 字节", () => {
  assert.equal(textTooLong("中".repeat(1000)), false);
  assert.equal(textTooLong("a".repeat(MAX_BODY_BYTES)), false);
  assert.equal(textTooLong("a".repeat(MAX_BODY_BYTES + 1)), true);
});
