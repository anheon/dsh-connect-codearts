// 用真实 dsh-llm 基类 + 真实网关跑一次 adapter 流式对话
import { CodeArtsAdapter, CODEARTS_PROVIDER } from '../src/adapter.ts'
import { CodeArtsUpstreamClient } from '../src/upstream.ts'
import { loadCredentials, maskAccessKey } from '../src/credentials.ts'

const cred = await loadCredentials(process.env['DSH_HOME'] ?? '')
if (cred.key === undefined) { console.log('NO CRED'); process.exit(1) }
console.log('cred source:', cred.key.source, '| ak:', maskAccessKey(cred.key.accessKey))

const client = new CodeArtsUpstreamClient({})
const catalogEntries = await client.listModels({ accessKey: cred.key.accessKey, secretKey: cred.key.secretKey })
console.log('catalog entries:', catalogEntries.length)
const adapter = new CodeArtsAdapter({
  client,
  credentials: async () => cred.key,
  catalog: () => catalogEntries,
  thinkingVariants: () => new Map(),
  defaultEfforts: () => new Map(),
  resolveImage: async () => undefined,
  log: (l) => console.log('  [log]', String(l).slice(0, 140)),
})

console.log('providerInfo:', JSON.stringify(adapter.providerInfo(CODEARTS_PROVIDER)))
const models = await adapter.listModels(CODEARTS_PROVIDER)
console.log('listModels count:', models.length)
console.log('first 3:', models.slice(0, 3).map(m => m.id + ' / ' + m.name).join(' | '))

const resolved = await adapter.resolveModel(CODEARTS_PROVIDER, 'glm-5.3-flash')
console.log('resolveModel:', JSON.stringify({
  id: resolved.id, name: resolved.name,
  context: resolved.context, defaultMaxTokens: resolved.defaultMaxTokens,
  reasoning: resolved.reasoning, inputModalities: resolved.inputModalities,
}))

const chunks = []
let text = '', reasoning = ''
for await (const c of adapter.stream({
  provider: CODEARTS_PROVIDER,
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: '用一句话说明你是谁' }],
  maxTokens: 2048,
})) {
  chunks.push(c.type)
  if (c.type === 'text-delta') text += c.text
  else if (c.type === 'reasoning-delta') reasoning += c.text
  else if (c.type === 'usage') console.log('usage:', JSON.stringify(c.usage))
  else if (c.type === 'finish') console.log('finish:', JSON.stringify(c.reason))
}
console.log('chunk types:', [...new Set(chunks)].join(','))
console.log('text len:', text.length, '| reasoning len:', reasoning.length)
console.log('text:', text.slice(0, 200))

console.log('
===== 工具调用 =====');
let toolFinish = null, toolDeltas = []
for await (const c of adapter.stream({
  provider: CODEARTS_PROVIDER, model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: '北京现在天气怎么样？用工具查。' }],
  tools: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
  maxTokens: 1024,
})) {
  if (c.type === 'tool-call-delta') toolDeltas.push(c)
  if (c.type === 'finish') toolFinish = c.reason
}
console.log('tool deltas:', toolDeltas.length, '| names:', [...new Set(toolDeltas.map(d=>d.name).filter(Boolean))].join(','))
console.log('tool args:', toolDeltas.map(d=>d.argumentsDelta).join('').slice(0,120))
console.log('finish:', JSON.stringify(toolFinish))

console.log('
===== developer 角色改写 =====');
let devText = '', devFinish = null
for await (const c of adapter.stream({
  provider: CODEARTS_PROVIDER, model: 'glm-5.3-flash',
  messages: [{ role: 'developer', content: '你只说一个字。' }, { role: 'user', content: '说"好"' }],
  maxTokens: 512,
})) {
  if (c.type === 'text-delta') devText += c.text
  if (c.type === 'finish') devFinish = c.reason
}
console.log('developer→system 结果:', JSON.stringify(devText), '| finish:', JSON.stringify(devFinish))
