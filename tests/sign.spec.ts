/**
 * 签名器单测。
 *
 * 这里的每一条都对应一个**曾经失败过的真实请求**，不是从文档抄的例子：
 *   - CanonicalQuery 没参与签名时，`GET /v1/ops/delivery?channel=IDE` 恒定
 *     401 `verify ak sk signature fail`，而同一路径不带 query 会返回 400
 *     「channel : 参数无效」—— 已经通过鉴权到达后端。这个对比是判断
 *     「是签名错还是接口不存在」的唯一可靠依据。
 *   - 尾斜杠、头排序、`X-Sdk-Date` 格式这三处任何一处不对，同样恒定 401，
 *     而错误信息完全相同，所以必须各钉一条。
 *
 * @module dsh-connect-codearts/tests/sign
 */
import { describe, expect, it } from 'vitest'

import {
  EMPTY_BODY_SHA256,
  SIGN_ALGORITHM,
  canonicalQuery,
  canonicalUri,
  formatSdkDate,
  huaweiEncode,
  signRequest,
} from '../src/protocol/sign.ts'
import type { CodeArtsCredentials } from '../src/protocol/sign.ts'

const credentials: CodeArtsCredentials = {
  accessKey: 'AKFIXTURE0000000000',
  secretKey: 'skfixture0000000000000000000000000000',
}

describe('huaweiEncode', () => {
  it('编码 RFC 3986 保留字符，含 encodeURIComponent 漏掉的 !\'()*', () => {
    expect(huaweiEncode('a b')).toBe('a%20b')
    expect(huaweiEncode("!*'()")).toBe('%21%2A%27%28%29')
    expect(huaweiEncode('a/b')).toBe('a%2Fb')
    expect(huaweiEncode('-_.~')).toBe('-_.~')
  })
})

describe('canonicalUri', () => {
  it('末尾补斜杠', () => {
    expect(canonicalUri('/api/v2/chat/completions')).toBe('/api/v2/chat/completions/')
  })

  it('根路径就是单斜杠', () => {
    expect(canonicalUri('/')).toBe('/')
  })

  it('逐段编码，斜杠保留为分隔符', () => {
    expect(canonicalUri('/a b/c d')).toBe('/a%20b/c%20d/')
  })

  it('已经带尾斜杠时不重复补', () => {
    expect(canonicalUri('/a/b/')).toBe('/a/b/')
  })
})

describe('canonicalQuery', () => {
  it('空查询串返回空字符串', () => {
    expect(canonicalQuery('')).toBe('')
    expect(canonicalQuery('?')).toBe('')
  })

  it('按 key 排序', () => {
    expect(canonicalQuery('?b=2&a=1')).toBe('a=1&b=2')
  })

  it('同名 key 按值排序', () => {
    expect(canonicalQuery('?a=2&a=1')).toBe('a=1&a=2')
  })

  it('key 与 value 都编码', () => {
    expect(canonicalQuery('?k y=v w')).toBe('k%20y=v%20w')
  })

  /**
   * 这条是「签到端点一直 401」的直接回归测试。
   *
   * 如果实现回退成硬编码空字符串，这个断言会立刻失败 —— 而线上表现只是
   * 一个 401，根本看不出是这里的问题。
   */
  it('带 query 时必须非空（否则重复历史上那个恒定 401）', () => {
    expect(canonicalQuery('?channel=IDE')).toBe('channel=IDE')
    expect(canonicalQuery('?channel=IDE')).not.toBe('')
  })
})

describe('formatSdkDate', () => {
  it('格式是 YYYYMMDDTHHmmssZ（UTC，无分隔符）', () => {
    const date = new Date(Date.UTC(2026, 10, 18, 2, 15, 7))
    expect(formatSdkDate(date)).toBe('20261118T021507Z')
  })
})

