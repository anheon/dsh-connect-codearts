/**
 * 积分胶囊的「该不该出现」判定。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/client/ComposerCreditsGate.tsx`
 *       —— 核心机制照搬：**槽位无条件注册，由 gate 读宿主的 `modelSelection`
 *       投影决定渲染**。这样换模型时不需要重新注册槽位，也让两个连接器插件
 *       能共存于同一个 list 槽而不会同时抢那一行。
 * 改动：①只判一个 provider（`codearts`），不做参考实现的双区域映射；
 *       ②读不到投影时**不渲染**而不是渲染 —— 见下面 WHY。
 *
 * WHY 用投影而不是本插件自己的状态：投影是模型选择器写进去、下一次请求真正
 * 会用的那份，所以读数不可能和实际生效的模型打架。
 *
 * WHY `next` 优先于 `lastUsed`：已经切了但还没发出去的模型，才是输入框此刻
 * 显示给用户的那个；宿主自己也用这个优先级。
 *
 * WHY 读不到投影时不渲染：这正是本文件要修的 bug —— 胶囊原先无条件出现，
 * 用 DeepSeek 模型时旁边也挂着码道积分。判据缺失时，宁可少显示也不要错显示；
 * 错显示会被当成插件的 bug，少显示至少是安静的。
 *
 * 与 `ComposerCredits` 分开的理由：判定逻辑不依赖浏览器环境，可以在 node 里
 * 单测；而 `index.tsx` 会 import 只能在浏览器里跑的宿主包。
 *
 * @module dsh-connect-codearts/client/credits-gate
 */
import { ComposerCredits } from './ComposerCredits.tsx'
import type { CodeArtsCardInjected } from './CodeArtsCard.tsx'

/** 本插件拥有的 provider 路由。与 `adapter.ts` 的 `CODEARTS_PROVIDER` 一致。 */
export const CODEARTS_OWN_PROVIDER = 'codearts'

/**
 * `modelSelection` 投影里本判定要用的那一片。
 *
 * 两个键都可能缺席：投影还没落地的首帧、或旧版宿主不带这个投影。
 */
export interface ModelSelectionProjectionLike {
  readonly lastUsed?: { readonly provider?: unknown } | null
  readonly next?: { readonly provider?: unknown } | null
}

/**
 * 这个会话现在指向哪个 provider。
 *
 * @param projection - 宿主的 `modelSelection` 投影，可能还没落地。
 * @returns provider 路由 id，或判不出来时的 undefined。
 */
export const selectedProviderOf = (
  projection: ModelSelectionProjectionLike | undefined,
): string | undefined => {
  const candidate = projection?.next ?? projection?.lastUsed
  const provider = candidate?.provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}

/**
 * 本会话是否该显示码道积分。
 *
 * 抽成纯函数是为了能直接单测「用 DeepSeek 时不显示」这条主诉 —— 不需要起
 * React，也不需要造宿主。
 */
export const shouldShowCredits = (projection: ModelSelectionProjectionLike | undefined): boolean =>
  selectedProviderOf(projection) === CODEARTS_OWN_PROVIDER

export interface CreditsGateProps extends CodeArtsCardInjected {
  /**
   * 宿主注入的标准 hook：读本会话的一个投影。
   *
   * 槽位的 `standardProps` 会把它传进来，所以这里声明为可选 —— 直接渲染本
   * 组件（测试里）时它是缺席的，那时按「判不出来」处理。
   */
  readonly useProjection?: (key: 'modelSelection') => unknown
}

/**
 * 胶囊的门。只有当前会话用的是码道模型时才渲染读数。
 */
export const CreditsGate = ({ useProjection, ...injected }: CreditsGateProps): React.ReactElement | null => {
  const projection =
    useProjection === undefined
      ? undefined
      : (useProjection('modelSelection') as ModelSelectionProjectionLike | undefined)

  if (!shouldShowCredits(projection)) {
    // 只在「hook 根本没被注入」时报一次，不在「投影还没落地」时报。
    // 前者是宿主契约变了（我们读不到模型，胶囊从此永不出现），必须留痕迹
    // 才查得到；后者是每一次新会话都会经历的瞬态，报它会把控制台刷满。
    if (useProjection === undefined) warnMissingProjectionOnce()
    return null
  }

  return <ComposerCredits {...injected} />
}

/** 只报一次：这条告警描述的是宿主契约，不是每次渲染的事件。 */
let warnedMissingProjection = false

const warnMissingProjectionOnce = (): void => {
  if (warnedMissingProjection) return
  warnedMissingProjection = true
  console.info(
    '[dsh-connect-codearts] 宿主没有向 conversation.input.right 注入 useProjection，'
    + '积分胶囊无法判断当前会话用的是哪个模型，因此不显示。'
    + '（宿主契约变化时请检查该槽位的 standardProps。）',
  )
}
