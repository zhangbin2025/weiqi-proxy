export default {
  async fetch(request, env, ctx) {
    // CORS 预检：放行所有允许透传的请求头（与 buildOutboundHeaders 同源，
    // 避免预检声明与实际白名单漂移）
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': [
            ...REQUEST_HEADER_PASSTHROUGH,
            ...Object.keys(PREFIXED_HEADER_MAP),
          ].join(', '),
        }
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // WebSocket 信令服务（WebRTC P2P）
    if (pathname === '/ws/signal') {
      return await handleWebSocketSignal(request, env);
    }

    // 通用代理接口
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return jsonError('Missing url parameter', 400);
    }

    // url 由请求端提供（未来可由模型输出），属不可信输入：
    // 只放行 http/https，并显式拒绝环回/私网字面地址（SSRF 兜底）。
    const invalidReason = validateTargetUrl(targetUrl);
    if (invalidReason) {
      return jsonError(invalidReason, 400);
    }

    try {
      // 出站头由请求端指定，代理只做透传，不注入任何业务站点默认的
      // Referer / User-Agent。
      const method = request.method;
      const headers = new Headers(buildOutboundHeaders(request.headers));
      // 有 body 的方法转发请求体；手动跟随重定向时可按 Fetch 语义决定是否保留。
      const body = method !== 'GET' && method !== 'HEAD' ? await request.text() : undefined;
      const response = await fetchPublicTarget(targetUrl, { method, headers, body });

      // 全量按字节透传：不做 text() 的 UTF-8 解码/重编码往返。
      // Workers 的 fetch 已自动解压上游 gzip/br，这里拿到的是解压后的原始
      // 字节；HTML / JSON / 图片 / PDF / 字体 / wasm / 非 UTF-8 文本一律保真，
      // 也不需要靠枚举 content-type 来猜哪些是二进制。
      const data = await response.arrayBuffer();

      // null body 状态码不允许带 body（Response 构造会抛）
      const body = NO_BODY_STATUS.has(response.status) ? null : data;

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: buildResponseHeaders(response.headers),
      });
    } catch (error) {
      return jsonError(error.message, 500);
    }
  }
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 手动处理重定向，确保每一跳都重新执行目标 URL 校验，而不是把安全边界
// 交给 fetch 的自动重定向实现。20 跳与 Fetch 标准的重定向循环上限一致。
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const SENSITIVE_REDIRECT_HEADERS = [
  'authorization', 'cookie', 'proxy-authorization', 'referer',
  'appkey', 'checksum', 'accesstoken', 'nonce', 'curtime',
  'timestamp', 'usertoken', 'uuid',
];

async function fetchPublicTarget(rawUrl, init) {
  let current = new URL(rawUrl);
  let method = init.method;
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(current.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;

    if (redirects >= MAX_REDIRECTS) {
      try { await response.body?.cancel(); } catch { /* release best-effort */ }
      throw new Error('Too many redirects');
    }

    let next;
    try {
      next = new URL(location, current);
    } catch {
      try { await response.body?.cancel(); } catch { /* release best-effort */ }
      throw new Error('Invalid redirect URL');
    }
    const invalidReason = validateTargetUrl(next.toString());
    if (invalidReason) {
      try { await response.body?.cancel(); } catch { /* release best-effort */ }
      throw new Error('Redirect blocked: ' + invalidReason);
    }

    // 跨 origin 跳转不转发凭据、Cookie 或站点身份头，避免开放代理替目标站泄漏凭证。
    if (next.origin !== current.origin) {
      for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
    }

    // 与 Fetch redirect 语义一致：303（HEAD 除外）以及 301/302 POST 改为 GET。
    if ((response.status === 303 && method !== 'HEAD')
      || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
    }

    try { await response.body?.cancel(); } catch { /* release best-effort */ }
    current = next;
  }
}

// ============ 目标 URL 校验（最小协议防护） ============

/**
 * url 参数是请求端可控的输入，开放代理不该被用作访问代理自身网络内的地址。
 *
 * 只做两件事：协议必须是 http/https；环回/私网字面地址直接拒绝。
 * 不查内容、不鉴权、不设域名白名单、不解析 DNS —— 域名解析到私网 IP 的
 * 场景仍由 Cloudflare 平台拦截（实测 1003 / 1016），此处是不依赖平台行为的
 * 显式兜底。IP 段取值来自 RFC 1918 / RFC 3927 / RFC 5735 的协议定义，
 * 不是可调的经验阈值。
 */
function validateTargetUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Invalid url';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http/https urls are allowed';
  }
  if (parsed.username || parsed.password) return 'URL credentials are not allowed';
  if (isPrivateHost(parsed.hostname)) {
    return 'Private or loopback targets are not allowed';
  }
  return null;
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) return true;
  if (bare === '::' || bare === '::1') return true;
  // IPv4-mapped IPv6: Cloudflare URL parsing may normalize dotted tails to hex.
  const mapped = bare.match(/^::ffff:(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    const octets = mapped[1] !== undefined
      ? mapped.slice(1, 5).map(Number)
      : [Number.parseInt(mapped[4].slice(0, 2), 16), Number.parseInt(mapped[4].slice(2), 16), Number.parseInt(mapped[5].slice(0, 2), 16), Number.parseInt(mapped[5].slice(2), 16)];
    if (isPrivateIpv4(octets)) return true;
  }
  if (/^f[cd][0-9a-f]*:/i.test(bare) || /^fe[89ab][0-9a-f]*:/i.test(bare)
    || bare.startsWith('ff') || bare.startsWith('2002:') || bare.startsWith('64:ff9b:')) return true;

  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isPrivateIpv4(v4.slice(1, 5).map(Number));
  return false;
}

function isPrivateIpv4(octets) {
  const [a, b, c] = octets;
  // Private, loopback, link-local, shared-address (CGNAT), protocol-assignment,
  // benchmarking, documentation, multicast and reserved ranges.
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return true;
  if (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

// ============ 通用代理：出站请求头透传 ============

/**
 * 可以由请求端直接指定、按原名透传的请求头。
 * 与 Android ProxyHandler / Desktop asset-server 的透传白名单保持一致。
 * 不在白名单内的一律丢弃（含 Host、Connection、CF-* 等），避免把代理自身
 * 的请求头泄漏给目标站点。
 */
const REQUEST_HEADER_PASSTHROUGH = [
  'content-type', 'accept', 'accept-language', 'authorization',
  'appkey', 'checksum', 'accesstoken', 'nonce', 'curtime',
  'timestamp', 'usertoken', 'version', 'platform', 'uuid',
];

/**
 * 浏览器不允许用 fetch 显式设置 Referer / User-Agent / Cookie（forbidden
 * header names），请求端改用 X- 前缀指定，代理在这里还原成标准头。
 * 只认显式指定：不回落到浏览器自动携带的 Referer/UA，避免代理替请求端
 * 决定来源（旧版曾写死业务站点来源的问题）。
 */
const PREFIXED_HEADER_MAP = {
  'x-referer': 'Referer',
  'x-user-agent': 'User-Agent',
  'x-cookie': 'Cookie',
};

function buildOutboundHeaders(incoming) {
  const headers = {};

  for (const name of REQUEST_HEADER_PASSTHROUGH) {
    const value = incoming.get(name);
    if (value) headers[name] = value;
  }
  for (const [prefixed, standard] of Object.entries(PREFIXED_HEADER_MAP)) {
    const value = incoming.get(prefixed);
    if (value) headers[standard] = value;
  }
  return headers;
}

// ============ 通用代理：上游响应头透传 ============

/** null body 状态码不允许带 body（Response 构造会抛） */
const NO_BODY_STATUS = new Set([204, 205, 304]);

/**
 * 透传给请求端的上游响应头（语义性头）。
 *
 * 刻意不透传以下两类，因为 Workers 运行时已让它们失效：
 *  1. 编码/长度类（content-encoding / content-length / transfer-encoding）：
 *     fetch 自动解压 gzip/br，且本代理全量缓冲响应；透传会让浏览器二次
 *     解压、或拿到与解压后字节不符的长度。实际长度由平台按最终 body 重算。
 *  2. hop-by-hop / 会话 / 平台内部头（connection / set-cookie / cf-* / server）：
 *     跨站 set-cookie 不生效且会泄漏上游会话；其余属传输层而非资源语义。
 *
 * 这份列表同时用作 Access-Control-Expose-Headers：否则浏览器 fetch 读不到
 * 非 safelisted 头（如 Content-Disposition / ETag），端侧拿不到完整元数据。
 */
const RESPONSE_HEADER_PASSTHROUGH = [
  'content-type',
  'content-disposition',
  'content-language',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'expires',
  'link',
];

function buildResponseHeaders(upstream) {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  const exposed = [];

  for (const name of RESPONSE_HEADER_PASSTHROUGH) {
    const value = upstream.get(name);
    if (value) {
      headers[name] = value;
      exposed.push(name);
    }
  }
  // 上游没给 Content-Type 时不臆造默认值：没给就是没给，由端侧决定。
  if (exposed.length) {
    headers['Access-Control-Expose-Headers'] = exposed.join(', ');
  }
  return headers;
}

// ============ WebSocket 信令服务 ============

// 处理 WebSocket 信令连接
async function handleWebSocketSignal(request, env) {
  // 速率限制
  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  if (!checkRateLimit(clientIP)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const url = new URL(request.url);
  const roomId = url.searchParams.get('room');
  
  if (!roomId) {
    return new Response(JSON.stringify({ error: 'Missing room parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 获取或创建房间 Durable Object
  const id = env.ROOM.idFromName(roomId);
  const room = env.ROOM.get(id);
  
  // 转发请求到 Durable Object，传递 env
  return room.fetch(request, { env });
}

// ============ TURN 凭据生成 ============

// 速率限制（简单内存缓存）
const rateLimiter = new Map();
const RATE_LIMIT = 100;  // 每分钟最多100次请求
const RATE_WINDOW = 60000;  // 1分钟窗口

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimiter.get(ip);
  
  if (!entry || now - entry.timestamp > RATE_WINDOW) {
    rateLimiter.set(ip, { count: 1, timestamp: now });
    return true;
  }
  
  if (entry.count >= RATE_LIMIT) {
    return false;
  }
  
  entry.count++;
  return true;
}// ============ TURN 凭据生成（可选，全部由部署者配置） ============

/**
 * 本项目不内置任何 TURN 密钥，也不内置任何 TURN 服务器地址。
 * 部署者若需要 TURN 中继，通过 Worker secrets 提供：
 *   TURN_SECRET  TURN 服务器共享密钥（与 coturn 的 static-auth-secret 一致）
 *   TURN_URLS    逗号分隔的 TURN URL 列表，例如
 *                turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
 * 未配置时不下发 turn 字段，WebRTC 仍可走 STUN 直连，也不会生成无效凭据。
 */
function getTurnConfig(env) {
  const secret = env?.TURN_SECRET;
  const urlsRaw = env?.TURN_URLS;
  if (!secret || !urlsRaw) return null;
  const urls = urlsRaw.split(',').map((v) => v.trim()).filter(Boolean);
  if (!urls.length) return null;
  return { secret, urls };
}

// 生成临时 TURN 凭据（4 小时有效）；未配置 TURN 时返回 null
async function generateTurnCredentials(env) {
  const config = getTurnConfig(env);
  if (!config) return null;

  const timestamp = Math.floor(Date.now() / 1000) + 14400;  // 4小时
  const username = `${timestamp}:weiqi`;

  // 使用 Web Crypto API (Cloudflare Workers 环境)
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(config.secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return { urls: config.urls, username, credential };
}

// ============ GameRoom Durable Object ============

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();  // 连接的客户端
    this.lastActivity = Date.now();  // 最后活动时间
  }
  
  // 定时器：每5分钟检查一次
  async alarm() {
    const now = Date.now();
    const idleTime = now - this.lastActivity;
    const MAX_IDLE_TIME = 30 * 60 * 1000; // 30分钟无活动
    
    // 如果房间空闲超过30分钟，清理
    if (idleTime > MAX_IDLE_TIME && this.clients.size === 0) {
      // 通知所有等待的客户端（如果有）
      this.broadcast(JSON.stringify({
        type: 'room-expired',
        message: '房间已过期'
      }));
      
      // 清理状态
      await this.state.storage.deleteAll();
      return; // 不再设置下一次 alarm
    }
    
    // 设置下一次检查
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }
  
  async fetch(request) {
    const url = new URL(request.url);
    
    // WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      await this.handleSession(server);
      
      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }
    
    // HTTP 请求：获取房间信息
    if (url.pathname === '/info') {
      return new Response(JSON.stringify({
        clients: this.clients.size,
        roomId: url.searchParams.get('room')
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
  
  async handleSession(ws) {
    ws.accept();
    this.clients.add(ws);
    this.lastActivity = Date.now();  // 更新活动时间
    
    // 设置定期清理检查（如果还没设置）
    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
    
    // TURN 为可选能力：仅在部署者配置了 TURN_SECRET / TURN_URLS 时下发凭据。
    const turnCredentials = await generateTurnCredentials(this.env);
    const welcome = {
      type: 'connected',
      clients: this.clients.size,
    };
    if (turnCredentials) welcome.turn = turnCredentials;

    // 发送欢迎消息
    ws.send(JSON.stringify(welcome));
    
    // 如果是第二个玩家，通知双方可以开始 WebRTC 连接
    if (this.clients.size === 2) {
      this.broadcast(JSON.stringify({ type: 'ready' }));
    }
    
    ws.addEventListener('message', (event) => {
      this.lastActivity = Date.now();  // 更新活动时间
      try {
        const data = JSON.parse(event.data);
        
        // 心跳消息直接回复，不转发
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        
        // 转发消息给房间内其他客户端
        this.broadcast(event.data, ws);
        
      } catch (e) {
        // Failed to parse message
      }
    });
    
    ws.addEventListener('close', () => {
      this.clients.delete(ws);
      this.lastActivity = Date.now();  // 更新活动时间
      
      // 通知其他客户端有人离开
      this.broadcast(JSON.stringify({
        type: 'disconnected',
        clients: this.clients.size
      }));
    });
    
    ws.addEventListener('error', (err) => {
      this.clients.delete(ws);
    });
  }
  
  // 广播消息给所有客户端（可选排除发送者）
  broadcast(message, exclude = null) {
    for (const client of this.clients) {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}