describe('signRequest', () => {
  const url = new URL('https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions')
  const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] })
  const now = new Date(Date.UTC(2026, 10, 18, 2, 15, 7))

  it('组装出 SDK-HMAC-SHA256 的 Authorization 头', () => {
    const signed = signRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials,
      now,
    })

    const authorization = signed.headers['Authorization']
    expect(authorization).toMatch(
      /^SDK-HMAC-SHA256 Access=AKFIXTURE0000000000, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    )
    // Authorization 里列的 SignedHeaders 必须与实际签的一模一样，否则网关
    // 会按自己解析出的清单重算，得到不同签名。
    expect(authorization).toContain(`SignedHeaders=${signed.signedHeaders}`)
  })

  it('SignedHeaders 一定包含 host 与 x-sdk-date，且按名排序', () => {
    const signed = signRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials,
      now,
    })

    const names = signed.signedHeaders.split(';')
    expect(names).toContain('host')
    expect(names).toContain('x-sdk-date')
    expect(names).toContain('content-type')
    expect([...names].sort()).toEqual(names)
  })

  /**
   * 出站 headers 由调用方原样发出，所以 `host` 必须剔除（fetch 自己写）。
   * `Authorization` 反而必须在里面 —— 它是网关唯一认的凭证载体。
   */
  it('返回的 headers 没有 host，但带 authorization 与 x-sdk-date', () => {
    const signed = signRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials,
      now,
    })

    const keys = Object.keys(signed.headers).map((key) => key.toLowerCase())
    expect(keys).not.toContain('host')
    expect(keys).toContain('authorization')
    expect(keys).toContain('x-sdk-date')
  })

  it('GET 空 body 用 SHA256("") 常量', () => {
    const signed = signRequest({ method: 'GET', url, credentials, now })
    expect(signed.payloadHash).toBe(EMPTY_BODY_SHA256)
  })

  it('带 query 的 canonicalRequest 含查询串（第二道回归）', () => {
    const withQuery = new URL(
      'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE',
    )
    const signed = signRequest({ method: 'GET', url: withQuery, credentials, now })
    const lines = signed.canonicalRequest.split('\n')

    // [METHOD, CanonicalURI, CanonicalQuery, CanonicalHeaders, SignedHeaders, PayloadHash]
    expect(lines[0]).toBe('GET')
    expect(lines[1]).toBe('/v1/ops/delivery/')
    expect(lines[2]).toBe('channel=IDE')
  })

  it('临时凭据带 X-Security-Token，且它参与签名', () => {
    const signed = signRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: { ...credentials, securityToken: 'stsfixture' },
      now,
    })

    expect(signed.signedHeaders).toContain('x-security-token')
    expect(signed.headers['X-Security-Token']).toBe('stsfixture')
  })

  it('持久凭据不产生 X-Security-Token', () => {
    const signed = signRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials,
      now,
    })

    expect(signed.signedHeaders).not.toContain('x-security-token')
  })

  /**
   * body 改一个字节签名就必须变 —— 这是「先固定一份序列化结果再既签名又发送」
   * 这条约束的可执行形式。实测里 body hash 不一致的表现是
   * `calc ak sk signature fail:body hash mismatch x-sdk-content-sha256 header`。
   */
  it('body 变化会改变 payloadHash 与签名', () => {
    const first = signRequest({ method: 'POST', url, body, credentials, now })
    const second = signRequest({ method: 'POST', url, body: `${body} `, credentials, now })

    expect(second.payloadHash).not.toBe(first.payloadHash)
    expect(second.signature).not.toBe(first.signature)
  })

  it('SK 变化会改变签名但保持 payloadHash', () => {
    const first = signRequest({ method: 'POST', url, body, credentials, now })
    const second = signRequest({
      method: 'POST',
      url,
      body,
      credentials: { ...credentials, secretKey: `${credentials.secretKey}x` },
      now,
    })

    expect(second.payloadHash).toBe(first.payloadHash)
    expect(second.signature).not.toBe(first.signature)
  })

  it('stringToSign 首行是算法名、次行是 sdkDate', () => {
    const signed = signRequest({ method: 'POST', url, body, credentials, now })
    const lines = signed.stringToSign.split('\n')

    expect(lines[0]).toBe(SIGN_ALGORITHM)
    expect(lines[1]).toBe('20261118T021507Z')
    expect(lines[2]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('头名大小写不敏感、值折行被压平', () => {
    const signed = signRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', 'X-Custom': '  a\nb  ' },
      body,
      credentials,
      now,
    })

    expect(signed.canonicalRequest).toContain('x-custom:a b\n')
  })
})
