# iLinker

基于微信 iLink 协议的自部署通知网关。支持管理员登录、多机器人连接、按机器人组织的聊天界面，以及路径 Token 认证的通知 WebHook。

## 本地运行

需要 Node.js **22.13 或以上版本**（使用内置 `node:sqlite`，推荐 Node.js 24 LTS）和 npm。

```powershell
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>，首次访问创建管理员账号。没有默认账号或默认密码。

生产模式：

```powershell
npm run build
npm start
```

打开 <http://127.0.0.1:3000>。生产服务同时提供前端静态资源和后端 API。

局域网访问时，可在 `.env` 中将 `HOST` 设置为本机的局域网 IP，例如 `HOST=192.168.0.10`，重启后使用
`http://192.168.0.10:3000` 访问。该 IP 必须属于本机；绑定指定 IP 后，不再通过 `127.0.0.1:3000` 提供访问。
开发模式的 API 代理会读取同一份 HOST、PORT 配置。Windows 防火墙需允许局域网访问对应端口。
可在管理员 PowerShell 中运行 `./scripts/enable-lan-access.ps1 -LocalAddress 192.168.0.10 -Port 3000`，
仅允许本地子网访问该 IP 的 TCP 3000 端口。

## Docker 部署

镜像使用 Node.js 24，多阶段构建前后端，以非 root 用户运行。需要 Docker Engine / Docker Desktop 和 Compose v2。
Compose 默认使用已发布的 `ghcr.io/stacklix/ilinker:latest` 镜像，无需在部署主机构建。

```sh
docker compose pull
docker compose up -d
docker compose ps
```

默认通过宿主机的 `3000` 端口访问后台。容器内固定监听 `0.0.0.0:3000`，数据保存在命名卷 `ilinker-data` 的 `/app/data` 中，
包括 SQLite 数据库、图片、加密密钥及 CLI 登录状态。容器重建后继续使用该卷，机器人会自动恢复连接。

本地运行与 Docker Compose 共用 `.env.example`。需要设置对外访问地址时，将其复制为 `.env` 并按需修改，例如：

```dotenv
PUBLIC_ORIGIN=http://192.168.0.10:3000
```

```sh
docker compose up -d
docker compose logs --tail=100 ilinker
```

Compose 自动从 `.env` 读取 `PUBLIC_ORIGIN`、`COOKIE_SECURE` 和 `ENCRYPTION_KEY`；容器内的 `HOST`、`PORT`、`DATA_DIR` 由 `compose.yaml` 固定。
需要限制宿主机绑定 IP 或更换端口时，直接修改 `compose.yaml` 的 `ports`，例如 `192.168.0.10:3000:3000` 或 `3001:3000`，
同时更新 `PUBLIC_ORIGIN`。
HTTPS 反向代理部署时，未设置 `PUBLIC_ORIGIN` 也允许浏览器明确标记为同源的请求；设置后则严格匹配该地址。
如果浏览器未发送 `Sec-Fetch-Site: same-origin`，仍会根据后端收到的协议和 Host 校验，此时应设置 `PUBLIC_ORIGIN` 为实际访问地址。
HTTPS 部署可设置 `PUBLIC_ORIGIN=https://你的域名` 自动启用安全 Cookie；不设置时请单独设置 `COOKIE_SECURE=true`。

镜像内置 `/healthz` 健康检查。Docker 构建上下文排除了本机 `.env`、数据库、密钥、测试数据和 `node_modules`；
新容器使用独立的数据卷。每个数据卷只运行一个网关服务实例。

Compose 升级时运行 `docker compose pull`，再运行 `docker compose up -d`，继续使用原数据卷。

### GitHub Actions 镜像发布

`.github/workflows/docker.yml` 先在 Linux / Windows 上运行测试和构建，通过后构建 `linux/amd64`、`linux/arm64` 镜像并发布到 `ghcr.io/stacklix/ilinker`。
使用 GitHub 自动提供的 `GITHUB_TOKEN`（`packages: write`），无需额外配置发布 Token。

