/**
 * 插件宿主入口：把码道接成 DSH 的一个 LLM provider。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/index.ts` — 装配顺序（先起
 *       传输层 → 构造 provider → 注册 adapter 与可配置 provider → 异步刷新
 *       目录）与 `settingsNamespaceOf()` 从 profile entry 取真实命名空间的做法。
 * 参考：dsh-huaweicloud-connect（MIT, Alanine-孔硕）`lib/index.js` — 把厂商
 *       差异收进 driver 的写法，以及「webServer 路由必须在 apply 同步阶段注册」
 *       这条踩坑结论。
 * 改动：**没有回环 shim**，因此装配里少了「等服务监听 → 才注册 adapter」这一
 *       整个异步前置；适配器可以直接同步注册。目录发现走宿主的
 *       `registerModelDiscovery`，所以模型清单是点击即生效的，不需要参考实现
 *       那种「启动时拉清单 → 重写 cordis.patch.yml → 重启生效」。
 *
 * @module dsh-connect-codearts/index
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

import { CodeArtsAdapter, CODEARTS_PROVIDER, CODEARTS_PROVIDER_DISPLAY_NAME } from './adapter.ts'
import { loadCredentials, maskAccessKey, resolveCodeArtsHome } from './credentials.ts'
import { createImageResolver } from './image-input.ts'
import {
  applyHidden,
  loadLocalState,
  localDateKey,
  normalizeState,
  saveLocalState,
} from './local-state.ts'
import type { LocalState } from './local-state.ts'
import type { CodeArtsCredentialKey } from './credentials.ts'
import type { CodeArtsCredentials } from './protocol/sign.ts'
import { CODEARTS_GATEWAY, CODEARTS_POLL_INTERVALS_MS, CODEARTS_THINKING_VARIANTS_PATH } from './protocol/types.ts'
import type { AccountInfo, CreditInfo, ModelCatalogEntry, WelfareItem } from './upstream.ts'
import { CodeArtsUpstreamClient } from './upstream.ts'
import {
  registerPreferencesRoute,
  registerSettingsRoute,
  registerStatusRoute,
  registerWelfareClaimRoute,
} from './web-status.ts'
import type { PreferencesPatch, PreferencesSnapshot, SettingsSnapshot } from './protocol/types.ts'
import type { WelfareSnapshot } from './web-status.ts'

/** 插件在 profile 里的 entry id。宿主用它做设置命名空间。 */
export const name = 'dsh-connect-codearts'

/**
 * 版本号。
 *
 * 由 tsdown 的 `define` 在构建期注入（见 `tsdown.config.ts`），因此运行期是
 * 一个常量字符串而不是读 package.json —— `bin.ts` 在纯 Node 解析下跑，
 * 那里用相对路径读包元数据会因为 `lib/` 与 `src/` 层级差异而找错文件。
 */
declare const __DSH_CODEARTS_VERSION__: string
export const VERSION: string =
  typeof __DSH_CODEARTS_VERSION__ === 'string' ? __DSH_CODEARTS_VERSION__ : '0.0.0-dev'

/**
 * 依赖的宿主服务。
 *
 * `llm` 是硬依赖（没有它整个插件无意义）；`settings` 让用户的配置有地方落盘。
 * 两个都是宿主自带服务，写进 inject 不会让 apply 永不运行。
 */
export const inject = ['llm', 'settings']

/**
 * 设置命名空间。
 *
 * 必须取**宿主真实使用的那个**：宿主按精确匹配查表，宣告错名字会让 provider
 * 被判「未配置」，配置入口与模型发现双双静默失效 —— 不报错，只是什么都不
 * 发生，非常难查。`ctx.fiber.entry?.options.id` 是 profile 里的 entry id，
 * 取不到才回落到包名（开发期单测会走这条）。
 */
export const settingsNamespaceOf = (ctx: unknown): SettingsNamespace => {
  const fiber = (ctx as { fiber?: { entry?: { options?: { id?: unknown } } } } | undefined)?.fiber
  const id = fiber?.entry?.options?.id
  return (typeof id === 'string' && id !== '' ? id : name) as SettingsNamespace
}

