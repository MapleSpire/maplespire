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
import { useTranslation } from 'react-i18next'
import * as api from '../../lib/platform/api'
import { timeAgo } from '../../lib/orgAdmin/timeAgo'
import { StatCard, InlineError, EmptyState, SectionCard } from '../admin/shared'

/** C1 — Overview: cross-org counter cards + the active impersonations list
 * (the plan's safety centerpiece — every "view as" session is visible here). */
export function PlatformOverview() {
  const { t } = useTranslation()
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ok'; data: api.PlatformOverview } | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [imps, setImps] = useState<
    { status: 'loading' } | { status: 'ok'; data: api.ActiveImpersonation[] } | { status: 'error'; message: string }
  >({ status: 'loading' })

  const load = () => {
    setState({ status: 'loading' })
    api
      .getOverview()
      .then((data) => setState({ status: 'ok', data }))
      .catch((err) => setState({ status: 'error', message: err instanceof Error ? err.message : t('platform.overview.loadFailed') }))
  }

  const loadImps = () => {
    setImps({ status: 'loading' })
    api
      .getActiveImpersonations()
      .then((res) => setImps({ status: 'ok', data: res.impersonations }))
      .catch((err) => setImps({ status: 'error', message: err instanceof Error ? err.message : t('platform.overview.loadImpersonationsFailed') }))
  }

  useEffect(() => {
    load()
    loadImps()
  }, [])

  return (
    <div data-testid="platform-overview" className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('platform.overview.title')}</h1>
      <p className="mb-6 text-[13px] text-fg-secondary">{t('platform.overview.subtitle')}</p>

      {state.status === 'error' && <InlineError message={state.message} onRetry={load} />}

      {state.status === 'loading' && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-[84px] animate-pulse rounded-xl bg-surface-200" />
          ))}
        </div>
      )}

      {state.status === 'ok' && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard testid="platform-stat-orgs" label={t('platform.overview.stats.organizations')} value={state.data.orgs} />
          <StatCard testid="platform-stat-users" label={t('platform.overview.stats.users')} value={state.data.users} />
          <StatCard testid="platform-stat-landscapes" label={t('platform.overview.stats.landscapes')} value={state.data.landscapes} />
          <StatCard testid="platform-stat-versions" label={t('platform.overview.stats.versions')} value={state.data.versions} />
          <StatCard testid="platform-stat-live-connections" label={t('platform.overview.stats.liveConnections')} value={state.data.liveConnections} />
        </div>
      )}

      <SectionCard className="mt-6">
        <div className="border-b border-line px-5 py-3.5">
          <h2 className="text-[13px] font-semibold text-fg">{t('platform.overview.activeImpersonations.title')}</h2>
          <p className="mt-0.5 text-[12px] text-fg-subtle">{t('platform.overview.activeImpersonations.subtitle')}</p>
        </div>

        {imps.status === 'error' && (
          <div className="p-5">
            <InlineError message={imps.message} onRetry={loadImps} />
          </div>
        )}

        {imps.status === 'loading' && (
          <div className="p-5">
            <div className="flex flex-col gap-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-11 animate-pulse rounded-[10px] bg-surface-200" />
              ))}
            </div>
          </div>
        )}

        {imps.status === 'ok' && imps.data.length === 0 && (
          <div className="p-5">
            <EmptyState title={t('platform.overview.activeImpersonations.empty.title')} description={t('platform.overview.activeImpersonations.empty.description')} />
          </div>
        )}

        {imps.status === 'ok' && imps.data.length > 0 && (
          <ul data-testid="platform-active-impersonations" className="divide-y divide-line">
            {imps.data.map((imp) => (
              <li key={imp.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0 text-[13px] text-fg">
                  <span className="font-medium">{imp.adminEmail}</span>
                  <span className="text-fg-subtle"> {t('platform.overview.activeImpersonations.viewingAs')} </span>
                  <span className="font-medium">{imp.targetEmail}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-[11.5px] text-fg-subtle">{t('platform.overview.activeImpersonations.started', { time: timeAgo(imp.startedAt) })}</span>
                  <button
                    data-testid="impersonation-force-stop"
                    onClick={() => {
                      void api.forceEndImpersonation(imp.id).then(loadImps).catch(loadImps)
                    }}
                    className="rounded-md border border-line px-2.5 py-1 text-[11.5px] font-medium text-error-text hover:bg-surface-50"
                  >
                    {t('platform.overview.activeImpersonations.forceStop')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-line px-5 py-2.5 text-[11px] text-fg-subtle">
          {t('platform.overview.activeImpersonations.forceStopHint')}
        </p>
      </SectionCard>
    </div>
  )
}
