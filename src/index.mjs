/**
 * CC GUI 插件反馈中转（Cloudflare Worker）。
 *
 * 路由：
 *   POST /feedback  { text, pluginId, pluginVersion, hostVersion, ts }
 *   GET  /quota?pluginId=<id>  → { remaining, dailyLimit, resetAt, fallbackRemaining }
 *
 * 为什么需要这一层：插件源码完全公开，任何邮件凭据写进去都等于公开。
 * 凭据只存在 Worker 的 secret 里，插件只知道这个公开端点。
 *
 * 额度（2026-11-23 改版）：**每 IP × 每插件，滚动 48 小时 1 条**；另加
 * 一个**每 IP 每天 3 条的兜底池**，跨插件共享，只在该插件冷却命中时才动用。
 * 详见 ratelimit.mjs 的头注释。
 */

import { WorkerMailer } from "worker-mailer";
import {
  FALLBACK_DAILY_LIMIT,
  MAX_BODY_BYTES,
  utcDay,
  clientKey,
  cooldownKey,
  fallbackKey,
  decideCooldown,
  decideFallback,
  quotaView,
  nextResetAt,
  normaliseClientText,
  textTooLong,
  buildMailSubject,
  buildMailBody,
} from "./ratelimit.mjs";

const ALLOWED_PLUGINS = new Set([
  "github-trending",
  "worklog",
  "slash-palette",
  "cli-install-audit",
]);

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
  });
}

/**
 * 取客户端 IP。CF 在 cf-connecting-ip 里给，且会覆盖客户端自带的同名头。
 *
 * **不回落到 x-forwarded-for**：那是客户端可控的。只有在
 * cf-connecting-ip 缺失（service binding / 本地 dev）时才走到这里，
 * 统一归到固定桶，比让人伪造 IP 换额度安全。
 */
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

/**
 * KV 键的存活时间。冷却键要活过 48 小时窗口（给一天余量）；兜底池键按
 * UTC 日切分，两天余量即可。
 */
const COOLDOWN_TTL_SECONDS = 3 * 24 * 60 * 60;
const FALLBACK_TTL_SECONDS = 2 * 24 * 60 * 60;

/** 兜底池状态：日计数 + 突发窗口，一次 get / 一次 put。 */
async function readFallback(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return { used: 0, burst: [] };
  try {
    const v = JSON.parse(raw);
    // used 必须收敛到非负整数：脏数据会直接进 remaining 的计算，
    // 出现「-5」「9」这种越界结果，比直接当 0 更糟。
    const used = Math.max(0, Math.floor(Number(v.used) || 0));
    return { used, burst: Array.isArray(v.burst) ? v.burst : [] };
  } catch {
    return { used: 0, burst: [] };
  }
}

async function writeFallback(kv, key, state) {
  await kv.put(key, JSON.stringify({ used: state.used, burst: state.burst.slice(-20) }), {
    expirationTtl: FALLBACK_TTL_SECONDS,
  });
}

/** 冷却状态只存一个上次发送时刻，读不到/脏数据都当作「从未发过」。 */
async function readCooldown(kv, key) {
  try {
    const raw = await kv.get(key);
    if (!raw) return 0;
    const v = JSON.parse(raw);
    const t = Number(v && v.last);
    return Number.isFinite(t) && t > 0 ? t : 0;
  } catch {
    return 0;
  }
}

async function writeCooldown(kv, key, last) {
  await kv.put(key, JSON.stringify({ last }), { expirationTtl: COOLDOWN_TTL_SECONDS });
}

/** 按端口决定 TLS 形态：465 是隐式 TLS，587 必须走 STARTTLS（secure:false）。 */
function smtpPort(env) {
  return Number(env.SMTP_PORT || 465);
}

async function sendMail(env, subject, text) {
  const port = smtpPort(env);
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST || "smtp.qq.com",
      port,
      // 587 用 STARTTLS：secure:true 会直接做隐式 TLS，跟 587 握手必失败。
      secure: port === 465,
      credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
      authType: ["plain", "login"],
      socketTimeoutMs: 8000,
      logLevel: 0,
    },
    {
      from: env.SMTP_USER,
      to: env.MAIL_TO,
      subject,
      text,
    },
  );
}

/** KV 不可用时统一回 503，别让异常冒到 fetch 变成 HTML 500。 */
function storageFailure() {
  return json(503, { ok: false, error: "storage_unavailable" });
}

async function handleQuota(env, request) {
  const url = new URL(request.url);
  const pluginId = String(url.searchParams.get("pluginId") || "");
  // 老版本插件不带 pluginId。回一个乐观值（本插件「现在能发」），不阻断它们。
  if (!ALLOWED_PLUGINS.has(pluginId)) {
    return json(
      200,
      { remaining: 1, dailyLimit: 1, resetAt: nextResetAt(Date.now()), fallbackRemaining: FALLBACK_DAILY_LIMIT },
      { "cache-control": "public, max-age=10" },
    );
  }
  const now = Date.now();
  let cooldownLast;
  let fallback;
  try {
    const ipKey = clientKey(clientIp(request), env.IP_SALT);
    cooldownLast = await readCooldown(env.FEEDBACK_KV, cooldownKey(ipKey, pluginId));
    fallback = await readFallback(env.FEEDBACK_KV, fallbackKey(ipKey, utcDay(now)));
  } catch {
    return storageFailure();
  }
  return json(200, quotaView({ cooldownLast, fallback, now }), {
    // 额度 10 秒内不会变太多；给边缘缓存，挡住脚本循环刷 /quota 烧 KV 读额度。
    "cache-control": "public, max-age=10",
  });
}

