/**
 * SSE 解析与首帧错误嗅探的单测。
 *
 * 两个核心不变量（都来自 M0 实测，不是推测）：
 *   ① **`text` 是增量不是累计** —— 用长回答量过：content 90 帧拼出 152 字，
 *      各帧不是彼此的前缀。所以解析层直接透传，调用方累加，不需要去重。
 *   ② **HTTP 200 也可能是错误** —— 网关会把 `{"error_code":…}` 包成一行伪
 *      SSE 后直接关流。不识别它的话，上层看到的是「流结束了但没有
 *      finish_reason」，与真实原因（余额不足、模型不可用、签名过期）毫无关系。
 *
 * @module dsh-connect-codearts/tests/sse
 */
import { describe, expect, it } from 'vitest'

import { ToolCallAccumulator, inlineErrorOf, parseChunk, parseSseEvents } from '../src/protocol/sse.ts'

describe('parseSseEvents', () => {
  it('按空行切块并取出 data 负载', () => {
    const events = parseSseEvents('data: {"a":1}\n\ndata: {"b":2}\n\n')
    expect(events).toEqual([
      { kind: 'data', payload: '{"a":1}' },
      { kind: 'data', payload: '{"b":2}' },
    ])
  })

  it('[DONE] 识别为结束标记而不是数据', () => {
    const events = parseSseEvents('data: [DONE]\n\n')
    expect(events).toEqual([{ kind: 'done' }])
  })

  it('忽略注释行与 event/id/retry 字段', () => {
    const raw = ': keep-alive\nevent: message\nid: 7\nretry: 1000\ndata: {"a":1}\n\n'
    expect(parseSseEvents(raw)).toEqual([{ kind: 'data', payload: '{"a":1}' }])
  })

  it('同一块的多个 data 行按换行拼接', () => {
    const events = parseSseEvents('data: line1\ndata: line2\n\n')
    expect(events).toEqual([{ kind: 'data', payload: 'line1\nline2' }])
  })

  /**
   * `parseSseEvents` 是**整块解析器**，不负责跨 chunk 的缓冲 —— 那是
   * `upstream.ts` 里 `buffer.indexOf('\n\n')` 那段循环的职责（它只把完整的块
   * 交进来，残留半块留到下一轮）。
   *
   * 所以这里钉住的是「不完整的块也能解析出已到的内容」这个宽容行为，而不是
   * 「丢弃它」。写这条测试是为了防止有人把缓冲逻辑挪进解析器 —— 那样两边都
   * 缓冲会导致帧被切两半。
   */
  it('单块不带尾随空行时仍解析出内容（缓冲由调用方负责）', () => {
    expect(parseSseEvents('data: {"a":1}')).toEqual([{ kind: 'data', payload: '{"a":1}' }])
  })

  it('空输入返回空数组', () => {
    expect(parseSseEvents('')).toEqual([])
    expect(parseSseEvents('\n\n\n\n')).toEqual([])
  })
})

describe('inlineErrorOf', () => {
  /**
   * 这条是「正常帧也带 error: null」的回归测试。
   *
   * 只检查「有没有 error 字段」的实现会把每一条正常帧都判成错误，那样对话
   * 一条都发不出去。
   */
  it('正常帧带 "error":null 时不算错误', () => {
    const payload = JSON.stringify({
      choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }],
      error: null,
    })
    expect(inlineErrorOf(payload)).toBeUndefined()
  })

  it('有 choices 时即使带 error_code 也不算（正常帧优先）', () => {
    const payload = JSON.stringify({
      choices: [{ index: 0, delta: { content: 'x' } }],
      error_code: 'WHATEVER',
      error_msg: 'ignored',
    })
    expect(inlineErrorOf(payload)).toBeUndefined()
  })

  it('认出 error_code / error_msg 形状', () => {
    const payload = JSON.stringify({
      error_code: 'InferHub.4004.200',
      error_msg: 'benefit not found',
    })
    expect(inlineErrorOf(payload)).toEqual({
      code: 'InferHub.4004.200',
      message: 'benefit not found',
    })
  })

  it('认出 error.code / error.message 形状', () => {
    const payload = JSON.stringify({
      error: { code: 'APIG.0301', message: 'signature fail' },
    })
    expect(inlineErrorOf(payload)).toEqual({ code: 'APIG.0301', message: 'signature fail' })
  })

  it('没有错误字段时返回 undefined', () => {
    expect(inlineErrorOf(JSON.stringify({ choices: [] }))).toBeUndefined()
    expect(inlineErrorOf(JSON.stringify({ usage: { prompt_tokens: 1 } }))).toBeUndefined()
  })

  it('不是合法 JSON 时不算错误（可能是 keep-alive 文本）', () => {
    expect(inlineErrorOf('not json')).toBeUndefined()
  })
})

