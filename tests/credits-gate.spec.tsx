/**
 * `CreditsGate` 的判定测试。
 *
 * 存在理由：GUI 验证时用户报的真 bug —— 用 DeepSeek 模型时码道积分也挂在
 * 输入框旁边。胶囊原先无条件渲染，判据缺失。
 *
 * 这里只测纯判定函数，不渲染 React：宿主的槽位注入（`useProjection`）在 node
 * 里拿不到，而真正要钉住的是「什么条件下显示」这条规则本身。
 *
 * @module dsh-connect-codearts/tests/credits-gate
 */
import { describe, expect, it } from 'vitest'

import {
  CODEARTS_OWN_PROVIDER,
  selectedProviderOf,
  shouldShowCredits,
} from '../src/client/credits-gate.tsx'

describe('selectedProviderOf', () => {
  it('投影缺席时判不出来', () => {
    expect(selectedProviderOf(undefined)).toBeUndefined()
  })

  it('两个键都是 null 时判不出来（首帧、新会话）', () => {
    expect(selectedProviderOf({ lastUsed: null, next: null })).toBeUndefined()
    expect(selectedProviderOf({})).toBeUndefined()
  })

  it('只有 lastUsed 时用它', () => {
    expect(selectedProviderOf({ lastUsed: { provider: 'codearts' } })).toBe('codearts')
  })

  it('next 优先于 lastUsed（切了还没发出去的也算当前选择）', () => {
    expect(
      selectedProviderOf({
        lastUsed: { provider: 'deepseek-official' },
        next: { provider: 'codearts' },
      }),
    ).toBe('codearts')
  })

  it('provider 不是非空字符串时判不出来', () => {
    expect(selectedProviderOf({ lastUsed: { provider: '' } })).toBeUndefined()
    expect(selectedProviderOf({ lastUsed: { provider: 42 } })).toBeUndefined()
    expect(selectedProviderOf({ lastUsed: {} })).toBeUndefined()
  })
})

describe('shouldShowCredits — 主诉回归', () => {
  it('用码道模型时显示', () => {
    expect(shouldShowCredits({ lastUsed: { provider: CODEARTS_OWN_PROVIDER } })).toBe(true)
  })

  /**
   * 这是本次修的那条：用户在 GUI 里选 DeepSeek，码道积分不该出现。
   */
  it('用 DeepSeek 时不显示', () => {
    expect(shouldShowCredits({ lastUsed: { provider: 'deepseek-official' } })).toBe(false)
  })

  it('用其他连接器（workbuddy）时不显示', () => {
    expect(shouldShowCredits({ lastUsed: { provider: 'workbuddy' } })).toBe(false)
  })

  /**
   * 判据缺失时选「不显示」而不是「显示」。错显示会被当成插件 bug，
   * 少显示至少是安静的 —— 这条是本文件的核心取舍，别改成 true。
   */
  it('判不出来时不显示（宁缺勿错）', () => {
    expect(shouldShowCredits(undefined)).toBe(false)
    expect(shouldShowCredits({ lastUsed: null, next: null })).toBe(false)
  })

  it('从码道切到 DeepSeek 后立刻不显示', () => {
    const before = { lastUsed: { provider: CODEARTS_OWN_PROVIDER } }
    const after = { lastUsed: { provider: CODEARTS_OWN_PROVIDER }, next: { provider: 'deepseek-official' } }
    expect(shouldShowCredits(before)).toBe(true)
    expect(shouldShowCredits(after)).toBe(false)
  })
})
