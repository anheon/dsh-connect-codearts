/**
 * 供设置页读取的只读状态路由。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/web-status.ts` — 三条加固
 *       结论：①路由必须在 `apply` 的**同步阶段**注册，放进异步流程会让注入
 *       请求晚于注册窗口，症状是插件显示「运行中」但卡片 404；②每个
 *       `register()` 的 disposer 统一收进数组，否则热重载时「新加路由忘了写
 *       卸载」会因为同路径重复注册而抛错，后面的路由全部挂不上；③所有
 *       handler 都要过 loopback 闸，否则存在 DNS-rebinding 读取面。
 * 改动：①`status` 是**只读**路由（唯一的写副作用是 `?refresh=1` 触发的目录
 *       刷新，幂等）。签到**不**走 GET —— 领取一天一次，不能因为「打开了面板」
 *       就替用户点掉，所以它是独立的 POST 路由 `welfare/claim`，只在用户显式
 *       点按钮时调；
 *       ②增加 `host` 段：把宿主 `llm` 服务眼里的 provider 状态一并报出来。
 *       起因是真机验证时发现宿主自己的 `/api/llm/*` 全部 401（要 bearer，
 *       而 bearer 从进程命令行拿不到），从 shell 侧完全看不到「provider 到底
 *       注册上没有」。让插件自己答是最省事也最可信的办法 —— 它就在那个进程里。
 *       ③增加 `settings` 段：把插件 `Config` 的**生效值**报给客户端。起因是
 *       `showCredits` 曾经只是个没人读的字段 —— 配置里关掉它胶囊照样出现。
 *       报了之后客户端才有判据，而不是靠猜。
 *       ④增加 `welfare` 段：签到/福利列表。`welfareItems()` 早就写好了，但一直
 *       没有路由出口，等于死代码。
 *
 * @module dsh-connect-codearts/web-status
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import { maskAccessKey } from './credentials.ts'
import type { CodeArtsCredentialKey } from './credentials.ts'
import { CODEARTS_WRITE_REQUEST_HEADER } from './protocol/types.ts'
import type { PreferencesPatch, PreferencesSnapshot } from './protocol/types.ts'
import type { CreditInfo, AccountInfo, ModelCatalogEntry, WelfareItem } from './upstream.ts'

/** 状态路由的绝对路径。客户端按同样的常量拼 URL。 */
export const CODEARTS_STATUS_PATH = '/plugins/dsh-connect-codearts/status'

/** 签到领取路由。POST-only，且只在用户显式点击时调。 */
export const CODEARTS_WELFARE_CLAIM_PATH = '/plugins/dsh-connect-codearts/welfare/claim'

/**
 * 偏好写入口（POST）。
 *
 * 存在的理由见 `local-state.ts` 的文件头：本机宿主的客户端服务里**没有
 * `configForms`**，浏览器半边没有写 Config 的通道，所以「哪些模型要藏」
 * 这类纯客户端选择只能由插件自己落盘，再由这条路由代写。
 */
export const CODEARTS_PREFERENCES_PATH = '/plugins/dsh-connect-codearts/preferences'

/**
 * 插件配置的生效值（客户端只读，写入走宿主的设置服务）。
 *
 * 只报客户端真正需要的字段：把整个 `Config` 原样吐出去会把将来的内部字段
 * 也锁进这条路由的契约里。
 */
export interface SettingsSnapshot {
  /** 是否启用 provider。关了之后整个插件不注册 adapter。 */
  readonly enabled: boolean
  /** 输入框旁是否显示积分胶囊。**这是 `showCredits` 的唯一消费点。** */
  readonly showCredits: boolean
  /** 目录与积分的自动刷新间隔（毫秒）。 */
  readonly pollIntervalMs: number
  /** 自定义网关地址；空串表示用官方地址。 */
  readonly gateway: string
  /** 每模型的默认思考档位。 */
  readonly defaultEfforts: Readonly<Record<string, string>>
}

/** 福利列表快照。 */
export interface WelfareSnapshot {
  readonly items: readonly WelfareItem[]
  /** 拉列表时的异常文本；成功时 null。 */
  readonly error: string | null
  /** 拉取时刻（毫秒）。失败时保留上一次成功的时间。 */
  readonly fetchedAt: number
}

/** 一次领取的结果。 */
export interface WelfareClaimResult {
  readonly ok: boolean
  /** 失败时的可执行建议（已按错误码翻译成人话）。 */
  readonly error?: string
}

type RouteAuthorization = (request: IncomingMessage) => 401 | 403 | 503 | undefined

