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
import { Button } from '../ui/button'
import { InlineError, SkeletonRows, EmptyState, SectionCard } from '../admin/shared'

/** Global audit: same shape as the org-scoped audit list but
 * cross-org + platform-level events, with orgId/action filters and keyset
 * load-more. Impersonated actions are badged ("by Operator as Alice"). */
export function PlatformAudit() {
  const { t } = useTranslation()
  const [orgIdFilter, setOrgIdFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [debounced, setDebounced] = useState({ orgId: '', action: '' })
  const [entries, setEntries] = useState<api.PlatformAuditEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ orgId: orgIdFilter.trim(), action: actionFilter.trim() }), 300)
    return () => clearTimeout(timer)
  }, [orgIdFilter, actionFilter])

  const load = () => {
    setStatus('loading')
    setError(null)
    api
      .getAudit({ orgId: debounced.orgId || undefined, action: debounced.action || undefined })
      .then((page) => {
        // Defensive: a server/client key drift must not crash the whole route
        // on `undefined.length` — an empty list is the correct degradation.
        setEntries(page.entries ?? [])
        setNextCursor(page.nextCursor ?? null)
        setStatus('ok')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('platform.audit.loadFailed'))
        setStatus('error')
      })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable enough for this list of deps
  }, [debounced])

  const loadMore = () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    api
      .getAudit({ orgId: debounced.orgId || undefined, action: debounced.action || undefined, after: nextCursor })
      .then((page) => {
        setEntries((prev) => [...prev, ...(page.entries ?? [])])
        setNextCursor(page.nextCursor ?? null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('platform.audit.loadMoreFailed')))
      .finally(() => setLoadingMore(false))
  }

  return (
    <div data-testid="platform-audit" className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('platform.audit.title')}</h1>
      <p className="mb-6 text-[13px] text-fg-secondary">{t('platform.audit.subtitle')}</p>

      <div className="mb-3 flex items-center gap-2">
        <input
          data-testid="platform-audit-org-filter"
          value={orgIdFilter}
          onChange={(e) => setOrgIdFilter(e.target.value)}
          placeholder={t('platform.audit.filterByOrgId')}
          className="h-8 w-full max-w-[220px] rounded-md border border-line bg-surface-50 px-3 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <input
          data-testid="platform-audit-action-filter"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder={t('platform.audit.filterByAction')}
          className="h-8 w-full max-w-[220px] rounded-md border border-line bg-surface-50 px-3 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
      </div>

      {status === 'error' && <InlineError message={error ?? t('platform.audit.loadFailed')} onRetry={load} />}

      {status === 'loading' && <SkeletonRows rows={6} />}

      {status === 'ok' && entries.length === 0 && (
        <EmptyState title={t('platform.audit.empty.title')} description={t('platform.audit.empty.description')} />
      )}

      {status === 'ok' && entries.length > 0 && (
        <SectionCard>
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fg-subtle">
                <th className="px-4 py-2.5 font-medium">{t('platform.audit.columns.when')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.audit.columns.action')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.audit.columns.target')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.audit.columns.actor')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.audit.columns.org')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-fg-secondary">{timeAgo(entry.at)}</td>
                  <td className="px-4 py-3 font-medium text-fg">{formatAction(entry.action)}</td>
                  <td className="px-4 py-3 text-fg-secondary">
                    {entry.targetKind ? `${entry.targetKind} ${truncateId(entry.targetId ?? '')}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-fg-secondary">
                    <div className="flex items-center gap-1.5">
                      <span>{entry.actorEmail ?? truncateId(entry.actorUserId ?? '')}</span>
                      {entry.impersonatorUserId && (
                        <span className="inline-flex items-center rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-semibold text-warning-text">
                          {t('platform.audit.by', { who: entry.impersonatorEmail ?? truncateId(entry.impersonatorUserId) })}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-fg-secondary">
                    {entry.orgName ?? (entry.orgId ? truncateId(entry.orgId) : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="flex justify-center border-t border-line p-3">
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t('platform.audit.loadingMore') : t('platform.audit.loadMore')}
              </Button>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  )
}

function formatAction(action: string): string {
  return action.replace(/[._-]/g, ' ')
}

function truncateId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id
}
