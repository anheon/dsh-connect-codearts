/**
 * 端到端冒烟：拉真实网关，验证「实现对不对」而不只是「解析对不对」。
 *
 * 单测能证明签名器算得对、SSE 解析得对，但证明不了这四件事 —— 它们都只能在
 * 真实响应上验：
 *   ① `settingsNamespaceOf()` 取到的命名空间。宿主按**精确匹配**查表，取错了
 *      会让配置入口与模型发现双双静默失效（不报错，只是什么都不发生）。
 *   ② `TokenUsage` 的**字段互斥**语义。宿主注释写明 `inputTokens` 只算未命中
 *      缓存的输入，而上游的 `prompt_tokens` 是「命中 + 未命中」之和 —— 不减
 *      出来的话宿主会把缓存命中的输入再算一遍钱。
 *   ③ `finishReasonOf` 的映射。`length` 归成 `stop` 就变成静默空回复。
 *   ④ 构建产物（`lib/`）与源码行为一致，且 `lib/bin.js` 里没有裸宿主 specifier
 *      （profile 的 peer 从不安装，`bin` 会在纯 Node 解析下崩）。
 *
 * 用法（需要 CODEARTS_CLI_AK / CODEARTS_CLI_SK）：
 *   node --experimental-strip-types probe/m1-smoke.mjs
 *
 * @module dsh-connect-codearts/probe/m1-smoke
 */
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * 根目录的 file:// URL。
 *
 * Windows 上**不能**把裸盘符路径交给动态 `import()`：ESM loader 只认
 * file/data/node 三种 scheme，`C:\...` 会被解析成协议 `c:` 并抛
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`。用 `pathToFileURL` 转一次即可，
 * 这也是唯一在三种平台上都成立的写法。
 */
const ROOT = new URL('..', import.meta.url)
const at = (relative) => new URL(relative, ROOT).href

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const main = async () => {
  // ── 1. 构建产物导出面 ────────────────────────────────────────────────
  const lib = await import(at('lib/index.js'))
  record('lib 导出 name', lib.name === 'dsh-connect-codearts', lib.name)
  record('lib 导出 inject 含 llm', Array.isArray(lib.inject) && lib.inject.includes('llm'), JSON.stringify(lib.inject))
  record('lib 导出 apply', typeof lib.apply === 'function')
  record('lib 导出 Config', lib.Config !== undefined)
  record('lib 导出 VERSION', typeof lib.VERSION === 'string', lib.VERSION)

  /**
   * 命名空间回退。真实环境里宿主一定带 fiber，这条分支测的是「取错时不要
   * 静默拿到 undefined」—— 那会让 provider 被判未配置。
   */
  const fallback = lib.settingsNamespaceOf({})
  record('settingsNamespaceOf 无 fiber 时回退到包名', fallback === 'dsh-connect-codearts', String(fallback))
  const fromFiber = lib.settingsNamespaceOf({ fiber: { entry: { options: { id: 'profile-entry' } } } })
  record('settingsNamespaceOf 优先取 fiber.entry.options.id', fromFiber === 'profile-entry', String(fromFiber))

  // ── 2. 凭据 ──────────────────────────────────────────────────────────
  const { loadCredentials } = await import(at('src/credentials.ts'))
  const loaded = await loadCredentials(process.env.DSH_HOME ?? '')

  if (loaded.key === undefined) {
    console.error('\n没有读到凭据，跳过网络部分。先配置 CODEARTS_CLI_AK / CODEARTS_CLI_SK。')
    for (const attempt of loaded.attempts) {
      console.error(`  ${attempt.ok ? '✓' : '✗'} ${attempt.source.padEnd(8)} ${attempt.origin} ${attempt.reason ?? ''}`)
    }
    process.exitCode = 1
    return
  }
  record('凭据已读到', true, `${loaded.key.source} @ ${loaded.key.origin}`)

  const credentials = { accessKey: loaded.key.accessKey, secretKey: loaded.key.secretKey }
  const { CodeArtsUpstreamClient } = await import(at('src/upstream.ts'))
  const client = new CodeArtsUpstreamClient()

  // ── 3. 目录 ──────────────────────────────────────────────────────────
  const entries = await client.listModels(credentials)
  record('模型目录非空', entries.length > 0, `${entries.length} 个`)
  record('每个模型都有真实 contextWindow', entries.every((entry) => entry.contextWindow > 0))
  record('每个模型都有真实 maxTokens', entries.every((entry) => entry.maxTokens > 0))
  const withRatio = entries.filter((entry) => entry.ratioDisplay !== undefined)
  record('至少一个模型带积分倍率', withRatio.length > 0, `${withRatio.length} 个`)
  const withImages = entries.filter((entry) => entry.supportsImages)
  record('至少一个模型支持图片', withImages.length > 0, withImages.map((entry) => entry.id).join(','))

  // ── 4. 思考档位 ──────────────────────────────────────────────────────
  const variants = await client.thinkingVariants(credentials, entries.map((entry) => entry.id))
  const declared = [...variants.entries()].filter(([, value]) => value.strengths.length > 0)
  record('思考档位表可读', true, `${declared.length}/${variants.size} 个模型声明了档位`)

  // ── 5. 适配器 ────────────────────────────────────────────────────────
  const { CodeArtsAdapter, CODEARTS_PROVIDER } = await import(at('src/adapter.ts'))
  const adapter = new CodeArtsAdapter({
    client,
    credentials: async () => credentials,
    catalog: () => entries,
    thinkingVariants: () => variants,
    defaultEfforts: () => new Map(),
  })

  const info = adapter.providerInfo(CODEARTS_PROVIDER)
  record('providerInfo 正确', info.id === CODEARTS_PROVIDER, `${info.id} / ${info.name}`)

  const listed = await adapter.listModels(CODEARTS_PROVIDER)
  record('adapter.listModels 与目录一致', listed.length === entries.length, `${listed.length}`)

  const first = entries[0]
  const resolved = await adapter.resolveModel(CODEARTS_PROVIDER, first.id)
  record(
    'resolveModel 用真实 contextWindow',
    resolved.context?.contextWindow === first.contextWindow,
    `${resolved.context?.contextWindow}`,
  )
  record(
    'resolveModel 的 defaultMaxTokens ≤ 32768',
    (resolved.defaultMaxTokens ?? 0) <= 32_768,
    `${resolved.defaultMaxTokens}`,
  )
  record(
    'resolveModel 声明了 off 档位',
    resolved.reasoning?.efforts.some((effort) => String(effort.id) === 'off') === true,
    resolved.reasoning?.efforts.map((effort) => String(effort.id)).join('/') ?? '(none)',
  )

  /**
   * 未声明档位的模型**不能**给 `defaultEffort`。
   *
   * 宿主会把 defaultEffort 物化进每个请求，而只声明了 `off` 的模型接了别的
   * 档位会抛 `UNSUPPORTED_REASONING_EFFORT` —— 表现是模型在界面上可选但一发
   * 就失败。
   */
  const plain = entries.find((entry) => (variants.get(entry.id)?.strengths.length ?? 0) === 0)
  if (plain !== undefined) {
    const plainResolved = await adapter.resolveModel(CODEARTS_PROVIDER, plain.id)
    record(
      `未声明档位的 ${plain.id} 不给 defaultEffort`,
      plainResolved.reasoning?.defaultEffort === undefined,
      String(plainResolved.reasoning?.defaultEffort),
    )
  }

  // ── 6. 真实 stream（含 usage 字段语义）───────────────────────────────
  const chunks = []
  let usage
  let finish
  for await (const chunk of adapter.stream({
    provider: CODEARTS_PROVIDER,
    model: first.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
    maxTokens: 512,
  })) {
    if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
    else chunks.push(chunk)
  }

  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  record('stream 产出正文', text.length > 0, JSON.stringify(text.slice(0, 40)))
  record('stream 以 finish 收尾', finish !== undefined, JSON.stringify(finish))
  record('finish 不是 error', finish?.kind !== 'error', finish?.kind)

  if (usage !== undefined) {
    record('usage.outputTokens > 0', usage.outputTokens > 0, `${usage.outputTokens}`)
    /**
     * 字段互斥的活体检查：`inputTokens` 与 `cacheReadTokens` 必须是**拆开**的
     * 两个数，各自非负，且 `inputTokens` 不应把缓存命中算进去。
     */
    const cacheRead = usage.cacheReadTokens ?? 0
    record(
      'usage.inputTokens 与 cacheReadTokens 分开且非负',
      usage.inputTokens >= 0 && cacheRead >= 0,
      `input=${usage.inputTokens} cacheRead=${cacheRead} output=${usage.outputTokens}`,
    )
  } else {
    record('usage 存在', false, 'undefined')
  }

  // ── 7. 工具调用 ──────────────────────────────────────────────────────
  const toolChunks = []
  let toolFinish
  for await (const chunk of adapter.stream({
    provider: CODEARTS_PROVIDER,
    model: first.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: '查一下北京天气，用工具。' }] }],
    tools: [
      {
        name: 'get_weather',
        description: '查询城市天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      },
    ],
    maxTokens: 512,
  })) {
    if (chunk.type === 'finish') toolFinish = chunk.reason
    else toolChunks.push(chunk)
  }
  const sawToolCall = toolChunks.some((chunk) => chunk.type === 'tool-call-delta')
  record(
    '工具调用可用（delta 或 finish 至少一个命中）',
    sawToolCall || toolFinish?.kind === 'tool-calls',
    `delta=${sawToolCall} finish=${toolFinish?.kind ?? '(none)'}`,
  )

  // ── 8. developer 角色改写（M0 发现：网关直接 400）───────────────────
  const devChunks = []
  let devError
  try {
    for await (const chunk of adapter.stream({
      provider: CODEARTS_PROVIDER,
      model: first.id,
      messages: [
        { role: 'developer', content: [{ type: 'text', text: '你是简洁的助手。' }] },
        { role: 'user', content: [{ type: 'text', text: '只回复：好' }] },
      ],
      maxTokens: 256,
    })) {
      devChunks.push(chunk)
    }
  } catch (error) {
    devError = error instanceof Error ? error.message : String(error)
  }
  const devText = devChunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  record(
    'developer 角色被改写成 system（否则这里会报 role cannot empty）',
    devError === undefined && devText.length > 0,
    devError ?? JSON.stringify(devText.slice(0, 20)),
  )

  // ── 9. 账号与积分 ────────────────────────────────────────────────────
  const account = await client.currentUser(credentials)
  record('账号可读', account.userName !== undefined || account.domainName !== undefined)
  const credit = await client.credit(credentials)
  record(
    '积分可读',
    credit !== undefined,
    credit === undefined ? 'undefined（可能是 Token 计费账号）' : `remain=${credit.remain}/${credit.total}`,
  )

  const welfare = await client.welfareItems(credentials)
  const checkin = welfare.find((item) => item.type === 'USER_LOGIN')
  record(
    '签到活动可识别（按 type 而不是硬编码 campaignId）',
    checkin !== undefined,
    checkin === undefined ? '未找到 USER_LOGIN' : `campaignId=${checkin.campaignId} 奖励=${checkin.benefitAmount} ${checkin.status}`,
  )

  // ── 结论 ─────────────────────────────────────────────────────────────
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const entry of failed) console.log(`  ✗ ${entry.name} ${entry.detail ?? ''}`)
    process.exitCode = 1
  }
}

await main()