/** 路由要读的运行时状态。 */
export interface StatusRouteDeps {
  readonly authorize: RouteAuthorization
  readonly version: string
  readonly credential: () => CodeArtsCredentialKey | undefined
  readonly credentialError: () => string | undefined
  readonly catalog: () => readonly ModelCatalogEntry[]
  readonly catalogError: () => string | undefined
  readonly fetchedAt: () => number
  readonly account: () => AccountInfo | undefined
  readonly credit: () => CreditInfo | undefined
  /** 触发一次刷新。返回后调用方重新拉一次 status 即可看到新值。 */
  readonly refresh: () => Promise<void>
  /**
   * 宿主 `llm` 服务眼里的 provider 状态。
   *
   * 单独做成一个可选依赖而不是直接在 handler 里 `ctx.get('llm')`：这个模块
   * 只依赖 node:http，保持可单测；而 `llm` 是异步才可用的服务。
   */
  readonly host?: (() => Promise<HostSnapshot>) | undefined
  /**
   * 插件 `Config` 的生效值。
   *
   * 必须现读（函数）而不是挂载时快照：宿主的设置服务允许不重挂就改配置，
   * 快照会让「关掉积分胶囊」这类改动要重启才生效。
   */
  readonly settings?: (() => SettingsSnapshot) | undefined
  /**
   * 签到/福利列表。
   *
   * 可选是因为它要打网关：纯 CLI 运行或凭据没配好时没有这个东西，此时该段
   * 报 `error` 而不是让整条路由失败。
   */
  readonly welfare?: (() => Promise<WelfareSnapshot>) | undefined
  /**
   * 领取某个活动。**只在用户显式点击时被调**。
   *
   * 不放进 GET 的 `?refresh=1` 分支里：签到一天一次，GET 可能被浏览器的预取、
   * 刷新、开发者工具的重复请求触发。
   */
  readonly claimWelfare?: ((campaignId: number) => Promise<WelfareClaimResult>) | undefined
  /**
   * 本地偏好（模型隐藏、签到记录）。
   *
   * 与 `settings` 的区别：`settings` 是宿主 Config 的**生效值**（只读），
   * 这里读的是插件自己落盘的用户选择（可写）。两者都要报出来，因为界面上
   * 它们是两件事 —— 一个是「装插件时配的」，一个是「用的时候在界面上点的」。
   */
  readonly preferences?: (() => PreferencesSnapshot | Promise<PreferencesSnapshot>) | undefined
  /**
   * 保存偏好。**只在用户显式操作时被调**。
   *
   * 收的是完整的隐藏模型列表而不是增量：浏览器手里已经有一份完整状态，传
   * 全量让服务端不需要维护「隐藏/显示」两个方向的语义，也不会出现「客户端
   * 与服务端对当前状态理解不一致」的竞态。
   */
  readonly savePreferences?: ((patch: PreferencesPatch) => Promise<PreferencesSnapshot>) | undefined
}

/** 宿主 `llm` 服务眼里的 provider 状态快照。 */
export interface HostSnapshot {
  /** `llm.listProviders()` —— 真正挂了 adapter 的路由。 */
  readonly providers: readonly { readonly id: string; readonly name: string }[]
  /** `llm.listConfigurableProviders()` —— 声明过但可能没激活的路由。 */
  readonly configurable: readonly { readonly provider: string; readonly displayName: string; readonly settingsNs: string }[]
  /** 我们自己那条路由的模型数；读不到时 null（例如 adapter 抛错）。 */
  readonly modelCount: number | null
  /** 读 `listModels` 时的异常文本。 */
  readonly modelsError: string | null
}

interface WebServer {
  readonly protocol?: string
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  }): () => void
}

const webServerOf = (ctx: Context): WebServer | undefined =>
  (ctx as unknown as { webServer?: WebServer }).webServer

