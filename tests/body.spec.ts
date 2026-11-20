/**
 * 请求体构造的单测。
 *
 * 核心不变量都来自 M0 实测失败现场：
 *   - `developer` 角色必须改写成 `system`。网关对 `developer` 的回答是
 *     `InferHub.001001044.400: Message role cannot empty` —— 注意报错文案说的
 *     是「role 不能为空」，与「不认这个角色名」毫无字面关系，所以这条只能靠
 *     实测钉住，不能靠读文档。
 *   - `max_tokens` 必须在发出去之前夹到 131072 以内。超过上界时网关**不报错**，
 *     只给一个没有任何有效帧的空流 —— 那种失败比 400 难查得多。
 *   - `stream` 恒为 true。网关的非流式虽然支持，但让它走流式是 shim 侧唯一
 *     能识别首帧错误的路径。
 *
 * @module dsh-connect-codearts/tests/body
 */
import { describe, expect, it } from 'vitest'

import {
  buildUpstreamBody,
  clampMaxTokens,
  normalizeContent,
  upstreamReasoningEffort,
  upstreamRole,
} from '../src/protocol/body.ts'
import { CODEARTS_DEFAULT_MAX_OUTPUT, CODEARTS_MAX_OUTPUT_CEILING } from '../src/protocol/types.ts'

describe('upstreamRole', () => {
  it('developer 改写成 system', () => {
    expect(upstreamRole('developer')).toBe('system')
  })

  it('其余角色原样', () => {
    expect(upstreamRole('system')).toBe('system')
    expect(upstreamRole('user')).toBe('user')
    expect(upstreamRole('assistant')).toBe('assistant')
    expect(upstreamRole('tool')).toBe('tool')
  })
})

describe('upstreamReasoningEffort', () => {
  it('off 映射成 none（网关不认 off）', () => {
    expect(upstreamReasoningEffort('off')).toBe('none')
  })

  it('其余档位原样透传', () => {
    expect(upstreamReasoningEffort('high')).toBe('high')
    expect(upstreamReasoningEffort('max')).toBe('max')
    expect(upstreamReasoningEffort('low')).toBe('low')
  })

  it('未指定时不产生字段', () => {
    expect(upstreamReasoningEffort(undefined)).toBeUndefined()
  })
})

describe('clampMaxTokens', () => {
  it('未指定时用兜底值', () => {
    expect(clampMaxTokens(undefined)).toBe(CODEARTS_DEFAULT_MAX_OUTPUT)
  })

  it('合法值原样保留', () => {
    expect(clampMaxTokens(1024)).toBe(1024)
    expect(clampMaxTokens(131_072)).toBe(131_072)
  })

  /** 超出上界时不报错只给空流，所以必须在这里夹住。 */
  it('超过上界夹到 131072', () => {
    expect(clampMaxTokens(393_216)).toBe(CODEARTS_MAX_OUTPUT_CEILING)
    expect(clampMaxTokens(999_999)).toBe(CODEARTS_MAX_OUTPUT_CEILING)
  })

  it('0 与负数用兜底值（发 0 等于要空回复）', () => {
    expect(clampMaxTokens(0)).toBe(CODEARTS_DEFAULT_MAX_OUTPUT)
    expect(clampMaxTokens(-1)).toBe(CODEARTS_DEFAULT_MAX_OUTPUT)
  })

  it('非有限数用兜底值', () => {
    expect(clampMaxTokens(Number.NaN)).toBe(CODEARTS_DEFAULT_MAX_OUTPUT)
    expect(clampMaxTokens(Number.POSITIVE_INFINITY)).toBe(CODEARTS_DEFAULT_MAX_OUTPUT)
  })

  it('小数向下取整', () => {
    expect(clampMaxTokens(100.9)).toBe(100)
  })
})

describe('normalizeContent', () => {
  it('空数组折成空字符串（上游期待字符串而不是 []）', () => {
    expect(normalizeContent([])).toBe('')
  })

  it('全文本折成单个字符串', () => {
    expect(normalizeContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })

  it('含图片时保留数组形状并留下 text 与 image_url', () => {
    const parts = normalizeContent([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ])
    expect(Array.isArray(parts)).toBe(true)
    expect(parts).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ])
  })

  /**
   * 码道内部格式（`{type:'file'}` / `{type:'image'}`）实测会被网关当成空内容，
   * 所以其他类型一律丢弃。留着它们不会报错，只会让模型「看不见图」而不报错。
   */
  it('丢弃非 text/image_url 的类型', () => {
    const parts = normalizeContent([
      { type: 'text', text: 'x' },
      { type: 'file', filename: 'a.pdf' },
      { type: 'image', url: 'https://example.com/a.png' },
    ] as never)
    expect(parts).toBe('x')
  })

  it('单个文本 part 时直接返回字符串而不是数组', () => {
    expect(normalizeContent([{ type: 'text', text: 'solo' }])).toBe('solo')
  })
})

describe('buildUpstreamBody', () => {
  const messages = [{ role: 'user' as const, content: '你好' }]

  it('恒为 stream:true', () => {
    expect(buildUpstreamBody({ model: 'm', messages }).stream).toBe(true)
  })

  it('developer 角色在体里已经变成 system', () => {
    const body = buildUpstreamBody({
      model: 'm',
      messages: [{ role: 'developer' as const, content: '系统提示' }, ...messages],
    })
    expect(body.messages[0]?.role).toBe('system')
  })

  it('max_tokens 默认用兜底值', () => {
    expect(buildUpstreamBody({ model: 'm', messages }).max_tokens).toBe(CODEARTS_DEFAULT_MAX_OUTPUT)
  })

  it('max_tokens 超上界被夹住', () => {
    expect(buildUpstreamBody({ model: 'm', messages, maxTokens: 500_000 }).max_tokens).toBe(
      CODEARTS_MAX_OUTPUT_CEILING,
    )
  })

  it('reasoning_effort 字段名为下划线且 off→none', () => {
    expect(buildUpstreamBody({ model: 'm', messages, reasoningEffort: 'off' }).reasoning_effort).toBe(
      'none',
    )
    expect(
      buildUpstreamBody({ model: 'm', messages, reasoningEffort: 'high' }).reasoning_effort,
    ).toBe('high')
  })

  it('未指定 effort 时不出现该字段', () => {
    expect('reasoning_effort' in buildUpstreamBody({ model: 'm', messages })).toBe(false)
  })

  it('有 tools 时补默认 tool_choice:auto', () => {
    const body = buildUpstreamBody({
      model: 'm',
      messages,
      tools: [{ type: 'function', function: { name: 'f' } }],
    })
    expect(body.tools).toHaveLength(1)
    expect(body.tool_choice).toBe('auto')
  })

  it('没有 tools 时既无 tools 也无 tool_choice', () => {
    const body = buildUpstreamBody({ model: 'm', messages })
    expect('tools' in body).toBe(false)
    expect('tool_choice' in body).toBe(false)
  })

  it('temperature / stop 透传', () => {
    const body = buildUpstreamBody({ model: 'm', messages, temperature: 0.3, stop: ['\n\n'] })
    expect(body.temperature).toBe(0.3)
    expect(body.stop).toEqual(['\n\n'])
  })
})
