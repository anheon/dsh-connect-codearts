#!/usr/bin/env node
/**
 * 构建产物守卫：把「我手动验过一次」变成「每次构建都验」。
 *
 *   node scripts/verify-entry-artifacts.mjs
 *
 * 由 `npm run build` 在 `tsdown` 之后调用，也是 `prepack` 的一部分。
 *
 * ## 为什么需要它
 *
 * 这份插件有三个入口，各自在不同的模块系统里跑，任一个错都是**静默**的：
 *
 *   `lib/index.js`  —— 宿主进程的 ESM。宿主 peer 必须保持外置（`neverBundle`），
 *                      否则会把 host 的实现复制进包，两套 cordis 实例互不认识。
 *   `lib/bin.js`    —— `dsh plugin exec` 在**纯 Node 解析**下跑，profile 里
 *                      peer 从不安装（`autoInstallPeers: false`）。这里出现
 *                      任何一个裸 specifier（比如 `@deepseek-ai/dsh-llm`）都会
 *                      `ERR_MODULE_NOT_FOUND`，而且只在用户机器上炸。
 *   `lib/client.js` —— 浏览器 classic script，必须包在
 *                      `window.__ModuleLoader__.load({...})` 里。裸着输出会报
 *                      "Cannot use import statement outside a module"，并让整个
 *                      GUI 启动失败（web boot: 1 entry did not activate）。
 *
 * 之前这三条我都是手动 `grep` 验的。手动会忘，忘了不会报错 —— 所以写下来。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const problems = []

const read = (relative) => {
  const full = join(ROOT, relative)
  if (!existsSync(full)) {
    problems.push(`${relative} 不存在 —— 构建没有产出这个入口`)
    return undefined
  }
  return readFileSync(full, 'utf8')
}

/** 抽出所有 `from "x"` / `import("x")` / `require("x")` 的说明符。 */
const specifiersOf = (source) => {
  const found = new Set()
  const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  let match
  while ((match = pattern.exec(source)) !== null) found.add(match[1])
  return found
}

const isBare = (spec) => !spec.startsWith('.') && !spec.startsWith('node:')

/**
 * 宿主 peer：`neverBundle` 里的那些。它们出现在 `lib/index.js` 里是**要求**，
 * 出现在 `lib/bin.js` 里是**故障**。
 */
const HOST_PEERS = [
  '@earendil-works/pi-ai',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
  // 只在类型位置用到，但万一将来变成值导入，这里会立刻报出来。
  '@deepseek-ai/dsh-attachment',
]

// ─── lib/bin.js：必须能在纯 Node 里解析 ─────────────────────────────────────
const bin = read('lib/bin.js')
if (bin !== undefined) {
  const bare = [...specifiersOf(bin)].filter(isBare)
  if (bare.length > 0) {
    problems.push(
      `lib/bin.js 里有 ${bare.length} 个裸 specifier：${bare.join(', ')}\n` +
        `    bin 在纯 Node 解析下跑，profile 里 peer 从不安装，这些会在用户机器上\n` +
        `    ERR_MODULE_NOT_FOUND。改为运行时 import()，或把对应依赖打进产物。`,
    )
  }
}

// ─── lib/index.js：宿主 peer 必须外置，且不能吊死在内核之外 ──────────────────
const index = read('lib/index.js')
if (index !== undefined) {
  const bare = [...specifiersOf(index)].filter(isBare)
  const unexpected = bare.filter((spec) => !HOST_PEERS.includes(spec))
  if (unexpected.length > 0) {
    problems.push(
      `lib/index.js 引用了非宿主 peer 的外部包：${unexpected.join(', ')}\n` +
        `    要么加进 tsdown 的 neverBundle（当它是 host peer），要么让它被打进产物。\n` +
        `    现在这个状态装到用户机器上会找不到模块。`,
    )
  }
}

// ─── lib/client.js：必须是 __ModuleLoader__ 外壳 ──────────────────────────────
const client = read('lib/client.js')
if (client !== undefined) {
  if (!client.includes('window.__ModuleLoader__.load(')) {
    problems.push(
      'lib/client.js 没有 window.__ModuleLoader__.load( 外壳 —— 浏览器里会报\n' +
        '    "Cannot use import statement outside a module"，整个 GUI 启动失败。',
    )
  }
  // `id` 是对象键，tsdown 输出里不带引号（`id: "dsh-connect-codearts"`），
  // 所以这里键侧两种形态都要接受 —— 只写带引号的那版会让守卫永远误报。
  if (!/(?:["']id["']|(?<![\w$])id)\s*:\s*["']dsh-connect-codearts["']/.test(client)) {
    problems.push('lib/client.js 的 modloader id 不是 dsh-connect-codearts（宿主按它索引前端半边）。')
  }
  for (const name of ['apply', 'inject', 'name']) {
    if (!new RegExp(`exports\\.${name}\\s*=`).test(client)) {
      problems.push(`lib/client.js 没有导出 ${name}（宿主靠这三项装配前端半边）。`)
    }
  }
  const bare = [...specifiersOf(client)].filter(isBare)
  const notExternal = bare.filter((spec) => !['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(spec))
  if (notExternal.length > 0) {
    problems.push(
      `lib/client.js 引用了未在 CLIENT_EXTERNALS 里声明的包：${notExternal.join(', ')}\n` +
        `    它们会被打进产物（可能带进 Node 专用代码，如 react-dom 的 process 引用）。`,
    )
  }
}

// ─── 声明文件：类型入口必须存在 ──────────────────────────────────────────────
for (const relative of ['lib/index.d.ts']) {
  if (!existsSync(join(ROOT, relative))) problems.push(`${relative} 不存在，types 字段会指向空。`)
}

// ─── 结论 ───────────────────────────────────────────────────────────────────
if (problems.length === 0) {
  console.log('✓ 三个入口的产物形态都正确（bin 无裸 specifier / index peer 外置 / client 有 modloader 外壳）')
  process.exitCode = 0
} else {
  console.error(`✗ 构建产物有 ${problems.length} 个问题\n`)
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exitCode = 1
}