- 推送到 `master`：发布 `latest`、`master` 和 `sha-<提交摘要>` 标签。
- 推送 `v*` 标签（例如 `v1.0.0`）：发布同名镜像标签和 SHA 标签，不覆盖 `latest`。
- 向 `master` 提交 PR：执行测试和镜像构建，不发布。
- Actions 页面可手动运行；只有 `master` 或 `v*` 标签允许发布。

首次发布后，如需匿名拉取，在 GitHub 包设置中将包的可见性设为 Public；私有包需要先通过 `docker login ghcr.io` 登录具备拉取权限的账号。
使用已发布镜像，无需在服务器上构建：

```sh
docker run -d --name ilinker --restart unless-stopped --init -p 3000:3000 -v ilinker-data:/app/data ghcr.io/stacklix/ilinker:latest
docker exec -it ilinker ilinker bot bind --name "微信通知"
```

升级时先 `docker pull ghcr.io/stacklix/ilinker:latest`，再使用相同数据卷重新创建容器。不要同时启动多个实例共享该卷。

## CLI 管理

CLI 通过后台 API 操作。容器内管理机器人和 WebHook 无需登录，也无需先创建管理员；Web 后台和远程 CLI 仍需管理员认证。先启动服务，再执行命令。
Docker 容器中已经安装 `ilinker` 命令：

```sh
# 创建机器人，终端显示二维码；扫码确认后自动完成绑定
docker compose exec ilinker ilinker bot bind --name "微信通知"

# 查看机器人 ID
docker compose exec ilinker ilinker bot list

# 使用上一条输出的机器人 ID 创建 WebHook
docker compose exec ilinker ilinker webhook create --bot bot_xxx --name "服务器告警" --public-url http://192.168.0.10:3000

docker compose exec ilinker ilinker webhook list
```

`--public-url` 指定其他应用实际访问的网关地址；设置了 `PUBLIC_ORIGIN` 时可以省略。
创建命令显示一次完整 WebHook 地址，列表只显示摘要。绑定后，在微信中给机器人发一条消息，即可通过 WebHook 发送文本和图片。
扫码绑定需要保留交互终端，不要为 `docker compose exec` 添加 `-T`。

本地使用同一套 CLI：

```sh
npm run build
npm run cli -- auth login --username admin
npm run cli -- bot bind --name "微信通知"
npm run cli -- webhook create --bot bot_xxx --name "服务器告警"
```

开发时也可以使用 `npm run cli:dev -- <命令>`，无需提前构建。

| 命令 / 参数 | 功能 |
| --- | --- |
| `auth setup --username NAME` | 首次初始化管理员并登录 |
| `auth login --username NAME` | 登录已有管理员 |
| `auth logout` | 撤销当前 CLI 会话并删除本地登录状态 |
| `bot list` | 查看机器人 ID、名称、状态及绑定账号 |
| `bot bind --name NAME [--note TEXT]` | 新建机器人并等待微信扫码 |
| `bot bind --id BOT_ID` | 为未绑定机器人扫码，或恢复原绑定账号 |
| `bot bind ... --qr-file PATH.png` | 同时将二维码保存为 PNG，不覆盖已有文件 |
| `bot bind ... --timeout 300` | 设置扫码等待秒数，范围 1–900 |
| `webhook list` | 列出 WebHook，不显示完整 Token |
| `webhook create --bot BOT_ID --name NAME` | 为指定机器人创建 WebHook |
| `webhook create ... --rate-limit 60` | 每分钟调用上限，范围 1–600 |
| `webhook create ... --expires-at ISO_TIME` | 指定未来的过期时间，如 `2027-01-01T00:00:00+08:00` |
| `--url http://host:3000` | 连接指定网关；也可设置 `ILINKER_URL` |
| `--session-file PATH` | 指定 CLI 登录状态文件；也可设置 `ILINKER_SESSION_FILE` |
| `--json` | 将最终结果输出为 JSON；二维码和进度输出到标准错误 |
| `--help` | 查看完整帮助 |