/** DSH 的 volatile 配置是实时引用；直接调用插件入口时也接受普通配置。 */
type Setting<T> = T | { get(): T }

const readSetting = <T>(setting: Setting<T> | undefined): T | undefined =>
  typeof setting === 'object' && setting !== null && 'get' in setting && typeof setting.get === 'function'
    ? setting.get()
    : setting as T | undefined

/** 默认 5 分钟。码道的模型目录与积分都不需要秒级新鲜度。 */
const DEFAULT_POLL_INTERVAL_MS = 300_000

/**
 * 插件配置。
 *
 * 两处非显然的取舍：
 *   - AK/SK 由独立的凭据探测链读取，避免进入宿主设置文件和配置导出。
 *   - `defaultEfforts` 按模型配置。码道同一台网关上
 *     只有部分模型声明了思考档位（M0 实测 12 个模型里只有 GLM-5.2 有
 *     high/max），一个全局默认值对多数模型无意义。
 */
export interface Config {
  /** 关掉整个 provider（不注册 adapter）。默认开。 */
  enabled?: boolean
  /** 目录与积分的自动刷新间隔。 */
  pollIntervalMs?: Setting<number>
  /** 用户可覆盖网关地址（企业内网代理场景）。只接受 https。 */
  gateway?: string
  /** 每个模型默认的思考档位，键是 model id。 */
  defaultEfforts?: Setting<Readonly<Record<string, string>>>
  /** 是否在输入框显示积分胶囊。 */
  showCredits?: Setting<boolean>
  /**
   * 每日自动签到。
   *
   * 默认开启。签到页保存的本机偏好优先于初始配置。
   * 开启时随定时刷新检查可领取的登录奖励，领取记录按本地日期归档。
   */
  autoCheckin?: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用码道 CodeArts provider。'),
  pollIntervalMs: z
    .union(CODEARTS_POLL_INTERVALS_MS.map((ms) => z.const(ms)))
    .default(DEFAULT_POLL_INTERVAL_MS)
    .description('模型目录与积分的自动刷新间隔。')
    .volatile(),
  gateway: z
    .string()
    .default('')
    .description('自定义网关地址（留空用官方地址）。企业内网代理才需要改。'),
  defaultEfforts: z
    .dict(z.string())
    .default({})
    .description('每个模型默认的思考档位，键是模型 id，值是档位名。')
    .volatile(),
  showCredits: z.boolean().default(true).description('在输入框旁显示积分读数。').volatile(),
  autoCheckin: z.boolean().default(true).description('自动签到的初始值，签到页保存的开关优先。'),
})

/** 目录与档位的运行时缓存。 */
interface CatalogCache {
  entries: readonly ModelCatalogEntry[]
  variants: ReadonlyMap<string, { strengths: readonly string[]; defaultStrength?: string }>
  fetchedAt: number
  error?: string
}

const emptyCache = (): CatalogCache => ({ entries: [], variants: new Map(), fetchedAt: 0 })

/** `LoadResult.key` → 上游要的形状。少一层字段，避免把来源信息带进请求路径。 */
const toUpstreamCredentials = (key: CodeArtsCredentialKey): CodeArtsCredentials => ({
  accessKey: key.accessKey,
  secretKey: key.secretKey,
})

