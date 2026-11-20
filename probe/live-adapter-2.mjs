// 真实网关下的两项关键行为：工具调用、developer 角色改写。
// 与 live-adapter.mjs 分开，避免一次跑太久。
import { CodeArtsAdapter, CODEARTS_PROVIDER } from '../src/adapter.ts'
import { CodeArtsUpstreamClient } from '../src/upstream.ts'
import { loadCredentials } from '../src/credentials.ts'

const cred = await loadCredentials(process.env['DSH_HOME'] ?? '')
if (cred.key === undefined) {
  console.log('NO CRED')
  process.exit(1)
}

const upstreamCred = { accessKey: cred.key.accessKey, secretKey: cred.key.secretKey }
const client = new CodeArtsUpstreamClient({})
const entries = await client.listModels(upstreamCred)

const adapter = new CodeArtsAdapter({
  client,
  credentials: async () => upstreamCred,
  catalog: () => entries,
  thinkingVariants: () => new Map(),
  defaultEfforts: () => new Map(),
  resolveImage: async () => undefined,
  log: () => {},
})

console.log('===== 1. 工具调用 =====')
const toolDeltas = []
let toolFinish = null
for await (const c of adapter.stream({
  provider: CODEARTS_PROVIDER,
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: '北京现在天气怎么样？用工具查。' }],
  tools: [
    {
      name: 'get_weather',
      description: '查天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ],
  maxTokens: 1024,
})) {
  if (c.type === 'tool-call-delta') toolDeltas.push(c)
  if (c.type === 'finish') toolFinish = c.reason
}
console.log('  tool-call deltas:', toolDeltas.length)
console.log('  distinct names :', [...new Set(toolDeltas.map((d) => d.name).filter(Boolean))].join(',') || '(none)')
console.log('  merged args    :', toolDeltas.map((d) => d.argumentsDelta).join('').slice(0, 160))
console.log('  finish         :', JSON.stringify(toolFinish))

console.log('\n===== 2. developer 角色改写 =====')
let devText = ''
let devFinish = null
let devFailure = null
for await (const c of adapter.stream({
  provider: CODEARTS_PROVIDER,
  model: 'glm-5.3-flash',
  messages: [
    { role: 'developer', content: '你是一个只回答单个汉字的助手。' },
    { role: 'user', content: '说“好”' },
  ],
  maxTokens: 512,
})) {
  if (c.type === 'text-delta') devText += c.text
  if (c.type === 'finish') {
    devFinish = c.reason
    if (c.reason.kind === 'error' || c.reason.kind === 'aborted') devFailure = c.reason.failure
  }
}
console.log('  text   :', JSON.stringify(devText))
console.log('  finish :', JSON.stringify(devFinish))
if (devFailure) console.log('  failure:', JSON.stringify(devFailure))

console.log('\n===== 3. 未知模型是否干净报错 =====')
try {
  await adapter.resolveModel(CODEARTS_PROVIDER, 'no-such-model-xyz')
  console.log('  ⚠ 没有抛错（应该抛）')
} catch (e) {
  console.log('  resolveModel 抛错 ✓:', String(e.message).slice(0, 120))
}
