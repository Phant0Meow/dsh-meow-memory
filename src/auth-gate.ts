/**
 * 连接鉴权闸（#57）：给本插件经 webServer.register 直注册的路由补上官方鉴权。
 *
 * 背景：dsh 的鉴权由 dsh-client-connection 执行，但它只包 connection.register 的
 * 路由与 index fallback 外；webServer.register 的路由不经过任何闸——本插件的
 * /meow-memory/* 三条路由此前跨站可读可写（同机接了栅栏的插件为 401/403）。
 *
 * 修复与 dsh-meow-smooth 的 auth-gate 同源同语义（其 0.4.x 真机验证过的实现）：
 * - dsh ≥0.1.5：connection.requestRejection（Host fence 403 → 未认证 401 → 放行）。
 * - dsh ≤0.1.2：connection 服务存在但没有 requestRejection（0.1.5 才加入）。旧版
 *   官方 /api 的闸是纯 Host/Origin fence（isTrustedApiRequest：loopback/LAN IP
 *   字面量/声明 trustedHosts 之外 403；sec-fetch-site: cross-site 403；Origin 与
 *   Host 不同源 403）。这里逐语义复刻同一把 fence，trustedHosts 从 connection
 *   服务读取；回退后旧宿主的防护与官方 /api 恰好等价，绝不比官方更松。
 * - connection 服务整个缺失：authGate（显式传入 undefined）保守 503；生产注册
 *   走 authGateLazy（#78）——0.2.x 宿主上 connection 对插件 ctx 根本不可见
 *   （dsh-client-connection 只在浏览器侧入口 ctx.provide；宿主侧的
 *   HostConnectionService 是局部变量不进 DI，0.2.0-rc.1 包源码实证），"缺失即
 *   503"会把三条路由永久打死。懒解析版在缺失时降级为环回 fence，详见其注释。
 */

/** connection 服务最小面：0.1.5+ 的 requestRejection 与旧版的 trustedHosts。 */
export interface ConnectionAuthFace {
  requestRejection?: (req: unknown) => number | undefined
  /** 旧版（≤0.1.2）Host fence 的可信主机列表；缺省为空（等价官方默认）。 */
  trustedHosts?: readonly string[]
}

/** 从插件 ctx 取 connection 服务：先属性访问，回退 ctx.get——两版 cordis 兼容。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function connectionAuthOf(ctx: any): ConnectionAuthFace | undefined {
  let connection: ConnectionAuthFace | undefined
  try { connection = ctx.connection as ConnectionAuthFace | undefined } catch { connection = undefined }
  if ((connection === undefined || connection.requestRejection === undefined) && typeof ctx.get === 'function') {
    try { connection = ctx.get('connection') as ConnectionAuthFace | undefined } catch { connection = undefined }
  }
  return connection
}

// --- 旧版（≤0.1.2）Host fence：逐语义复刻 dsh-client-connection 的
// isTrustedApiRequest（api-request-trust.js），行为必须与官方 /api 一致。 ---

interface ParsedAuthority { hostname: string; host: string; port: string }

function fenceHeader(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null || typeof headers !== 'object') return undefined
  const h = headers as Record<string, unknown>
  // Fetch Headers 形态（官方 header() 同款兼容）：get() 优先。
  const getter = (h as { get?: unknown }).get
  if (typeof getter === 'function') {
    try { const v = (h as { get: (n: string) => unknown }).get(name); if (typeof v === 'string') return v } catch { /* 非标准 get，走索引 */ }
  }
  const value = h[name]
  if (typeof value === 'string') return value
  const lower = h[name.toLowerCase()]
  return typeof lower === 'string' ? lower : undefined
}

