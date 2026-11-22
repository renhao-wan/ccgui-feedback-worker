# ccgui-feedback-worker

CC GUI 插件的反馈中转。插件设置页里填的文字经这里转发到邮箱。

插件源码完全公开，**任何邮件凭据都不能写在插件里**——写进去等于公开。
所以凭据只存在这个 Worker 的 secret 里，插件只知道一个公开端点。

这份代码也公开，是为了让「只转发五个字段、不存明文 IP」这些承诺**可以被独立核对**，
而不是只能听我说。想给别的项目复用，直接照抄 `wrangler.toml` 和下面的部署步骤即可。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/quota` | 返回 `{ remaining, dailyLimit, resetAt }`，设置页打开时查一次 |
| `POST` | `/feedback` | `{ text, pluginId, pluginVersion, hostVersion, ts }` → `{ ok, remaining }` |

失败时：`429 { error: "rate_limited", kind, resetAt }`（额度用完）、
`400`（正文为空 / 插件不在白名单）、`413 { error: "too_large" }`（请求体超 16KB）、
`502 { error: "smtp_failed" }`（发信失败，额度已退回）、
`503 { error: "storage_unavailable" }`（KV 不可用）。
所有失败都是 JSON；顶层 catch 兜底，不会漏出 HTML 500 页（插件只认 JSON，HTML 会被判成「被拦截」）。

被接受的 `pluginId`：`github-trending`、`worklog`、`slash-palette`、`cli-install-audit`。
新增插件时改 `src/index.mjs` 的 `ALLOWED_PLUGINS`。

## 额度

**每 IP 每天 30 条，四个插件共享同一个池**——限流键是 `IP 哈希 + UTC 日期`，
刻意不含插件名，否则换个插件就能再拿一份额度。

另加 **10 分钟 3 条** 的突发保护，防止脚本刷屏。两个计数存在同一个 KV 值里，
值带 2 天 TTL——额度按 UTC 日切分，跨日之后旧键就永远读不到了。

> 额度是自设的，不是 Cloudflare 的配额。Workers 免费额度是 10 万请求/天，
> 对反馈量来说等于无限——拿它当卖点对用户没有意义。真正会先撞的有两处：
>
> - **每次请求 10ms 的 CPU 上限**：所以请求体超过 16KB 直接 413，不先 parse
>   再跑正则（几十 MB 的正则遍历能把这 10ms 打爆，返回 HTML 1102）。
> - **KV 免费额度每天 1000 次写**：一次 `/feedback` 至少一次写（发信失败还要
>   再写一次退款）。也就是说极端情况下全站每天最多约 1000 条反馈。这是
>   兜底上限，不是设计目标；真要放开得换 Durable Object。

**并发不是严格的**：KV 没有 compare-and-swap，两个请求同时读到 `used=0`
会各记一条。这里的计数是「降低重放」，不是「消除」。要严格得换 Durable Object。

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

**没设 `IP_SALT` 也能跑**，但盐为空时同一个 IP 的额度键在不同部署之间通用，
少了「换部署就换一份对照表」这层保护。上线请务必设。

部署完会得到一个 `https://ccgui-feedback.<你的账号>.workers.dev`。

部署后可以自测：

```bash
curl "https://ccgui-feedback.<你的账号>.workers.dev/quota"
# {"remaining":30,"dailyLimit":30,"resetAt":...}
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

覆盖：UTC 切日、额度键不含插件名、日额度 / 突发两条拒绝路径、窗口过期、
正文收敛与限长、请求体字节上限、邮件主题防头注入、越界时间戳降级、
加盐假名化（换盐必须换键）。

Worker 的路由与 KV 读写由集成测试之外的手工冒烟覆盖（`curl /quota`、
连发 4 条看 429 的 `kind: "burst"`）。
