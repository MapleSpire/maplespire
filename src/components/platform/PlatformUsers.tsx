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
import { Search, Eye, ShieldCheck, ShieldOff, UserX, UserCheck } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import * as api from '../../lib/platform/api'
import { Button } from '../ui/button'
import { Chip } from '../ui/chip'
import { InlineError, SkeletonRows, EmptyState, TypedConfirmModal, SectionCard } from '../admin/shared'

/** Users (global): search across every org, impersonate ("view as" — a
 * FULL page navigation so the whole app reboots under the target session),
 * deactivate/reactivate, grant/revoke platform-admin (both typed-confirm by
 * email; the 409 last-platform-admin case gets a friendly inline error). */
export function PlatformUsers() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [users, setUsers] = useState<api.PlatformUser[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<api.PlatformUser | null>(null)
  const [adminTarget, setAdminTarget] = useState<{ user: api.PlatformUser; grant: boolean } | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  const load = (q: string) => {
    setStatus('loading')
    setError(null)
    api
      .getUsers({ q: q || undefined })
      .then((page) => {
        setUsers(page.users)
        setNextCursor(page.nextCursor)
        setStatus('ok')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('platform.users.loadFailed'))
        setStatus('error')
      })
  }

  useEffect(() => {
    load(debouncedQuery)
  }, [debouncedQuery])

  const loadMore = () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    api
      .getUsers({ q: debouncedQuery || undefined, after: nextCursor })
      .then((page) => {
        setUsers((prev) => [...prev, ...page.users])
        setNextCursor(page.nextCursor)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('platform.users.loadMoreFailed')))
      .finally(() => setLoadingMore(false))
  }

  const handleImpersonate = async (user: api.PlatformUser) => {
    setRowError((prev) => ({ ...prev, [user.id]: '' }))
    setImpersonatingId(user.id)
    try {
      await api.startImpersonation(user.id)
      // Full page navigation so the whole app reboots under the target session
      // (impersonation must be WYSIWYG, not a partial client-side state swap).
      window.location.assign('/app')
    } catch (err) {
      setRowError((prev) => ({ ...prev, [user.id]: err instanceof Error ? err.message : t('platform.users.startImpersonationFailed') }))
      setImpersonatingId(null)
    }
  }

  return (
    <div data-testid="platform-users" className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('platform.users.title')}</h1>
      <p className="mb-6 text-[13px] text-fg-secondary">{t('platform.users.subtitle')}</p>

      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-full max-w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            data-testid="platform-users-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('platform.users.searchPlaceholder')}
            className="h-8 w-full rounded-md border border-line bg-surface-50 pl-8 pr-3 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {status === 'error' && <InlineError message={error ?? t('platform.users.loadFailed')} onRetry={() => load(debouncedQuery)} />}

      {status === 'loading' && <SkeletonRows rows={6} />}

      {status === 'ok' && users.length === 0 && (
        <EmptyState title={t('platform.users.empty.title')} description={debouncedQuery ? t('platform.users.empty.tryDifferentSearch') : t('platform.users.empty.willAppear')} />
      )}

      {status === 'ok' && users.length > 0 && (
        <SectionCard>
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fg-subtle">
                <th className="px-4 py-2.5 font-medium">{t('platform.users.columns.user')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.users.columns.status')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.users.columns.organizations')}</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} data-testid="user-row" className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <p className="font-medium text-fg">{u.name ?? u.email}</p>
                      {u.isPlatformAdmin && (
                        <span
                          data-testid="user-platform-admin-badge"
                          className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-1.5 py-0.5 text-[10px] font-semibold text-accent"
                        >
                          <ShieldCheck className="h-2.5 w-2.5" />
                          {t('platform.users.platformAdminBadge')}
                        </span>
                      )}
                    </div>
                    {u.name && <p className="text-[11.5px] text-fg-subtle">{u.email}</p>}
                    {rowError[u.id] && <p className="mt-1 max-w-[260px] text-[11px] text-error-text">{rowError[u.id]}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        u.status === 'active' ? 'bg-success-bg text-success-text' : 'bg-surface-200 text-fg-subtle'
                      }`}
                    >
                      {u.status === 'active' ? t('platform.users.statusActive') : t('platform.users.statusDeactivated')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {u.orgs.length === 0 ? (
                        <span className="text-[11.5px] text-fg-subtle">—</span>
                      ) : (
                        u.orgs.map((o) => (
                          <Chip key={o.orgId} title={`${o.role}${o.name ? ` · ${o.orgId}` : ''}`}>
                            {o.name ?? (o.orgId.length > 10 ? `${o.orgId.slice(0, 10)}…` : o.orgId)}
                          </Chip>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        data-testid="user-impersonate"
                        variant="secondary"
                        size="sm"
                        disabled={impersonatingId === u.id || u.status !== 'active'}
                        onClick={() => handleImpersonate(u)}
                        title={t('platform.users.viewAsThisUser')}
                        className="gap-1.5"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        {impersonatingId === u.id ? t('platform.users.starting') : t('platform.users.impersonate')}
                      </Button>
                      <button
                        data-testid="user-deactivate"
                        onClick={() => setDeactivateTarget(u)}
                        title={u.status === 'active' ? t('platform.users.deactivate') : t('platform.users.reactivate')}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-error-bg hover:text-error-text"
                      >
                        {u.status === 'active' ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        data-testid="user-grant-admin"
                        onClick={() => setAdminTarget({ user: u, grant: !u.isPlatformAdmin })}
                        title={u.isPlatformAdmin ? t('platform.users.revokePlatformAdmin') : t('platform.users.grantPlatformAdmin')}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-accent-subtle hover:text-accent"
                      >
                        {u.isPlatformAdmin ? <ShieldOff className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="flex justify-center border-t border-line p-3">
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t('platform.users.loadingMore') : t('platform.users.loadMore')}
              </Button>
            </div>
          )}
        </SectionCard>
      )}

      {deactivateTarget && (
        <DeactivateUserModal
          user={deactivateTarget}
          onClose={() => setDeactivateTarget(null)}
          onDone={(status) => {
            setUsers((prev) => prev.map((u) => (u.id === deactivateTarget.id ? { ...u, status } : u)))
            setDeactivateTarget(null)
          }}
        />
      )}

      {adminTarget && (
        <PlatformAdminModal
          user={adminTarget.user}
          grant={adminTarget.grant}
          onClose={() => setAdminTarget(null)}
          onDone={() => {
            setUsers((prev) =>
              prev.map((u) => (u.id === adminTarget.user.id ? { ...u, isPlatformAdmin: adminTarget.grant } : u))
            )
            setAdminTarget(null)
          }}
        />
      )}
    </div>
  )
}

// ── Deactivate / reactivate modal ────────────────────────────────────────────

function DeactivateUserModal({
  user,
  onClose,
  onDone,
}: {
  user: api.PlatformUser
  onClose: () => void
  onDone: (status: 'active' | 'deactivated') => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deactivating = user.status === 'active'
  const nextStatus = deactivating ? 'deactivated' : 'active'

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.updateUserStatus(user.id, nextStatus)
      onDone(nextStatus)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : deactivating
            ? t('platform.users.deactivateModal.deactivateFailed')
            : t('platform.users.deactivateModal.reactivateFailed')
      )
      setBusy(false)
    }
  }

  return (
    <TypedConfirmModal
      title={deactivating ? t('platform.users.deactivateModal.deactivateTitle') : t('platform.users.deactivateModal.reactivateTitle')}
      description={
        deactivating ? (
          <Trans
            i18nKey="platform.users.deactivateModal.deactivateDescription"
            values={{ email: user.email }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        ) : (
          <Trans
            i18nKey="platform.users.deactivateModal.reactivateDescription"
            values={{ email: user.email }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        )
      }
      expected={user.email}
      confirmLabel={deactivating ? t('platform.users.deactivate') : t('platform.users.reactivate')}
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onClose}
      testidPrefix="user-deactivate"
    />
  )
}

// ── Grant / revoke platform admin modal ──────────────────────────────────────

function PlatformAdminModal({
  user,
  grant,
  onClose,
  onDone,
}: {
  user: api.PlatformUser
  grant: boolean
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.setPlatformAdmin(user.id, grant)
      onDone()
    } catch (err) {
      if (err instanceof api.PlatformApiError && err.code === 'last-platform-admin') {
        setError(t('platform.users.adminModal.lastPlatformAdmin'))
      } else {
        setError(
          err instanceof Error
            ? err.message
            : grant
              ? t('platform.users.adminModal.grantFailed')
              : t('platform.users.adminModal.revokeFailed')
        )
      }
      setBusy(false)
    }
  }

  return (
    <TypedConfirmModal
      title={grant ? t('platform.users.adminModal.grantTitle') : t('platform.users.adminModal.revokeTitle')}
      description={
        grant ? (
          <Trans
            i18nKey="platform.users.adminModal.grantDescription"
            values={{ email: user.email }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        ) : (
          <Trans
            i18nKey="platform.users.adminModal.revokeDescription"
            values={{ email: user.email }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        )
      }
      expected={user.email}
      confirmLabel={grant ? t('platform.users.adminModal.grant') : t('platform.users.adminModal.revoke')}
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onClose}
      testidPrefix="user-grant-admin"
    />
  )
}
