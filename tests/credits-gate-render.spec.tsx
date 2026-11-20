/**
 * `CreditsGate` 的渲染测试：证明它真的会渲染出 null，而不只是纯函数返回 false。
 *
 * 为什么还要这一条：纯函数测试证明的是「判定对不对」，而 GUI 里那个 bug 是
 * 「组件无条件渲染」。两者之间隔着一次 React 渲染 —— 判定写对了但组件没用上
 * 它，界面照样错。所以这里用 react-dom/server 真渲染一遍。
 *
 * 用 `createElement` 而不是 JSX：本文件不需要 jsx 编译选项就能跑，测试本身也
 * 不必依赖 tsconfig.client.json 的 jsx 设置。
 *
 * @module dsh-connect-codearts/tests/credits-gate-render
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CreditsGate } from '../src/client/credits-gate.tsx'

/** 造一个 `CodeArtsCardInjected` —— 只给 gate 真会用到的那一个字段。 */
const injected = { t: (key: string): string => key } as never

/** 造一个只回答 `modelSelection` 的 `useProjection`。 */
const projectionOf = (value: unknown) => (key: string): unknown => (key === 'modelSelection' ? value : undefined)

const render = (value: unknown, withHook = true): string =>
  renderToStaticMarkup(
    createElement(CreditsGate, {
      ...(injected as object),
      ...(withHook ? { useProjection: projectionOf(value) } : {}),
    } as never),
  )

describe('CreditsGate 渲染', () => {
  /**
   * 用户报的那条 bug 的最终验收：选 DeepSeek 时这里必须是空串。
   * 空串 = React 什么都没画 = 输入框旁边没有码道胶囊。
   */
  it('DeepSeek 模型下渲染为空（主诉）', () => {
    expect(render({ lastUsed: { provider: 'deepseek-official' } })).toBe('')
  })

  it('workbuddy 模型下渲染为空', () => {
    expect(render({ lastUsed: { provider: 'workbuddy' } })).toBe('')
  })

  it('码道模型下渲染出胶囊（不是空串）', () => {
    const html = render({ lastUsed: { provider: 'codearts' } })
    expect(html).not.toBe('')
    expect(html).toContain('dsc-chip')
  })

  /**
   * 投影还没落地时不闪：首帧必须是空的，不能先画一个「—」再消失。
   * 这是「无条件渲染」时代的第二类症状 —— 切会话时胶囊闪一下。
   */
  it('投影缺席时不渲染（不闪）', () => {
    expect(render(undefined)).toBe('')
    expect(render({ lastUsed: null, next: null })).toBe('')
  })

  /**
   * hook 根本没注入（宿主契约变了）时也不渲染，但走的是另一条分支：
   * 会打一次 console.info 说明原因，不是静默失败。
   */
  it('宿主没注入 useProjection 时不渲染', () => {
    expect(render(undefined, false)).toBe('')
  })
})
