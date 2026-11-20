#!/usr/bin/env node
/**
 * 前端半边（`lib/client.js`）的运行时冒烟测试。
 *
 *   node scripts/smoke-client.mjs
 *
 * ## 为什么需要它
 *
 * `verify-entry-artifacts.mjs` 只验证**形态**（有没有 modloader 外壳、`require`
 * 是不是只有 react）。形态对了但运行时全错的组合非常多，而且**每一种都是静默的**：
 *
 *   · `ctx.locale.register(ns, dict)` 传错签名 → `t()` 每次返回 key 原文，
 *     界面上出现 `panel.title` 这种词，不报错。
 *   · `ctx.slots.register` 的 registration 形状与槽位 kind 不符（`list` 槽要
 *     `id`，`keyed` 槽要 `key`）→ 宿主抛错或静默丢弃，取决于版本。
 *   · `inject(...)` 的返回值不是 `{ t, ... }` → 组件里 `props.t` 是 undefined，
 *     渲染时炸，但被 apply 的 try/catch 吞掉，用户只看到「卡片没出来」。
 *   · `apply` 整段包了 try/catch → **任何异常都不会让 DSH 启动失败**，
 *     所以只会在用户机器上表现为「插件装了但设置页没有它」。
 *
 * 这个脚本模拟宿主的这两个服务，把 `lib/client.js` 真跑一遍，逐条断言。
 *
 * ## 它不能替代什么
 *
 * 它不渲染 React 树，所以样式、布局、CSS 变量名写错它看不见。那些需要真实 GUI。
 * 但「注册行为是否正确」这一层它是真的在跑代码，不是读源码猜的。
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const problems = []
const notes = []

const check = (label, condition, detail) => {
  if (condition) return
  problems.push(detail === undefined ? label : `${label}\n    ${detail}`)
}

// ─── 假 React：客户端只用 createElement 与 hooks，这里给最小可用实现 ──────────
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}
const jsxRuntimeStub = {
  jsx: reactStub.createElement,
  jsxs: reactStub.createElement,
  Fragment: Symbol('Fragment'),
}
const requires = {
  react: reactStub,
  'react/jsx-runtime': jsxRuntimeStub,
}

// ─── 假宿主服务：只实现本插件真正用到的部分 ─────────────────────────────────
const registrations = []
const localeNamespaces = new Map()
let bindCallCount = 0

const makeContext = () => {
  const slots = {
    inject(key, callback) {
      // 宿主语义：注入回调在槽位可用时执行，返回 disposer。
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register(registration, component) {
      registrations.push({ registration, component })
      return () => {}
    },
  }

  const locale = {
    register(ns, dicts) {
      if (typeof ns !== 'string' || ns === '') {
        throw new TypeError(`locale.register: ns 必须是非空字符串，收到 ${String(ns)}`)
      }
      if (dicts === null || typeof dicts !== 'object') {
        throw new TypeError(`locale.register(${ns}): 第二个参数必须是语言字典对象`)
      }
      // 宿主签名是 register(ns, { zh, en }) 或 register(ns, locale, dict)，两种都接受。
      const languages = Object.keys(dicts)
      if (languages.length === 0) {
        throw new TypeError(`locale.register(${ns}): 字典为空`)
      }
      localeNamespaces.set(ns, dicts)
      return () => {}
    },
    bind(ns) {
      bindCallCount += 1
      const dicts = localeNamespaces.get(ns)
      // 宿主 t() 的行为：找不到 key 就返回 key 本身，不抛错也不报警。
      // 这正是「界面出现 panel.title」这种故障的成因，所以要在这里查出来。
      return (key, options) => {
        if (dicts === undefined) return key
        const zhDict = dicts.zh ?? dicts
        const value = zhDict?.[key]
        if (typeof value !== 'string') return key
        if (options === null || typeof options !== 'object') return value
        return value.replace(/\{(\w+)\}/g, (whole, name) =>
          Object.hasOwn(options, name) ? String(options[name]) : whole,
        )
      }
    },
    getLocale: () => 'zh',
    setLocale: () => {},
  }

  // 客户端只 inject ['slots','locale']，其它服务一律不提供 —— 这样能验证
  // 「插件真的只依赖这两个」。若代码偷偷用了第三个服务，这里会 undefined 炸。
  return { slots, locale }
}

// ─── 装载 lib/client.js ─────────────────────────────────────────────────────
const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

let moduleExports
const fakeWindow = {
  __ModuleLoader__: {
    load({ id, factory }) {
      if (id !== 'dsh-connect-codearts') {
        problems.push(`modloader id 是 ${id}，宿主按包名索引，应为 dsh-connect-codearts`)
      }
      moduleExports = factory((specifier) => {
        if (!Object.hasOwn(requires, specifier)) {
          throw new Error(`client.js 请求了未提供的模块：${specifier}`)
        }
        return requires[specifier]
      })
    },
  },
}

// 用 Function 而不是 eval，避免严格模式下的变量提升差异；沙箱里只有 window。
const run = new Function('window', 'console', `${source}\n`)
const quietConsole = { info: () => {}, warn: () => {}, error: () => {}, log: () => {}, debug: () => {} }
try {
  run(fakeWindow, quietConsole)
} catch (error) {
  problems.push(`加载 lib/client.js 抛异常：${error instanceof Error ? error.message : String(error)}`)
}

// ─── 断言 1：导出形状 ───────────────────────────────────────────────────────
if (moduleExports === undefined) {
  problems.push('lib/client.js 没有调用 window.__ModuleLoader__.load，前端半边不会被加载')
} else {
  check(
    'name 应为 dsh-connect-codearts-client',
    moduleExports.name === 'dsh-connect-codearts-client',
    `实际：${String(moduleExports.name)}`,
  )
  const injectList = moduleExports.inject
  check(
    'inject 必须是数组且只含 slots / locale',
    Array.isArray(injectList) &&
      injectList.length === 2 &&
      injectList.includes('slots') &&
      injectList.includes('locale'),
    `实际：${JSON.stringify(injectList)}。inject 里写宿主没提供的服务会让 apply 永不运行（Cordis 依赖门是硬的）。`,
  )
  check('apply 必须是函数', typeof moduleExports.apply === 'function', `实际：${typeof moduleExports.apply}`)
}

// ─── 断言 2：apply 真的注册了东西 ───────────────────────────────────────────
if (typeof moduleExports?.apply === 'function') {
  const ctx = makeContext()
  try {
    moduleExports.apply(ctx)
  } catch (error) {
    // apply 内部包了 try/catch 才不该抛到这里；抛出来说明包裹不完整。
    problems.push(`apply(ctx) 抛异常：${error instanceof Error ? error.message : String(error)}`)
  }

  check(
    'locale 命名空间应被注册一次',
    localeNamespaces.size === 1,
    `实际注册了 ${localeNamespaces.size} 个：${[...localeNamespaces.keys()].join(', ') || '(无)'}`,
  )
  check('locale.bind 应被调用（拿 t）', bindCallCount > 0, `实际调用 ${bindCallCount} 次`)

  const slotNames = registrations.map((r) => r.registration?.name)
  check(
    '应注册 settings.section',
    slotNames.includes('settings.section'),
    `实际注册的槽位：${JSON.stringify(slotNames)}`,
  )
  check(
    '应注册 conversation.input.right',
    slotNames.includes('conversation.input.right'),
    `实际注册的槽位：${JSON.stringify(slotNames)}`,
  )
  check(
    '不应注册 conversation.input.model.label（该槽是 single，赢家通吃会挤掉宿主徽章）',
    !slotNames.includes('conversation.input.model.label'),
    '注册了它会把宿主自己的模型徽章顶掉。',
  )

  // 每个注册项的形状检查 —— 宿主对 list 槽要求 id，写错会被静默丢弃或抛错。
  for (const { registration } of registrations) {
    const name = registration?.name
    if (typeof name !== 'string') {
      problems.push(`有个注册项的 name 不是字符串：${JSON.stringify(registration)}`)
      continue
    }
    if (typeof registration.id !== 'string' || registration.id === '') {
      problems.push(`${name} 缺少 id（list 槽的 registration 必须有 id）`)
    }
    if (!Object.hasOwn(registration, 'locale')) {
      notes.push(`${name} 没有声明 locale 命名空间`)
    }
    if (typeof registration.inject !== 'function') {
      problems.push(`${name} 的 inject 不是函数，组件拿不到 t`)
    }
  }

  // ─── 断言 3：组件里用到的每个 t() key 都在字典里 ──────────────────────────
  //
  // 宿主 t() 的兜底行为是「找不到就返回 key 原文」，不抛错也不报警。所以少一个
  // 词条的现场是：界面上某处显示 `models.ratioHint`，而所有检查都是绿的。
  // 这里从产物里抓真实调用点，逐个对字典查。
  const usedKeys = new Set()
  const keyPattern = /\bt\(\s*["']([A-Za-z][A-Za-z0-9_.]*)["']/g
  let keyMatch
  while ((keyMatch = keyPattern.exec(source)) !== null) usedKeys.add(keyMatch[1])

  const dicts0 = [...localeNamespaces.values()][0] ?? {}
  const zh0 = dicts0.zh ?? {}
  const missing = [...usedKeys].filter((key) => !Object.hasOwn(zh0, key))
  check(
    '组件里调用的 t() key 必须都在字典里',
    missing.length === 0,
    `缺 ${missing.length} 个：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}\n    宿主 t() 找不到 key 时返回原文，界面上就会出现这些 key。`,
  )
  notes.push(`组件共用到 ${usedKeys.size} 个 t() key，字典 ${Object.keys(zh0).length} 个词条`)
}

// ─── 结论 ───────────────────────────────────────────────────────────────────
if (problems.length === 0) {
  console.log('✓ lib/client.js 运行时冒烟通过')
  console.log(`  注册了 ${registrations.length} 个槽位：${registrations.map((r) => r.registration?.name).join(', ')}`)
  const dicts = [...localeNamespaces.values()][0] ?? {}
  console.log(`  字典：zh ${Object.keys(dicts.zh ?? {}).length} 个键 / en ${Object.keys(dicts.en ?? {}).length} 个键`)
  for (const note of notes) console.log(`  提示：${note}`)
  process.exitCode = 0
} else {
  console.error(`✗ 前端半边有 ${problems.length} 个问题\n`)
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exitCode = 1
}