function parseAuthority(authority: string): ParsedAuthority | undefined {
  try {
    const url = new URL(`http://${authority}`)
    return { hostname: url.hostname, host: url.host, port: url.port }
  } catch { return undefined }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 官方语义：无显式端口的条目按"HTTPS 解析得到的默认端口"参与判断——
 *  `:80`/`:443` 仍算显式端口（两种 special scheme 默认端口不同）。 */
function canonicalAuthority(entry: string, entryUrl: ParsedAuthority): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl: ParsedAuthority, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    // 条目无显式端口（canonical == hostname）→ 只比主机名（任意端口）；
    // 带显式端口 → 比 host（主机名+端口）。
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** 旧版官方 /api 的完整 Host fence（逐语义复刻）。 */
function legacyHostFence(req: unknown, trustedHosts: readonly string[]): boolean {
  const host = fenceHeader((req as { headers?: unknown })?.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (fenceHeader((req as { headers?: unknown })?.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = fenceHeader((req as { headers?: unknown })?.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/**
 * 包一层鉴权闸。
 *
 * - connection.requestRejection 可用（0.1.5+）：返回数字（403/401）原样写回，
 *   语义与 connection.register 的包装层一致；undefined 放行。
 * - connection 存在但无 requestRejection（≤0.1.2）：回退旧版官方同款 Host
 *   fence，不过 → 403，过 → 放行。
 * - connection 整个缺失：保守拒绝（503）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function authGate<R extends { writeHead: (...args: any[]) => void; end: (...args: any[]) => void }>(
  connection: ConnectionAuthFace | undefined,
  handler: (req: unknown, res: R) => void,
): (req: unknown, res: R) => void {
  return (req, res) => {
    const reject = connection?.requestRejection
    if (typeof reject === 'function') {
      const rejection = reject.call(connection, req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      handler(req, res)
      return
    }
    // 旧版宿主（≤0.1.2）：connection 存在但没有 requestRejection → 复刻旧版
    // 官方 /api 的 Host fence；trustedHosts 缺省为空（loopback 永远放行）。
    if (connection !== undefined) {
      if (!legacyHostFence(req, connection.trustedHosts ?? [])) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      handler(req, res)
      return
    }
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('meow-memory: authentication service unavailable')
  }
}

/**
 * 懒解析版鉴权闸（#78）：connection 不在注册时刻捕获，每请求现取。
 *
 * 三个理由：
 * 1. 0.2.x 宿主上 connection 服务对插件 ctx **结构性不可见**（不是晚到）——注册时
 *    捕获一次（0.31.1 的做法）在 webServer 就绪那一刻就永远定格成 undefined，
 *    轮询重试也救不回来；
 * 2. 若宿主确属晚注册（fiber 竞态），逐请求现取会在服务出现的那一请求起自动
 *    升级到官方闸，无需定时器；
 * 3. 拿不到时不再 503（#78：三条路由全灭、dream 小月亮消失），降级为环回 fence
 *    ——Host fence + sec-fetch-site: cross-site + Origin 同源三重校验照做，#57 的
 *    跨站读写向量仍然全挡；相对官方闸损失仅 cookie 认证（本机非浏览器进程可直连，
 *    与任何无认证 localhost 服务同级，残留面见 onDegraded 日志）。降级只发生一次
 *    提示（onDegraded 节流），不刷屏。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function authGateLazy<R extends { writeHead: (...args: any[]) => void; end: (...args: any[]) => void }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  handler: (req: unknown, res: R) => void,
  opts: { onDegraded?: () => void } = {},
): (req: unknown, res: R) => void {
  let degradedWarned = false
  return (req, res) => {
    const connection = connectionAuthOf(ctx)
    if (connection === undefined) {
      if (!degradedWarned) {
        degradedWarned = true
        opts.onDegraded?.()
      }
      // 环回 fence：trustedHosts 空表 = 只认 loopback Host（无 LAN 配置可达——
      // 降级路径拿不到宿主 trustedHosts；LAN 场景下官方闸可用时走不到这里）。
      if (!legacyHostFence(req, [])) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      handler(req, res)
      return
    }
    authGate(connection, handler)(req, res)
  }
}
