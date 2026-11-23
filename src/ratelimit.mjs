/**
 * 限流与邮件正文的纯函数。不碰 KV、不碰网络，方便直接单测。
 *
 * 额度口径（2026-11-23 改版）：**每 IP × 每插件，滚动 48 小时内 1 条**；
 * 另有一个**每 IP 每天 3 条的兜底池**，跨四个插件共享，只在某插件冷却
 * 命中时才动用。
 *
 * 为什么有两层：
 *   - 插件零凭据、不收集设备指纹，Worker 唯一可信的身份是 IP。「每用户」
 *     只能退化成「每 IP」，共享出口（公司 / 校园 / CGNAT）会误伤。
 *   - 冷却键**带插件名**（每个插件独立 1 条），兜底池键**不带插件名**
 *     （换插件刷也吃同一份）。「防跨插件刷」的职责由兜底池承担，不再靠
 *     「共享一个大池」。
 *
 * 已知后果：单人 48 小时内最多 4 条（常规 1 + 兜底 3）。这是兜底池的
 * 刻意代价，不是漏算。
 */

/** 同一 IP、同一插件的冷却窗口：滚动 48 小时。 */
export const COOLDOWN_MS = 48 * 60 * 60 * 1000;
/** 兜底池日额度：每 IP 每天，跨插件共享。 */
export const FALLBACK_DAILY_LIMIT = 3;
/**
 * 兜底路径的突发保护：10 分钟内最多 2 条。
 * 必须**严格小于** FALLBACK_DAILY_LIMIT——相等的话第三条永远先撞日额度，
 * 突发保护就死了。兜底池本身只有 3 条/天，收紧到 2 条才拦得住连点。
 */
export const BURST_LIMIT = 2;
export const BURST_WINDOW_MS = 10 * 60 * 1000;
export const TEXT_LIMIT = 1000;
/**
 * 请求体字节上限。正常反馈 1000 字中文约 3KB，加上 JSON 开销远远不到这里。
 * 超过就别 parse 了：`normaliseClientText` 会对整个字符串跑正则，
 * 几十 MB 的 body 会直接把 Workers 的 10ms CPU 打爆，返回 HTML 1102 页。
 */
export const MAX_BODY_BYTES = 16 * 1024;

const encoder = new TextEncoder();

/** 字符串的 UTF-8 字节数。Workers 没有 Buffer，统一用 TextEncoder。 */
function byteLength(s) {
  return encoder.encode(s).length;
}

/**
 * 这段文本是否超过请求体上限。
 * 按**字节**判断而不是字符：1000 个中文是 3000 字节，1000 个 emoji 更多。
 */
export function textTooLong(text) {
  return byteLength(String(text === undefined || text === null ? "" : text)) > MAX_BODY_BYTES;
}

