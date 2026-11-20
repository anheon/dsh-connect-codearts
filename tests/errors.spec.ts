/**
 * 错误分类单测。
 *
 * 这些断言的价值在于「同一个业务码永远给同一条建议」。码道最坑的一点是
 * **HTTP 200 也可能带错误**（错误被包成一行伪 SSE），如果内联错误走一条分类
 * 路径、4xx 走另一条，用户会看到两种完全不同的说法描述同一个问题。所以
 * `classifyError(200, …)` 与 `classifyError(400, …)` 必须对同一份 body 给同一个
 * `kind`。
 *
 * @module dsh-connect-codearts/tests/errors
 */
import { describe, expect, it } from 'vitest'

import {
  classifyBusinessRejection,
  classifyError,
  classifyTransportError,
  parseErrorDetail,
  summarizeForStatusLine,
} from '../src/protocol/errors.ts'

describe('parseErrorDetail', () => {
  it('读出 error_code / error_msg', () => {
    expect(
      parseErrorDetail(JSON.stringify({ error_code: 'APIG.0301', error_msg: 'signature fail' })),
    ).toEqual({ code: 'APIG.0301', message: 'signature fail' })
  })

  it('读出 error.code / error.message', () => {
    expect(
      parseErrorDetail(JSON.stringify({ error: { code: 'TM.00001041', message: '并发会话数已达上限' } })),
    ).toEqual({ code: 'TM.00001041', message: '并发会话数已达上限' })
  })

  it('读出 code / message（网关错误的最外层形状）', () => {
    expect(parseErrorDetail(JSON.stringify({ code: 'InferHub.4005.200', message: 'unsupported model' }))).toEqual(
      { code: 'InferHub.4005.200', message: 'unsupported model' },
    )
  })

  it('非 JSON 时退回首行，并截断过长文本', () => {
    const detail = parseErrorDetail(`${'x'.repeat(900)}\nsecond line`)
    expect(detail.message.length).toBeLessThanOrEqual(500)
    expect(detail.message).not.toContain('second line')
  })

  it('空文本不崩', () => {
    expect(() => parseErrorDetail('')).not.toThrow()
  })
})

describe('classifyError — 签名', () => {
  it('APIG.0301 归为 signature', () => {
    const error = classifyError(401, JSON.stringify({ error_code: 'APIG.0301', error_msg: 'signature fail' }))
    expect(error.kind).toBe('signature')
    expect(error.retryable).toBe(false)
  })

  /**
   * 这条建议的内容是有讲究的：三种原因里「query 没参与签名」是最隐蔽的一个
   * （同一路径不带参数能过、带参数过不了），必须写进 hint 否则用户会一直怀疑
   * 是 AK/SK 抄错了。
   */
  it('signature 的 hint 覆盖三种成因', () => {
    const error = classifyError(401, 'APIG.0301 calc ak sk signature fail')
    expect(error.hint).toContain('AK/SK')
    expect(error.hint).toMatch(/签名/)
    expect(error.hint).toMatch(/时间|时钟/)
  })
})

describe('classifyError — 凭据与权益', () => {
  it('security token expired 归为 credential', () => {
    const error = classifyError(401, JSON.stringify({ error_code: 'APIG.0602', error_msg: 'the security token has expired' }))
    expect(error.kind).toBe('credential')
  })

  it('benefit not found 归为 entitlement 而不是模型不可用', () => {
    const error = classifyError(200, JSON.stringify({ error_code: 'InferHub.4004.200', error_msg: 'benefit not found' }))
    expect(error.kind).toBe('entitlement')
    // 这不是插件故障，界面上必须说清楚。
    expect(error.hint).toMatch(/权益/)
  })

  // 实测补丁：真实打网关时，调用一个当前套餐不含的模型会得到
  //  + 「您当前无权调用该模型，请联系企业管理员开通」。
  // HTTP 200、正文是中文文案、码号与 benefit/InferHub.4004 都不同，
  // 第一版分类表漏了它，用户看到的是「未归类的错误」。
  it('TM.000010051 无权调用该模型 归为 entitlement', () => {
    const error = classifyError(
      200,
      JSON.stringify({
        error_code: 'TM.000010051',
        error_msg: '您当前无权调用该模型，请联系企业管理员开通。',
      }),
    )
    expect(error.kind).toBe('entitlement')
    expect(error.retryable).toBe(false)
    expect(error.hint).toContain('无权调用')
  })
  it('unsupported model 归为 unsupported_model', () => {
    expect(classifyError(400, 'InferHub.4005.200 unsupported model').kind).toBe('unsupported_model')
    expect(classifyError(400, 'ModelArts.81009 Invalid model').kind).toBe('unsupported_model')
  })
})

