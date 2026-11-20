import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rmdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveCodeArtsHome } from '../src/credentials.ts'
import { apply } from '../src/index.ts'
import { loadLocalState, localStatePath, saveLocalState } from '../src/local-state.ts'
import { CODEARTS_WRITE_REQUEST_HEADER } from '../src/protocol/types.ts'
import { CodeArtsUpstreamClient } from '../src/upstream.ts'
import { CODEARTS_PREFERENCES_PATH } from '../src/web-status.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
type Discover = (request: { provider?: string }) => Promise<readonly { id: string }[]>

const firstKey = 'FIXTUREKEY0000000001'
const secondKey = 'FIXTUREKEY0000000002'
const model = {
  id: 'sample-model',
  name: 'Sample',
  contextWindow: 10_000,
  maxTokens: 2_000,
  supportsImages: false,
  strengths: [],
}

let stateHome: string
const disposers: Array<() => void> = []

beforeEach(async () => {
  stateHome = await mkdtemp(join(tmpdir(), 'codearts-'))
  vi.stubEnv('DSH_HOME', stateHome)
  vi.stubEnv('CODEARTS_CLI_AK', firstKey)
  vi.stubEnv('CODEARTS_CLI_SK', 'x'.repeat(40))
  vi.spyOn(CodeArtsUpstreamClient.prototype, 'thinkingVariants').mockResolvedValue(new Map())
  vi.spyOn(CodeArtsUpstreamClient.prototype, 'currentUser').mockResolvedValue({ roles: [] })
  vi.spyOn(CodeArtsUpstreamClient.prototype, 'credit').mockResolvedValue(undefined)
})

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(localStatePath(stateHome), { force: true })
  await rmdir(stateHome)
})

const boot = (autoCheckin: boolean) => {
  const routes = new Map<string, Handler>()
  let poll: (() => void) | undefined
  let discover: Discover | undefined
  const nativeInterval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation((...args) => {
    const [callback, delay, ...parameters] = args
    if (delay === 300_000) poll = () => callback(...parameters)
    return nativeInterval(...args)
  })
  const effect = (register: () => () => void) => { disposers.push(register()) }
  const ctx = {
    effect,
    inject(_services: string[], register: (webCtx: object) => void) {
      register({
        effect,
        get: () => ({ requestRejection: () => undefined }),
        webServer: {
          protocol: 'http:',
          register: ({ path, handler }: { path: string; handler: Handler }) => {
            routes.set(path, handler)
            return () => { routes.delete(path) }
          },
        },
      })
    },
    llm: {
      registerAdapter() {},
      registerConfigurableProviders: () => () => undefined,
      registerModelDiscovery(_namespace: string, handler: Discover) { discover = handler },
    },
  }
  apply(ctx as never, { autoCheckin })
  if (poll === undefined || discover === undefined) throw new Error('Plugin registration incomplete')
  return { routes, poll, discover }
}

const requestPreferences = async (handler: Handler, patch: unknown) => {
  const req = {
    method: 'POST',
    headers: {
      host: '127.0.0.1:12345',
      // 桌面转发会移除 Origin 和 Sec-Fetch-Site。
      [CODEARTS_WRITE_REQUEST_HEADER]: '1',
      'content-type': 'application/json',
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(patch))
    },
  }
  let status = 0
  let body: unknown
  const res = {
    writeHead(code: number) { status = code },
    end(text: string) { body = JSON.parse(text) },
  }
  await handler(req as never, res as never)
  return { status, body }
}