describe('parseChunk', () => {
  it('解析 content 增量', () => {
    const chunk = parseChunk(
      JSON.stringify({
        choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
      }),
    )
    expect(chunk.delta?.content).toBe('你好')
  })

  it('解析 reasoning_content 增量', () => {
    const chunk = parseChunk(
      JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: '想一下' } }],
      }),
    )
    expect(chunk.delta?.reasoning).toBe('想一下')
  })

  it('解析 finish_reason', () => {
    const chunk = parseChunk(
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    )
    expect(chunk.delta?.finishReason).toBe('tool_calls')
  })

  it('解析 usage 帧（含缓存与思考明细）', () => {
    const chunk = parseChunk(
      JSON.stringify({
        usage: {
          prompt_tokens: 35,
          completion_tokens: 400,
          total_tokens: 435,
          prompt_tokens_details: { cached_tokens: 12 },
          completion_tokens_details: { reasoning_tokens: 306 },
        },
      }),
    )
    expect(chunk.usage).toEqual({
      promptTokens: 35,
      completionTokens: 400,
      totalTokens: 435,
      cachedTokens: 12,
      reasoningTokens: 306,
    })
  })

  it('解析流式 tool_calls 增量', () => {
    const chunk = parseChunk(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city"' },
                },
              ],
            },
          },
        ],
      }),
    )
    expect(chunk.delta?.toolCalls).toEqual([
      { index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city"' },
    ])
  })

  it('内联错误直接暴露在 inlineError 上', () => {
    const chunk = parseChunk(
      JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限' }),
    )
    expect(chunk.inlineError).toEqual({
      code: 'TM.00001041',
      message: '并发会话数已达上限',
    })
  })
})

describe('ToolCallAccumulator', () => {
  /**
   * 实测本机网关把整个调用放在**单帧**里，但 OpenAI 协议允许多帧按 index
   * 累积 —— 依赖「永远单帧」会在网关改成分片下发时静默丢参数（表现是
   * `finish_reason: tool_calls` 但 arguments 是残的 JSON）。
   */
  it('单帧完整调用', () => {
    const acc = new ToolCallAccumulator()
    acc.push([{ index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":"北京"}' }])
    expect(acc.finish()).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    ])
  })

  it('多帧按 index 累积参数', () => {
    const acc = new ToolCallAccumulator()
    acc.push([{ index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city"' }])
    acc.push([{ index: 0, argumentsDelta: ':"北京"}' }])
    expect(acc.finish()).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    ])
  })

  it('两个并发调用按 index 分开累积并升序输出', () => {
    const acc = new ToolCallAccumulator()
    acc.push([{ index: 1, id: 'b', name: 'second', argumentsDelta: '{}' }])
    acc.push([{ index: 0, id: 'a', name: 'first', argumentsDelta: '{}' }])
    expect(acc.finish().map((call) => call.name)).toEqual(['first', 'second'])
  })

  it('空累积器返回空数组', () => {
    expect(new ToolCallAccumulator().finish()).toEqual([])
  })

  it('size 反映已见的调用数', () => {
    const acc = new ToolCallAccumulator()
    acc.push([{ index: 0, id: 'a', name: 'x', argumentsDelta: '' }])
    expect(acc.size).toBe(1)
  })
})