describe('classifyError — 限流', () => {
  /**
   * `TM.00001041` 的文案是「并发会话数已达上限」，但实测是网关侧节奏限流：
   * 串行单请求、间隔 5~8 秒、客户端进程数为 0 照样复现，且所有响应都在
   * 120~190ms 返回。归到「不可重试」会让模型熔断连锁挂掉，必须走退避。
   */
  it('TM.00001041 归为 rate_limited 且可重试', () => {
    const error = classifyError(400, JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限' }))
    expect(error.kind).toBe('rate_limited')
    expect(error.retryable).toBe(true)
    expect(error.retryAfterMs).toBeGreaterThan(0)
  })

  it('429 一律归为 rate_limited', () => {
    expect(classifyError(429, '').kind).toBe('rate_limited')
  })

  it('ModelArts.81114 与 81101 也归为 rate_limited', () => {
    expect(classifyError(429, 'InferHub.ModelArts.81114.429 rate limit').kind).toBe('rate_limited')
    expect(classifyError(429, 'ModelArts.81101 too many requests').kind).toBe('rate_limited')
  })
})

describe('classifyError — 参数与服务器', () => {
  it('Message role cannot empty 归为 bad_request 并点明 developer 角色', () => {
    const error = classifyError(400, JSON.stringify({ error_code: 'InferHub.001001044.400', error_msg: 'Message role cannot empty' }))
    expect(error.kind).toBe('bad_request')
    // 报错文案说的是「role 不能为空」，与「不认 developer 角色」毫无字面关系，
    // 必须由我们翻译。
    expect(error.hint).toMatch(/developer|system/)
  })

  it('InferHub.001001005（参数非法）归为 bad_request', () => {
    expect(classifyError(400, 'InferHub.001001005.400').kind).toBe('bad_request')
  })

  it('5xx 归为 server 且可重试', () => {
    const error = classifyError(503, '')
    expect(error.kind).toBe('server')
    expect(error.retryable).toBe(true)
  })

  it('未知组合归为 unknown 且不可重试', () => {
    const error = classifyError(418, 'teapot')
    expect(error.kind).toBe('unknown')
    expect(error.retryable).toBe(false)
  })
})

describe('classifyError — 200 与 4xx 同码同解', () => {
  /**
   * 这条是本文件存在的核心理由。内联错误（HTTP 200 + 伪 SSE）与真 4xx 必须
   * 得到同一个 `kind` 与同一条 `hint`，否则「余额不足」在两种到达方式下会说
   * 两种话。
   */
  it('同一 body，200 与 400 的 kind 一致', () => {
    const body = JSON.stringify({ error_code: 'InferHub.4004.200', error_msg: 'benefit not found' })
    expect(classifyError(200, body).kind).toBe(classifyError(400, body).kind)
  })

  it('同一 body，200 与 400 的 hint 一致', () => {
    const body = JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限' })
    expect(classifyError(200, body).hint).toBe(classifyError(400, body).hint)
  })
})

describe('classifyTransportError', () => {
  it('从嵌套 cause 里找出 ENOTFOUND', () => {
    const error = new Error('fetch failed', {
      cause: new Error('outer', { cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) }),
    })
    const result = classifyTransportError(error)
    expect(result.kind).toBe('transport')
    expect(result.code).toBe('NETWORK_DNS')
  })

  it('证书问题单独归一类', () => {
    const error = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'CERT_HAS_EXPIRED',
    })
    expect(classifyTransportError(error).code).toBe('NETWORK_TLS')
  })

  it('普通网络错误不崩且可重试', () => {
    const result = classifyTransportError(new Error('socket hang up'))
    expect(result.kind).toBe('transport')
    expect(result.retryable).toBe(true)
  })
})

