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
import { CheckCircle2, Settings2, ShieldCheck, UserRoundCheck, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import * as api from '../../lib/platform/api'
import { cn } from '../../lib/utils'
import { InlineError, SectionCard } from '../admin/shared'
import { Switch } from '../ui/switch'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: api.PlatformSettings }

export function PlatformSettings() {
  const { t } = useTranslation()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const loadFailedMessage = t('platform.settings.loadFailed')

  const load = () => {
    setState({ status: 'loading' })
    setSaveError(null)
    api.getPlatformSettings()
      .then((data) => setState({ status: 'ok', data }))
      .catch((error) => setState({
        status: 'error',
        message: error instanceof Error ? error.message : t('platform.settings.loadFailed'),
      }))
  }

  useEffect(() => {
    let cancelled = false
    api.getPlatformSettings()
      .then((data) => {
        if (!cancelled) setState({ status: 'ok', data })
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : loadFailedMessage,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadFailedMessage])

  const updateIndependentReview = async (value: boolean) => {
    if (state.status !== 'ok' || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const data = await api.updatePlatformSettings({ requireIndependentTechnologyReview: value })
      setState({ status: 'ok', data })
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('platform.settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="platform-settings" className="mx-auto w-full max-w-5xl px-8 py-8">
      <div className="mb-6 flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-100">
          <Settings2 className="h-4 w-4 text-fg-secondary" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-[20px] font-semibold text-fg">{t('platform.settings.title')}</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-fg-secondary">
            {t('platform.settings.subtitle')}
          </p>
        </div>
      </div>

      {state.status === 'error' && <InlineError message={state.message} onRetry={load} />}

      {state.status === 'loading' && (
        <div className="h-[220px] animate-pulse rounded-xl border border-line bg-surface-100" />
      )}

      {state.status === 'ok' && (
        <SectionCard>
          <div className="flex items-center gap-2 border-b border-line px-5 py-4">
            <ShieldCheck className="h-4 w-4 text-fg-secondary" aria-hidden="true" />
            <div>
              <h2 className="text-[13px] font-semibold text-fg">{t('platform.settings.governance.title')}</h2>
              <p className="mt-0.5 text-[11.5px] text-fg-subtle">{t('platform.settings.governance.description')}</p>
            </div>
          </div>

          <div className="px-5 py-5">
            <div className="flex items-start justify-between gap-8">
              <div className="max-w-2xl">
                <p className="text-[13px] font-medium text-fg">
                  {t('platform.settings.independentReview.title')}
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-fg-secondary">
                  {t('platform.settings.independentReview.description')}
                </p>
              </div>
              <Switch
                checked={state.data.requireIndependentTechnologyReview}
                onCheckedChange={(value) => void updateIndependentReview(value)}
                disabled={saving}
                aria-label={t('platform.settings.independentReview.title')}
                className="mt-0.5"
              />
            </div>

            <div
              data-testid="independent-review-effective-state"
              className={cn(
                'mt-4 flex items-start gap-3 rounded-lg border px-3.5 py-3',
                state.data.independentTechnologyReviewEffective
                  ? 'border-success-line bg-success-bg'
                  : 'border-line bg-surface-50',
              )}
            >
              {state.data.activePlatformAdminCount <= 1 ? (
                <UserRoundCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              ) : state.data.independentTechnologyReviewEffective ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-text" aria-hidden="true" />
              ) : (
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              )}
              <div>
                <p className="text-[12px] font-medium text-fg">
                  {state.data.activePlatformAdminCount <= 1
                    ? t('platform.settings.independentReview.soleAdminTitle')
                    : state.data.independentTechnologyReviewEffective
                      ? t('platform.settings.independentReview.effectiveTitle')
                      : t('platform.settings.independentReview.disabledTitle')}
                </p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-secondary">
                  {state.data.activePlatformAdminCount <= 1
                    ? t('platform.settings.independentReview.soleAdminDescription')
                    : state.data.independentTechnologyReviewEffective
                      ? t('platform.settings.independentReview.effectiveDescription')
                      : t('platform.settings.independentReview.disabledDescription')}
                </p>
              </div>
            </div>

            <div className="mt-3 flex min-h-5 items-center justify-between gap-3">
              <span className="text-[11px] text-fg-subtle">
                {t('platform.settings.activeAdmins', { count: state.data.activePlatformAdminCount })}
              </span>
              {saving && <span className="text-[11px] text-fg-subtle">{t('platform.settings.saving')}</span>}
              {saveError && <span role="alert" className="text-[11px] text-error-text">{saveError}</span>}
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  )
}