async function handleFeedback(env, request) {
  // 先看 Content-Length，超了直接拒，不把几十 MB 读进内存。
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "too_large" });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  // 没给 Content-Length 时也要兜底：对原始正文先粗判，再走正则收敛。
  if (textTooLong(payload && payload.text)) {
    return json(413, { ok: false, error: "too_large" });
  }

  const text = normaliseClientText(payload && payload.text);
  if (!text) return json(400, { ok: false, error: "empty_text" });

  const pluginId = String((payload && payload.pluginId) || "");
  if (!ALLOWED_PLUGINS.has(pluginId)) {
    return json(400, { ok: false, error: "unknown_plugin" });
  }

  const ipKey = clientKey(clientIp(request), env.IP_SALT);
  const day = utcDay(Date.now());
  const cdKey = cooldownKey(ipKey, pluginId);
  const fbKey = fallbackKey(ipKey, day);

  let cooldownLast;
  let fallback;
  try {
    cooldownLast = await readCooldown(env.FEEDBACK_KV, cdKey);
    fallback = await readFallback(env.FEEDBACK_KV, fbKey);
  } catch {
    return storageFailure();
  }

  const now = Date.now();
  const cd = decideCooldown(cooldownLast, now);
  // 常规路径：本插件的 48 小时冷却已过，直接放行，不动兜底池。
  // 兜底路径：冷却命中，动用跨插件共享的每日 3 条。
  let verdict;
  let nextFallback = fallback;
  if (cd.available) {
    verdict = { allowed: true, kind: "ok" };
  } else {
    verdict = decideFallback(fallback, now);
    if (verdict.allowed) nextFallback = { used: fallback.used + 1, burst: [...verdict.burst, now] };
  }

  if (!verdict.allowed) {
    return json(429, {
      ok: false,
      error: "rate_limited",
      // burst = 兜底池的 10 分钟窗口撞了（本插件仍在 48h 冷却里）；
      // cooldown = 本插件冷却中且兜底池也空了。
      kind: verdict.kind === "burst" ? "burst" : "cooldown",
      remaining: 0,
      resetAt: cd.available ? nextResetAt(now) : cd.retryAt,
      fallbackRemaining: verdict.kind === "burst" ? verdict.remaining : 0,
    });
  }

  // 先记额度再发信：SMTP 慢（TLS 握手通常 1-3 秒），先记可以缩小
  // 「连点十下、每下都绕过限流」的窗口。
  //
  // 注意：KV 没有 compare-and-swap，跨实例的并发仍可能漏计。这步是
  // **降低**重放，不是消除；要严格得上 Durable Object。
  try {
    if (cd.available) {
      await writeCooldown(env.FEEDBACK_KV, cdKey, now);
    } else {
      await writeFallback(env.FEEDBACK_KV, fbKey, nextFallback);
    }
  } catch {
    return storageFailure();
  }

  try {
    await sendMail(
      env,
      buildMailSubject({ pluginId, text }),
      buildMailBody({
        text,
        pluginId,
        pluginVersion: String((payload && payload.pluginVersion) || ""),
        hostVersion: String((payload && payload.hostVersion) || ""),
        ts: Number(payload && payload.ts) || now,
      }),
    );
  } catch (error) {
    // 发信失败要把额度退回去，否则用户白白丢掉一次机会。
    // 退款自身失败不能让 catch 再抛（那会变成 HTML 500），吞掉并照常回 502。
    try {
      if (cd.available) {
        // 常规路径：冷却恢复成发送前的值（通常是 0 = 从未发过）。
        await writeCooldown(env.FEEDBACK_KV, cdKey, cooldownLast);
      } else {
        await writeFallback(env.FEEDBACK_KV, fbKey, fallback);
      }
    } catch {
      /* 退款失败：额度会少一条，但至少接口还能回 JSON */
    }
    const after = quotaView({ cooldownLast, fallback, now });
    return json(502, { ok: false, error: "smtp_failed", ...after });
  }

  // 发送成功后统一用配额视图回话：常规路径下本插件进入 48h 冷却，remaining=0。
  const after = quotaView({
    cooldownLast: cd.available ? now : cooldownLast,
    fallback: nextFallback,
    now,
  });
  return json(200, { ok: true, ...after });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/quota") {
        return await handleQuota(env, request);
      }
      if (request.method === "POST" && url.pathname === "/feedback") {
        return await handleFeedback(env, request);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      return json(404, { ok: false, error: "not_found" });
    } catch {
      // 兜底：任何没预料到的异常都回 JSON，别让宿主侧拿到 HTML 500 页。
      // 插件只认 JSON，HTML 会被当成「无法识别的内容」。
      return json(500, { ok: false, error: "internal_error" });
    }
  },
};
