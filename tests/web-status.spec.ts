/**
 * `status` 路由的契约测试。
 *
 * 存在理由：这条路由是插件**唯一**的运行时观测窗口。真机验证时发现宿主自己的
 * `/api/llm/*` 全部 401（要 bearer，而 bearer 从进程命令行拿不到），所以
 * 「provider 到底注册上没有」只能由插件自己回答 —— 这条路由挂了就彻底失明。
 *
 * 因此这里不测 JSON 的每个字段（那是实现细节），只钉四件会静默出事的事：
 *   ① loopback 闸真的拦非本机 Host（DNS rebinding 面）
 *   ② `host` 段抛错时整条路由仍然 200，错误被降级进 `host.error`
 *      —— 诊断信息不该让主状态变 500，否则出问题时正好看不到出问题
 *   ③ 没配 `host` 依赖时该段退化成 `{ error: null }`
 *   ④ `?refresh=1` 的刷新失败不改变响应形状，但要留 warn 日志
 *
 * @module dsh-connect-codearts/tests/web-status
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { registerStatusRoute } from '../src/web-status.ts'
import type { StatusRouteDeps } from '../src/web-status.ts'

interface Captured {
  readonly status: number
  readonly payload: Record<string, unknown>
}

/**
 * 造一套最小的 ctx/req/res，把 handler 截下来手动调用。
 *
 * 不用真起 HTTP 服务：起服务会引入端口、超时、并发三个不稳定源，而这个测试
 * 要验的是 handler 对输入的响应，与网络无关。
 *
 * `host: null` 表示**不带 Host 头**；不传则默认给一个回环 Host，让大部分用例
 * 不必每次都重复写它。
 */
