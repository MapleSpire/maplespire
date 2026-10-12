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
import { Button } from '../ui/button'
import { SectionCard } from '../admin/shared'

/** Access debugger: pick a user (typeahead over the users search) + a
 * free scopeId, run explainAccess cross-org, show the verdict with provenance
 * plus the raw response in a <details> for support/debugging — the first tool
 * for any "I can't see my diagram" ticket. */
export function PlatformDebug() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [candidates, setCandidates] = useState<api.PlatformUser[]>([])
  const [userId, setUserId] = useState('')
  const [selectedUser, setSelectedUser] = useState<api.PlatformUser | null>(null)
  const [scopeId, setScopeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<api.AccessDebugResult | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!debouncedQuery) {
      setCandidates([])
      return
    }
    let cancelled = false
    api
      .getUsers({ q: debouncedQuery, limit: 10 })
      .then((page) => {
        if (!cancelled) setCandidates(page.users)
      })
      .catch(() => {
        // Non-fatal — the picker just stays empty.
      })
    return () => {
      cancelled = true
    }
  }, [debouncedQuery])

  const handleRun = async () => {
    if (!userId || !scopeId.trim()) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.getAccessDebug(userId, scopeId.trim())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('platform.debug.runFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('platform.debug.title')}</h1>
      <p className="mb-6 text-[13px] text-fg-secondary">
        {t('platform.debug.subtitle')}
      </p>

      <SectionCard className="p-4">
        <label className="mb-1 block text-[11px] font-medium text-fg-secondary">{t('platform.debug.user')}</label>
        <div className="relative mb-3">
          <input
            data-testid="debug-user"
            value={selectedUser ? selectedUser.email : query}
            onChange={(e) => {
              setSelectedUser(null)
              setUserId('')
              setQuery(e.target.value)
            }}
            placeholder={t('platform.debug.searchPlaceholder')}
            className="h-9 w-full rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          {!selectedUser && candidates.length > 0 && (
            <ul className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-56 overflow-y-auto rounded-md border border-line bg-surface-100 py-1 shadow-lg">
              {candidates.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedUser(u)
                      setUserId(u.id)
                      setQuery(u.email)
                      setCandidates([])
                    }}
                    className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-hover"
                  >
                    <span className="text-[12.5px] text-fg">{u.name ?? u.email}</span>
                    {u.name && <span className="text-[11px] text-fg-subtle">{u.email}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="mb-1 block text-[11px] font-medium text-fg-secondary">{t('platform.debug.scopeId')}</label>
        <input
          data-testid="debug-scope"
          value={scopeId}
          onChange={(e) => setScopeId(e.target.value)}
          placeholder={t('platform.debug.scopeIdPlaceholder')}
          className="mb-4 h-9 w-full rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />

        <Button
          data-testid="debug-run"
          variant="primary"
          size="md"
          disabled={!userId || !scopeId.trim() || busy}
          onClick={handleRun}
        >
          {busy ? t('platform.debug.running') : t('platform.debug.run')}
        </Button>

        {error && <p className="mt-3 text-[12px] text-error-text">{error}</p>}

        {result && (
          <div data-testid="debug-result" className="mt-5 rounded-md border border-line bg-surface-50 p-4">
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  result.allowed ? 'bg-success-bg text-success-text' : 'bg-surface-200 text-fg-subtle'
                }`}
              >
                {result.allowed === undefined
                  ? t('platform.debug.result')
                  : result.allowed
                    ? result.canWrite
                      ? t('platform.debug.edit')
                      : t('platform.debug.view')
                    : t('platform.debug.noAccess')}
              </span>
              {result.userEmail && <span className="text-[12px] text-fg-secondary">{t('platform.debug.for', { email: result.userEmail })}</span>}
            </div>
            {result.via && <p className="text-[12px] text-fg-secondary">{t('platform.debug.via', { via: result.via })}</p>}
            {result.grantScopeId && <p className="text-[12px] text-fg-secondary">{t('platform.debug.grantedAtScope', { scopeId: result.grantScopeId })}</p>}

            <details className="mt-3">
              <summary className="cursor-pointer text-[12px] font-medium text-fg-secondary hover:text-fg">{t('platform.debug.rawResponse')}</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-surface-200 p-3 text-[11px] text-fg-secondary">
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </SectionCard>
    </div>
  )
}