CLI 默认读取 `.env` 中的 `HOST` / `PORT`，容器内通过 `127.0.0.1:3000` 连接运行中的网关。
镜像通过 `ILINKER_LOCAL_CLI_FILE` 启用容器本地管理：服务启动时生成权限为 `0600` 的临时凭证，CLI 自动读取，每次重启更换。
该权限仅用于本机回环连接的机器人和 WebHook 接口，不会发送给 `--url` 指定的其他网关；外部请求不能免登录。
需要使用 Web 后台时，可在网页初始化管理员，或执行 `ilinker auth setup --username admin`。
以下登录状态配置适用于本地开发或远程 CLI：
登录状态按网关源地址隔离，默认保存在 `DATA_DIR/cli-session.json`；未设置 `DATA_DIR` 时保存在用户目录的 `.ilinker/cli-session.json`。
文件包含管理员会话凭证，Linux 权限为 `0600`。登录过期后重新执行 `auth login`。
无人值守认证可使用 `--password-stdin` 从管道读取密码，CLI 不接受明文密码命令行参数。

扫码超时或中断时，已创建的机器人会保留；使用输出的 ID 执行 `bot bind --id BOT_ID` 重试。
重新扫码仍遵守“一个机器人固定绑定一个账号”的限制。更换接收账号时创建另一个机器人，再在 WebHook 配置中切换机器人。

## 接入微信

1. 在「机器人」页面添加一个微信 iLink 机器人。
2. 使用具备相关机器人功能的微信账号扫描二维码，按提示确认授权或输入验证码。
3. 在微信中给机器人发送一条消息。
4. 在「消息中心」选择该机器人，直接查看聊天记录；支持修改备注、搜索和手动回复。
5. 在「WebHook」创建 WebHook，只选择机器人，复制生成的完整地址。

WebHook 可在配置中更换机器人，新通知使用新机器人，已排队任务和历史消息保持原发送对象。
每个机器人固定绑定一个扫码账号，只拥有一个聊天会话，不支持换绑。重新扫码只能恢复原账号；需要其他账号时创建新的机器人。
WebHook 可以在尚未建立会话时先创建，实际发送前需要在微信中给机器人发一条消息。

每个机器人单独维护凭证、同步游标、会话上下文及消息。官方协议依据：
[Tencent/openclaw-weixin 协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)。

## WebHook 调用

```http
POST https://notify.example.com/webhook/message/hk_YOUR_TOKEN
Content-Type: application/json
Idempotency-Key: deploy-20261026-001

{
  "text": "生产环境部署成功，版本 v1.0.0"
}
```

路径中的 Token 即认证凭证，无需 Authorization 请求头。每个 WebHook 选择一个机器人，发送给该机器人绑定的扫码账号。
文本最多 4000 个字符；使用 POST JSON 发送，不通过 GET 触发发送。

同一个接口也支持图片 URL：

```json
{
  "type": "image",
  "image": {
    "url": "https://example.com/report.png"
  }
}
```

或者直接提交 Base64（可带 `data:image/png;base64,` 等前缀）：

```json
{
  "type": "image",
  "image": {
    "base64": "data:image/png;base64,<图片的 Base64 数据>"
  }
}
```

`url` 与 `base64` 必须且只能提供一个。每次请求发送一条文本或一张图片；文本和图片需要分别调用。
支持 PNG、JPEG、GIF、WebP，单张最大 **8 MB**，最多 4000 万像素。URL 需为公开可访问的 HTTPS 地址；
网关会校验每次 DNS 解析和重定向，并将已校验的公网 IP 固定到下载连接，不允许访问内网、本机或保留地址。
URL 图片在任务进入队列后下载，下载失败通过消息状态和调用日志反馈。
图片会保存在本地 SQLite 中，供后台聊天预览和失败重试使用。原始 URL 加密保存，不出现在调用日志中。

本地图片的 PowerShell 调用示例：

```powershell
$webhookUrl = 'http://127.0.0.1:3000/webhook/message/hk_YOUR_TOKEN'
$encoded = [Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\images\report.png'))
$payload = @{ type = 'image'; image = @{ base64 = $encoded } } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $webhookUrl -ContentType 'application/json' -Body $payload
```

WebHook 的「接入指南」中提供三种请求示例，「在线测试」可以选择文本、图片 URL 或本地图片。

### 截图发送脚本

`scripts/send-screenshot.ps1` 用于发送已有截图，兼容 Windows PowerShell 5 和 PowerShell 7。
默认读取 `$CODEX_HOME/screenshot-hook.json`，未设置 CODEX_HOME 时读取用户目录的 `.codex/screenshot-hook.json`：