describe('summarizeForStatusLine', () => {
  it('一行以内，含业务码与建议', () => {
    const line = summarizeForStatusLine(classifyError(401, 'APIG.0301 signature fail'))
    expect(line).not.toContain('\n')
    expect(line).toMatch(/APIG\.0301|签名/)
  })
})

describe('classifyBusinessRejection', () => {
  // 这组断言的来历：积分胶囊修好之后，真机点了一次已经签过的签到，
  // 界面显示「领取失败，原因未知」—— 因为 HTTP 200 且 code 非 0 时
  // 旧代码直接丢掉整个响应体。用户看不出是「已经领过了」，只会以为插件坏了。
  it('已领取给出「不用再点」而不是「失败了」', () => {
    const result = classifyBusinessRejection(
      JSON.stringify({ code: 'PROMPTCENTER.00000002', message: '您今天已签到' }),
    )
    expect(result.kind).toBe('rejected')
    expect(result.retryable).toBe(false)
    expect(result.hint).toContain('已经领过')
    expect(result.hint).toContain('不用再点')
    // 关键：不能出现「失败」这种让人以为出故障的说法
    expect(result.hint).not.toContain('失败')
  })

  it('没有业务码时用兜底码 ALREADY_CLAIMED', () => {
    expect(classifyBusinessRejection(JSON.stringify({ message: 'you already claimed this' })).code).toBe(
      'ALREADY_CLAIMED',
    )
  })

  it('有真实业务码时保留它，不覆盖成兜底', () => {
    // 真实码对报 issue 有用，兜底码只是「认不出原文」时的标签。
    const result = classifyBusinessRejection(JSON.stringify({ code: 409, message: 'already claimed' }))
    expect(result.kind).toBe('rejected')
    expect(result.code).toBe('409')
  })

  it('活动过期给出「不是插件问题」并保留上游原文', () => {
    const result = classifyBusinessRejection(JSON.stringify({ code: 'X', message: '活动已结束' }))
    expect(result.kind).toBe('rejected')
    expect(result.hint).toContain('活动已结束')
    expect(result.hint).toContain('不是插件的问题')
  })

  it('认不出来的业务码也要把原文与业务码透出来，不吞掉', () => {
    const result = classifyBusinessRejection(JSON.stringify({ code: 'WEIRD.999', message: '别的原因' }))
    expect(result.kind).toBe('rejected')
    expect(result.hint).toContain('别的原因')
    expect(result.hint).toContain('WEIRD.999')
  })

  it('空响应体也不崩，且不编造原因', () => {
    const result = classifyBusinessRejection('')
    expect(result.kind).toBe('rejected')
    expect(result.code).toBe('BUSINESS_REJECTED')
    expect(result.hint).toContain('上游拒绝了这次操作')
  })
})

describe('parseErrorDetail 认数字业务码', () => {
  // 真机踩到的形态：HTTP 200 + `{"code":40001,"message":"尚未到达权益刷新时间，暂时无法领取"}`
  // 早期只认字符串码，整条 JSON 掉进纯文本兜底，message 变成一整串原始 JSON，
  // 界面显示成 `上游拒绝了这次操作：{"code":40001,...}` —— 内层 JSON 又嵌一层。
  it('数字 code 也能抠出 code 与 message', () => {
    expect(parseErrorDetail(JSON.stringify({ code: 40001, message: '尚未到达权益刷新时间' }))).toEqual({
      code: '40001',
      message: '尚未到达权益刷新时间',
    })
  })

  it('code 为 0 视为成功，不产生错误码', () => {
    expect(parseErrorDetail(JSON.stringify({ code: 0, message: 'ok' })).code).toBe('')
  })
})

describe('classifyBusinessRejection 的「再等等」分支', () => {
  it('权益还没刷新到账 → 让用户等一会儿，不报「已经领过」也不报「失败」', () => {
    const result = classifyBusinessRejection(
      JSON.stringify({ code: 40001, message: '尚未到达权益刷新时间，暂时无法领取' }),
    )
    expect(result.kind).toBe('rejected')
    expect(result.code).toBe('40001')
    expect(result.hint).toContain('等一会儿再点')
    expect(result.hint).toContain('不是插件的问题')
    expect(result.hint).not.toContain('已经领过')
    // 不能把内层 JSON 原样再嵌一层
    expect(result.hint).not.toContain('{"code"')
  })
})
