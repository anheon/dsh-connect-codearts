/**
 * 签到领取路由的契约测试。
 *
 * 存在理由：这是本项目**唯一有真实副作用**的端点——签到一天只能领一次，领错了
 * 用户当天就没了。所以这里钉的不是「能不能领到」（那要真打网关），而是
 * 「什么情况下绝对不能发出去」：
 *   ① GET 必须被拒 —— 浏览器预取、页面刷新、开发者工具的重复请求都会命中
 *      GET，任何一次误发都等于把用户当天的签到点掉了
 *   ② 非回环 Host 必须被拒 —— 否则局域网内任何机器都能替用户签到
 *   ③ body 形状不对必须被拒，**不能猜默认值** —— 猜错会领到别的活动
 *   ④ 领取失败仍然是 200 + `ok:false`，让界面用同一条路径显示建议
 *
 * @module dsh-connect-codearts/tests/welfare-claim
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { CODEARTS_WRITE_REQUEST_HEADER } from '../src/protocol/types.ts'
import { registerWelfareClaimRoute } from '../src/web-status.ts'
import type { WelfareClaimResult } from '../src/web-status.ts'

interface Captured {
  readonly status: number
  readonly payload: Record<string, unknown>
}

/**
 * 造一套最小的 ctx/req/res 把 handler 截下来手动调用。
 *
 * `body` 为 `undefined` 表示请求体为空（空 body 是非法输入，见用例）。
 * req 要能 `for await`，所以造一个最小的 async iterable。
 */
