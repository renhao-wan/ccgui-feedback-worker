# ccgui-feedback-worker

CC GUI 插件的反馈中转。插件设置页里填的文字经这里转发到邮箱。

插件源码完全公开，**任何邮件凭据都不能写在插件里**——写进去等于公开。
所以凭据只存在这个 Worker 的 secret 里，插件只知道一个公开端点。

这份代码也公开，是为了让「只转发五个字段、不存明文 IP」这些承诺**可以被独立核对**，
而不是只能听我说。想给别的项目复用，直接照抄 `wrangler.toml` 和下面的部署步骤即可。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/quota?pluginId=<id>` | 返回 `{ remaining, dailyLimit, resetAt, fallbackRemaining }`，设置页打开时查一次 |
| `POST` | `/feedback` | `{ text, pluginId, pluginVersion, hostVersion, ts }` → `{ ok, remaining, fallbackRemaining }` |

失败时：`429 { error: "rate_limited", kind, resetAt }`（`kind: "cooldown"` 本插件 48h 冷却 + 兜底也用完；
`kind: "burst"` 兜底池突发窗口撞了、本插件仍在冷却）、
`400`（正文为空 / 插件不在白名单）、`413 { error: "too_large" }`（请求体超 16KB）、
`502 { error: "smtp_failed" }`（发信失败，额度已退回）、
`503 { error: "storage_unavailable" }`（KV 不可用）。
所有失败都是 JSON；顶层 catch 兜底，不会漏出 HTML 500 页（插件只认 JSON，HTML 会被判成「被拦截」）。

被接受的 `pluginId`：`github-trending`、`worklog`、`slash-palette`、`cli-install-audit`。
新增插件时改 `src/index.mjs` 的 `ALLOWED_PLUGINS`。

## 额度

**每 IP × 每插件，滚动 48 小时 1 条**。冷却键是 `IP 哈希 + 插件 id`，**含插件名**：
四个插件各自独立计时，一个插件发过不影响另一个。

另有一个**每 IP 每天 3 条的共享兜底池**，键是 `IP 哈希 + UTC 日期`，**不含插件名**——
跨插件共用，只在本插件冷却命中时才动用。它存在的理由：插件零凭据、不收集设备指纹，
Worker 唯一可信身份是 IP，「每用户」只能退化成「每 IP」。公司 / 校园 / CGNAT 这类
共享出口里，一个人发过会把整栋楼卡在 48 小时冷却里，兜底池就是放过这些正常用户的口子。
因为它是全 IP 共享的，「换个插件接着刷」也吃同一份，防跨插件刷的职责从「共享大池」挪到了这里。

兜底路径另有 **10 分钟 2 条** 的突发保护（必须严格小于每天 3 条，否则第三条永远先撞日额度，
突发保护形同虚设）。冷却键 TTL 3 天，兜底键 TTL 2 天。

> 已知后果：单人 48 小时内最多 4 条（常规 1 + 兜底 3）。这是兜底池的刻意代价。

> 额度是自设的，不是 Cloudflare 的配额。Workers 免费额度是 10 万请求/天，
> 对反馈量来说等于无限——拿它当卖点对用户没有意义。真正会先撞的有两处：
>
> - **每次请求 10ms 的 CPU 上限**：所以请求体超过 16KB 直接 413，不先 parse
>   再跑正则（几十 MB 的正则遍历能把这 10ms 打爆，返回 HTML 1102）。
> - **KV 免费额度每天 1000 次写**：一次 `/feedback` 至少一次写（发信失败还要
>   再写一次退款）。也就是说极端情况下全站每天最多约 1000 条反馈。这是
>   兜底上限，不是设计目标；真要放开得换 Durable Object。

**并发不是严格的**：KV 没有 compare-and-swap，两个请求同时读到旧值会各记一条。
这里的计数是「降低重放」，不是「消除」。要严格得换 Durable Object。

## 部署

```bash
cd ccgui-feedback-worker
npm install

# 1) 建 KV namespace，把返回的 id 填进 wrangler.toml
npx wrangler kv namespace create FEEDBACK_KV

# 2) 设置凭据（QQ 邮箱 → 设置 → 账户 → 开启 SMTP 服务后拿到的授权码）
npx wrangler secret put SMTP_USER   # 你的 QQ 邮箱地址，如 123456@qq.com
npx wrangler secret put SMTP_PASS   # SMTP 授权码，不是 QQ 登录密码
npx wrangler secret put MAIL_TO     # 收件邮箱（可以和 SMTP_USER 相同）
npx wrangler secret put IP_SALT     # 任意长随机串；换掉等于给所有 IP 重发一份额度

