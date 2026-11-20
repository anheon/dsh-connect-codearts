/**
 * 适配器单测。
 *
 * 这里钉的是三件「宿主契约里写得很细、但错了不会报错只会静默出错」的事：
 *   ① `TokenUsage` 的字段是**互斥**的。宿主注释原文：「inputTokens is uncached
 *      input only; billed input = sum of the three. Adapters whose providers fold
 *      cache hits into a total prompt count (DeepSeek's prompt_tokens) subtract
 *      them out.」上游的 `prompt_tokens` 就是「命中 + 未命中」之和，不减出来
 *      宿主会把缓存命中的输入再算一遍钱。
 *   ② `finish_reason: 'length'` 必须映射成 `max-tokens` 而不是 `stop`。映射成
 *      stop 的话，一个被输出预算截断的空回复在界面上与「模型正常说完」无法
 *      区分。
 *   ③ 未声明思考档位的模型**不能**给 `defaultEffort`。宿主会把 defaultEffort
 *      物化进每个请求，而只声明了 `off` 的模型接别的档位会抛
 *      `UNSUPPORTED_REASONING_EFFORT`。
 *
 * @module dsh-connect-codearts/tests/adapter
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'

import { CodeArtsAdapter, CODEARTS_PROVIDER, finishReasonOf, reasoningInfoOf } from '../src/adapter.ts'
import { CodeArtsUpstreamClient } from '../src/upstream.ts'
import type { ModelCatalogEntry } from '../src/upstream.ts'

const entry = (overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  id: 'test-model',
  name: 'Test Model',
  contextWindow: 200_000,
  maxTokens: 65_536,
  supportsImages: false,
  strengths: [],
  ...overrides,
})

const buildAdapter = (
  entries: readonly ModelCatalogEntry[],
  variants: ReadonlyMap<string, { strengths: readonly string[]; defaultStrength?: string }> = new Map(),
  hidden: readonly string[] = [],
): CodeArtsAdapter =>
  new CodeArtsAdapter({
    client: {} as never,
    credentials: async () => undefined,
    catalog: () => entries,
    thinkingVariants: () => variants,
    hiddenModels: () => new Set(hidden),
    defaultEfforts: () => new Map(),
  })

describe('listModels', () => {
  /** 空目录 = 宿主隐藏整个 provider，这正是「没配凭据」应有的表现。 */
  it('空目录返回空数组（宿主据此隐藏 provider）', async () => {
    expect(await buildAdapter([]).listModels(CODEARTS_PROVIDER)).toEqual([])
  })

  it('目录映射成宿主模型信息，保留图片能力', async () => {
    const models = await buildAdapter([entry({ supportsImages: true })]).listModels(CODEARTS_PROVIDER)
    expect(models).toHaveLength(1)
    expect(models[0]?.inputModalities).toEqual(['text', 'image'])
  })

  it('不支持图片时只声明文本', async () => {
    const models = await buildAdapter([entry()]).listModels(CODEARTS_PROVIDER)
    expect(models[0]?.inputModalities).toEqual(['text'])
  })
})

describe('resolveModel', () => {
  it('用真实 contextWindow（不做上下文放大）', async () => {
    const resolved = await buildAdapter([entry({ contextWindow: 202_752 })]).resolveModel(
      CODEARTS_PROVIDER,
      'test-model',
    )
    expect(resolved.context?.contextWindow).toBe(202_752)
  })

  /**
   * 参考实现把 window 乘 2.5 来绕过宿主自己的上下文估算。我们不这么做：
   * 放大之后「实际超窗口」会变成「网关静默截断」（M0 实测 900KB 打 202752
   * 窗口返回 `finish=stop content="好"`，不报错），那比在宿主侧被拦下危险
   * 得多。
   */
  it('defaultMaxTokens 不超过 32768', async () => {
    const resolved = await buildAdapter([entry({ maxTokens: 65_536 })]).resolveModel(
      CODEARTS_PROVIDER,
      'test-model',
    )
    expect(resolved.defaultMaxTokens).toBe(32_768)
  })

  it('目录里没有的模型也给最小描述（避免 provider 从选择器闪没）', async () => {
    const resolved = await buildAdapter([]).resolveModel(CODEARTS_PROVIDER, 'ghost')
    expect(resolved.provider).toBe(CODEARTS_PROVIDER)
    expect(resolved.id).toBe('ghost')
  })
})

