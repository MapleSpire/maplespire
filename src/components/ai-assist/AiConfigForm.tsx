// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Loader2, ShieldCheck, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import {
  getAiConfig, saveAiConfig, deleteAiConfig, testAiConfig,
  AiApiError, type AiConfigPublic, type AiProbeResult,
} from '../../lib/ai/api'

/**
 * Org AI configuration (BYOK) — provider / model / base URL / API key. The key
 * is write-only: the server stores it AES-256-GCM encrypted and only ever
 * returns a masked hint. Shared by the workspace Settings modal and the org
 * admin console's AI page.
 */

function providerOptions(t: TFunction): { id: string; label: string; needsBaseUrl: boolean; keyless: boolean; modelHint: string }[] {
  return [
    { id: 'openai', label: t('aiAssist.config.providerOpenai'), needsBaseUrl: false, keyless: false, modelHint: 'gpt-5.2' },
    { id: 'anthropic', label: t('aiAssist.config.providerAnthropic'), needsBaseUrl: false, keyless: false, modelHint: 'claude-sonnet-4-5' },
    { id: 'google', label: t('aiAssist.config.providerGoogle'), needsBaseUrl: false, keyless: false, modelHint: 'gemini-2.5-flash' },
    { id: 'lmstudio', label: t('aiAssist.config.providerLmstudio'), needsBaseUrl: false, keyless: true, modelHint: 'google/gemma-4-12b-qat' },
    { id: 'openai-compatible', label: t('aiAssist.config.providerOpenaiCompatible'), needsBaseUrl: true, keyless: true, modelHint: t('aiAssist.config.modelHintCustom') },
  ]
}