/**
 * 挂载插件。
 *
 * 结构上刻意把「注册」放在同步段、把「刷新目录」放在异步段：宿主的
 * `registerModelDiscovery` 本身是惰性的（用户点「刷新」才调），所以目录为空
 * 时 provider 只是暂时不出现在选择器里，等第一次刷新完成就出现。反过来做
 * （等目录到手再注册）会让 provider 在冷启动时闪一下再消失。
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return

  const settingsNs = settingsNamespaceOf(ctx)
  const gateway = config.gateway?.trim()
  const client = new CodeArtsUpstreamClient(gateway ? { gateway } : {})
  const dshHome = resolveCodeArtsHome()

  let cache: CatalogCache = emptyCache()
  let credential: CodeArtsCredentialKey | undefined
  let credentialError: string | undefined
  let credentialLoading: Promise<CodeArtsCredentialKey | undefined> | undefined
  let account: AccountInfo | undefined
  let credit: CreditInfo | undefined
  /** 上一次成功拉到的签到列表；`loadWelfare` 失败时拿它兜底。 */
  let welfare: WelfareSnapshot | undefined
  let stopped = false

  /**
   * 本机状态：模型隐藏表 + 签到记录。
   *
   * 初始值是空状态（同步可得），磁盘版本在异步段读进来替换。**不能等磁盘**：
   * `hiddenModels()` 会在 `listModels` 里被调用，而宿主可能在 `apply` 之后
   * 立刻就来问 —— 那时磁盘还没读完，必须有一个可用的默认值。
   */
  let localState: LocalState = { hiddenModelIds: [], lastCheckin: undefined }
  const stateReady = loadLocalState(dshHome).then((loaded) => {
    localState = loaded
  })
  let stateWrites = stateReady

  const updateLocalState = (patch: Partial<LocalState>): Promise<void> => {
    const write = stateWrites.then(async () => {
      const next = normalizeState({ ...localState, ...patch })
      await saveLocalState(dshHome, next)
      localState = next
    })
    stateWrites = write.catch(() => undefined)
    return write
  }
  /**
   * 隐藏表读数器。
   *
   * 每次调用现算一个 `Set`，而不是缓存一份：隐藏表由 HTTP 路由修改，
   * 缓存就要记得在每条写路径上失效 —— 少一处就是「勾了没生效」。候选集
   * 只有十几个 id，现算比维护失效成本低。
   */
  const hiddenModels = (): ReadonlySet<string> => new Set(localState.hiddenModelIds)
  /** 自动签到的进行中标记，防两轮刷新并发各领一次。 */
  let checkinInFlight = false
  /** 已领取、待落盘的结果。写盘失败时下一轮只重试写盘。 */
  let pendingCheckin: LocalState['lastCheckin']

  const defaultEfforts = (): ReadonlyMap<string, string> =>
    new Map(Object.entries(readSetting(config.defaultEfforts) ?? {}))

  const pollInterval = (): number => readSetting(config.pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS

  const settingsSnapshot = (): SettingsSnapshot => {
    const descriptor = ctx.settings?.describe({ redactSecrets: true }).find((row) => row.ns === settingsNs)
    return {
      enabled: config.enabled !== false,
      showCredits: readSetting(config.showCredits) !== false,
      pollIntervalMs: pollInterval(),
      gateway: config.gateway ?? '',
      defaultEfforts: { ...readSetting(config.defaultEfforts) },
      ...(descriptor === undefined || typeof ctx.settings?.mutate !== 'function' ? {} : { revision: descriptor.revision }),
    }
  }

  /** 按来源优先级读取凭据，合并同一时间的探测。 */
  const ensureCredential = async (reload = false): Promise<CodeArtsCredentialKey | undefined> => {
    if (stopped) return undefined
    if (credentialLoading !== undefined) return credentialLoading
    if (!reload && (credential !== undefined || credentialError !== undefined)) return credential

    credentialLoading = loadCredentials(dshHome).then((result) => {
      if (stopped) return undefined
      const key = result.key
      if (
        key?.accessKey !== credential?.accessKey ||
        key?.secretKey !== credential?.secretKey ||
        key?.source !== credential?.source ||
        key?.origin !== credential?.origin
      ) {
        credential = key
        cache = emptyCache()
        account = undefined
        credit = undefined
        welfare = undefined
        if (key !== undefined) {
          ctx.logger?.info?.(
            `[${name}] 凭据已就绪：${maskAccessKey(key.accessKey)}（来源 ${key.source}）`,
          )
        }
      }
      if (credential !== undefined) {
        credentialError = undefined
        return credential
      }
      const reasons = result.attempts
        .filter((attempt) => !attempt.ok)
        .map((attempt) => `${attempt.source}(${attempt.reason ?? '未找到'})`)
        .join('、')
      credentialError = `没有读到码道的 AK/SK。已尝试：${reasons}。请在华为云控制台「访问密钥」创建并下载 CSV，或设置环境变量 CODEARTS_CLI_AK / CODEARTS_CLI_SK。`
      return undefined
    })
    try {
      return await credentialLoading
    } finally {
      credentialLoading = undefined
    }
  }

  /**
   * 刷新目录与档位。
   *
   * 两处保护：
   *   - 档位查询失败**不影响**目录 —— 它是纯增强信息，M0 实测 12 个模型里只有
   *     一个声明了档位，为了它让整个目录失败不值得。
   *   - 目录失败时**保留上次成功的结果**，不让一次网络抖动把 provider 从选择器
   *     里抹掉。
   *
   * 账号与积分也在这一趟里拉：它们和目录的刷新节奏一致，分成两个定时器只会
   * 让网关多收一倍请求。两者都是「拿不到就算了」的展示信息，失败不影响对话。
   */
  const refresh = async (reloadCredential = false): Promise<CatalogCache> => {
    if (stopped) return cache
    const key = await ensureCredential(reloadCredential || credential === undefined)
    if (key === undefined) return cache

    const credentials = toUpstreamCredentials(key)
    try {
      const entries = await client.listModels(credentials)
      const variants = await client.thinkingVariants(
        credentials,
        entries.map((entry) => entry.id),
      )
      if (stopped || credential !== key) return cache
      cache = { entries, variants, fetchedAt: Date.now() }
    } catch (error) {
      if (stopped || credential !== key) return cache
      const message = error instanceof Error ? error.message : String(error)
      cache = { ...cache, error: message }
      ctx.logger?.warn?.(`[${name}] 刷新模型目录失败：${message}`)
    }

    // 展示信息，失败静默：不让「积分接口挂了」表现成「模型不能用」。
    try {
      const current = await client.currentUser(credentials)
      if (stopped || credential !== key) return cache
      account = current
    } catch {
      // 保留上一次成功的值。
    }
    try {
      if (stopped || credential !== key) return cache
      const current = await client.credit(credentials)
      if (!stopped && credential === key) credit = current
    } catch {
      // 同上。
    }

    return cache
  }

  /**
   * 拉签到/福利列表。
   *
   * 状态接口按需读取列表。后台只在今日尚未签到时查询领取资格。
   * 拉取失败时保留上一次成功的福利列表。
   */
  const loadWelfare = async (): Promise<WelfareSnapshot> => {
    const key = await ensureCredential()
    const previous = welfare
    if (key === undefined) {
      return {
        items: previous?.items ?? [],
        error: credentialError ?? '没有读到码道的 AK/SK',
        fetchedAt: previous?.fetchedAt ?? 0,
      }
    }
    try {
      const items = await client.welfareItems(toUpstreamCredentials(key))
      if (stopped || credential !== key) {
        return welfare ?? { items: [], error: null, fetchedAt: 0 }
      }
      welfare = { items, error: null, fetchedAt: Date.now() }
      return welfare
    } catch (error) {
      if (stopped || credential !== key) {
        return welfare ?? { items: [], error: null, fetchedAt: 0 }
      }
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[${name}] 读取签到列表失败：${message}`)
      return {
        items: previous?.items ?? [],
        error: message,
        fetchedAt: previous?.fetchedAt ?? 0,
      }
    }
  }

  const autoCheckinEnabled = (): boolean =>
    localState.autoCheckin ?? (config.autoCheckin !== false)

  /** 状态与偏好接口共用一份快照，日期按宿主本地时区计算。 */
  const preferencesSnapshot = (): PreferencesSnapshot => {
    const lastCheckin = pendingCheckin ?? localState.lastCheckin
    return {
      hiddenModelIds: [...localState.hiddenModelIds],
      lastCheckin: lastCheckin ?? null,
      checkedInToday: lastCheckin?.date === localDateKey(),
      autoCheckin: autoCheckinEnabled(),
    }
  }

  /**
   * 写本机偏好。
   *
   * 只处理「用户改了什么」，磁盘与内存的顺序是**先落盘再生效**：反过来
   * （先改内存再落盘）在落盘失败时会留下「界面说已隐藏、重启后又出现」的
   * 假象，用户会以为插件记不住设置。
   */
  const persistPreferences = async (patch: PreferencesPatch): Promise<PreferencesSnapshot> => {
    if (patch.autoCheckin === undefined && patch.hiddenModelIds === undefined) {
      await stateWrites
      return preferencesSnapshot()
    }
    await updateLocalState(patch)
    if (patch.hiddenModelIds !== undefined) {
      // 通知宿主刷新模型选择器。
      ;(ctx as unknown as { emit?: (type: string) => void }).emit?.('llm/adapters-updated')
    }
    return preferencesSnapshot()
  }

  /** 每轮刷新检查登录奖励，领取成功后通过偏好队列保存结果。 */
  const runAutoCheckin = async (): Promise<void> => {
    if (checkinInFlight || stopped) return
    checkinInFlight = true
    try {
      await stateReady
      if (stopped) return
      if (pendingCheckin !== undefined) {
        await updateLocalState({ lastCheckin: pendingCheckin })
        pendingCheckin = undefined
      }
      if (!autoCheckinEnabled() || localState.lastCheckin?.date === localDateKey()) return

      const key = await ensureCredential()
      if (key === undefined || stopped || !autoCheckinEnabled()) return
      const credentials = toUpstreamCredentials(key)
      const items = await client.welfareItems(credentials)
      if (stopped || credential !== key) return
      welfare = { items, error: null, fetchedAt: Date.now() }
      const daily = items.find((item) => item.type === 'USER_LOGIN' && item.claimable)
      if (daily === undefined || !autoCheckinEnabled()) return

      const result = await client.claimWelfare(credentials, daily.campaignId)
      if (!result.ok) {
        ctx.logger?.debug?.(`[${name}] 自动签到未成功：${result.error?.message ?? '原因未知'}`)
        return
      }

      if (stopped || credential !== key) return
      const now = new Date()
      pendingCheckin = {
        date: localDateKey(now),
        at: now.getTime(),
        ...(daily.benefitAmount === undefined ? {} : { amount: daily.benefitAmount }),
      }
      await updateLocalState({ lastCheckin: pendingCheckin })
      pendingCheckin = undefined
      ctx.logger?.info?.(`[${name}] 已自动领取今日签到奖励`)
      const updated = await client.credit(credentials)
      if (!stopped && credential === key && updated !== undefined) credit = updated
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.debug?.(`[${name}] 自动签到流程失败：${message}`)
    } finally {
      checkinInFlight = false
    }
  }

  ctx.effect(() => {
    let polling = false
    const poll = async (): Promise<void> => {
      if (stopped || polling) return
      polling = true
      try {
        await stateReady
        await refresh()
        await runAutoCheckin()
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] 定时刷新失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        polling = false
      }
    }

    let interval = pollInterval()
    let timer = setInterval(() => void poll(), interval)
    timer.unref?.()
    ctx.on?.('settings/document-updated', (ns) => {
      if (ns !== settingsNs || stopped) return
      const next = pollInterval()
      if (next === interval) return
      clearInterval(timer)
      interval = next
      timer = setInterval(() => void poll(), interval)
      timer.unref?.()
    })
    void poll()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, `${name}: catalog refresh`)

  const adapter = new CodeArtsAdapter({
    client,
    credentials: async () => {
      const key = await ensureCredential()
      return key === undefined ? undefined : toUpstreamCredentials(key)
    },
    catalog: () => cache.entries,
    thinkingVariants: () => cache.variants,
    hiddenModels,
    defaultEfforts,
    resolveImage: createImageResolver(() => ctx.get('attachments')),
    log: (line) => ctx.logger?.debug?.(line),
  })

  /**
   * 注册路由。
   *
   * 顺序不能反：`registerConfigurableProviders` 会校验 provider 是否已经有
   * adapter，先声明目录再注册 adapter 会抛错。两处 register 都是「全有或全无」，
   * 一处在 finally 里回滚另一处，避免半挂状态。
   */
  ctx.llm.registerAdapter([CODEARTS_PROVIDER], adapter)

  const directory = ctx.llm.registerConfigurableProviders([
    {
      provider: CODEARTS_PROVIDER,
      displayName: CODEARTS_PROVIDER_DISPLAY_NAME,
      settingsNs,
      settingsPath: [],
      declared: false,
      defaultBaseURL: 'https://snap-access.cn-north-4.myhuaweicloud.com',
      baseURLEnv: ['CODEARTS_GATEWAY'],
    },
  ])

  ctx.effect(
    () => () => {
      directory()
    },
    `${name}: provider directory`,
  )

  /**
   * 模型发现。
   *
   * 宿主点「刷新」时调这个函数，所以这里可以放网络请求。返回的
   * `contextWindow` / `maxTokens` 用网关直出的**真实值**：放大窗口会让超限
   * 变成「网关静默截断」（M0 实测 900KB 打 202752 窗口返回 `finish=stop`），
   * 比报错更难排查。
   */
  ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
    if (request.provider !== undefined && request.provider !== CODEARTS_PROVIDER) return []
    await stateReady
    const fresh = await refresh(true)
    // 隐藏的模型要从发现结果里剔除 —— 模型选择器的条目就是从这里来的。
    // `listModels` 里还有一道同样的过滤（那是宿主其它路径读模型的入口），
    // 两处都要有：只在 adapter 过滤的话「刷新」会先把隐藏项画出来再消失。
    return applyHidden(fresh.entries, hiddenModels()).map((entry) => ({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      inputModalities: entry.supportsImages ? (['text', 'image'] as const) : (['text'] as const),
    }))
  })

  /**
   * 状态路由。
   *
   * **必须在 apply 的同步段注册**：放进异步流程会让宿主的注入请求晚于注册
   * 窗口，症状是插件显示「运行中」但设置页一直读到 404 —— 而客户端失败是
   * 被 try/catch 吞成一条 console.error 的，界面上完全看不出来。
   */
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const connection = webCtx.get('connection') as {
      requestRejection?: (request: IncomingMessage) => 401 | 403 | undefined
    } | undefined
    const authorization = {
      authorize: (request: IncomingMessage): 401 | 403 | 503 | undefined =>
        connection?.requestRejection === undefined ? 503 : connection.requestRejection(request),
    }

    const dispose = registerStatusRoute(webCtx, {
      ...authorization,
      version: VERSION,
      credential: () => credential,
      credentialError: () => credentialError,
      catalog: () => cache.entries,
      catalogError: () => cache.error,
      fetchedAt: () => cache.fetchedAt,
      account: () => account,
      credit: () => credit,
      refresh: async () => {
        await refresh(true)
      },
      settings: settingsSnapshot,
      welfare: () => loadWelfare(),
      /**
       * 本机偏好（模型隐藏 + 签到记录）。
       *
       * 与 `settings` 并列而不是合并：`settings` 是宿主 Config 的**生效值**，
       * 只读、由 patch yaml 决定；`preferences` 是插件自己状态文件里的东西，
       * 可改、只影响这台机器。两者来源不同、可写性不同，混在一个对象里会让
       * 客户端分不清「这个字段能不能保存」。
       *
       * `checkedInToday` 在服务端算：客户端自己算就要复制一份日界逻辑，
       * 两边的时区处理一旦不一致，界面会说「今日已签」而实际没签。
       */
      preferences: async () => {
        await stateReady
        return preferencesSnapshot()
      },
      /**
       * 宿主眼里的我们。
       *
       * 真机验证时踩到的死路：宿主自己的 `/api/llm/providers`、`/api/llm/models`
       * 全部 401（要 bearer，而 bearer 从进程命令行拿不到），所以从 shell 侧
       * 完全无法回答「模型到底进选择器了没有」。插件自己就在宿主进程里，让
       * 它顺手把 `llm` 服务的读结果报出来，比任何外部手段都直接。
       */
      host: async () => {
        const llm = ctx.get('llm') as
          | {
              listProviders(): { id: string; name: string }[]
              listConfigurableProviders(): { provider: string; displayName: string; settingsNs: string }[]
              listModels(provider: string): Promise<{ id: string; name: string }[]>
            }
          | undefined
        if (llm === undefined) {
          throw new Error('宿主没有 llm 服务')
        }
        const providers = llm.listProviders()
        const configurable = llm.listConfigurableProviders()
        let modelCount: number | null = null
        let modelsError: string | null = null
        try {
          modelCount = (await llm.listModels(CODEARTS_PROVIDER)).length
        } catch (error) {
          modelsError = error instanceof Error ? error.message : String(error)
        }
        return { providers, configurable, modelCount, modelsError }
      },
    })
    webCtx.effect(() => dispose, `${name}: status route`)

    /**
     * 签到领取路由。
     *
     * 独立注册、POST-only。挂载顺序紧跟 status，两者独立：签到端点坏了不该
     * 影响主状态，反之亦然。
     */
    const disposeClaim = registerWelfareClaimRoute(webCtx, {
      ...authorization,
      claimWelfare: async (campaignId) => {
        const key = await ensureCredential()
        if (key === undefined) {
          return { ok: false, error: credentialError ?? '没有读到码道的 AK/SK' }
        }
        const result = await client.claimWelfare(toUpstreamCredentials(key), campaignId)
        if (result.ok) {
          // 领到了就把列表刷新一遍，界面上的 `claimable` 才是新状态。
          void loadWelfare()
          // 积分也变了，但那次刷新走定时器更省事 —— 这里顺手触发一次目录刷新，
          // 让用户点完「领取」再点「刷新」能看到余额变多。
          void refresh()
          return { ok: true }
        }
        return {
          ok: false,
          error: result.error?.hint ?? result.error?.message ?? '领取失败，原因未知',
        }
      },
    })
    webCtx.effect(() => disposeClaim, `${name}: welfare claim route`)

    /**
     * 本机偏好写入口。
     *
     * 单独一条路由而不是并进 claim：两者语义无关（一个是动积分、一个是动
     * 界面可见性），合成一条会让任何一边的校验规则污染另一边。
     */
    if (typeof ctx.settings?.mutate === 'function') {
      const disposeSettings = registerSettingsRoute(webCtx, {
        ...authorization,
        save: async (values, revision) => {
          await ctx.settings.mutate(settingsNs, [
            { op: 'set', path: ['showCredits'], value: values.showCredits },
            { op: 'set', path: ['pollIntervalMs'], value: values.pollIntervalMs },
            { op: 'set', path: ['defaultEfforts'], value: values.defaultEfforts },
          ], revision)
          return settingsSnapshot()
        },
      })
      webCtx.effect(() => disposeSettings, `${name}: settings route`)
    }

    const disposePreferences = registerPreferencesRoute(webCtx, {
      ...authorization,
      savePreferences: persistPreferences,
    })
    webCtx.effect(() => disposePreferences, `${name}: preferences route`)
  })

  ctx.logger?.info?.(
    `[${name}] 已注册 provider "${CODEARTS_PROVIDER}"（设置命名空间 ${String(settingsNs)}），模型目录异步刷新中`,
  )
}

/** 供 `bin.ts` 与测试复用的内部快照。 */
export const internals = {
  POLL_INTERVALS_MS: CODEARTS_POLL_INTERVALS_MS,
  DEFAULT_POLL_INTERVAL_MS,
  CODEARTS_THINKING_VARIANTS_PATH,
  emptyCache,
} as const
