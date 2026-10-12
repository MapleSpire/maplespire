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
import { useParams } from '@tanstack/react-router'
import { Trans, useTranslation } from 'react-i18next'
import * as api from '../../lib/orgAdmin/api'
import { timeAgo } from '../../lib/orgAdmin/timeAgo'
import { useAuthStore } from '../../stores/authStore'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Modal } from '../ui/modal'
import { StatCard, InlineError, EmptyState, SectionCard } from './shared'

/** Overview: counter cards + recent audit list. */
export function AdminOverview() {
  const { orgId } = useParams({ from: '/org/$orgId/admin/' })
  const { t } = useTranslation()
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ok'; data: api.OrgOverview } | { status: 'error'; message: string }
  >({ status: 'loading' })

  const load = () => {
    setState({ status: 'loading' })
    api
      .getOverview(orgId)
      .then((data) => setState({ status: 'ok', data }))
      .catch((err) => setState({ status: 'error', message: err instanceof Error ? err.message : t('admin.overview.failedToLoad') }))
  }

  // t is only read for the rare non-Error fallback message; refetching from the server on
  // every language switch would be wasteful, and "Retry" already re-runs load() with the
  // current t.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [orgId])

  return (
    <div data-testid="admin-overview" className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('admin.overview.title')}</h1>
      <p className="mb-6 text-[13px] text-fg-secondary">{t('admin.overview.subtitle')}</p>

      {state.status === 'error' && <InlineError message={state.message} onRetry={load} />}

      {state.status === 'loading' && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[84px] animate-pulse rounded-xl bg-surface-200" />
          ))}
        </div>
      )}

      {state.status === 'ok' && (
        <>
          <OrgSettingsCard orgId={orgId} org={state.data.org} onSaved={load} />
          <SeedDemoCard orgId={orgId} onSeeded={load} />

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard testid="admin-stat-members" label={t('admin.overview.statMembers')} value={state.data.memberCount} />
            <StatCard testid="admin-stat-teams" label={t('admin.overview.statTeams')} value={state.data.teamCount} />
            <StatCard testid="admin-stat-landscapes" label={t('admin.overview.statLandscapes')} value={state.data.landscapeCount} />
            <StatCard testid="admin-stat-invites" label={t('admin.overview.statPendingInvites')} value={state.data.pendingInviteCount} />
          </div>

          <SectionCard className="mt-6">
            <div className="border-b border-line px-5 py-3.5">
              <h2 className="text-[13px] font-semibold text-fg">{t('admin.overview.recentActivity')}</h2>
            </div>
            {state.data.recentAudit.length === 0 ? (
              <div className="p-5">
                <EmptyState title={t('admin.overview.noActivityYet')} description={t('admin.overview.noActivityDescription')} />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {state.data.recentAudit.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-4 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] text-fg">
                        <span className="font-medium">{formatAction(entry.action)}</span>
                        {entry.targetKind && (
                          <span className="text-fg-subtle"> · {entry.targetKind} <span className="font-mono text-[12px]">{truncateId(entry.targetId)}</span></span>
                        )}
                      </p>
                      <p className="mt-0.5 truncate text-[11.5px] text-fg-subtle">
                        <Trans i18nKey="admin.overview.byActor" values={{ actorId: truncateId(entry.actorUserId) }}>
                          {/* {{var}} children-interpolation cast: see AdminMembers.tsx inviteSentTo for why */}
                          by <span className="font-mono">{{ actorId: truncateId(entry.actorUserId) } as unknown as string}</span>
                        </Trans>
                        {entry.impersonatorUserId
                          ? ` ${t('admin.overview.asImpersonatedBy', { impersonatorId: truncateId(entry.impersonatorUserId) })}`
                          : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11.5px] text-fg-subtle">{timeAgo(entry.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}
    </div>
  )
}

/** Org name (rename) + invite-TTL setting. Slug stays read-only — it's the
 * stable URL-safe identifier. TTL changes apply to invites created FROM NOW
 * ON; already-issued invites keep the expiry they were stamped with. */
function OrgSettingsCard({
  orgId,
  org,
  onSaved,
}: {
  orgId: string
  org: api.OrgOverview['org']
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(org.name)
  const [ttl, setTtl] = useState(String(org.settings.inviteTtlHours ?? 24))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const dirty = name.trim() !== org.name || Number(ttl) !== (org.settings.inviteTtlHours ?? 24)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !dirty) return
    const hours = Number(ttl)
    if (!name.trim()) {
      setError(t('admin.overview.nameRequired'))
      return
    }
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      setError(t('admin.overview.inviteExpiryRange'))
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await api.updateOrg(orgId, {
        ...(name.trim() !== org.name ? { name: name.trim() } : {}),
        ...(hours !== (org.settings.inviteTtlHours ?? 24) ? { settings: { inviteTtlHours: hours } } : {}),
      })
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.overview.failedToSave'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard className="mb-6">
      <div className="border-b border-line px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-fg">{t('admin.overview.orgSettingsTitle')}</h2>
      </div>
      <form onSubmit={handleSave} className="flex flex-col gap-4 p-5">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="org-name" className="text-[12px] font-medium text-fg-secondary">
              {t('admin.overview.name')}
            </label>
            <Input
              id="org-name"
              data-testid="org-settings-name"
              value={name}
              maxLength={200}
              onChange={(e) => {
                setName(e.target.value)
                setSaved(false)
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="org-invite-ttl" className="text-[12px] font-medium text-fg-secondary">
              {t('admin.overview.inviteExpiryHours')}
            </label>
            <Input
              id="org-invite-ttl"
              data-testid="org-settings-invite-ttl"
              type="number"
              min={1}
              max={720}
              value={ttl}
              onChange={(e) => {
                setTtl(e.target.value)
                setSaved(false)
              }}
            />
            <p className="text-[11.5px] text-fg-subtle">{t('admin.overview.appliesToNewInvitesOnly')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-fg-secondary">{t('admin.overview.slug')}</span>
            <p className="flex h-9 items-center font-mono text-[12.5px] text-fg-subtle">{org.slug}</p>
          </div>
        </div>
        {error && (
          <div className="rounded-lg border border-line bg-error-bg px-3 py-2 text-[12.5px] text-error-text">{error}</div>
        )}
        <div className="flex items-center justify-end gap-3">
          {saved && !dirty && (
            <span className="text-[12.5px] text-success-text" data-testid="org-settings-saved">
              {t('admin.overview.saved')}
            </span>
          )}
          <Button type="submit" data-testid="org-settings-save" size="sm" disabled={busy || !dirty}>
            {busy ? t('admin.overview.saving') : t('admin.overview.saveChanges')}
          </Button>
        </div>
      </form>
    </SectionCard>
  )
}

/** ORG_SEED=on only: seed a complete demo environment (landscape + versions +
 * diagrams + teams + fake members) into this org. Each run creates a FRESH
 * demo landscape. */
function SeedDemoCard({ orgId, onSeeded }: { orgId: string; onSeeded: () => void }) {
  const { t } = useTranslation()
  const config = useAuthStore((s) => s.config)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<api.SeedResult | null>(null)

  if (!config?.orgSeed) return null

  const handleSeed = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.seedDemoEnvironment(orgId)
      setResult(r)
      // onSeeded (overview reload) waits for Done — reloading now flips the
      // page to its loading state, which unmounts this card and the summary.
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.overview.failedToSeed'))
    } finally {
      setBusy(false)
    }
  }

  const handleDone = () => {
    setConfirmOpen(false)
    setResult(null)
    onSeeded()
  }

  return (
    <SectionCard className="mb-6">
      <div className="flex items-center justify-between gap-4 px-5 py-3.5">
        <div>
          <h2 className="text-[13px] font-semibold text-fg">{t('admin.overview.demoEnvironmentTitle')}</h2>
          <p className="text-[12px] text-fg-secondary">{t('admin.overview.demoEnvironmentDescription')}</p>
        </div>
        <Button data-testid="seed-demo-open" variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
          {t('admin.overview.seedDemoEnvironment')}
        </Button>
      </div>
      {confirmOpen && (
        <Modal title={t('admin.overview.seedDemoEnvironment')} onClose={() => setConfirmOpen(false)} data-testid="seed-demo-dialog">
          {!result ? (
            <div className="flex flex-col gap-3">
              <p className="text-[13px] text-fg-secondary">
                <Trans
                  i18nKey="admin.overview.seedDemoConfirmBody"
                  components={{ emphasis: <span className="font-medium text-fg" /> }}
                />
              </p>
              {error && (
                <div className="rounded-lg border border-line bg-error-bg px-3 py-2 text-[12.5px] text-error-text">{error}</div>
              )}
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" data-testid="seed-demo-confirm" onClick={() => void handleSeed()} disabled={busy}>
                  {busy ? t('admin.overview.seeding') : t('admin.overview.seedNow')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3" data-testid="seed-demo-result">
              <p className="text-[13px] text-fg">
                <Trans
                  i18nKey="admin.overview.createdLandscape"
                  values={{ name: result.landscapeName }}
                  components={{ emphasis: <span className="font-medium" /> }}
                />
              </p>
              <ul className="list-inside list-disc text-[12.5px] text-fg-secondary">
                <li>{t('admin.overview.summaryVersionsDiagrams', { versions: result.versions, diagrams: result.diagrams })}</li>
                <li>{t('admin.overview.summaryObjectsConnections', { objects: result.objects, connections: result.connections })}</li>
                <li>{t('admin.overview.summaryTeamsMembers', { teams: result.teams, users: result.users })}</li>
              </ul>
              <div className="mt-2 flex justify-end">
                <Button type="button" onClick={handleDone}>
                  {t('admin.overview.done')}
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </SectionCard>
  )
}

function formatAction(action: string): string {
  return action.replace(/[._-]/g, ' ')
}

function truncateId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id
}
