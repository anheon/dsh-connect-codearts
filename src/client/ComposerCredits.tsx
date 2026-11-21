/**
 * 输入框右侧的积分胶囊。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/client/ComposerCredits.tsx` —
 *       「座位选 `conversation.input.right` 而不是 `input.left`」这条结论：
 *       宿主把 `input.right` 渲染在模型选择器紧前面，而 `input.left` 在工具条
 *       最末端、离权限选择器只有 8px，点「完全权限」会误触积分胶囊。
 * 改动：读数来自本插件的 status 路由而不是某个上游 HTTP 调用 —— 码道的积分
 *       接口需要 APIG 签名，浏览器里做不了，必须由宿主侧代取。
 *
 * @module dsh-connect-codearts/client/ComposerCredits
 */
import { useEffect, useState } from 'react'
import { CODEARTS_SETTINGS_CHANGED } from '../protocol/types.ts'

import type { CodeArtsCardInjected } from './CodeArtsCard.tsx'

/** 与 `web-status.ts` 保持一致的路径。 */
const STATUS_PATH = '/plugins/dsh-connect-codearts/status'

/** 胶囊刷新间隔。积分不需要秒级新鲜度，5 分钟足够。 */
const POLL_MS = 5 * 60_000

type ChipState = 'loading' | 'ready' | 'error'

interface ChipReading {
  state: ChipState
  remain?: number
  /**
   * 配置里 `showCredits` 的生效值。
   *
   * `undefined` 表示这次读取没拿到（网络失败、或宿主版本没有 `settings` 段）。
   * 区分「没拿到」与「明确关掉」很重要：前者不该让胶囊消失 —— 一次网络抖动
   * 就让读数闪没，用户会以为是坏了；后者必须让它消失。
   *
   * 显式写出 `| undefined` 是因为本仓库开了 `exactOptionalPropertyTypes`：
   * 光写 `showCredits?: boolean` 不允许把 `undefined` 赋给它。
   */
  showCredits?: boolean | undefined
  checkedInToday?: boolean | undefined
}

const read = async (): Promise<ChipReading> => {
  try {
    const response = await fetch(STATUS_PATH, { headers: { Accept: 'application/json' } })
    if (!response.ok) return { state: 'error' }
    const payload = (await response.json()) as {
      credential: { signedIn: boolean }
      credit: { remain?: number } | null
      settings?: { showCredits?: boolean } | null
      preferences?: { checkedInToday?: boolean } | null
    }
    // `settings` 是 0.1.2 起才有的段；旧宿主返回 null，按「没拿到」处理。
    const showCredits =
      payload.settings === null || payload.settings === undefined
        ? undefined
        : payload.settings.showCredits !== false
    const checkedInToday =
      payload.preferences === null || payload.preferences === undefined
        ? undefined
        : payload.preferences.checkedInToday === true
    if (!payload.credential.signedIn) return { state: 'error', showCredits }
    const remain = payload.credit?.remain
    if (remain === undefined) return { state: 'loading', showCredits, checkedInToday }
    return { state: 'ready', remain, showCredits, checkedInToday }
  } catch {
    return { state: 'error' }
  }
}

/**
 * 胶囊组件。
 *
 * 刻意做得很小（一行、11px）：它是常驻在输入框旁边的元素，占位越少越好。
 * 读不到时显示「—」而不是隐藏 —— 隐藏会让用户以为插件没装。
 *
 * **`showCredits` 的判定放在这里而不是 gate 里**：本组件已经每 5 分钟拉一次
 * status，`settings` 段就在同一个响应里；再让 gate 单独拉一次只会多一条请求，
 * 还多一处可能与读数不同步的缓存。
 */
export const ComposerCredits = ({ t }: CodeArtsCardInjected): React.ReactElement | null => {
  const [reading, setReading] = useState<ChipReading>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    let latestRequest = 0

    const tick = (): void => {
      const request = ++latestRequest
      void read().then((next) => {
        if (!cancelled && request === latestRequest) {
          setReading((current) => ({ ...next, showCredits: next.showCredits ?? current.showCredits }))
        }
      })
    }

    tick()
    const timer = setInterval(tick, POLL_MS)
    window.addEventListener(CODEARTS_SETTINGS_CHANGED, tick)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener(CODEARTS_SETTINGS_CHANGED, tick)
    }
  }, [])

  // 配置里明确关掉就什么都不渲染。必须在读取之后判：`undefined`（没拿到）
  // 要继续显示，只有明确的 `false` 才隐藏。
  if (reading.showCredits === false) return null

  const label =
    reading.state === 'error' && reading.remain === undefined
      ? t('chip.unknown')
      : reading.remain === undefined
        ? t('chip.loading')
        : reading.remain.toLocaleString('zh-CN')

  return (
    <span
      className="dsc-chip"
      data-state={reading.state}
      title={t(reading.checkedInToday === true ? 'chip.checkedIn' : 'chip.title')}
      aria-label={t('chip.title')}
    >
      <span className="dsc-chip-dot" />
      <span>码道</span>
      <span className="dsc-chip-num">{label}</span>
    </span>
  )
}