const invoke = async (
  deps: { claimWelfare?: (id: number) => Promise<WelfareClaimResult> },
  options: {
    readonly host?: string | null
    readonly method?: string
    readonly body?: string
    readonly origin?: string | null
    readonly contentType?: string
    readonly desktopRequest?: boolean
    readonly fetchSite?: string
    readonly authorizationStatus?: 401 | 403 | 503
  } = {},
): Promise<Captured> => {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const ctx = {
    webServer: {
      register: (route: { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        handler = route.handler
        return () => undefined
      },
    },
  }

  registerWelfareClaimRoute(ctx as never, {
    authorize: () => options.authorizationStatus,
    ...deps,
  })

  if (handler === undefined) throw new Error('handler 没被注册')

  const host = options.host === undefined ? '127.0.0.1:63496' : options.host
  const body = options.body ?? '{"campaignId":34}'
  const req = {
    method: options.method ?? 'POST',
    url: '/plugins/dsh-connect-codearts/welfare/claim',
    headers: {
      ...(host === null ? {} : { host }),
      ...(options.origin === null ? {} : { origin: options.origin ?? 'http://127.0.0.1:63496' }),
      'content-type': options.contentType ?? 'application/json; charset=utf-8',
      ...(options.desktopRequest ? { [CODEARTS_WRITE_REQUEST_HEADER]: '1' } : {}),
      ...(options.fetchSite === undefined ? {} : { 'sec-fetch-site': options.fetchSite }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body === '') return
      yield Buffer.from(body, 'utf8')
    },
  }

  let status = 0
  let payload: Record<string, unknown> = {}
  const res = {
    writeHead: (code: number) => {
      status = code
      return res
    },
    end: (text: string) => {
      payload = JSON.parse(text) as Record<string, unknown>
      return res
    },
  }

  await handler(req as never, res as never)
  return { status, payload }
}

describe('签到领取路由 — 方法闸', () => {
  // 主诉：GET 绝不能被接受。这是本文件最重要的一条。
  it('GET 一律 405，且不调用领取实现', async () => {
    const claimWelfare = vi.fn(async () => ({ ok: true }))
    const result = await invoke({ claimWelfare }, { method: 'GET' })
    expect(result.status).toBe(405)
    expect(result.payload).toEqual({ ok: false, error: 'method not allowed' })
    // 「拒了」还不够，必须证明它真的没发出去 —— 否则拒得再响也白搭。
    expect(claimWelfare).not.toHaveBeenCalled()
  })

  it('HEAD 也 405（健康检查会打 HEAD）', async () => {
    const claimWelfare = vi.fn(async () => ({ ok: true }))
    const result = await invoke({ claimWelfare }, { method: 'HEAD' })
    expect(result.status).toBe(405)
    expect(claimWelfare).not.toHaveBeenCalled()
  })
})

describe('签到领取路由 — 来源闸', () => {
  it('非本机 Host 403，且不调用领取实现', async () => {
    const claimWelfare = vi.fn(async () => ({ ok: true }))
    const result = await invoke({ claimWelfare }, { host: 'evil.example' })
    expect(result.status).toBe(403)
    expect(claimWelfare).not.toHaveBeenCalled()
  })

  it('没有 Host 头也拒绝', async () => {
    const claimWelfare = vi.fn(async () => ({ ok: true }))
    const result = await invoke({ claimWelfare }, { host: null })
    expect(result.status).toBe(403)
    expect(claimWelfare).not.toHaveBeenCalled()
  })
})

describe('签到领取路由 — 鉴权与请求格式', () => {
  it.each([
    [{ authorizationStatus: 401 as const }, 401],
    [{ authorizationStatus: 503 as const }, 503],
    [{ origin: null }, 403],
    [{ origin: 'http://localhost:63496', desktopRequest: true }, 403],
    [{ origin: 'null', desktopRequest: true }, 403],
    [{ origin: null, desktopRequest: true, fetchSite: 'same-site' }, 403],
    [{ origin: null, desktopRequest: true, authorizationStatus: 401 as const }, 401],
    [{ origin: null, desktopRequest: true, contentType: 'text/plain' }, 415],
    [{ contentType: 'text/plain' }, 415],
  ])('拒绝未通过鉴权或格式校验的请求 (%o)', async (options, status) => {
    const claimWelfare = vi.fn(async () => ({ ok: true }))
    expect((await invoke({ claimWelfare }, options)).status).toBe(status)
    expect(claimWelfare).not.toHaveBeenCalled()
  })

  it('允许桌面转发移除 Origin 的已授权写请求', async () => {
    const claimWelfare = vi.fn(async () => ({ ok: true }))
    const result = await invoke({ claimWelfare }, { origin: null, desktopRequest: true })
    expect(result.status).toBe(200)
    expect(claimWelfare).toHaveBeenCalledOnce()
  })
})

describe('签到领取路由 — body 闸', () => {
  // 每条都必须断言「没发出去」。判 400 但已经领了是最糟的组合。
  it.each([
    ['空 body', ''],
    ['非 JSON', 'not json at all'],
    ['缺 campaignId', '{}'],
    ['campaignId 是字符串', '{"campaignId":"34"}'],
    ['campaignId 是小数', '{"campaignId":34.5}'],
    ['campaignId 是 0', '{"campaignId":0}'],
    ['campaignId 是负数', '{"campaignId":-1}'],
    ['JSON 顶层是数组', '[34]'],
  ])('%s → 400，且不调用领取实现', async (_title, body) => {
    const claimWelfare = vi.fn(async () => ({ ok: true }))
    const result = await invoke({ claimWelfare }, { body })
    expect(result.status).toBe(400)
    expect(result.payload['ok']).toBe(false)
    expect(claimWelfare).not.toHaveBeenCalled()
  })

  it('合法 body 会把 campaignId 原样传给领取实现', async () => {
    const claimWelfare = vi.fn(async () => ({ ok: true }))
    await invoke({ claimWelfare }, { body: '{"campaignId":39}' })
    expect(claimWelfare).toHaveBeenCalledWith(39)
  })
})

describe('签到领取路由 — 结果与降级', () => {
  it('领取成功 → 200 + {ok:true}', async () => {
    const result = await invoke({ claimWelfare: async () => ({ ok: true }) })
    expect(result.status).toBe(200)
    expect(result.payload).toEqual({ ok: true })
  })

  it('领取失败仍然是 200 + ok:false 带建议（业务结果不是路由故障）', async () => {
    const result = await invoke({
      claimWelfare: async () => ({ ok: false, error: '今天已经领过了' }),
    })
    expect(result.status).toBe(200)
    expect(result.payload).toEqual({ ok: false, error: '今天已经领过了' })
  })

  it('领取实现抛错时折叠成 ok:false，不变成 500', async () => {
    const result = await invoke({
      claimWelfare: async () => {
        throw new Error('网络断了')
      },
    })
    expect(result.status).toBe(200)
    expect(result.payload).toEqual({ ok: false, error: '网络断了' })
  })

  it('没传 claimWelfare 依赖时 503（功能没启用，不是用户操作错）', async () => {
    const result = await invoke({})
    expect(result.status).toBe(503)
    expect(result.payload['ok']).toBe(false)
  })
})
