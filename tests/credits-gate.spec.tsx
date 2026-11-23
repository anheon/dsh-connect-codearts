import { describe, expect, it } from 'vitest'
import { shouldShowCredits } from '../src/client/credits-gate.tsx'

describe('积分胶囊的有效模型', () => {
  it('码道路由可用时显示', () => {
    expect(shouldShowCredits({ current: { provider: 'codearts' }, routable: true })).toBe(true)
  })

  it.each(['deepseek-official', 'workbuddy'])('选中 %s 时隐藏', (provider) => {
    expect(shouldShowCredits({ current: { provider }, routable: true })).toBe(false)
  })

  it('模型目录未确定当前模型时隐藏', () => {
    expect(shouldShowCredits({ current: null, routable: null })).toBe(false)
  })

  it('码道模型已从目录中移除时隐藏', () => {
    expect(shouldShowCredits({ current: { provider: 'codearts' }, routable: false })).toBe(false)
  })
})