```json
{ "webhookUrl": "http://your-gateway:3000/webhook/message/hk_YOUR_TOKEN" }
```

```powershell
pwsh -NoProfile -File ./scripts/send-screenshot.ps1 -ImagePath 'C:\screenshots\result.png'
```

脚本将文件编码为 Base64，使用幂等键创建任务，并查询最终状态；输出中不会显示 WebHook 地址、Token 或图片数据。
默认等待 120 秒，可用 `-WaitTimeoutSeconds` 调整；`-NoWait` 只入队、不等待。
退出码：0 表示平台接受（使用 NoWait 时只表示入队成功）；1 表示失败或结果不明；2 表示仍在排队或发送。
输出的 `messageId`、`idempotencyKey` 可用于排查或确认原任务，脚本不会自动重复 POST。
需要交付截图时，可以将此脚本复制到全局 Codex 目录使用；私有配置不要提交到仓库。

## 按 WebHook 查看消息

在「WebHook」中点击 WebHook 名称或该行的「消息」，打开「消息记录」页签：

- 按聊天时间线查看该 WebHook 创建的文本、图片和后台测试消息，以及实时发送状态和失败原因。
- 支持关键词搜索、文本/图片筛选、发送状态筛选，每页 30 条，通过「更早消息」「更新消息」翻页。
- 图片可预览并打开原图；明确失败的消息可以手动重试，结果待确认的消息不自动重发。
- 每条消息保留原机器人和会话归属，可点击「查看会话」进入对应聊天窗口。
- 更换 WebHook 机器人、轮换 Token 或停用 WebHook 后，消息仍归属于同一个 WebHook；已删除机器人的历史仍可查看。

此视图以消息记录中的 WebHook ID 为准，独立于调用日志。微信收到的回复保存在机器人会话中，
同一会话可绑定多个 WebHook，因此不会自动将回复归给某一个 WebHook。

后台查询接口（需要管理员登录）：

```http
GET /api/v1/webhooks/{webhookId}/messages?limit=30&type=image&status=provider_accepted&search=关键词&before=msg_...
```

所有查询参数均可省略；返回 `items`、筛选后的 `total` 和分页 `nextCursor`。
`before` 必须是该 WebHook 自己的消息 ID，历史目标按每条消息实际保存的机器人和会话解析。

PowerShell 示例：

```powershell
$webhookUrl = 'http://127.0.0.1:3000/webhook/message/hk_YOUR_TOKEN'
$payload = @{ text = '部署成功' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $webhookUrl -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
```

微信发送窗口从接收人最近一条入站消息开始计算，持续 24 小时；机器人发出的消息不会延长窗口。文本和图片均受此限制。超过窗口时，发送接口直接返回 HTTP 409，不创建发送任务：

```json
{
  "code": "WECHAT_SEND_WINDOW_EXPIRED",
  "message": "微信发送限制：24 小时内未收到用户消息，无法主动发送。请接收人在微信中给机器人发送一条消息后重试。"
}
```

接收人在微信中重新给机器人发消息后恢复发送。若消息入队后才超时，或微信明确返回 24 小时限制，状态查询返回 `status: "failed"`、`code: "WECHAT_SEND_WINDOW_EXPIRED"` 和 `error` 说明；同一幂等键再次调用也返回原任务的失败原因，不重复发送。

接受任务返回 HTTP 202：

```json
{
  "requestId": "req_...",
  "messageId": "msg_...",
  "status": "queued"
}
```

查询状态：

```http
GET /webhook/message/{token}/status/{messageId}
```

Token 只能查询由自身 WebHook 创建的消息。

| 状态 | 含义 |
| --- | --- |
| `queued` | 任务已持久化，等待处理 |
| `sending` | 正在向平台提交 |
| `provider_accepted` | 平台接口已接受，不代表对方已收到或已读 |
| `failed` | 明确失败，可在后台手动重试 |
| `unknown` | 超时、中断或发送期间重启导致结果不明；需核实，网关不自动重发 |

