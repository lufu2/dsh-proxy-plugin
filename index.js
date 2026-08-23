/**
 * dsh-proxy —— 节点半区（host）入口。
 *
 * 问题：Node 的全局 fetch（undici）既不读系统代理、也不读 HTTPS_PROXY 环境变量，
 * 因此 dsh web 进程对 OpenRouter 等服务的请求直连出口 IP。当出口 IP 所在地区被
 * 服务商限制时（例如 OpenRouter 对 Claude 系模型按地区封锁），请求返回 403
 * "This model is not available in your region."，而 harness 会把 401/403 统一
 * 归类为 AUTH，界面上显示成误导性的 "API key is invalid"。
 *
 * 解法：本插件在 apply 时调用 undici 的 setGlobalDispatcher，给进程内全局 fetch
 * 挂上一个 ProxyAgent。undici 的全局 dispatcher 存放在
 * Symbol.for('undici.globalDispatcher.2') 共享符号上，所以无论进程内 import 的
 * 是哪个 undici 实例（本插件依赖的、还是 dsh 自带的），设置后 Node 全局 fetch
 * （OpenAI SDK / pi-ai / web 工具）都走该代理出口。
 *
 * 代理地址解析优先级（取第一个命中的）：
 *   1. 组合行 config.proxyUrl（cordis.patch.yml，手动覆盖，最优先）
 *   2. Windows 系统代理（注册表 ProxyEnable + ProxyServer）——自动跟随
 *      代理工具（Clash 等）的端口变化，且每 15 秒重查一次，运行中改了端口
 *      也会自动切换
 *   3. HTTPS_PROXY / https_proxy 环境变量
 *   4. 都没有 → 不设代理，保持直连（并打印提示）
 *
 * 只支持 Windows（依赖 reg.exe 读注册表）；其他平台请用 config.proxyUrl 或
 * HTTPS_PROXY 显式指定。
 */
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { spawnSync } from 'node:child_process'

export const name = 'dsh-proxy'

/** Windows 系统代理注册表位置。 */
const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
/** 系统代理重查间隔（毫秒）：运行中切换代理端口也会被跟随。 */
const CHECK_INTERVAL_MS = 15_000

/**
 * 读取 Windows 系统代理（注册表）。返回 http(s):// URL；未启用或读取失败返回 null。
 * @returns {string | null}
 */
function readSystemProxy() {
  try {
    const enable = spawnSync('reg', ['query', INTERNET_SETTINGS_KEY, '/v', 'ProxyEnable'], {
      encoding: 'utf8',
      timeout: 3000,
    })
    if (enable.status !== 0 || enable.error !== undefined || !/0x1\b/i.test(enable.stdout || '')) return null
    const server = spawnSync('reg', ['query', INTERNET_SETTINGS_KEY, '/v', 'ProxyServer'], {
      encoding: 'utf8',
      timeout: 3000,
    })
    if (server.status !== 0 || server.error !== undefined) return null
    const match = /ProxyServer\s+REG_\w+\s+(.+)/i.exec(server.stdout || '')
    const raw = match ? match[1].trim() : ''
    if (raw === '') return null
    // ProxyServer 可能是 "host:port"，也可能是分协议列表 "http=host:1;https=host:2"
    const httpEntry = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith('http='))
    const value = httpEntry ? httpEntry.slice('http='.length) : raw
    return /^https?:\/\//.test(value) ? value : `http://${value}`
  } catch {
    return null
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ proxyUrl?: string, checkIntervalMs?: number }} config 组合行 config（cordis.patch.yml）
 */
export function apply(ctx, config = {}) {
  const explicit = (typeof config.proxyUrl === 'string' && config.proxyUrl !== '') ? config.proxyUrl : undefined
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || undefined
  const checkIntervalMs = Number.isFinite(config.checkIntervalMs) && config.checkIntervalMs > 0
    ? config.checkIntervalMs
    : CHECK_INTERVAL_MS
  const previousDispatcher = getGlobalDispatcher()

  let currentUrl = null
  let currentAgent = null

  /** 应用一个代理 URL；null 表示恢复直连。URL 未变化时不动。 */
  function applyUrl(url) {
    if (url === currentUrl) return
    if (currentAgent !== null) {
      currentAgent.close().catch(() => {})
      currentAgent = null
    }
    currentUrl = url
    if (url === null) {
      setGlobalDispatcher(previousDispatcher)
      console.log('[dsh-proxy] no proxy configured; global fetch stays direct')
      return
    }
    currentAgent = new ProxyAgent(url)
    setGlobalDispatcher(currentAgent)
    console.log(`[dsh-proxy] global fetch dispatcher -> ${url}`)
  }

  /** 按优先级重算并应用代理地址。 */
  function refresh() {
    if (explicit !== undefined) {
      applyUrl(explicit)
      return
    }
    const system = readSystemProxy()
    if (system !== null) {
      applyUrl(system)
      return
    }
    if (envProxy !== undefined) {
      applyUrl(envProxy)
      return
    }
    applyUrl(null)
  }

  ctx.effect(() => {
    refresh()
    const timer = ctx.get('timer')
    if (timer === undefined || typeof timer.interval !== 'function') return undefined
    const stop = timer.interval(refresh, checkIntervalMs)
    return () => {
      stop()
      if (currentAgent !== null) {
        currentAgent.close().catch(() => {})
        currentAgent = null
      }
      setGlobalDispatcher(previousDispatcher)
    }
  }, 'dsh-proxy: global undici dispatcher')
}
