/**
 * 设置页里的码道面板。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/client/WorkBuddyCard.tsx` —
 *       「所有值都用工厂函数现读而不是把 config 拷进 state」这条结构，以及
 *       「目录刷新即时生效、勾选类改动是草稿要点保存」的交互分工。
 * 参考：dsh-connect-madao（MIT, XLNC-L）`src/client/Panel.tsx` — 四个页签的
 *       信息组织，以及 models 表格的列选择。
 * 改动：①面板只在用户点击「领取」后提交领取请求，自动签到由宿主定时执行；
 *       ②模型可见性是唯一走「草稿 + 保存」两段式的改动 —— 勾错一个会让它从
 *       模型选择器里消失，即时生效太危险；③把「思考内容可能不下发」直接写在
 *       档位提示里，避免用户以为是插件坏了。
 *
 * @module dsh-connect-codearts/client/CodeArtsCard
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import React from 'react'

import { CODEARTS_WRITE_REQUEST_HEADER } from '../protocol/types.ts'
import type { PreferencesPatch, PreferencesSnapshot } from '../protocol/types.ts'

/** 面板拿到的注入。`t` 来自 `ctx.locale.bind(ns)`。 */
export interface CodeArtsCardInjected {
  readonly t: (key: string, params?: Record<string, string | number>) => string
}

export interface CodeArtsCardProps extends CodeArtsCardInjected {
  /** 宿主渲染 `settings.section` 会传 `surface: 'settings'`。 */
  readonly surface?: 'card' | 'page' | 'settings'
}

/** 状态路由的响应形状（与 `web-status.ts` 对齐）。 */
interface StatusPayload {
  version: string
  credential:
    | { signedIn: false; error: string | null }
    | { signedIn: true; accessKey: string; source: string }
  catalog: {
    total: number
    fetchedAt: number
    error: string | null
    models: Array<{
      id: string
      name: string
      contextWindow: number
      maxTokens: number
      supportsImages: boolean
      ratio: string | null
      strengths: string[]
    }>
  }
  account: {
    label: string | null
    roles: string[]
  } | null
  credit: {
    total: number
    used: number
    remain: number
    expiringAmount?: number
  } | null
  /**
   * 配置的生效值。旧版宿主没有这一段（`null`），界面要能容忍。
   */
  settings?: SettingsPayload | null
  /**
   * 签到/福利列表。`items` 为空且 `error` 非 null 表示拉取失败。
   */
  welfare?: WelfarePayload | null
  /**
   * 本机偏好：模型隐藏表 + 签到记录。旧版宿主没有这一段（`null`）。
   */
  preferences?: PreferencesSnapshot | null
}

interface SettingsPayload {
  enabled: boolean
  showCredits: boolean
  pollIntervalMs: number
  gateway: string
  defaultEfforts: Record<string, string>
}

interface WelfareItemPayload {
  campaignId: number
  title: string
  type?: string
  status?: string
  claimable: boolean
  benefitAmount?: number
  benefitUnit?: string
  expireAt?: string
}

interface WelfarePayload {
  items: WelfareItemPayload[]
  error: string | null
  fetchedAt: number
}

type Tab = 'account' | 'welfare' | 'models' | 'diagnostics'

/** 状态路由地址。与 `web-status.ts` 里的常量保持一致。 */
const STATUS_PATH = '/plugins/dsh-connect-codearts/status'

/** 签到领取路由。POST-only，只在用户点按钮时调。 */
const CLAIM_PATH = '/plugins/dsh-connect-codearts/welfare/claim'

/** 本机偏好读写路由。GET 走 status，POST 走这条。 */
const PREFERENCES_PATH = '/plugins/dsh-connect-codearts/preferences'

const WRITE_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  [CODEARTS_WRITE_REQUEST_HEADER]: '1',
}

type SavePreferencesResult =
  | { ok: true; preferences: PreferencesSnapshot }
  | { ok: false; error?: string }