export function AiConfigForm({ orgId, onSaved }: { orgId: string; onSaved?: (config: AiConfigPublic) => void }) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [cryptoAvailable, setCryptoAvailable] = useState(true)
  const [existing, setExisting] = useState<AiConfigPublic | null>(null)

  const [provider, setProvider] = useState('lmstudio')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('') // '' = keep the stored key
  const [clearKey, setClearKey] = useState(false)

  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [probe, setProbe] = useState<AiProbeResult | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getAiConfig(orgId)
      .then((res) => {
        if (cancelled) return
        setCryptoAvailable(res.cryptoAvailable)
        setExisting(res.config)
        if (res.config) {
          setProvider(res.config.provider)
          setModel(res.config.model)
          setBaseUrl(res.config.baseUrl ?? '')
        }
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof AiApiError && (err.status === 401 || err.status === 403)) setForbidden(true)
        else setLoadError(err instanceof Error ? err.message : t('aiAssist.config.loadFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // t is only read for the rare non-Error fallback message; refetching config on every
    // language switch would be wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

  const options = providerOptions(t)
  const meta = options.find((p) => p.id === provider) ?? options[0]

  const payload = () => ({
    provider,
    model: model.trim(),
    baseUrl: baseUrl.trim() || null,
    // undefined keeps the stored key; '' / null clears it.
    ...(clearKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  })

  const handleSave = async () => {
    setBusy('save')
    setErrorMsg(null)
    setSaveMsg(null)
    setProbe(null)
    try {
      const { config } = await saveAiConfig(orgId, payload())
      setExisting(config)
      setApiKey('')
      setClearKey(false)
      setSaveMsg(t('aiAssist.config.savedMessage'))
      onSaved?.(config)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('aiAssist.config.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleTest = async () => {
    setBusy('test')
    setErrorMsg(null)
    setProbe(null)
    try {
      setProbe(await testAiConfig(orgId, payload()))
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('aiAssist.config.testFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async () => {
    setBusy('delete')
    setErrorMsg(null)
    try {
      await deleteAiConfig(orgId)
      setExisting(null)
      setModel('')
      setBaseUrl('')
      setApiKey('')
      setSaveMsg(t('aiAssist.config.removedMessage'))
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('aiAssist.config.deleteFailed'))
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-fg-muted py-3">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('aiAssist.config.loadingConfig')}
      </div>
    )
  }
  if (forbidden) {
    return (
      <div className="rounded-lg border border-line bg-surface-50 px-3 py-2.5 text-[12.5px] text-fg-secondary">
        {t('aiAssist.config.forbidden')}
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="rounded-lg border border-line bg-error-bg px-3 py-2 text-[12.5px] text-error-text">
        {loadError}
      </div>
    )
  }

  const label = 'text-[12px] font-medium text-fg-secondary'
  const field =
    'w-full rounded-lg border border-line bg-surface-50 px-2.5 py-1.5 text-[12.5px] text-fg outline-none focus:border-line-strong placeholder:text-fg-muted'

  return (
    <div className="flex flex-col gap-3" data-testid="ai-config-form">
      {!cryptoAvailable && (
        <div className="flex items-start gap-2 rounded-lg border border-line bg-error-bg px-3 py-2 text-[12px] text-error-text">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('aiAssist.config.noKeySecret')}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor="ai-provider">{t('aiAssist.config.providerLabel')}</label>
          <select
            id="ai-provider"
            data-testid="ai-config-provider"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value)
              setProbe(null)
            }}
            className={cn(field, 'appearance-none')}
          >
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor="ai-model">{t('aiAssist.config.modelLabel')}</label>
          <input
            id="ai-model"
            data-testid="ai-config-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={meta.modelHint}
            className={field}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className={label} htmlFor="ai-base-url">
          {t('aiAssist.config.baseUrlLabel')} {meta.needsBaseUrl ? t('aiAssist.config.required') : provider === 'lmstudio' ? t('aiAssist.config.baseUrlDefaultLmstudio') : t('aiAssist.config.optional')}
        </label>
        <input
          id="ai-base-url"
          data-testid="ai-config-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={provider === 'lmstudio' ? 'http://localhost:1234/v1' : 'https://api.example.com/v1'}
          className={field}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={label} htmlFor="ai-api-key">
          {t('aiAssist.config.apiKeyLabel')} {meta.keyless ? t('aiAssist.config.optionalForLocal') : ''}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="ai-api-key"
            data-testid="ai-config-api-key"
            type="password"
            value={apiKey}
            disabled={clearKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              clearKey
                ? t('aiAssist.config.keyWillBeRemoved')
                : existing?.hasKey
                  ? t('aiAssist.config.keyStored', { hint: existing.keyHint ?? '…' })
                  : meta.keyless
                    ? t('aiAssist.config.keyNotNeeded')
                    : 'sk-…'
            }
            className={cn(field, 'flex-1')}
            autoComplete="off"
          />
          {existing?.hasKey && (
            <button
              type="button"
              onClick={() => {
                setClearKey((v) => !v)
                setApiKey('')
              }}
              className={cn(
                'shrink-0 rounded-lg border px-2 py-1.5 text-[11.5px] font-medium transition-colors',
                clearKey
                  ? 'border-accent/40 bg-accent-subtle text-accent'
                  : 'border-line text-fg-secondary hover:bg-surface-hover'
              )}
            >
              {clearKey ? t('aiAssist.config.keepingRemoval') : t('aiAssist.config.removeKey')}
            </button>
          )}
        </div>
        <p className="m-0 flex items-center gap-1 text-[11px] text-fg-subtle">
          <ShieldCheck className="h-3 w-3" /> {t('aiAssist.config.encryptedAtRest')}
        </p>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-line bg-error-bg px-3 py-2 text-[12px] text-error-text">{errorMsg}</div>
      )}
      {saveMsg && !errorMsg && (
        <div className="flex items-center gap-1.5 text-[12px] text-fg-secondary">
          <CircleCheck className="h-3.5 w-3.5 text-accent" /> {saveMsg}
        </div>
      )}
      {probe && (
        <div
          data-testid="ai-config-probe-result"
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px]',
            probe.ok ? 'border-line bg-surface-50 text-fg-secondary' : 'border-line bg-error-bg text-error-text'
          )}
        >
          {probe.ok ? (
            <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          ) : (
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>
            {probe.ok
              ? t('aiAssist.config.connectedMessage', { latency: probe.latencyMs })
              : t('aiAssist.config.connectionFailedMessage', { latency: probe.latencyMs, message: probe.message ?? t('aiAssist.config.unknownError') })}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => void handleSave()}
          disabled={busy !== null || !model.trim()}
          data-testid="ai-config-save"
          className="rounded-lg bg-inverse px-3.5 py-2 text-[12.5px] font-medium text-on-inverse transition-colors hover:bg-inverse-hover disabled:opacity-50"
        >
          {busy === 'save' ? t('aiAssist.config.saving') : t('aiAssist.config.saveConfiguration')}
        </button>
        <button
          onClick={() => void handleTest()}
          disabled={busy !== null || !model.trim()}
          data-testid="ai-config-test"
          className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-medium text-fg-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          {busy === 'test' ? t('aiAssist.config.testing') : t('aiAssist.config.testConnection')}
        </button>
        <div className="flex-1" />
        {existing && (
          <button
            onClick={() => void handleDelete()}
            disabled={busy !== null}
            title={t('aiAssist.config.removeConfigTooltip')}
            className="flex items-center gap-1 rounded-lg px-2.5 py-2 text-[12px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-error-text"
          >
            <Trash2 className="h-3.5 w-3.5" /> {t('aiAssist.config.remove')}
          </button>
        )}
      </div>
    </div>
  )
}