describe('reasoningInfoOf', () => {
  /** 造一张只含一个模型的档位表。 */
  const table = (variant: { strengths: readonly string[]; defaultStrength?: string } | undefined) =>
    new Map(variant === undefined ? [] : [['test-model', variant]])

  it('声明了档位时给出 off + 声明的档位，并给 defaultEffort', () => {
    const info = reasoningInfoOf(table({ strengths: ['high', 'max'], defaultStrength: 'high' }), 'test-model', undefined)
    expect(info.efforts.map((effort) => String(effort.id))).toEqual(['off', 'high', 'max'])
    expect(String(info.defaultEffort)).toBe('high')
  })

  it('声明了档位但没给 default_strength 时用第一个档位', () => {
    const info = reasoningInfoOf(table({ strengths: ['max'] }), 'test-model', undefined)
    expect(String(info.defaultEffort)).toBe('max')
  })

  it('未声明档位时只给 off 且不给 defaultEffort', () => {
    const info = reasoningInfoOf(table({ strengths: [] }), 'test-model', undefined)
    expect(info.efforts.map((effort) => String(effort.id))).toEqual(['off'])
    expect(info.defaultEffort).toBeUndefined()
  })

  it('档位表里没有该模型时同样只给 off', () => {
    const info = reasoningInfoOf(new Map(), 'test-model', undefined)
    expect(info.efforts).toHaveLength(1)
    expect(info.defaultEffort).toBeUndefined()
  })

  /** 用户在设置里手选的档位优先于上游 default_strength。 */
  it('配置里的 defaultEfforts 优先', () => {
    const info = reasoningInfoOf(table({ strengths: ['high', 'max'], defaultStrength: 'high' }), 'test-model', 'max')
    expect(String(info.defaultEffort)).toBe('max')
  })

  it('配置给了模型不支持的档位时忽略它（否则宿主会抛 UNSUPPORTED_REASONING_EFFORT）', () => {
    const info = reasoningInfoOf(table({ strengths: ['high'] }), 'test-model', 'low')
    expect(String(info.defaultEffort)).toBe('high')
  })
})

describe('finishReasonOf', () => {
  it('stop 映射成 stop', () => {
    expect(finishReasonOf('stop', false)).toEqual({ kind: 'stop' })
  })

  /**
   * 这条最关键：`length` 归成 stop 的话，被输出预算截断的空回复在界面上
   * 与正常结束无法区分，用户完全没有线索。
   */
  it('length 映射成 max-tokens 而不是 stop', () => {
    expect(finishReasonOf('length', false)).toEqual({ kind: 'max-tokens' })
  })

  it('tool_calls 映射成 tool-calls', () => {
    expect(finishReasonOf('tool_calls', true)).toEqual({ kind: 'tool-calls' })
  })

  it('上游没给 finish_reason 但确实有工具调用时按 tool-calls 收尾', () => {
    expect(finishReasonOf(undefined, true)).toEqual({ kind: 'tool-calls' })
  })

  it('上游没给 finish_reason 且无工具调用时按 stop 收尾', () => {
    expect(finishReasonOf(undefined, false)).toEqual({ kind: 'stop' })
  })

  it('未知取值按 stop 处理（不抛异常）', () => {
    expect(finishReasonOf('content_filter', false)).toEqual({ kind: 'stop' })
  })
})

describe('stream 无凭据时的失败方式', () => {
  /**
   * 没有凭据必须给 `MISSING_CREDENTIAL`，而不是发一个注定 401 的请求。
   * 前者能让界面直接说「去配对 AK/SK」，后者只会显示一个签名错误。
   */
  it('抛 MISSING_CREDENTIAL', async () => {
    const adapter = buildAdapter([entry()])
    const iterator = adapter.stream({
      provider: CODEARTS_PROVIDER,
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    await expect(iterator.next()).rejects.toMatchObject({
      failure: { code: 'MISSING_CREDENTIAL' },
    })
  })
})

describe('stream with images and tool calls', () => {
  it('sends the image and preserves two interleaved tools in the host assembler', async () => {
    const dataUrl = 'data:image/png;base64,dGVzdA=='
    const resolveImage = vi.fn(async () => dataUrl)
    const frames = [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call-a', function: { name: 'first', arguments: '{"a":' } },
        { index: 1, id: 'call-b', function: { name: 'second', arguments: '{"b":' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: '2}' } },
        { index: 0, function: { arguments: '1}' } },
      ] }, finish_reason: 'tool_calls' }] },
    ]
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'),
    )
    const adapter = new CodeArtsAdapter({
      client: new CodeArtsUpstreamClient({ fetchImpl }),
      credentials: async () => ({ accessKey: 'fixture-ak', secretKey: 'fixture-sk' }),
      catalog: () => [entry({ supportsImages: true })],
      thinkingVariants: () => new Map(),
      hiddenModels: () => new Set(),
      defaultEfforts: () => new Map(),
      resolveImage,
    })
    const assembler = new BlockAssembler()
    const streamedIds: string[] = []
    for await (const chunk of adapter.stream({
      provider: CODEARTS_PROVIDER,
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: {} as never }] }],
    })) {
      assembler.push(chunk)
      if (chunk.type === 'tool-call-delta') streamedIds.push(chunk.id)
    }
    expect(resolveImage).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).messages).toEqual([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] },
    ])
    expect(streamedIds).toEqual(['call-a', 'call-b', 'call-b', 'call-a'])
    expect(assembler.blocks()).toEqual([
      { type: 'tool-call', id: 'call-a', name: 'first', arguments: '{"a":1}' },
      { type: 'tool-call', id: 'call-b', name: 'second', arguments: '{"b":2}' },
    ])
  })
})
