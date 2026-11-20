/**
 * 客户端入口：注册设置页与输入框胶囊。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/client/index.tsx` — 三条硬
 *       结论全部照搬：
 *         ① `inject` 只写 `['slots','locale']`。这两个是宿主客户端一定提供的
 *            服务；`settingsScope` 之类必须用 `ctx.get()` 软探测，因为 Cordis
 *            的依赖门是硬的 —— inject 里写了宿主没提供的服务，apply 永远不
 *            运行，而且不报错。
 *         ② 整个 apply 包在 try/catch 里，失败只 `console.error`，不弹横幅。
 *            客户端半边坏掉不该让宿主侧 provider 也看起来像坏了。
 *         ③ 最后打一行 `console.info` 报「注册了几个槽」，健康路径用 info 不用
 *            warn，否则运维会把正常启动当成告警。
 * 改动：只认领两个槽（设置页 + 输入框右侧）。不做 model.label，因为本机实测
 *       `conversation.input.model.label` 仍然是 single 槽 —— 赢家通吃，占了它
 *       就会把宿主自带的模型徽章挤掉，代价与收益不成比例。
 *
 * @module dsh-connect-codearts/client
 */
import { CodeArtsCard } from './CodeArtsCard.tsx'
import { CreditsGate } from './credits-gate.tsx'
import { CODEARTS_LOCALE_NS, dictionaries } from './locales.ts'
import { ensureStyles } from './styles.ts'

/** 客户端插件名。宿主按 `<slug>-client` 约定识别。 */
export const name = 'dsh-connect-codearts-client'

/**
 * 依赖的客户端服务。
 *
 * 只写这两个，理由见文件头第 ① 条。
 */
export const inject = ['slots', 'locale'] as const

/** 设置页的槽位 id 与排序。 */
const SETTINGS_SECTION_ID = 'dsh-connect-codearts'
const SETTINGS_SECTION_ORDER = 62

/** 输入框胶囊的槽位 id 与排序。 */
const COMPOSER_CHIP_ID = 'dsh-connect-codearts-credits'
const COMPOSER_CHIP_ORDER = 6

/** 最小可用的宿主上下文形状。全部用可选字段，缺失时降级而不是崩。 */
interface ClientContext {
  locale?: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  }
  slots?: {
    inject(key: string, callback: () => unknown): () => void
    register(entry: Record<string, unknown>, component: unknown): () => void
  }
}

/**
 * 挂载客户端。
 *
 * 整段包在 try/catch 里：客户端的失败不应该阻止宿主继续跑，也不应该显示成
 * 红色横幅 —— 用户真正需要知道的是「码道的模型还能不能用」，那是宿主侧的事。
 */
export const apply = (ctx: ClientContext): void => {
  try {
    const doc = (globalThis as { document?: Document }).document
    if (doc !== undefined) ensureStyles(doc)

    const locale = ctx.locale
    if (locale === undefined) {
      console.error('[dsh-connect-codearts] 宿主没有提供 locale 服务，客户端卡片未注册')
      return
    }

    locale.register(CODEARTS_LOCALE_NS, dictionaries)
    const t = locale.bind(CODEARTS_LOCALE_NS)

    const slots = ctx.slots
    if (slots === undefined) {
      console.error('[dsh-connect-codearts] 宿主没有提供 slots 服务，客户端卡片未注册')
      return
    }

    let registered = 0

    /**
     * `settings.section`：设置页左侧导航的一项 + 内容区。
     *
     * 用 `ctx.slots.inject(key, () => register(...))` 而不是直接 register：
     * 前者会等宿主把该槽位挂好再执行回调，后者在宿主还没准备好时会静默丢掉。
     */
    slots.inject('settings.section', () => {
      registered += 1
      return slots.register(
        {
          // `name` 是「往哪个槽位注册」，不是可选的装饰字段。漏了它宿主拿不到
          // 目标槽，注册会失败 —— 而整个 apply 包在 try/catch 里，用户看到的
          // 只是「设置页没有码道这一项」，没有任何报错。`scripts/smoke-client.mjs`
          // 就是为了钉住这一点（它这次确实抓到了这个漏写）。
          name: 'settings.section',
          id: SETTINGS_SECTION_ID,
          order: SETTINGS_SECTION_ORDER,
          label: () => t('panel.title'),
          locale: CODEARTS_LOCALE_NS,
          inject: () => ({ t, surface: 'settings' as const }),
        },
        CodeArtsCard,
      )
    })

    /**
     * `conversation.input.right`：输入框右侧的积分胶囊。
     *
     * **无条件注册、由 `CreditsGate` 自己决定渲不渲染**，而不是「只在码道
     * 模型下才注册」。理由是槽位注册与当前会话模型无关 —— 注册时读不到
     * `modelSelection`，而模型是每次切换都可能变的。真要在外面判，就得在模型
     * 变化时反复 dispose/register，那会在切换瞬间闪一下、也更容易漏。
     *
     * 这个 bug 是 GUI 验证时用户报的：用 DeepSeek 模型时码道积分也挂在旁边。
     */
    slots.inject('conversation.input.right', () => {
      registered += 1
      return slots.register(
        {
          name: 'conversation.input.right',
          id: COMPOSER_CHIP_ID,
          order: COMPOSER_CHIP_ORDER,
          locale: CODEARTS_LOCALE_NS,
          inject: () => ({ t }),
        },
        CreditsGate,
      )
    })

    console.info(
      `[dsh-connect-codearts] 客户端已挂载，注册了 ${registered} 个槽位（设置页 + 积分胶囊）`,
    )
  } catch (error) {
    console.error(
      '[dsh-connect-codearts] 客户端卡片加载失败（宿主侧 provider 不受影响）：',
      error,
    )
  }
}
