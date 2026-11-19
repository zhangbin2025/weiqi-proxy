# Weiqi Proxy

可自行部署的 Cloudflare Worker：通用透明字节代理 + WebSocket 信令服务。

## 接口

### 通用代理

```
GET|POST|PUT|PATCH|DELETE|HEAD  /?url=<encoded_url>
```

- 取回 `url` 指向的资源，按字节原样返回并保留原始状态码；不解析、不改写内容、不缓存、不落日志、不鉴权。
- 出站请求头按白名单透传：`Content-Type`、`Accept`、`Accept-Language`、`Authorization`、`AppKey`、`CheckSum`、`AccessToken`、`Nonce`、`CurTime`、`Timestamp`、`UserToken`、`Version`、`Platform`、`UUID`。
- `Referer` / `User-Agent` / `Cookie` 由请求端用 `X-Referer` / `X-User-Agent` / `X-Cookie` 指定；未指定就不发送，不注入默认值。白名单外的头一律丢弃。
- 响应头按白名单透传：`Content-Type`、`Content-Disposition`、`Content-Language`、`Content-Range`、`Accept-Ranges`、`ETag`、`Last-Modified`、`Cache-Control`、`Expires`、`Link`，并写入 `Access-Control-Expose-Headers`。
- 不透传 `Content-Encoding` / `Content-Length` / `Transfer-Encoding`（Workers 已自动解压并全量缓冲），也不透传 `Set-Cookie` / `CF-*` / `Server`。上游未给 `Content-Type` 时不臆造默认值。
- `url` 只放行 `http/https`，拒绝环回与私网字面地址（RFC 1918 / 3927 / 5735）；域名解析到私网 IP 的场景由 Cloudflare 平台拦截。
- CORS 全开（`Access-Control-Allow-Origin: *`），`OPTIONS` 预检直接放行。
- Workers 全量缓冲、无流式，大文件受平台内存上限约束。

### WebSocket 信令

```
/ws/signal?room=<roomId>
```

- 按 `room` 分配 Durable Object，房间内消息广播给其他客户端，`ping` 直接回 `pong`。
- 连接时下发 `connected`（`clients` 数，配置 TURN 时另带 `turn`）；第二人加入广播 `ready`；断开广播 `disconnected`。
- 30 分钟无活动且无客户端时清理房间状态。
- 每个 IP 每分钟最多 100 次请求（示例级内存计数，按 Worker 实例计，不构成安全边界）。

## 部署

需要 Node.js 18+、wrangler CLI、Cloudflare 账户。

```bash
cp .env.example .env      # 填入 CLOUDFLARE_API_TOKEN
source .env && wrangler deploy
```

`wrangler.toml` 已声明 `GameRoom` Durable Object（SQLite 免费计划适配）。默认域名形如 `https://<worker-name>.<account-subdomain>.workers.dev`，可在 Cloudflare Dashboard 绑定自定义域名。

本地开发：`wrangler dev`；查看日志：`wrangler tail`。

### 可选：TURN 中继

默认只做信令转发，WebRTC 走 STUN 直连。需要 TURN 时用 secret 配置（勿写入代码或 `.env`）：

```bash
wrangler secret put TURN_SECRET   # 与 coturn static-auth-secret 一致
wrangler secret put TURN_URLS     # 逗号分隔，如 turn:turn.example.com:3478?transport=udp
```

两项都配置后 `connected` 消息才带 `turn` 字段（HMAC-SHA1，4 小时有效）；未配置不下发凭据。仓库不内置任何 TURN 密钥或服务器地址。

## 文件

`index.js` 主代码 · `wrangler.toml` 配置 · `.env.example` 变量模板 · `.gitignore` · `README.md` · `LICENSE`

## 免责声明

无鉴权的开放代理，部署实例对外可被任何人访问。请仅用于你有权访问的数据与自有服务，遵守目标站点条款与 Cloudflare 可接受使用政策；上生产前自行加鉴权、域名白名单、速率限制与监控。软件按 MIT 许可证「按原样」提供，不附带任何担保。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
