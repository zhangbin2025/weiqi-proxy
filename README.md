# Weiqi Proxy - Cloudflare Worker

> 一个可自行部署的通用 CORS 透传代理 + WebSocket 信令服务（Cloudflare Worker）。
> 本仓库不含任何账号凭据、部署实例或私有服务地址。

围棋数据代理服务，通过 Cloudflare Worker 实现跨域数据获取。

## 功能

### 1. 通用 CORS 代理

```
GET|POST|PUT|PATCH|DELETE|HEAD  https://<your-worker-domain>/?url=<encoded_url>
```

**透明字节代理**：请求端给出 URL，代理取回并按字节原样返回。HTML / JSON /
文本 / 图片 / PDF / 字体 / wasm / 压缩包 / 非 UTF-8 文本一律保真，不做解析、
不猜内容类型、不搜索、不缓存、不落日志。**授权与内容消费由端侧负责**（后续
客户端插件），代理不提供鉴权、不提供搜索、不提供正文提取。

出站请求头由请求端指定，代理只做透传，不注入任何业务站点默认的
`Referer` / `User-Agent`。

**用途**：
- 云比赛网 API 代理
- 手谈等级分查询代理
- 端侧 LLM 取网页资源（由端侧插件决定 URL、授权与如何送入模型上下文）

**请求头透传**：

- 按原名透传：`Content-Type`、`Accept`、`Accept-Language`、`Authorization`，
  以及 `AppKey`、`CheckSum`、`AccessToken`、`Nonce`、`CurTime`、`Timestamp`、
  `UserToken`、`Version`、`Platform`、`UUID`（与 Android / Desktop 本地代理的白名单一致）。
- 浏览器禁止用 `fetch` 设置 `Referer` / `User-Agent` / `Cookie`，请求端改用
  `X-Referer` / `X-User-Agent` / `X-Cookie`，代理还原成标准头。
- 不在白名单内的一律丢弃；**未指定就不发送** `Referer` / `User-Agent`，
  不回落到浏览器自动携带的值。

**响应**：

- 全量按字节透传（不做 `text()` 的 UTF-8 解码/重编码往返），保留原始状态码。
- 按白名单透传语义性响应头：`Content-Type`、`Content-Disposition`、
  `Content-Language`、`Content-Range`、`Accept-Ranges`、`ETag`、
  `Last-Modified`、`Cache-Control`、`Expires`、`Link`，并同步写入
  `Access-Control-Expose-Headers` 让浏览器可读。
- **不透传** `Content-Encoding` / `Content-Length` / `Transfer-Encoding`：
  Workers 的 `fetch` 已自动解压 gzip/br 且响应全量缓冲，这些头已失效，
  透传会导致浏览器二次解压或长度不符。也不透传 `Set-Cookie` / `CF-*` / `Server`。
- 上游未给 `Content-Type` 时不臆造默认值。

**最小协议防护**：`url` 参数属不可信输入，只放行 `http/https`，并显式拒绝
环回 / 私网字面地址（RFC 1918 / RFC 3927 / RFC 5735 定义的地址段）。不查内容、
不鉴权、不设域名白名单；域名解析到私网 IP 的场景仍由 Cloudflare 平台拦截。

**平台边界**：Workers 全量缓冲响应、无流式，大文件受平台内存上限约束；
这是部署平台限制，不是代理参数。

## 部署

### 前提条件

- Node.js 18+
- wrangler CLI (`npm install -g wrangler`)
- Cloudflare 账户

### 配置

1. 复制环境变量模板：
   ```bash
   cp .env.example .env
   ```

2. 编辑 `.env` 文件，填入 Cloudflare API Token：
   ```
   CLOUDFLARE_API_TOKEN=your_token_here
   ```

### 部署命令

```bash
# 使用环境变量中的 Token
source .env && wrangler deploy

# 或者直接指定 Token
CLOUDFLARE_API_TOKEN=your_token wrangler deploy
```

## 开发

### 本地测试

```bash
wrangler dev
```

### 查看日志

```bash
wrangler tail
```

## 文件结构

```
weiqi-proxy/
├── index.js          # Worker 主代码
├── wrangler.toml     # wrangler 配置
├── README.md         # 说明文档
├── LICENSE           # MIT 许可证
├── .env.example      # 环境变量模板（仅占位值，非真实凭据）
├── .gitignore        # 忽略 .env / .wrangler / node_modules
└── .env              # 本地环境变量（被 .gitignore 忽略，不入库）
```

## 域名配置

- Worker 默认域名形如 `https://<worker-name>.<account-subdomain>.workers.dev`
- 自定义域名可在 Cloudflare Dashboard 中为 Worker 绑定

本仓库不包含任何特定账号、域名或部署实例的信息。

## 可选：TURN 中继配置

WebSocket 信令服务默认只做消息转发，WebRTC 走浏览器自带的 STUN 直连即可。
若需 TURN 中继，用 `wrangler secret` 配置（**不要写进代码或 `.env`**）：

```bash
wrangler secret put TURN_SECRET   # 与 coturn static-auth-secret 一致
wrangler secret put TURN_URLS     # 逗号分隔，例如 turn:turn.example.com:3478?transport=udp
```

两项都配置后，`connected` 消息才会带上 `turn` 字段；未配置则不下发凭据。
本仓库不内置任何 TURN 密钥或服务器地址。

## 合法使用与免责声明

本项目是一个通用、无鉴权的透明字节代理与 WebSocket 信令服务。你部署的实例对
外可被任何人访问，请自行评估并遵守：

- 仅用于你有权访问的数据与自有服务；尊重目标站点的服务条款、robots.txt、
  版权与个人信息保护要求，不要用本代理绕过访问控制或抓取未授权内容。
- 遵守托管平台（Cloudflare Workers）的可接受使用政策。
- 建议自行加上域名白名单、鉴权、速率限制、日志与监控后再用于生产；
  仓库内自带的速率限制是示例级实现，按 Worker 实例内存计数，不构成安全边界。
- 作者不对部署者或使用者如何使用本软件、以及由此产生的任何后果负责。
  软件按 MIT 许可证「按原样」提供，不附带任何明示或暗示的担保。

## 许可证

MIT License — 见 [LICENSE](LICENSE)。

## 更新历史

### 2026-11-12

- 明确为透明字节代理：不做联网搜索，只按 URL 取回资源原样返回，授权由端侧插件负责
- 响应改为全量 `arrayBuffer` 透传，各类资源字节保真；按白名单透传语义性响应头
- 增加最小协议防护：仅 http/https，拒绝环回 / 私网字面地址
- 移除 `/yichafen/query` 接口（weiqi-bot 已改用本地资源提供查询服务）
- 出站请求头改为请求端指定 + 代理透传，不再写死云比赛网 `Referer` / `User-Agent`

### 2026-05-08

- 重命名目录从 `yunbisai-proxy` 到 `weiqi-proxy`

### 2026-05-07

- 初始版本
- 实现通用 CORS 代理功能
- 支持绑定自定义域名
