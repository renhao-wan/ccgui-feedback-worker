# ccgui-feedback-worker

CC GUI 插件的反馈中转。插件设置页里填的文字经这里转发到邮箱。

插件源码完全公开，**任何邮件凭据都不能写在插件里**——写进去等于公开。
所以凭据只存在这个 Worker 的 secret 里，插件只知道一个公开端点。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/quota` | 返回 `{ remaining, dailyLimit, resetAt }`，设置页打开时查一次 |
| `POST` | `/feedback` | `{ text, pluginId, pluginVersion, hostVersion, ts }` → `{ ok, remaining }` |

失败时：`429 { error: "rate_limited", kind, resetAt }`（额度用完）、
`400`（正文为空 / 插件不在白名单）、`502 { error: "smtp_failed" }`（发信失败，额度已退回）。

被接受的 `pluginId`：`github-trending`、`worklog`、`slash-palette`、`cli-install-audit`。
新增插件时改 `src/index.mjs` 的 `ALLOWED_PLUGINS`。

## 额度

**每 IP 每天 30 条，四个插件共享同一个池**——限流键是 `IP 哈希 + UTC 日期`，
刻意不含插件名，否则换个插件就能再拿一份额度。

另加 **10 分钟 3 条** 的突发保护，防止脚本刷屏。两个计数存在同一个 KV 值里。

> 额度是自设的，不是 Cloudflare 的配额。Workers 免费额度是 10 万请求/天，
> 对反馈量来说等于无限——拿它当卖点对用户没有意义。真正会先撞的是
> **每次请求 10ms 的 CPU 上限**，所以发信失败要让用户明确看到，而不是静默超时。

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

# 3) 部署
npx wrangler deploy
```

部署完会得到一个 `https://ccgui-feedback.<你的账号>.workers.dev`。

### 端点变了要同步改两处

插件侧写死了主机名，因为 `network:` 授权是**精确匹配**、不支持通配：

1. `ccgui-plugin-*/src/main.head.js` 的 `FEEDBACK_ENDPOINT`
2. `ccgui-plugin-*/manifest.json` 的 `network:<host>` 权限

两处不一致时，请求会在 JS 侧直接被拒（`network:` 授权未命中），
不会打到 Worker。

## QQ 邮箱注意事项

- 授权码不是登录密码：QQ 邮箱 → 设置 → 账户 → POP3/IMAP/SMTP → 开启服务后生成。
- 端口用 **465**（隐式 TLS）。Workers **禁止出站 25 端口**，但 465/587 可行。
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
```

`wrangler dev` 下 `cf-connecting-ip` 可能缺失，`clientIp` 会回落到 `"local"`，
所有本地请求共享一份额度——本地开发时更容易撞到限流，属正常。

## 隐私边界

Worker 只接收、只转发五个字段：正文、插件 id、插件版本、CC GUI 版本、时间戳。
不记录 IP（只存不可逆哈希用于限流）。日志开了 `observability`，但代码里没有
`console.log` 打印请求体。

## 测试

```bash
npm test
```

覆盖：UTC 切日、额度键不含插件名、日额度 / 突发两条拒绝路径、窗口过期、
正文收敛与限长、邮件主题防头注入。