/** UTC 日期串，作为日额度键的一部分。按 UTC 切日，避免时区边界摇摆。 */
export function utcDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** 额度重置时刻：次日 UTC 零点。前端用它写「明天再来」。 */
export function nextResetAt(now) {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * 每 IP 的额度键：加盐 FNV-1a 变体的前 16 位十六进制。
 *
 * 注意措辞：这是**加盐假名化**，不是「不可逆哈希」。IPv4 只有 2^32 个地址，
 * 拿一张「哈希→IP」对照表就能全量反查；加盐只是让这张表不能预先算好、
 * 换部署就不通用。真正的隐私保证来自「不落明文、不进日志」。
 *
 * @param {unknown} ip
 * @param {string} salt 部署级密钥（`wrangler secret put IP_SALT`）
 */
export function clientKey(ip, salt) {
  const raw = String(salt === undefined || salt === null ? "" : salt) + "|" + String(ip === undefined || ip === null ? "" : ip);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(c + i, 0x85ebca6b)) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

/** 冷却键：每 IP × 每插件各一个，存上次发送时刻。带插件名，便于排查。 */
export function cooldownKey(ipKey, pluginId) {
  return "rl:cd:" + String(ipKey) + ":" + String(pluginId);
}

/** 兜底池键：每 IP × 每 UTC 日一个，**不带插件名**（跨插件共享）。 */
export function fallbackKey(ipKey, day) {
  return "rl:fb:" + String(ipKey) + ":" + String(day);
}

/**
 * 这个插件的 48 小时冷却过了没有。
 *
 * @param {unknown} last 上次发送时刻（毫秒）；0/脏值视为从未发过
 * @param {number} now
 * @returns {{available: boolean, retryAt: number}}
 *   `retryAt` 只在冷却中时有意义（= last + 48h）。
 */
export function decideCooldown(last, now) {
  const t = Number(last);
  // 脏数据当作「没发过」：宁可多放一条，也不要把正常用户永久卡在冷却里。
  if (!Number.isFinite(t) || t <= 0) return { available: true, retryAt: 0 };
  const retryAt = t + COOLDOWN_MS;
  return { available: now >= retryAt, retryAt };
}

/**
 * 兜底池判定。结构沿用原 decideLimit 的 {used, burst}，只是额度从 30 收成 3。
 *
 * @param {{used: number, burst: number[]}} state
 * @param {number} now
 * @returns {{allowed: boolean, kind: string, remaining: number, burst: number[]}}
 */
export function decideFallback(state, now) {
  const used = Math.max(0, Number(state && state.used) || 0);
  const burst = Array.isArray(state && state.burst) ? state.burst.filter((t) => Number.isFinite(t)) : [];
  const recent = burst.filter((t) => now - t < BURST_WINDOW_MS);

  if (used >= FALLBACK_DAILY_LIMIT) {
    return { allowed: false, kind: "fallback", remaining: 0, burst: recent };
  }
  if (recent.length >= BURST_LIMIT) {
    // 突发被拒时兜底池其实还有剩，回落真实值——写 0 会让界面谎报「用完了」。
    return { allowed: false, kind: "burst", remaining: FALLBACK_DAILY_LIMIT - used, burst: recent };
  }
  return { allowed: true, kind: "ok", remaining: FALLBACK_DAILY_LIMIT - used - 1, burst: recent };
}

/**
 * `/quota` 的视图：本插件还能不能发（0/1），兜底池还剩几条，几时解冻。
 *
 * @param {{cooldownLast: unknown, fallback: {used: number}|null, now: number}} o
 * @returns {{remaining: number, dailyLimit: number, resetAt: number, fallbackRemaining: number}}
 */
export function quotaView(o) {
  const now = Number(o && o.now) || 0;
  const cd = decideCooldown(o && o.cooldownLast, now);
  const used = Math.max(0, Number(o && o.fallback && o.fallback.used) || 0);
  return {
    remaining: cd.available ? 1 : 0,
    dailyLimit: 1,
    // 解冻时刻用重试时刻；没在冷却时回次日零点，与旧字段语义保持一致。
    resetAt: cd.available ? nextResetAt(now) : cd.retryAt,
    fallbackRemaining: Math.max(0, FALLBACK_DAILY_LIMIT - used),
  };
}

/**
 * 正文收敛：控制字符折叠、合并空白、限长。
 * 这层必须做——邮件正文最终会进 SMTP payload，头注入类的字符不能穿过去。
 */
export function normaliseClientText(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f�]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_LIMIT)
    .trim();
}

/** 邮件主题带插件名，方便在收件箱里按插件分。去掉换行，防止头注入。 */
export function buildMailSubject(o) {
  const plugin = String((o && o.pluginId) || "unknown").replace(/[\r\n]+/g, " ").slice(0, 60);
  return ("[CC GUI 反馈] " + plugin + " · " + normaliseClientText(o && o.text).slice(0, 40)).slice(0, 120);
}

/**
 * 把客户端给的时间戳转成 ISO 字符串，越界时回落到服务端时间。
 *
 * `ts` 完全由客户端控制。`|ts| > 8.64e15`（或 Infinity/NaN）会让
 * `new Date(ts).toISOString()` 抛 RangeError，被上层当成发信失败，
 * 用户于是「重试必然失败」却以为是网络问题。
 */
export function safeIsoTime(ts, fallback) {
  // null/undefined/空串 = 「没给」，用服务端时间。不能靠 Number() 转：
  // Number(null) === 0、Number("") === 0，都会变成 1970。
  const missing = ts === undefined || ts === null || ts === "";
  const n = Number(ts);
  const valid = !missing && Number.isFinite(n) && Math.abs(n) <= 8640000000000000;
  return new Date(valid ? n : fallback).toISOString();
}

/** 邮件正文：原文 + 一段版本信息，便于复现。 */
export function buildMailBody(o) {
  const text = normaliseClientText(o && o.text);
  const ts = Number(o && o.ts) || Date.now();
  return [
    text,
    "",
    "------------------------------",
    "插件：" + String((o && o.pluginId) || ""),
    "插件版本：" + String((o && o.pluginVersion) || ""),
    "CC GUI：" + String((o && o.hostVersion) || ""),
    "时间：" + safeIsoTime(ts, Date.now()),
  ].join("\n");
}