`Idempotency-Key` 为可选项，按 WebHook 隔离，有效期 24 小时。同键同内容返回原任务；同键不同内容返回 409。
超过 WebHook 每分钟上限返回 429，停用返回 403，过期返回 410，无效 Token 返回 404。

## 配置与部署

复制 `.env.example` 为 `.env`，按需修改：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `3000` | 后端 / 生产前端端口 |
| `DATA_DIR` | `./data` | SQLite 数据库与本地加密密钥目录 |
| `PUBLIC_ORIGIN` | 无 | 可选对外访问源，例如 `https://notify.example.com`；配置后严格校验后台请求来源 |
| `COOKIE_SECURE` | 根据 PUBLIC_ORIGIN 推断 | HTTPS 部署使用 `true` |
| `ENCRYPTION_KEY` | 自动生成并保存在数据目录 | 可选 Base64 编码的 32 字节密钥 |

反向代理需转发 `/api/`、`/webhook/` 及静态资源；SSE 路径 `/api/v1/events` 应关闭缓冲。
发送 Base64 图片时，反向代理请求体大小上限应至少设置为 12 MB。
后台使用 HttpOnly、SameSite=Strict Cookie，并校验写请求来源；未配置 `PUBLIC_ORIGIN` 时允许浏览器明确标记为同源的请求，跨站请求仍会被拒绝。
密码使用 scrypt；微信凭证和会话上下文使用 AES-256-GCM 加密。

完整 WebHook Token 只在创建或重置时返回，数据库只保存摘要。重置立即使旧地址失效。
应用默认将请求开始、完成状态码、耗时和请求 ID 输出到标准输出，可用 `docker compose logs --tail=100 -f ilinker` 查看。
请求日志仅记录路由模板，不记录完整 WebHook Token、查询参数、请求头、请求体或响应体；反向代理访问日志也应对 `/webhook/message/` 后的 Token 脱敏。
对外提供服务前先在本地完成管理员初始化，并配置 HTTPS 和安全 Cookie；可通过 `PUBLIC_ORIGIN` 固定允许的访问源。

备份时保存整个 `DATA_DIR`；使用外部 ENCRYPTION_KEY 时另行备份该密钥。丢失密钥将无法恢复微信凭证和会话上下文。
启用连接的机器人会在网关重启后自动恢复；明确失效的授权需要重新扫码。

## 功能边界

- 支持微信私聊文本收发，以及通过 WebHook 发送图片；接收的图片、文件、语音、视频当前仍显示摘要。
- 消息历史从网关接入后开始保存，不导入微信原有聊天记录。
- 发送依赖微信会话上下文；缺少或失效时，需先在微信中给机器人发消息。
- 单管理员、单网关进程。SQLite 队列按机器人顺序发送，不支持多个网关进程共同消费一个数据目录。
- 删除机器人配置会清除凭证、停用关联 WebHook；历史消息仍保存在数据库中，已删除机器人不再出现在正常列表。
- 微信端的扫码授权及真实收发需要使用者的账号验证；自动化测试使用独立的协议替身和临时数据库。

## 接口与代码

- 后台认证：`/api/v1/auth/*`
- 平台能力：`GET /api/v1/platforms`
- 机器人连接：`/api/v1/bots/*`
- 机器人聊天：`/api/v1/bots/{botId}/conversation`（查看和修改备注）、`/read`（标记已读）、`/messages`（查看和发送消息）
- WebHook 管理：`/api/v1/webhooks/*`
- WebHook 消息记录：`GET /api/v1/webhooks/{webhookId}/messages`
- 实时通知：`GET /api/v1/events`（SSE）
- 外部发送：`POST /webhook/message/{token}`
- 健康检查：`GET /healthz`

前端位于 `src/`；后端位于 `server/`；共享类型位于 `shared/`。
平台适配器定义在 `server/ilink.ts`，通过 `PlatformAdapter` 隔离登录、收消息和发送行为，方便后续扩展平台。

```powershell
npm run typecheck
npm test
npm run build
```

测试覆盖认证、机器人数据隔离、分页、WebHook 路径 Token、幂等、限流、撤销、发送队列、失败重试、重启恢复、图片校验、下载目标校验和微信媒体加密上传协议。