/** 限制回环地址，并使用宿主服务验证浏览器会话。 */
const authorizeRoute = (
  req: IncomingMessage,
  authorize: RouteAuthorization,
): ReturnType<RouteAuthorization> => {
  const peer = req.socket.remoteAddress
  const host = req.headers.host
  if (
    (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') ||
    host === undefined ||
    !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(host)
  ) return 403
  return authorize(req)
}

/** 校验浏览器来源。DSH 桌面桥移除 Origin，由专用请求头保护其 JSON 写请求。 */
const authorizeWrite = (
  req: IncomingMessage,
  webServer: WebServer,
  authorize: RouteAuthorization,
): ReturnType<RouteAuthorization> | 415 => {
  const rejected = authorizeRoute(req, authorize)
  if (rejected !== undefined) return rejected
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return 403

  const origin = req.headers.origin
  if (origin === undefined) {
    // 普通跨源请求无法附加这个头，插件路由也不允许 CORS 预检。
    if (req.headers[CODEARTS_WRITE_REQUEST_HEADER] !== '1') return 403
  } else {
    try {
      const protocol = webServer.protocol ?? 'http:'
      if (origin !== new URL(`${protocol}//${req.headers.host}`).origin) return 403
    } catch {
      return 403
    }
  }

  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  return contentType === 'application/json' ? undefined : 415
}

const rejectionMessage = (status: 401 | 403 | 415 | 503): string =>
  ({ 401: 'unauthorized', 403: 'forbidden', 415: 'content type must be application/json', 503: '宿主鉴权服务不可用' })[status]

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/**
 * 挂载状态路由。
 *
 * 必须在 `apply` 的同步段调用（见文件头第 ① 条）。函数本身不开定时器、不读
 * 磁盘，所有副作用都由 deps 里的函数承担。
 */
export const registerStatusRoute = (ctx: Context, deps: StatusRouteDeps): (() => void) => {
  const webServer = webServerOf(ctx)
  if (webServer === undefined) {
    // 没有 webServer 服务时（例如纯 CLI 运行）静默跳过：这不是错误，
    // 宿主本来就允许不带 Web 服务启动。
    return () => undefined
  }

  return webServer.register({
    kind: 'exact',
    path: CODEARTS_STATUS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const rejected = authorizeRoute(req, deps.authorize)
      if (rejected !== undefined) {
        sendJson(res, rejected, { error: rejectionMessage(rejected) })
        return
      }

      // `?refresh=1` 触发一次刷新，但仍然是 GET + 幂等语义：重复调用只会
      // 让目录更新，不产生任何不可撤销的副作用。
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.searchParams.get('refresh') === '1') {
        try {
          await deps.refresh()
        } catch (error) {
          // 刷新失败不改变响应形状：把错误塞进 catalogError 让界面显示。
          ctx.logger?.warn?.(
            `[dsh-connect-codearts] 手动刷新失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      // host 段可能抛（provider 刚卸载、adapter 还没 ready），单独兜住：
      // 它只是诊断信息，不该让整条 status 变 500。
      let host: HostSnapshot | null = null
      let hostError: string | null = null
      if (deps.host !== undefined) {
        try {
          host = await deps.host()
        } catch (error) {
          hostError = error instanceof Error ? error.message : String(error)
        }
      }

      // 福利列表同理：它要打网关，凭据没配好或网络不通时不能连累主状态。
      let welfare: WelfareSnapshot | null = null
      if (deps.welfare !== undefined) {
        try {
          welfare = await deps.welfare()
        } catch (error) {
          welfare = {
            items: [],
            error: error instanceof Error ? error.message : String(error),
            fetchedAt: 0,
          }
        }
      }

      const credential = deps.credential()
      const catalog = deps.catalog()
      const account = deps.account()
      const accountName = account?.userName ?? account?.domainName
      sendJson(res, 200, {
        version: deps.version,
        credential:
          credential === undefined
            ? { signedIn: false, error: deps.credentialError() ?? null }
            : {
                signedIn: true,
                accessKey: maskAccessKey(credential.accessKey),
                source: credential.source,
              },
        catalog: {
          total: catalog.length,
          fetchedAt: deps.fetchedAt(),
          error: deps.catalogError() ?? null,
          models: catalog.map((entry) => ({
            id: entry.id,
            name: entry.name,
            contextWindow: entry.contextWindow,
            maxTokens: entry.maxTokens,
            supportsImages: entry.supportsImages,
            ratio: entry.ratioDisplay ?? null,
            strengths: entry.strengths,
          })),
        },
        account: account === undefined ? null : {
          label: accountName === undefined ? null : accountName.length > 6 ? `…${accountName.slice(-6)}` : '…',
          roles: account.roles,
        },
        credit: deps.credit() ?? null,
        /**
         * 配置的生效值。客户端拿它决定「胶囊要不要显示」这类事 ——
         * 以前 `showCredits` 没有人读，配置里关掉也不生效。
         *
         * 没传依赖时报 `null` 而不是空对象：空对象会让客户端以为「全部取默认」，
         * 与「这一版宿主没这个能力」是两件事。
         */
        settings: deps.settings?.() ?? null,
        /** 签到/福利列表。`items` 为空 + `error` 非 null 表示拉取失败。 */
        welfare: welfare,
        /**
         * 用户在本机界面上的选择（可写的那部分）。
         *
         * 与 `settings` 并列而不是合并：`settings` 是宿主 Config 的生效值，
         * 改它要动 profile 的 patch yaml；这个是我们自己状态文件里的东西，
         * 改它只碰 `$DSH_HOME/.codearts-state.json`。界面上前者只读、后者可改。
         */
        preferences: (await deps.preferences?.()) ?? null,
        /**
         * 宿主眼里的我们。用于回答「模型真的进选择器了吗」——这个问题的
         * 唯一可信来源是宿主自己的 `llm` 服务，而它的 HTTP API 要 bearer。
         */
        host: host === null ? { error: hostError } : { ...host, error: hostError },
      })
    },
  })
}

/**
 * 挂载偏好写入口。
 *
 * 保存模型可见性和自动签到偏好。使用与领取路由相同的会话及来源校验。
 */
export const registerPreferencesRoute = (
  ctx: Context,
  deps: Pick<StatusRouteDeps, 'authorize' | 'savePreferences'>,
): (() => void) => {
  const webServer = webServerOf(ctx)
  if (webServer === undefined) return () => undefined

  return webServer.register({
    kind: 'exact',
    path: CODEARTS_PREFERENCES_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const rejected = authorizeWrite(req, webServer, deps.authorize)
      if (rejected !== undefined) {
        sendJson(res, rejected, { ok: false, error: rejectionMessage(rejected) })
        return
      }
      if (deps.savePreferences === undefined) {
        sendJson(res, 503, { ok: false, error: '偏好保存未启用' })
        return
      }

      let raw: string
      try {
        raw = await readBody(req)
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }

      let patch: PreferencesPatch
      try {
        const parsed: unknown = raw.trim() === '' ? undefined : JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { ok: false, error: 'body 必须是 JSON 对象' })
          return
        }
        const { hiddenModelIds, autoCheckin } = parsed as { hiddenModelIds?: unknown; autoCheckin?: unknown }

        if (autoCheckin !== undefined && typeof autoCheckin !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'autoCheckin 必须是布尔值' })
          return
        }
        if (
          hiddenModelIds !== undefined &&
          (!Array.isArray(hiddenModelIds) || hiddenModelIds.some((id) => typeof id !== 'string'))
        ) {
          sendJson(res, 400, { ok: false, error: 'hiddenModelIds 必须是字符串数组' })
          return
        }
        patch = {
          ...(autoCheckin === undefined ? {} : { autoCheckin }),
          ...(hiddenModelIds === undefined ? {} : { hiddenModelIds: [...new Set<string>(hiddenModelIds)].filter(Boolean) }),
        }
      } catch {
        sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' })
        return
      }

      try {
        const saved = await deps.savePreferences(patch)
        sendJson(res, 200, { ok: true, preferences: saved })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}

/**
 * 挂载签到领取路由。
 *
 * 与 `status` 分开的理由写在文件头第 ① 条：这是**唯一有真实副作用**的端点
 * （一天只能领一次），绝不能挂在 GET 上 —— 浏览器预取、页面刷新、开发者工具
 * 的重复请求都会把它触发掉。
 *
 * 三重闸门与 status 一致：方法必须是 POST、Host 必须回环、body 必须是
 * `{campaignId: number}`。少了任何一道，本机任意进程都能替用户签到。
 */
export const registerWelfareClaimRoute = (
  ctx: Context,
  deps: Pick<StatusRouteDeps, 'authorize' | 'claimWelfare'>,
): (() => void) => {
  const webServer = webServerOf(ctx)
  if (webServer === undefined) return () => undefined

  return webServer.register({
    kind: 'exact',
    path: CODEARTS_WELFARE_CLAIM_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // POST 是硬要求：GET 会被预取，HEAD 会被健康检查打到。
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const rejected = authorizeWrite(req, webServer, deps.authorize)
      if (rejected !== undefined) {
        sendJson(res, rejected, { ok: false, error: rejectionMessage(rejected) })
        return
      }
      if (deps.claimWelfare === undefined) {
        sendJson(res, 503, { ok: false, error: '签到功能未启用' })
        return
      }

      // 先把 body 读全再判：`campaignId` 只接受正整数，别的形状一律拒绝，
      // 不要「猜一个默认值」—— 猜错会领到别的活动。
      let raw: string
      try {
        raw = await readBody(req)
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }

      let campaignId: number | undefined
      try {
        const parsed: unknown = raw.trim() === '' ? undefined : JSON.parse(raw)
        const value =
          parsed !== null && typeof parsed === 'object'
            ? (parsed as { campaignId?: unknown }).campaignId
            : undefined
        if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) campaignId = value
      } catch {
        // 落到下面统一报 400。
      }
      if (campaignId === undefined) {
        sendJson(res, 400, { ok: false, error: 'body 必须是 {"campaignId": 正整数}' })
        return
      }

      try {
        const result = await deps.claimWelfare(campaignId)
        sendJson(res, 200, result)
      } catch (error) {
        // 领取失败是业务结果而不是路由故障，仍然 200 + ok:false，
        // 让界面用同一条路径显示建议。
        sendJson(res, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}

/** 读请求体，带上限。没上限时一个坏请求能把内存吃穿。 */
const readBody = async (req: IncomingMessage): Promise<string> => {
  const MAX_BYTES = 16 * 1024
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buffer.length
    if (total > MAX_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