# 3) 部署
npx wrangler deploy
```

**没设 `IP_SALT` 也能跑**，只是 `clientKey` 退化成无盐哈希。差别在一件事上：
盐的用途是让「哈希 → IP」对照表**没法预先算好**。不设的话，一旦 KV 数据离开
你的控制（导出备份、后台排查截图、迁移账号），而算法又是公开的，那么全部
2³² 个 IPv4 枚举一遍只要**约半小时**，一小时左右就能建出完整对照表。

注意只影响 IPv4 用户：IPv6 的空间是 2¹²⁸，枚举不成立。

换盐的副作用：额度键与冷却键都变了，**当天所有人的额度重置一次**。一次性，第二天自然恢复。

部署完会得到一个 `https://ccgui-feedback.<你的账号>.workers.dev`。

部署后可以自测：

```bash
curl "https://ccgui-feedback.<你的账号>.workers.dev/quota?pluginId=github-trending"
# {"remaining":1,"dailyLimit":1,"resetAt":...,"fallbackRemaining":3}
```

### 端点变了要同步改两处

插件侧写死了主机名，因为 `network:` 授权是**精确匹配**、不支持通配：

1. `ccgui-plugin-*/src/main.head.js` 的 `FEEDBACK_ENDPOINT`
2. `ccgui-plugin-*/manifest.json` 的 `network:<host>` 权限

两处不一致时，请求会在 JS 侧直接被拒（`network:` 授权未命中），
不会打到 Worker。

## QQ 邮箱注意事项

- 授权码不是登录密码：QQ 邮箱 → 设置 → 账户 → POP3/IMAP/SMTP → 开启服务后生成。
- 端口默认 **465**（隐式 TLS）。Workers **禁止出站 25 端口**，但 465/587 可行。
  代码按端口自动选 TLS 形态：465 走隐式 TLS，其他端口走 STARTTLS
  （587 用隐式 TLS 必握手失败）。改端口只需设 `SMTP_PORT`，不用改代码。
- 若出现 `550` / `553` 退信，多是自己给自己发被风控，把 `MAIL_TO` 换成另一个邮箱试试。

## 本地开发

```bash
npx wrangler dev          # 本地起一份，secret 从 .dev.vars 读
node --test test/         # 限流与正文收敛的单测
```

`.dev.vars`（不要提交）：

```
SMTP_USER=123456@qq.com
SMTP_PASS=你的授权码
MAIL_TO=123456@qq.com
IP_SALT=local-dev-only
```

`wrangler dev` 下 `cf-connecting-ip` 可能缺失，`clientIp` 会回落到 `"unknown"`，
所有本地请求共享一份额度——本地开发时更容易撞到限流，属正常。
`x-forwarded-for` **不采信**：那是客户端可控的，采信它等于允许伪造 IP 换额度。

## 隐私边界

Worker 只接收、只转发五个字段：正文、插件 id、插件版本、CC GUI 版本、时间戳。
不保存正文、不落明文 IP：用于限流的键是**加盐 FNV-1a 的 16 位十六进制**。

措辞要准确：这是**加盐假名化**，不是「不可逆哈希」。IPv4 只有 2^32 个地址，
拿一张「哈希→IP」对照表就能全量反查；盐只是让这张表不能预先算好。真正的
隐私保证来自「不落明文、不进日志」。

`observability` 是开着的。代码里没有 `console.log` 打印请求体，但 Cloudflare
的请求日志**默认会记录 URL 和状态码**（不含 body）。介意的话可以在
`wrangler.toml` 里关掉 `[observability]`。

## 测试

```bash
npm test
```

覆盖：UTC 切日、冷却键含插件名 / 兜底键不含插件名、48 小时边界、兜底池日额度与突发两条拒绝路径、
窗口过期、正文收敛与限长、请求体字节上限、邮件主题防头注入、越界时间戳降级、
加盐假名化（换盐必须换键）。

Worker 的路由与 KV 读写由集成测试之外的手工冒烟覆盖（`curl /quota?pluginId=...`、
同一插件连发两条看 429 的 `kind: "cooldown"`、冷却中换插件看兜底池放行）。