const savePreferences = async (patch: PreferencesPatch): Promise<SavePreferencesResult> => {
  try {
    const response = await fetch(PREFERENCES_PATH, {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify(patch),
    })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${String(response.status)}` }
    }
    return (await response.json()) as SavePreferencesResult
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 领取某个活动。
 *
 * 返回 `{ok, error}` 而不是抛：领取失败是业务结果，界面要用同一条路径显示
 * 建议文案。路由本身 200 但 `ok:false` 也是正常返回（见 `web-status.ts`）。
 */
const claimWelfareItem = async (
  campaignId: number,
): Promise<{ ok: boolean; error?: string }> => {
  try {
    const response = await fetch(CLAIM_PATH, {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ campaignId }),
    })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${String(response.status)}` }
    }
    return (await response.json()) as { ok: boolean; error?: string }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const formatNumber = (value: number): string =>
  Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—'

const formatContext = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens <= 0) return '—'
  if (tokens >= 1_048_576) return `${(tokens / 1_048_576).toFixed(0)}M`
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`
  return String(tokens)
}

const formatTime = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 拉一次状态。任何失败都折叠成 `null`，由界面显示「未就绪」。 */
const fetchStatus = async (refresh: boolean): Promise<StatusPayload | undefined> => {
  try {
    const url = refresh ? `${STATUS_PATH}?refresh=1` : STATUS_PATH
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) return undefined
    return (await response.json()) as StatusPayload
  } catch {
    // 设置页可能在 webServer 起来之前就渲染，静默失败，等下一次轮询。
    return undefined
  }
}

/** 账号页签。 */
const AccountTab = ({
  status,
  t,
  onRefresh,
}: {
  status: StatusPayload | undefined
  t: CodeArtsCardInjected['t']
  onRefresh: () => void
}): React.ReactElement => {
  if (status === undefined) {
    return <div className="dsc-dim">{t('account.refreshing')}</div>
  }

  const credential = status.credential

  return (
    <>
      <div className="dsc-section">
        <div className="dsc-section-title">{t('account.title')}</div>
        {credential.signedIn ? (
          <>
            <div className="dsc-row">
              <span className="dsc-label">{t('account.accessKey')}</span>
              <span className="dsc-value dsc-mono">{credential.accessKey}</span>
              <span className="dsc-pill accent">{t('account.signedIn')}</span>
            </div>
            <div className="dsc-row">
              <span className="dsc-label">{t('account.source')}</span>
              <span className="dsc-value">{t(`account.source.${credential.source}`)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="dsc-row">
              <span className="dsc-label">{t('account.title')}</span>
              <span className="dsc-value dsc-fail">{t('account.signedOut')}</span>
            </div>
            {credential.error !== null && (
              <div className="dsc-hint dsc-dim">{credential.error}</div>
            )}
            <div className="dsc-hint">
              <strong>{t('account.hint.title')}</strong>
              <ol>
                <li>{t('account.hint.step1')}</li>
                <li>{t('account.hint.step2')}</li>
                <li>{t('account.hint.step3')}</li>
              </ol>
            </div>
          </>
        )}
        <div className="dsc-actions">
          <button type="button" className="dsc-btn" onClick={onRefresh}>
            {t('account.refresh')}
          </button>
        </div>
      </div>

      {status.account !== null && (
        <div className="dsc-section">
          <div className="dsc-row">
            <span className="dsc-label">{t('account.account')}</span>
            <span className="dsc-value dsc-mono">
              {status.account.label ?? '—'}
            </span>
          </div>
          {status.account.roles.length > 0 && (
            <div className="dsc-row">
              <span className="dsc-label">{t('account.roles')}</span>
              <span className="dsc-value">
                {status.account.roles.map((role) => (
                  <span key={role} className="dsc-pill" style={{ marginRight: 4 }}>
                    {role}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}

      {status.credit !== null && (
        <div className="dsc-section">
          <div className="dsc-section-title">{t('account.credit')}</div>
          <div className="dsc-row">
            <span className="dsc-label">{t('account.creditRemain')}</span>
            <span className="dsc-value">
              <strong>{formatNumber(status.credit.remain)}</strong>
              <span className="dsc-dim"> / {formatNumber(status.credit.total)} {t('account.creditTotal')}</span>
            </span>
          </div>
          {status.credit.expiringAmount !== undefined && status.credit.expiringAmount > 0 && (
            <div className="dsc-row">
              <span className="dsc-label">{t('account.creditExpiring')}</span>
              <span className="dsc-value">
                <span className="dsc-pill warn">{formatNumber(status.credit.expiringAmount)}</span>
              </span>
            </div>
          )}
        </div>
      )}

      <SettingsSection settings={status.settings} t={t} />
    </>
  )
}

/**
 * 配置的当前生效值。
 *
 * 刻意做成**只读展示**而不是可编辑控件：写入要走宿主的 `settings` 服务
 * （`settings.update(ns, patch)`），而本轮没有把那个能力接进卡片。做成可编辑
 * 却写不进去，比只读更糟 —— 用户会以为保存了。
 *
 * 显示出来的价值：这五个字段以前只能手改 `cordis.patch.yml`，改完还得重启。
 * 至少现在能看见「现在到底是开着还是关着」，出问题时不必翻文件。
 */
const SettingsSection = ({
  settings,
  t,
}: {
  settings: SettingsPayload | null | undefined
  t: CodeArtsCardInjected['t']
}): React.ReactElement | null => {
  // 旧版宿主不带这一段。显示「此版本宿主不支持」比显示一片空白诚实。
  if (settings === null || settings === undefined) return null

  const effortEntries = Object.entries(settings.defaultEfforts)

  return (
    <div className="dsc-section">
      <div className="dsc-section-title">{t('settings.title')}</div>
      <div className="dsc-row">
        <span className="dsc-label">{t('settings.enabled')}</span>
        <span className="dsc-value">{settings.enabled ? t('common.yes') : t('common.no')}</span>
      </div>
      <div className="dsc-row">
        <span className="dsc-label">{t('settings.showCredits')}</span>
        <span className="dsc-value">{settings.showCredits ? t('common.yes') : t('common.no')}</span>
      </div>
      <div className="dsc-row">
        <span className="dsc-label">{t('settings.pollInterval')}</span>
        <span className="dsc-value">
          {Math.round(settings.pollIntervalMs / 60_000)} {t('settings.minutes')}
        </span>
      </div>
      <div className="dsc-row">
        <span className="dsc-label">{t('settings.gateway')}</span>
        <span className="dsc-value dsc-mono dsc-dim">
          {settings.gateway === '' ? t('settings.gatewayDefault') : settings.gateway}
        </span>
      </div>
      {effortEntries.length > 0 && (
        <div className="dsc-row">
          <span className="dsc-label">{t('settings.defaultEfforts')}</span>
          <span className="dsc-value dsc-mono dsc-dim">
            {effortEntries.map(([model, effort]) => `${model}=${effort}`).join(', ')}
          </span>
        </div>
      )}
      <div className="dsc-hint dsc-dim">{t('settings.hint')}</div>
    </div>
  )
}

/**
 * 签到页签。
 *
 * 三个产品判断，都写在这里而不是留给用户猜：
 *   ①**默认只读**：打开页面只发 GET 拉列表，绝不自动领取 —— 签到一天一次，
 *     不能因为「打开了面板」就替用户点掉（参考实现也把这条写进注释）。
 *   ②**只有 `claimable === true` 的项才有按钮**：把「已领」「未认证」「不可领」
 *     混在一个按钮里，用户会反复点一个不会成功的按钮。
 *   ③**识别活动按 `type` 而不是 `campaignId`**：M0 实测每日签到的
 *     `campaignId` 是 34，但那是华为当时的值，写死会在他们调整后静默失效。
 *     `type: 'USER_LOGIN'` 才是语义标识。
 */
const WelfareTab = ({
  status,
  t,
  busy,
  onClaim,
  claimBusy,
  claimMessage,
  onAutoCheckinChange,
  autoCheckinSaving,
  autoCheckinError,
}: {
  status: StatusPayload | undefined
  t: CodeArtsCardInjected['t']
  busy: boolean
  onClaim: (campaignId: number) => void
  claimBusy: number | undefined
  claimMessage: { ok: boolean; text: string } | undefined
  onAutoCheckinChange: (enabled: boolean) => void
  autoCheckinSaving: boolean
  autoCheckinError: string | undefined
}): React.ReactElement => {
  if (status === undefined) {
    return <div className="dsc-dim">{t('account.refreshing')}</div>
  }

  const welfare = status.welfare
  const autoCheckin = status.preferences?.autoCheckin
  // 每日签到排最前：它是唯一每天都要看一眼的项。
  const items = [...(welfare?.items ?? [])].sort((left, right) => {
    const rank = (item: WelfareItemPayload): number => (item.type === 'USER_LOGIN' ? 0 : 1)
    return rank(left) - rank(right)
  })

  return (
    <div className="dsc-section">
      <div className="dsc-welfare-heading">
        <div className="dsc-section-title">{t('welfare.title')}</div>
        <button
          type="button"
          role="switch"
          aria-checked={autoCheckin === true}
          className="dsc-switch"
          disabled={autoCheckin === undefined || autoCheckinSaving}
          onClick={() => onAutoCheckinChange(autoCheckin !== true)}
        >
          {t('welfare.autoCheckin')}
          <span className="dsc-switch-track" aria-hidden="true" />
        </button>
      </div>
      {autoCheckinSaving && <div className="dsc-dim" role="status">{t('welfare.autoCheckinSaving')}</div>}
      {autoCheckinError !== undefined && <div className="dsc-fail" role="alert">{autoCheckinError}</div>}
      {welfare == null && <div className="dsc-dim">{t('welfare.unavailable')}</div>}
      {welfare?.error != null && (
        <div className="dsc-hint dsc-fail">{welfare.error}</div>
      )}
      {items.length === 0 && welfare?.error === null && (
        <div className="dsc-dim">{t('welfare.empty')}</div>
      )}
      {items.map((item) => (
        <div key={item.campaignId} className="dsc-row">
          <span className="dsc-label">{item.title}</span>
          <span className="dsc-value">
            {item.benefitAmount !== undefined && (
              <span className="dsc-dim" style={{ marginRight: 6 }}>
                {formatNumber(item.benefitAmount)} {item.benefitUnit ?? t('welfare.credit')}
              </span>
            )}
            {item.claimable ? (
              <span className="dsc-pill accent">{t('welfare.claimable')}</span>
            ) : (
              <span className="dsc-pill">
                {item.status === 'CONFIRMED'
                  ? t('welfare.claimed')
                  : t('welfare.notClaimable')}
              </span>
            )}
          </span>
          <span>
            {item.claimable && (
              <button
                type="button"
                className="dsc-btn"
                disabled={claimBusy !== undefined || busy}
                onClick={() => {
                  onClaim(item.campaignId)
                }}
              >
                {claimBusy === item.campaignId ? t('welfare.claiming') : t('welfare.claim')}
              </button>
            )}
          </span>
        </div>
      ))}
      {claimMessage !== undefined && (
        <div className={`dsc-hint ${claimMessage.ok ? '' : 'dsc-fail'}`}>
          {claimMessage.text}
        </div>
      )}
      <div className="dsc-hint dsc-dim">{t('welfare.hint')}</div>
    </div>
  )
}

/** 模型页签：七列表格，与 WorkBuddy 的模型管理页对齐。 */
const ModelsTab = ({
  status,
  t,
  onRefresh,
}: {
  status: StatusPayload | undefined
  t: CodeArtsCardInjected['t']
  onRefresh: () => void
}): React.ReactElement => {
  const models = status?.catalog.models ?? []
  /**
   * 草稿即本地勾选状态。
   *
   * 用 `useState` 初始化成服务端的隐藏表，之后用户每点一次都只改草稿 ——
   * 必须点「保存」才写盘。理由与签到按钮同一条：改模型可见性是**用户的决定**，
   * 不该因为「点了一下复选框」就立刻生效（勾错一个模型会让它从选择器里消失，
   * 而用户可能只是想先看看有哪些）。
   *
   * `undefined` 表示「还没建立草稿」，此时直接读服务端值。这样重新拉状态
   * （比如点了刷新）不会被旧草稿盖住。
   */
  const [draft, setDraft] = React.useState<readonly string[] | undefined>(undefined)
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [saveError, setSaveError] = React.useState<string | undefined>(undefined)

  const hidden = draft ?? status?.preferences?.hiddenModelIds ?? []
  const hiddenSet = new Set(hidden)
  const dirty =
    draft !== undefined &&
    (draft.length !== (status?.preferences?.hiddenModelIds ?? []).length ||
      draft.some((id) => !(status?.preferences?.hiddenModelIds ?? []).includes(id)))

  const toggle = (id: string): void => {
    setSaveState('idle')
    setSaveError(undefined)
    setDraft(hiddenSet.has(id) ? hidden.filter((value) => value !== id) : [...hidden, id])
  }

  const save = async (): Promise<void> => {
    if (draft === undefined) return
    setSaveState('saving')
    const result = await savePreferences({ hiddenModelIds: draft })
    if (result.ok) {
      setSaveState('saved')
      setSaveError(undefined)
      setDraft(undefined)
      onRefresh()
      return
    }
    setSaveState('failed')
    setSaveError(result.error ?? t('models.saveFailed'))
  }

  if (models.length === 0) {
    return (
      <div className="dsc-section">
        <div className="dsc-dim">{status?.catalog.error ?? t('models.empty')}</div>
      </div>
    )
  }

  return (
    <div className="dsc-section">
      <div className="dsc-section-title">
        {t('models.count', { n: models.length })}
        <span className="dsc-dim" style={{ marginLeft: 8, fontWeight: 400 }}>
          {formatTime(status?.catalog.fetchedAt ?? 0)}
        </span>
      </div>
      <table className="dsc-table">
        <thead>
          <tr>
            <th title={t('models.visibleHint')}>{t('models.visible')}</th>
            <th>{t('models.name')}</th>
            <th>{t('models.id')}</th>
            <th className="dsc-num">{t('models.context')}</th>
            <th className="dsc-num">{t('models.output')}</th>
            <th className="dsc-num">{t('models.ratio')}</th>
            <th>{t('models.image')}</th>
            <th>{t('models.strength')}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.id} className={hiddenSet.has(model.id) ? 'dsc-row-hidden' : undefined}>
              <td>
                <input
                  type="checkbox"
                  className="dsc-check"
                  checked={!hiddenSet.has(model.id)}
                  onChange={() => {
                    toggle(model.id)
                  }}
                  aria-label={model.name}
                />
              </td>
              <td>{model.name}</td>
              <td className="dsc-mono dsc-dim">{model.id}</td>
              <td className="dsc-num">{formatContext(model.contextWindow)}</td>
              <td className="dsc-num">{formatContext(model.maxTokens)}</td>
              <td className="dsc-num">{model.ratio ?? '—'}</td>
              <td>{model.supportsImages ? '👁' : ''}</td>
              <td>{model.strengths.length > 0 ? model.strengths.join(' / ') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dsc-btn-row">
        <button
          type="button"
          className="dsc-btn"
          disabled={!dirty || saveState === 'saving'}
          onClick={() => {
            void save()
          }}
        >
          {saveState === 'saving' ? t('models.saving') : t('models.save')}
        </button>
        {saveState === 'saved' && <span className="dsc-hint">{t('models.saved')}</span>}
        {saveState === 'failed' && (
          <span className="dsc-fail">{saveError ?? t('models.saveFailed')}</span>
        )}
        {!dirty && saveState === 'idle' && <span className="dsc-hint dsc-dim">{t('models.dirtyHint')}</span>}
      </div>
      <div className="dsc-hint dsc-dim">
        {t('models.ratioHint')}
        <br />
        {t('models.strengthHint')}
        <br />
        {t('models.strengthNoReasoning')}
      </div>
    </div>
  )
}

/** 诊断页签：四步检查，逐项显示结果。 */
const DiagnosticsTab = ({
  status,
  t,
}: {
  status: StatusPayload | undefined
  t: CodeArtsCardInjected['t']
}): React.ReactElement => {
  const signedIn = status?.credential.signedIn === true
  const hasCatalog = (status?.catalog.total ?? 0) > 0

  const checks: Array<{ name: string; state: 'ok' | 'fail' | 'skip'; detail?: string }> = [
    {
      name: t('diag.step.credential'),
      state: signedIn ? 'ok' : 'fail',
      ...(status?.credential.signedIn === false && status.credential.error !== null
        ? { detail: status.credential.error }
        : {}),
    },
    {
      name: t('diag.step.signature'),
      state: signedIn ? 'ok' : 'skip',
    },
    {
      name: t('diag.step.catalog'),
      state: hasCatalog ? 'ok' : signedIn ? 'fail' : 'skip',
      ...(status?.catalog.error !== null && status?.catalog.error !== undefined
        ? { detail: status.catalog.error }
        : {}),
    },
    {
      name: t('diag.step.credit'),
      state: status?.credit !== null && status?.credit !== undefined ? 'ok' : 'skip',
    },
  ]

  return (
    <>
      <div className="dsc-section">
        <div className="dsc-checks">
          {checks.map((check) => (
            <div key={check.name} className="dsc-check">
              <span className="dsc-check-name">{check.name}</span>
              <span
                className={
                  check.state === 'ok' ? 'dsc-ok' : check.state === 'fail' ? 'dsc-fail' : 'dsc-dim'
                }
              >
                {check.state === 'ok'
                  ? `✓ ${t('diag.ok')}`
                  : check.state === 'fail'
                    ? `✗ ${t('diag.fail')}`
                    : `– ${t('diag.skip')}`}
              </span>
              {check.detail !== undefined && (
                <span className="dsc-dim" style={{ flex: 1 }}>
                  {check.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="dsc-section">
        <div className="dsc-row">
          <span className="dsc-label">{t('diag.version')}</span>
          <span className="dsc-value dsc-mono">{status?.version ?? '—'}</span>
        </div>
        <div className="dsc-row">
          <span className="dsc-label">{t('diag.gateway')}</span>
          <span className="dsc-value dsc-mono dsc-dim">
            https://snap-access.cn-north-4.myhuaweicloud.com
          </span>
        </div>
      </div>
    </>
  )
}

/**
 * 面板主体。
 *
 * 状态只在挂载时拉一次 + 用户点刷新时再拉，不做定时轮询：设置页通常是「打开
 * → 看一眼 → 关掉」，让它在后台每 5 分钟打一次网关既无必要也浪费额度。
 */
export const CodeArtsCard = ({ t }: CodeArtsCardProps): React.ReactElement => {
  const [tab, setTab] = useState<Tab>('account')
  const [status, setStatus] = useState<StatusPayload | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /** 正在领取的活动 id；`undefined` 表示没有领取在进行。 */
  const [claimBusy, setClaimBusy] = useState<number | undefined>(undefined)
  /** 上一次领取的结果。成功失败都显示 —— 失败时那行字是可执行建议。 */
  const [claimMessage, setClaimMessage] = useState<{ ok: boolean; text: string } | undefined>(
    undefined,
  )

  const [autoCheckinSaving, setAutoCheckinSaving] = useState(false)
  const [autoCheckinError, setAutoCheckinError] = useState<string>()
  const autoCheckinRevision = useRef(0)

  const load = useCallback((refresh: boolean): void => {
    const revision = autoCheckinRevision.current
    setBusy(true)
    void fetchStatus(refresh)
      .then((next) => {
        if (next === undefined) return
        setStatus((current) => {
          if (revision === autoCheckinRevision.current || current?.preferences == null || next.preferences == null) {
            return next
          }
          // 较早发出的状态请求可能在开关保存后才返回。
          return { ...next, preferences: { ...next.preferences, autoCheckin: current.preferences.autoCheckin } }
        })
      })
      .finally(() => {
        setBusy(false)
      })
  }, [])

  const changeAutoCheckin = (enabled: boolean): void => {
    setAutoCheckinSaving(true)
    setAutoCheckinError(undefined)
    void savePreferences({ autoCheckin: enabled })
      .then((result) => {
        if (!result.ok) {
          setAutoCheckinError([t('welfare.autoCheckinSaveFailed'), result.error].filter(Boolean).join(' '))
          return
        }
        if (result.preferences?.autoCheckin !== enabled) {
          setAutoCheckinError(t('welfare.autoCheckinSaveFailed'))
          return
        }

        autoCheckinRevision.current += 1
        setStatus((current) =>
          current?.preferences == null
            ? current
            : { ...current, preferences: { ...current.preferences, autoCheckin: enabled } },
        )
      })
      .finally(() => setAutoCheckinSaving(false))
  }

  useEffect(() => {
    load(false)
  }, [load])

  const tabs = useMemo(
    () =>
      [
        { id: 'account' as const, label: t('tab.account') },
        { id: 'welfare' as const, label: t('tab.welfare') },
        { id: 'models' as const, label: t('tab.models') },
        { id: 'diagnostics' as const, label: t('tab.diagnostics') },
      ] satisfies Array<{ id: Tab; label: string }>,
    [t],
  )

  /**
   * 领取。
   *
   * 三件事都在这里做：调路由、显示结果、刷新状态。刷新放在 `finally` 之前
   * 还是之后有意：成功才刷新（失败了列表不会变，白打一次网关）。
   */
  const claim = useCallback(
    (campaignId: number): void => {
      setClaimBusy(campaignId)
      setClaimMessage(undefined)
      void claimWelfareItem(campaignId)
        .then((result) => {
          if (result.ok) {
            setClaimMessage({ ok: true, text: t('welfare.claimOk') })
            // 领取成功后刷新一次，让列表上的「可领取」变成「今日已领」，
            // 同时把积分读数一起更新（同一个 status 响应里）。
            load(false)
          } else {
            setClaimMessage({ ok: false, text: result.error ?? t('welfare.claimFail') })
          }
        })
        .finally(() => {
          setClaimBusy(undefined)
        })
    },
    [load, t],
  )

  return (
    <div className="dsc-panel">
      <div className="dsc-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="dsc-tab"
            aria-selected={tab === entry.id}
            onClick={() => {
              setTab(entry.id)
            }}
          >
            {entry.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="dsc-btn"
          disabled={busy}
          onClick={() => {
            load(true)
          }}
        >
          {busy ? t('account.refreshing') : t('account.refresh')}
        </button>
      </div>

      {tab === 'account' && (
        <AccountTab
          status={status}
          t={t}
          onRefresh={() => {
            load(true)
          }}
        />
      )}
      {tab === 'welfare' && (
        <WelfareTab
          status={status}
          t={t}
          busy={busy}
          onClaim={claim}
          claimBusy={claimBusy}
          claimMessage={claimMessage}
          onAutoCheckinChange={changeAutoCheckin}
          autoCheckinSaving={autoCheckinSaving}
          autoCheckinError={autoCheckinError}
        />
      )}
      {tab === 'models' && (
        <ModelsTab status={status} t={t} onRefresh={() => load(false)} />
      )}
      {tab === 'diagnostics' && <DiagnosticsTab status={status} t={t} />}
    </div>
  )
}
