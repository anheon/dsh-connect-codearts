/**
 * 卡面文案守卫。
 *
 * 插件卡上的标题与简介**不是本插件渲染的**，是 DSH 插件管理器读的包元数据：
 * `readPluginMeta()` 先解析 `<包名>/locale/en.json`，再扫描该文件所在目录取出
 * 其余语言文件，逐个读 `meta.title` / `meta.description`。三个静默失败点：
 *
 *   1. **`en.json` 是锚点。** 读取端遍历的是「英文资源所在目录」，没有
 *      `en.json` 就不会去读 `zh.json` —— 中文永不生效，且不报错。
 *   2. **`exports` 里缺 `"./locale/*.json"` 通配 = 静默失败。** 抛
 *      `ERR_PACKAGE_PATH_NOT_EXPORTED`，读取端把它连同 ENOENT 一起当「没有本地化
 *      元数据」吞掉，界面上只显示英文。
 *   3. **`displayName` 不在这条链上。** 标题回退是裸包名。
 *
 * 同一句话有三处副本：`locale/{en,zh}.json` 的 `meta`、`package.json` 的
 * `description`（简介回退，只认字符串）、市场条目草稿 YAML。改一处就要同改 ——
 * 但**注意 `package.json.description` 是中文**，见下面那条测试里的理由。
 *
 * @module dsh-connect-codearts/tests/locale-meta
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')

const readJson = <T>(relative: string): T => JSON.parse(read(relative)) as T

interface LocaleFile {
  readonly meta: { readonly title: string; readonly description: string }
}

interface PackageFile {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly files: readonly string[]
  readonly exports: Record<string, unknown>
  readonly dsh: {
    readonly bundle: { readonly patch: string }
    readonly client: { readonly inject: readonly string[]; readonly platform: string }
  }
}

const en = readJson<LocaleFile>('locale/en.json')
const zh = readJson<LocaleFile>('locale/zh.json')
const pkg = readJson<PackageFile>('package.json')

describe('locale 文件', () => {
  it('en.json 存在且 title 是裸包名（读取端不认 displayName）', () => {
    expect(en.meta.title).toBe(pkg.name)
  })

  it('zh.json 的 title 与 en 一致（标题不翻译）', () => {
    expect(zh.meta.title).toBe(pkg.name)
  })

  it('两种语言的简介都非空且互不相同', () => {
    expect(en.meta.description.length).toBeGreaterThan(40)
    expect(zh.meta.description.length).toBeGreaterThan(20)
    expect(zh.meta.description).not.toBe(en.meta.description)
  })

  /**
   * 中文简介里必须有汉字。用长度判断是不够的 —— 复制粘贴英文占位符也能达到
   * 长度要求，而那种情况在界面上完全看不出来（英文兜底会掩盖它）。
   */
  it('zh.json 的简介真的是中文', () => {
    expect(/[\u4e00-\u9fff]/.test(zh.meta.description)).toBe(true)
  })
})

describe('package.json 的元数据链', () => {
  /**
   * `package.json.description` 被**两处**读取，而这两处想要的东西不一样：
   *
   *   1. npmjs.com 的包页、GitHub 从它派生的 "About" 行 —— 受众是中文用户。
   *   2. 宿主在 `locale/en.json` **完全没被解析到**时的最后一层兜底
   *      （`localizedText` 从 `manifest.description` 起步）。
   *
   * 英文文案住在 `locale/en.json`，只要它读得到就会**覆盖**这层兜底
   * （字典是最后展开的），所以英文界面照样显示英文；中文是「装坏了降级到」
   * 的样子，也是 registry 页面显示的样子。
   *
   * 这是**刻意的分工，不是漂移** —— 所以这条断言钉的是「中文，且不是英文那句」，
   * 而不是「与 en.json 相同」。将来若有人想把这里改回英文，必须显式改这条测试。
   */
  it('description 是中文，且不是 en.json 那句（刻意的分工）', () => {
    expect(pkg.description).toMatch(/[\u4e00-\u9fff]/u)
    expect(pkg.description).not.toBe(en.meta.description)
    expect(pkg.description.length).toBeGreaterThan(20)
  })

  it('en.json 那句里没有汉字（英文界面不该漏中文）', () => {
    expect(en.meta.description).not.toMatch(/[\u4e00-\u9fff]/u)
  })

  it('displayName 存在（供插件列表显示人类可读名）', () => {
    expect(pkg.displayName.length).toBeGreaterThan(0)
  })

  /**
   * `files` 里写的是**裸目录名** `locale`（不是 glob）。写成 `locale/*.json` 也
   * 能工作，但 `docs/PRIVACY.md` 那种单文件白名单说明作者用的是「目录级 + 单文件
   * 级混排」风格，统一成裸目录名更不容易漏。
   */
  it('files 包含裸目录名 locale', () => {
    expect(pkg.files).toContain('locale')
  })

  it('files 包含 icons 与 cordis.patch.yml', () => {
    expect(pkg.files).toContain('icons')
    expect(pkg.files).toContain('cordis.patch.yml')
  })

  /**
   * 这条是「静默失败点 2」的守卫。缺了通配导出，`readPluginMeta()` 抛
   * `ERR_PACKAGE_PATH_NOT_EXPORTED` 后会被当成「没有本地化元数据」吞掉 ——
   * 界面上只是没有中文，没有任何报错。
   */
  it('exports 暴露 "./locale/*.json" 通配', () => {
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
  })

  it('exports 暴露 client 入口（宿主按 "./client" 加载前端半边）', () => {
    expect(pkg.exports['./client']).toBe('./lib/client.js')
  })

  it('exports 暴露 cordis.patch.yml 与 package.json', () => {
    expect(pkg.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    expect(pkg.exports['./package.json']).toBe('./package.json')
  })
})

describe('bundle 与 client 声明', () => {
  it('dsh.bundle.patch 指向存在的文件', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    const patch = read('cordis.patch.yml')
    expect(patch).toContain(pkg.name)
  })

  it('cordis.patch.yml 只做 insert，不改用户的默认模型', () => {
    const patch = read('cordis.patch.yml')
    expect(patch).toContain('insert')
    // 「不改 profile 当前默认模型」是设计约束：装插件不该悄悄换掉用户正在用的模型。
    expect(patch).not.toMatch(/agent-default-model/)
  })

  it('dsh.client.platform 是 web', () => {
    expect(pkg.dsh.client.platform).toBe('web')
  })

  /**
   * `dsh.client.inject` 列的是**内部**包名（要注入的宿主前端模块），不是服务名。
   * 少了 `dsh-client-ui-slots` 前端半边拿不到槽位服务，`apply` 会静默不执行。
   */
  it('dsh.client.inject 含 slots 与 locale', () => {
    const inject = pkg.dsh.client.inject.join(' ')
    expect(inject).toMatch(/dsh-client-ui-slots/)
    expect(inject).toMatch(/dsh-client-locale/)
  })
})
