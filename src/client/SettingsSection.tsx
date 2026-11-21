import { useState } from 'react'
import React from 'react'

import { CODEARTS_POLL_INTERVALS_MS, CODEARTS_SETTINGS_PATH, CODEARTS_WRITE_REQUEST_HEADER } from '../protocol/types.ts'
import type { QuickSettings, SettingsSnapshot } from '../protocol/types.ts'

interface SettingsModel {
  readonly id: string
  readonly name: string
  readonly strengths: readonly string[]
}

export const SettingsSection = ({
  settings,
  models,
  t,
  onSaved,
}: {
  settings: SettingsSnapshot | null | undefined
  models: readonly SettingsModel[]
  t: (key: string) => string
  onSaved: (settings: SettingsSnapshot) => void
}): React.ReactElement | null => {
  const [draft, setDraft] = useState<{ revision: number; values: QuickSettings }>()
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string }>()
  if (settings == null) return null

  const values = draft?.values ?? settings
  const editable = settings.revision !== undefined && !saving
  const modelOptions = new Map(models.map((model) => [model.id, model]))
  const effortIds = new Set([
    ...models.filter((model) => model.strengths.length > 0).map((model) => model.id),
    ...Object.keys(settings.defaultEfforts),
    ...Object.keys(values.defaultEfforts),
  ])

  const edit = (patch: Partial<QuickSettings>): void => {
    if (settings.revision === undefined) return
    setFeedback(undefined)
    const { showCredits, pollIntervalMs, defaultEfforts } = values
    setDraft({
      revision: draft?.revision ?? settings.revision,
      values: { showCredits, pollIntervalMs, defaultEfforts, ...patch },
    })
  }

  const save = async (): Promise<void> => {
    if (draft === undefined || saving) return
    setFeedback(undefined)
    setSaving(true)
    try {
      const response = await fetch(CODEARTS_SETTINGS_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CODEARTS_WRITE_REQUEST_HEADER]: '1' },
        body: JSON.stringify({ ...draft.values, revision: draft.revision }),
      })
      if (response.status === 409) {
        setFeedback({ ok: false, text: t('settings.conflict') })
        return
      }
      const result = await response.json() as { ok: boolean; settings?: SettingsSnapshot }
      if (!response.ok || !result.ok || result.settings === undefined) throw new Error(t('settings.saveFailed'))
      onSaved(result.settings)
      setDraft(undefined)
      setFeedback({ ok: true, text: t('settings.saved') })
    } catch {
      setFeedback({ ok: false, text: t('settings.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="dsc-section" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="dsc-section-title">{t('settings.title')}</div>
      <label className="dsc-row">
        <span className="dsc-label">{t('settings.showCredits')}</span>
        <input
          type="checkbox"
          checked={values.showCredits}
          disabled={!editable}
          onChange={(event) => edit({ showCredits: event.currentTarget.checked })}
        />
      </label>
      <label className="dsc-row">
        <span className="dsc-label">{t('settings.pollInterval')}</span>
        <select
          className="dsc-input"
          value={values.pollIntervalMs}
          disabled={!editable}
          onChange={(event) => edit({ pollIntervalMs: Number(event.currentTarget.value) })}
        >
          {[...new Set([...CODEARTS_POLL_INTERVALS_MS, values.pollIntervalMs])].sort((a, b) => a - b).map((ms) => (
            <option key={ms} value={ms}>{ms / 60_000} {t('settings.minutes')}</option>
          ))}
        </select>
      </label>
      {effortIds.size > 0 && <div className="dsc-hint">{t('settings.defaultEfforts')}</div>}
      {[...effortIds].map((id) => {
        const model = modelOptions.get(id)
        const current = Object.hasOwn(values.defaultEfforts, id) ? values.defaultEfforts[id] ?? '' : ''
        const strengths = new Set(model?.strengths ?? [])
        if (current !== '') strengths.add(current)
        return (
          <label className="dsc-row" key={id}>
            <span className="dsc-label">{model?.name ?? id}</span>
            <select
              className="dsc-input"
              disabled={!editable}
              value={current}
              onChange={(event) => {
                const effort = event.currentTarget.value
                const defaultEfforts = { ...values.defaultEfforts, [id]: effort }
                if (effort === '') delete defaultEfforts[id]
                edit({ defaultEfforts })
              }}
            >
              <option value="">{t('settings.useModelDefault')}</option>
              {[...strengths].map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label>
        )
      })}
      {settings.revision !== undefined && (
        <div className="dsc-actions">
          <button className="dsc-btn primary" type="submit" disabled={draft === undefined || saving}>
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
          {draft !== undefined && (
            <button className="dsc-btn" type="button" disabled={saving} onClick={() => { setDraft(undefined); setFeedback(undefined) }}>
              {t('settings.cancel')}
            </button>
          )}
        </div>
      )}
      {feedback !== undefined && (
        <div role={feedback.ok ? 'status' : 'alert'} className={feedback.ok ? 'dsc-hint' : 'dsc-hint dsc-fail'}>
          {feedback.text}
        </div>
      )}
      <div className="dsc-hint dsc-dim">{t(settings.revision === undefined ? 'settings.readOnly' : 'settings.hint')}</div>
      <div className="dsc-row">
        <span className="dsc-label">{t('settings.enabled')}</span>
        <span className="dsc-value">{settings.enabled ? t('common.yes') : t('common.no')}</span>
      </div>
      <div className="dsc-row">
        <span className="dsc-label">{t('settings.gateway')}</span>
        <span className="dsc-value dsc-mono dsc-dim">{settings.gateway || t('settings.gatewayDefault')}</span>
      </div>
    </form>
  )
}
