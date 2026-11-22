/**
 * CC GUI 插件反馈中转（Cloudflare Worker）。
 *
 * 路由：
 *   POST /feedback  { text, pluginId, pluginVersion, hostVersion, ts }
 *   GET  /quota     → { remaining, dailyLimit, resetAt }
 *
 * 为什么需要这一层：插件源码完全公开，任何邮件凭据写进去都等于公开。
 * 凭据只存在 Worker 的 secret 里，插件只知道这个公开端点。
 *
 * 额度：每 IP 每天 30 条，**四个插件共享同一个池**（键不含插件名）。
 * 另加 10 分钟 3 条的突发保护。捆在同一份 KV 值里，一次读写搞定。
 */

import { WorkerMailer } from "worker-mailer";
import {
  DAILY_LIMIT,
  utcDay,
  clientKey,
  decideLimit,
  nextResetAt,
  normaliseClientText,
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

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** 取客户端 IP。CF 在 cf-connecting-ip 里给；本地 wrangler dev 可能没有。 */
function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "local"
  );
}

/** 同一个 KV 键同时存日计数与突发窗口，一次 get / 一次 put。 */
async function readState(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return { used: 0, burst: [] };
  try {
    const v = JSON.parse(raw);
    return { used: Number(v.used) || 0, burst: Array.isArray(v.burst) ? v.burst : [] };
  } catch {
    return { used: 0, burst: [] };
  }
}

async function writeState(kv, key, state) {
  await kv.put(key, JSON.stringify({ used: state.used, burst: state.burst.slice(-20) }));
}

async function sendMail(env, subject, text) {
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST || "smtp.qq.com",
      port: Number(env.SMTP_PORT || 465),
      secure: true,
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

async function handleQuota(env, request) {
  const key = clientKey(clientIp(request));
  const day = utcDay(Date.now());
  const state = await readState(env.FEEDBACK_KV, "rl:" + key + ":" + day);
  const remaining = Math.max(0, DAILY_LIMIT - state.used);
  return json(200, { remaining, dailyLimit: DAILY_LIMIT, resetAt: nextResetAt(Date.now()) });
}

async function handleFeedback(env, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const text = normaliseClientText(payload && payload.text);
  if (!text) return json(400, { ok: false, error: "empty_text" });

  const pluginId = String((payload && payload.pluginId) || "");
  if (!ALLOWED_PLUGINS.has(pluginId)) {
    return json(400, { ok: false, error: "unknown_plugin" });
  }

  const key = clientKey(clientIp(request));
  const day = utcDay(Date.now());
  const kvKey = "rl:" + key + ":" + day;
  const now = Date.now();
  const state = await readState(env.FEEDBACK_KV, kvKey);
  const verdict = decideLimit(state, now);

  if (!verdict.allowed) {
    return json(429, {
      ok: false,
      error: "rate_limited",
      kind: verdict.kind,
      remaining: 0,
      resetAt: nextResetAt(now),
    });
  }

  // 先记额度再发信：SMTP 慢（TLS 握手通常 1-3 秒），先记可以挡住
  // 「连点十下、每下都绕过限流」的并发窗口。
  const nextState = { used: state.used + 1, burst: [...verdict.burst, now] };
  await writeState(env.FEEDBACK_KV, kvKey, nextState);

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
    await writeState(env.FEEDBACK_KV, kvKey, { used: state.used, burst: verdict.burst });
    return json(502, { ok: false, error: "smtp_failed", remaining: DAILY_LIMIT - state.used });
  }

  return json(200, { ok: true, remaining: Math.max(0, DAILY_LIMIT - nextState.used) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/quota") {
      return handleQuota(env, request);
    }
    if (request.method === "POST" && url.pathname === "/feedback") {
      return handleFeedback(env, request);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }
    return json(404, { ok: false, error: "not_found" });
  },
};
