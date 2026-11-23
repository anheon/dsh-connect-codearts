import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CreditsGate, type ModelDirectoryStore } from '../src/client/credits-gate.tsx'

const render = (snapshot: ReturnType<ModelDirectoryStore['getSnapshot']>): string =>
  renderToStaticMarkup(createElement(CreditsGate, {
    t: (key: string): string => key,
    directory: {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
    },
  }))

describe('积分胶囊首次渲染', () => {
  it('宿主默认使用码道时，无会话选择历史也会显示', () => {
    expect(render({ current: { provider: 'codearts' }, routable: true })).toContain('dsc-chip')
  })

  it('启动加载中保持隐藏，选中其他提供商后仍隐藏', () => {
    expect(render({ current: null, routable: null })).toBe('')
    expect(render({ current: { provider: 'workbuddy' }, routable: true })).toBe('')
  })
})