describe('plugin runtime', () => {
  it('uses the user home when DSH_HOME is absent or blank', () => {
    vi.stubEnv('DSH_HOME', undefined)
    expect(resolveCodeArtsHome()).toBe(join(homedir(), '.dsh'))
    vi.stubEnv('DSH_HOME', '  ')
    expect(resolveCodeArtsHome()).toBe(join(homedir(), '.dsh'))
  })

  it('keeps a valid catalog on an upstream error and reloads rotated credentials', async () => {
    const list = vi.spyOn(CodeArtsUpstreamClient.prototype, 'listModels').mockResolvedValue([model])
    const host = boot(false)
    expect((await host.discover({})).map((entry) => entry.id)).toEqual([model.id])
    list.mockRejectedValue(new Error('invalid gateway catalog'))
    expect((await host.discover({})).map((entry) => entry.id)).toEqual([model.id])

    vi.stubEnv('CODEARTS_CLI_AK', secondKey)
    expect(await host.discover({})).toEqual([])
    expect(list.mock.calls.at(-1)?.[0].accessKey).toBe(secondKey)
  })

  it('retries check-in on the next poll and preserves concurrent preference changes', async () => {
    const list = vi.spyOn(CodeArtsUpstreamClient.prototype, 'listModels').mockResolvedValue([model])
    const items = vi.spyOn(CodeArtsUpstreamClient.prototype, 'welfareItems')
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ campaignId: 42, title: 'Daily', type: 'USER_LOGIN', claimable: true }])
    const result = Promise.withResolvers<{ ok: boolean }>()
    const claim = vi.spyOn(CodeArtsUpstreamClient.prototype, 'claimWelfare').mockReturnValue(result.promise)
    const host = boot(true)
    await vi.waitFor(() => expect(items).toHaveBeenCalledOnce())
    expect(claim).not.toHaveBeenCalled()

    host.poll()
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce())
    const preferences = host.routes.get(CODEARTS_PREFERENCES_PATH)
    if (preferences === undefined) throw new Error('Preference route was not registered')
    const saved = requestPreferences(preferences, { hiddenModelIds: [model.id] })
    result.resolve({ ok: true })
    expect(await saved).toMatchObject({ status: 200, body: { ok: true } })
    await vi.waitFor(async () => {
      const latest = await loadLocalState(stateHome)
      expect(latest.hiddenModelIds).toEqual([model.id])
      expect(latest.lastCheckin).toBeDefined()
    })
    host.poll()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3))
    expect(items).toHaveBeenCalledTimes(2)
    expect(claim).toHaveBeenCalledOnce()
  })

  it('persists the switch and stops a pending eligibility check before it can claim', async () => {
    vi.spyOn(CodeArtsUpstreamClient.prototype, 'listModels').mockResolvedValue([model])
    const daily = { campaignId: 42, title: 'Daily', type: 'USER_LOGIN', claimable: true }
    const eligibility = Promise.withResolvers<readonly typeof daily[]>()
    const items = vi.spyOn(CodeArtsUpstreamClient.prototype, 'welfareItems')
      .mockReturnValueOnce(eligibility.promise)
      .mockResolvedValue([daily])
    const claim = vi.spyOn(CodeArtsUpstreamClient.prototype, 'claimWelfare').mockResolvedValue({ ok: true })
    const host = boot(true)
    const preferences = host.routes.get(CODEARTS_PREFERENCES_PATH)
    if (preferences === undefined) throw new Error('Preference route was not registered')
    await vi.waitFor(() => expect(items).toHaveBeenCalledOnce())

    expect(await requestPreferences(preferences, { autoCheckin: 'false' })).toMatchObject({
      status: 400, body: { ok: false },
    })
    expect(await requestPreferences(preferences, { autoCheckin: false })).toMatchObject({
      status: 200, body: { ok: true, preferences: { autoCheckin: false } },
    })
    eligibility.resolve([daily])
    await new Promise(setImmediate)
    expect(claim).not.toHaveBeenCalled()
    expect(await loadLocalState(stateHome)).toMatchObject({ autoCheckin: false })

    expect(await requestPreferences(preferences, { autoCheckin: true })).toMatchObject({
      status: 200, body: { ok: true, preferences: { autoCheckin: true } },
    })
    host.poll()
    await vi.waitFor(async () => {
      expect(claim).toHaveBeenCalledExactlyOnceWith(expect.anything(), daily.campaignId)
      expect(await loadLocalState(stateHome)).toMatchObject({
        autoCheckin: true, lastCheckin: { date: expect.any(String) },
      })
    })
  })

  it('loads a previously saved switch and preserves it when changing model visibility', async () => {
    await saveLocalState(stateHome, { autoCheckin: false, hiddenModelIds: [], lastCheckin: undefined })
    vi.spyOn(CodeArtsUpstreamClient.prototype, 'listModels').mockResolvedValue([model])
    const items = vi.spyOn(CodeArtsUpstreamClient.prototype, 'welfareItems').mockResolvedValue([])
    const credit = vi.mocked(CodeArtsUpstreamClient.prototype.credit)
    const host = boot(true)
    const preferences = host.routes.get(CODEARTS_PREFERENCES_PATH)
    if (preferences === undefined) throw new Error('Preference route was not registered')
    await vi.waitFor(() => expect(credit).toHaveBeenCalledOnce())
    expect(items).not.toHaveBeenCalled()
    expect(await requestPreferences(preferences, { hiddenModelIds: [model.id] })).toMatchObject({
      status: 200, body: { ok: true, preferences: { hiddenModelIds: [model.id], autoCheckin: false } },
    })
    expect(await loadLocalState(stateHome)).toMatchObject({ hiddenModelIds: [model.id], autoCheckin: false })
  })
})
