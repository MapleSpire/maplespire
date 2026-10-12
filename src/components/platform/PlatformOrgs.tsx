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

import { useEffect, useRef, useState } from 'react'
import { Search, Plus, Ban, PlayCircle } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import * as api from '../../lib/platform/api'
import { timeAgo } from '../../lib/orgAdmin/timeAgo'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'
import { InlineError, SkeletonRows, EmptyState, TypedConfirmModal, SectionCard } from '../admin/shared'

/** Organizations: server-paginated table + create-org dialog + typed-confirm
 * suspend/unsuspend. Suspend is a soft-lock that drops every live session in
 * the org, so it gets the same danger-pattern treatment as member removal. */
export function PlatformOrgs() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [orgs, setOrgs] = useState<api.PlatformOrg[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [suspendTarget, setSuspendTarget] = useState<api.PlatformOrg | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  const load = (q: string) => {
    setStatus('loading')
    setError(null)
    api
      .getOrgs({ q: q || undefined })
      .then((page) => {
        setOrgs(page.orgs)
        setNextCursor(page.nextCursor)
        setStatus('ok')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('platform.orgs.loadFailed'))
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
      .getOrgs({ q: debouncedQuery || undefined, after: nextCursor })
      .then((page) => {
        setOrgs((prev) => [...prev, ...page.orgs])
        setNextCursor(page.nextCursor)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('platform.orgs.loadMoreFailed')))
      .finally(() => setLoadingMore(false))
  }

  return (
    <div data-testid="platform-orgs" className="mx-auto max-w-5xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('platform.orgs.title')}</h1>
          <p className="text-[13px] text-fg-secondary">{t('platform.orgs.subtitle')}</p>
        </div>
        <Button data-testid="org-create-open" variant="primary" size="md" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          {t('platform.orgs.createOrg')}
        </Button>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-full max-w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            data-testid="platform-orgs-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('platform.orgs.searchPlaceholder')}
            className="h-8 w-full rounded-md border border-line bg-surface-50 pl-8 pr-3 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {status === 'error' && <InlineError message={error ?? t('platform.orgs.loadFailed')} onRetry={() => load(debouncedQuery)} />}

      {status === 'loading' && <SkeletonRows rows={6} />}

      {status === 'ok' && orgs.length === 0 && (
        <EmptyState title={t('platform.orgs.empty.title')} description={debouncedQuery ? t('platform.orgs.empty.tryDifferentSearch') : t('platform.orgs.empty.createFirst')} />
      )}

      {status === 'ok' && orgs.length > 0 && (
        <SectionCard>
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fg-subtle">
                <th className="px-4 py-2.5 font-medium">{t('platform.orgs.columns.organization')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.orgs.columns.status')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.orgs.columns.members')}</th>
                <th className="px-4 py-2.5 font-medium">{t('platform.orgs.columns.created')}</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id} data-testid="org-row" className="border-b border-line last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-fg">{org.name}</p>
                    <p className="text-[11.5px] text-fg-subtle">{org.slug}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        org.status === 'active' ? 'bg-success-bg text-success-text' : 'bg-warning-bg text-warning-text'
                      }`}
                    >
                      {org.status === 'active' ? t('platform.orgs.statusActive') : t('platform.orgs.statusSuspended')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg-secondary">{org.memberCount}</td>
                  <td className="px-4 py-3 text-fg-secondary">{timeAgo(org.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      data-testid="org-suspend"
                      variant="secondary"
                      size="sm"
                      onClick={() => setSuspendTarget(org)}
                      className="gap-1.5"
                    >
                      {org.status === 'active' ? (
                        <>
                          <Ban className="h-3.5 w-3.5" />
                          {t('platform.orgs.suspend')}
                        </>
                      ) : (
                        <>
                          <PlayCircle className="h-3.5 w-3.5" />
                          {t('platform.orgs.unsuspend')}
                        </>
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="flex justify-center border-t border-line p-3">
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t('platform.orgs.loadingMore') : t('platform.orgs.loadMore')}
              </Button>
            </div>
          )}
        </SectionCard>
      )}

      {createOpen && (
        <CreateOrgDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(org) => {
            setOrgs((prev) => [org, ...prev])
            setCreateOpen(false)
          }}
        />
      )}

      {suspendTarget && (
        <SuspendOrgModal
          org={suspendTarget}
          onClose={() => setSuspendTarget(null)}
          onDone={(status) => {
            setOrgs((prev) => prev.map((o) => (o.id === suspendTarget.id ? { ...o, status } : o)))
            setSuspendTarget(null)
          }}
        />
      )}
    </div>
  )
}

// ── Create org dialog ────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function CreateOrgDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (org: api.PlatformOrg) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const derivedSlug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const effectiveSlug = slugTouched ? slug : derivedSlug
  const slugValid = effectiveSlug.length > 0 && SLUG_RE.test(effectiveSlug)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !slugValid || busy) return
    setBusy(true)
    setError(null)
    try {
      const org = await api.createOrg(name.trim(), effectiveSlug)
      onCreated(org)
    } catch (err) {
      if (err instanceof api.PlatformApiError && err.status === 409) {
        setError(t('platform.orgs.create.slugTaken'))
      } else {
        setError(err instanceof Error ? err.message : t('platform.orgs.create.createFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('platform.orgs.create.title')} onClose={onClose} data-testid="create-org-dialog">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-fg-secondary">{t('platform.orgs.create.name')}</label>
            <input
              ref={nameRef}
              data-testid="org-create-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              className="h-9 w-full rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-fg-secondary">{t('platform.orgs.create.slug')}</label>
            <input
              data-testid="org-create-slug"
              required
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value.toLowerCase())
              }}
              placeholder="acme-corp"
              className="h-9 w-full rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
            <p className="mt-1 text-[11px] text-fg-subtle">
              {t('platform.orgs.create.slugHint')}
            </p>
            {effectiveSlug.length > 0 && !slugValid && (
              <p className="mt-1 text-[11px] text-error-text">{t('platform.orgs.create.slugInvalid')}</p>
            )}
          </div>
          {error && <p className="text-[12px] text-error-text">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              data-testid="org-create-submit"
              variant="primary"
              size="sm"
              disabled={busy || !name.trim() || !slugValid}
            >
              {busy ? t('platform.orgs.create.creating') : t('platform.orgs.create.submit')}
            </Button>
          </div>
      </form>
    </Modal>
  )
}

// ── Suspend / unsuspend modal ────────────────────────────────────────────────

function SuspendOrgModal({
  org,
  onClose,
  onDone,
}: {
  org: api.PlatformOrg
  onClose: () => void
  onDone: (status: 'active' | 'suspended') => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const suspending = org.status === 'active'
  const nextStatus = suspending ? 'suspended' : 'active'

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.updateOrgStatus(org.id, nextStatus)
      onDone(nextStatus)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : suspending
            ? t('platform.orgs.suspendModal.suspendFailed')
            : t('platform.orgs.suspendModal.unsuspendFailed')
      )
      setBusy(false)
    }
  }

  return (
    <TypedConfirmModal
      title={suspending ? t('platform.orgs.suspendModal.suspendTitle') : t('platform.orgs.suspendModal.unsuspendTitle')}
      description={
        suspending ? (
          <Trans
            i18nKey="platform.orgs.suspendModal.suspendDescription"
            values={{ name: org.name }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        ) : (
          <Trans
            i18nKey="platform.orgs.suspendModal.unsuspendDescription"
            values={{ name: org.name }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        )
      }
      expected={org.slug}
      confirmLabel={suspending ? t('platform.orgs.suspend') : t('platform.orgs.unsuspend')}
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onClose}
      testidPrefix="org-suspend"
    />
  )
}