const invoke = async (
  deps: Partial<StatusRouteDeps>,
  options: {
    readonly host?: string | null
    readonly url?: string
    readonly method?: string
    readonly remoteAddress?: string
  } = {},
): Promise<Captured> => {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const logger = { warn: vi.fn() }
  const ctx = {
    logger,
    webServer: {
      register: (route: { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        handler = route.handler
        return () => undefined
      },
    },
  }

  registerStatusRoute(ctx as never, {
    authorize: () => undefined,
    version: '9.9.9',
    credential: () => undefined,
    credentialError: () => undefined,
    catalog: () => [],
    catalogError: () => undefined,
    fetchedAt: () => 0,
    account: () => undefined,
    credit: () => undefined,
    refresh: async () => undefined,
    ...deps,
  })

  if (handler === undefined) throw new Error('handler 没被注册')

  const host = options.host === undefined ? '127.0.0.1:63496' : options.host
  const req = {
    method: options.method ?? 'GET',
    url: options.url ?? '/plugins/dsh-connect-codearts/status',
    headers: host === null ? {} : { host },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  }

  let status = 0
  let payload: Record<string, unknown> = {}
  const res = {
    writeHead: (code: number) => {
      status = code
      return res
    },
    end: (body: string) => {
      payload = JSON.parse(body) as Record<string, unknown>
      return res
    },
  }

  await handler(req as never, res as never)
  return { status, payload }
}

describe('status 路由 — 来源闸', () => {
  it('非本机 Host 一律 403（DNS rebinding 面）', async () => {
    const result = await invoke({}, { host: 'evil.example' })
    expect(result.status).toBe(403)
    expect(result.payload).toEqual({ error: 'forbidden' })
  })

  it('没有 Host 头的请求也拒绝', async () => {
    const result = await invoke({}, { host: null })
    expect(result.status).toBe(403)
  })

  // 三种回环写法都要放行。IPv6 字面量带方括号，是最容易写错的一种。
  it.each(['127.0.0.1:63496', 'localhost:63496', '[::1]:63496'])('放行回环 Host %s', async (host) => {
    const result = await invoke({}, { host })
    expect(result.status).toBe(200)
  })
})

describe('status 路由 — host 段', () => {
  /**
   * 这条是本次真机验证后新增 `host` 段的守卫。
   *
   * 真实场景：provider 刚被卸载、adapter 还没 ready 时 `llm.listModels` 会抛。
   * 如果不在 handler 里兜住，用户点开设置页看到的是整个 status 500 —— 恰好
   * 在最需要诊断信息的时候失去诊断信息。
   */
  it('host 段抛错时仍然 200，错误降级进 host.error', async () => {
    const result = await invoke({
      host: async () => {
        throw new Error('llm 服务已卸载')
      },
    })
    expect(result.status).toBe(200)
    expect(result.payload['host']).toEqual({ error: 'llm 服务已卸载' })
  })

  it('host 段正常时把 providers / modelCount 原样报出', async () => {
    const result = await invoke({
      host: async () => ({
        providers: [{ id: 'codearts', name: '码道 CodeArts' }],
        configurable: [
          { provider: 'codearts', displayName: '码道 CodeArts', settingsNs: 'dsh-connect-codearts' },
        ],
        modelCount: 12,
        modelsError: null,
      }),
    })
    expect(result.status).toBe(200)
    expect(result.payload['host']).toEqual({
      providers: [{ id: 'codearts', name: '码道 CodeArts' }],
      configurable: [
        { provider: 'codearts', displayName: '码道 CodeArts', settingsNs: 'dsh-connect-codearts' },
      ],
      modelCount: 12,
      modelsError: null,
      error: null,
    })
  })

  it('没传 host 依赖时该段退化成 { error: null }，其余字段照旧', async () => {
    const result = await invoke({})
    expect(result.payload['version']).toBe('9.9.9')
    expect(result.payload['host']).toEqual({ error: null })
  })
})

describe('status 路由 — 方法与时序', () => {
  it('非 GET/HEAD 方法 405', async () => {
    const result = await invoke({}, { method: 'POST' })
    expect(result.status).toBe(405)
  })

  it('refresh 抛错不影响响应形状（仍然 200）', async () => {
    const result = await invoke(
      {
        refresh: async () => {
          throw new Error('网关 502')
        },
      },
      { url: '/plugins/dsh-connect-codearts/status?refresh=1' },
    )
    expect(result.status).toBe(200)
    expect(result.payload['catalog']).toBeDefined()
  })
})

describe('status 路由 — settings 段', () => {
  it('有 settings 依赖时原样报出配置的生效值', async () => {
    const result = await invoke({
      settings: () => ({
        enabled: true,
        showCredits: false,
        pollIntervalMs: 300_000,
        gateway: '',
        defaultEfforts: { 'GLM-5.2': 'high' },
      }),
    })
    expect(result.payload['settings']).toEqual({
      enabled: true,
      showCredits: false,
      pollIntervalMs: 300_000,
      gateway: '',
      defaultEfforts: { 'GLM-5.2': 'high' },
    })
  })

  it('没传 settings 依赖时该段为 null（旧宿主兼容），不是空对象', async () => {
    const result = await invoke({})
    // null 与 {} 是两件事：空对象会让客户端以为「全部取默认值」。
    expect(result.payload['settings']).toBeNull()
  })
})

describe('status 路由 — welfare 段', () => {
  it('welfare 抛错时降级成空列表 + error，主状态仍 200', async () => {
    const result = await invoke({
      welfare: async () => {
        throw new Error('网关 403')
      },
    })
    expect(result.status).toBe(200)
    expect(result.payload['welfare']).toEqual({ items: [], error: '网关 403', fetchedAt: 0 })
    // 主状态不能因为福利拉不到而缺字段。
    expect(result.payload['catalog']).toBeDefined()
  })

  it('welfare 正常时原样报出', async () => {
    const items = [
      { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', claimable: false },
    ]
    const result = await invoke({
      welfare: async () => ({ items, error: null, fetchedAt: 123 }),
    })
    expect(result.payload['welfare']).toEqual({ items, error: null, fetchedAt: 123 })
  })

  it('没传 welfare 依赖时该段为 null', async () => {
    const result = await invoke({})
    expect(result.payload['welfare']).toBeNull()
  })
})

describe('状态路由 — 会话鉴权与数据最小化', () => {
  it('未通过宿主会话鉴权时不刷新目录', async () => {
    const refresh = vi.fn(async () => undefined)
    const result = await invoke({ authorize: () => 401, refresh }, { url: '/status?refresh=1' })
    expect(result.status).toBe(401)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('拒绝来自非回环连接的请求', async () => {
    expect((await invoke({}, { remoteAddress: '192.0.2.10' })).status).toBe(403)
  })

  it('只返回界面用到的账号字段', async () => {
    const result = await invoke({
      account: () => ({ userId: 'user-id', domainId: 'domain-id', userName: 'user-123456', roles: [] }),
    })
    expect(result.payload.account).toEqual({ label: '…123456', roles: [] })
  })
})
