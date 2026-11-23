import { describe, expect, it, vi } from 'vitest'

import { buildUpstreamBody, CODEARTS_MAX_CHAT_BODY_BYTES } from '../src/protocol/body.ts'
import { CodeArtsUpstreamClient } from '../src/upstream.ts'

const credentials = { accessKey: 'fixture-ak', secretKey: 'fixture-sk' }
const body = buildUpstreamBody({ model: 'sample', messages: [] })
const textFrame = 'data: {"choices":[{"delta":{"content":"中文"},"finish_reason":null}]}'
const finishFrame = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'

describe('gateway and catalog', () => {
  it('requires HTTPS and disables redirects on signed requests', async () => {
    expect(() => new CodeArtsUpstreamClient({ gateway: 'http://example.test' })).toThrow('HTTPS')
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ builtinModels: [] }))
    const client = new CodeArtsUpstreamClient({ gateway: 'https://example.test/proxy/', fetchImpl })
    expect(await client.listModels(credentials)).toEqual([])
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://example.test/proxy/v1/model/builtin')
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })

  it.each([
    [{ error_code: 'APIG.0301', error_msg: 'Signature mismatch' }, 'APIG.0301'],
    [{}, 'builtinModels'],
    [{ builtinModels: [{ model_name: 'invalid' }] }, 'model_id'],
  ])('detects an invalid HTTP 200 catalog (%o)', async (payload, message) => {
    const client = new CodeArtsUpstreamClient({ fetchImpl: async () => Response.json(payload) })
    await expect(client.listModels(credentials)).rejects.toThrow(message)
  })
})

describe('upstream stream termination', () => {
  it('reports an unshrinkable UTF-8 body before contacting the gateway', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new CodeArtsUpstreamClient({ fetchImpl })
    const oversized = buildUpstreamBody({ model: 'sample', messages: [
      { role: 'user', content: '中'.repeat(Math.ceil(CODEARTS_MAX_CHAT_BODY_BYTES / 3)) },
    ] })
    const bytes = Buffer.byteLength(JSON.stringify(oversized))
    const failure = await client.chatStream(credentials, oversized).next()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(failure).toMatchObject({
      done: true,
      value: { ok: false, error: { code: 'CODEARTS_REQUEST_BODY_TOO_LARGE', hint: expect.stringContaining(String(bytes)) } },
    })
  })

  it.each([400, 200])('retains safe parameter diagnostics from HTTP %s', async (status) => {
    const payload = { error_code: 'InferHub.001001005.400', error_msg: 'The request param is invalid' }
    const client = new CodeArtsUpstreamClient({
      fetchImpl: async () => status === 200
        ? new Response(`data: ${JSON.stringify(payload)}\n\n`)
        : Response.json(payload, { status }),
    })
    const response = await client.chatStream(credentials, body).next()
    expect(response).toMatchObject({
      done: true,
      value: {
        ok: false,
        ...(status === 400 ? { status } : {}),
        error: {
          code: payload.error_code,
          hint: expect.stringContaining(`请求体：${Buffer.byteLength(JSON.stringify(body))} 字节。 网关详情：${payload.error_msg}`),
        },
      },
    })
  })

  it('parses split CRLF frames and cancels an open body at [DONE]', async () => {
    const cancel = vi.fn()
    const text = [textFrame, finishFrame, 'data: [DONE]', ''].join('\r\n\r\n')
    const bytes = new TextEncoder().encode(text)
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      },
      cancel,
    })
    const client = new CodeArtsUpstreamClient({ fetchImpl: async () => new Response(stream) })
    const chat = client.chatStream(credentials, body)
    expect((await chat.next()).value).toMatchObject({ delta: { content: '中文' } })
    expect((await chat.next()).value).toMatchObject({ delta: { finishReason: 'stop' } })
    expect(await chat.next()).toMatchObject({ done: true, value: { ok: true } })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reports an interrupted reply on EOF without a terminal frame', async () => {
    const client = new CodeArtsUpstreamClient({ fetchImpl: async () => new Response(textFrame + '\n\n') })
    const chat = client.chatStream(credentials, body)
    expect((await chat.next()).value).toMatchObject({ delta: { content: '中文' } })
    expect(await chat.next()).toMatchObject({
      done: true,
      value: { ok: false, error: { code: 'INCOMPLETE_STREAM' } },
    })
  })

  it('does not treat malformed frames and [DONE] as an empty success', async () => {
    const client = new CodeArtsUpstreamClient({
      fetchImpl: async () => new Response('data: invalid\n\ndata: [DONE]\n\n'),
    })
    const chat = client.chatStream(credentials, body)
    expect(await chat.next()).toMatchObject({
      done: true,
      value: { ok: false, error: { code: 'EMPTY_STREAM' } },
    })
  })
})

describe('credit metrics', () => {
  it('uses upstream aggregate figures without summing the constituent packages', async () => {
    const client = new CodeArtsUpstreamClient({
      fetchImpl: async () => Response.json({
        metrics: [
          { name: 'usageTotalPackageCredit', package_credit_amount: 700, package_credit_remain: 460.25,
            package_credit_used: 239.75, package_credit_expiring_amount: 100 },
          { name: 'usageBasicPackageCredit', value: { package_credit_remain: 160.25 } },
          { name: 'usageBonusPackageCredit', package_credit_remain: 300 },
        ],
      }),
    })
    await expect(client.credit(credentials)).resolves.toEqual({
      total: 700, used: 239.75, remain: 460.25, expiringAmount: 100, basic: 160.25, bonus: 300,
    })
  })

  it('preserves a reported zero and leaves missing aggregate fields absent', async () => {
    const client = new CodeArtsUpstreamClient({
      fetchImpl: async () => Response.json({
        metrics: [{ name: 'usageTotalPackageCredit', value: { package_credit_remain: 0 } }],
      }),
    })
    await expect(client.credit(credentials)).resolves.toEqual({ remain: 0 })
  })
})

describe('welfare delivery', () => {
  it('passes through the account-specific registration reward and claim status', async () => {
    const item = {
      campaignId: 92,
      title: '新用户注册奖励',
      type: 'NEW_USER_REGISTER',
      status: 'CLAIMED',
      claimable: false,
      benefitAmount: 4000,
      benefitUnit: 'CREDIT',
    }
    const client = new CodeArtsUpstreamClient({
      fetchImpl: async () => Response.json({ code: 0, data: { items: [item] } }),
    })
    await expect(client.welfareItems(credentials)).resolves.toEqual([item])
  })

  it.each([
    [{ code: 40001, message: '暂时无法查询' }, '40001'],
    [{ code: 0, data: {} }, 'items'],
  ])('rejects an invalid HTTP 200 welfare response (%o)', async (payload, message) => {
    const client = new CodeArtsUpstreamClient({ fetchImpl: async () => Response.json(payload) })
    await expect(client.welfareItems(credentials)).rejects.toThrow(message)
  })
})
