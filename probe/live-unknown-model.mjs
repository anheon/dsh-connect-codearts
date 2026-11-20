// 未知模型时的真实行为：宿主的 resolveModel 通过 => stream 会带着不存在的 model 打网关
import { CodeArtsAdapter, CODEARTS_PROVIDER } from '../src/adapter.ts'
import { CodeArtsUpstreamClient } from '../src/upstream.ts'
import { loadCredentials } from '../src/credentials.ts'

const cred = await loadCredentials(process.env['DSH_HOME'] ?? '')
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

console.log('目录里', entries.length, '个模型')
const resolved = await adapter.resolveModel(CODEARTS_PROVIDER, 'no-such-model-xyz')
console.log('resolveModel(no-such-model-xyz) 返回:', JSON.stringify({
  id: resolved.id, name: resolved.name,
  hasContext: resolved.context !== undefined,
  defaultMaxTokens: resolved.defaultMaxTokens,
}))

let text = '', finish = null, failure = null
for await (const c of adapter.stream({
  provider: CODEARTS_PROVIDER, model: 'no-such-model-xyz',
  messages: [{ role: 'user', content: '你好' }], maxTokens: 128,
})) {
  if (c.type === 'text-delta') text += c.text
  if (c.type === 'finish') { finish = c.reason; if (c.reason.failure) failure = c.reason.failure }
}
console.log('stream 结果: text=' + JSON.stringify(text), '| finish=' + JSON.stringify(finish))
if (failure) console.log('failure:', JSON.stringify(failure))
