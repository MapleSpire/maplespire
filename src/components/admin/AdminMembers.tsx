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
import { useParams } from '@tanstack/react-router'
import { Search, Trash2, Copy, Check, Plus } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Modal } from '../ui/modal'
import * as api from '../../lib/orgAdmin/api'
import { timeAgo } from '../../lib/orgAdmin/timeAgo'
import { Button } from '../ui/button'
import { Chip } from '../ui/chip'
import { InlineError, SkeletonRows, EmptyState, TypedConfirmModal, SectionCard } from './shared'

type Tab = 'active' | 'invites'

/** Members: server-paginated table with debounced search, role change
 * (with last-admin 409 handled as a friendly inline error), typed-confirm
 * remove, and an Invites tab (pending list + revoke + invite dialog). */
export function AdminMembers() {
  const { orgId } = useParams({ from: '/org/$orgId/admin/members' })
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('active')
  const [inviteOpen, setInviteOpen] = useState(false)

  return (
    <div data-testid="admin-members" className="mx-auto max-w-5xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('admin.members.title')}</h1>
          <p className="text-[13px] text-fg-secondary">{t('admin.members.subtitle')}</p>
        </div>
        <Button data-testid="invite-open" variant="primary" size="md" onClick={() => setInviteOpen(true)} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          {t('admin.members.inviteMember')}
        </Button>
      </div>

      <div className="mb-4 flex gap-1 border-b border-line">
        <TabButton active={tab === 'active'} onClick={() => setTab('active')}>
          {t('admin.members.activeTab')}
        </TabButton>
        <TabButton active={tab === 'invites'} onClick={() => setTab('invites')}>
          {t('admin.members.pendingInvitesTab')}
        </TabButton>
      </div>

      {tab === 'active' ? <ActiveMembersTab orgId={orgId} /> : <InvitesTab orgId={orgId} />}

      {inviteOpen && <InviteDialog orgId={orgId} onClose={() => setInviteOpen(false)} />}
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
        active ? 'border-accent text-fg' : 'border-transparent text-fg-subtle hover:text-fg-secondary'
      }`}
    >
      {children}
    </button>
  )
}

// ── Active members ───────────────────────────────────────────────────────────

function ActiveMembersTab({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [members, setMembers] = useState<api.OrgMember[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [roleError, setRoleError] = useState<Record<string, string>>({})
  const [roleBusy, setRoleBusy] = useState<Record<string, boolean>>({})
  const [removeTarget, setRemoveTarget] = useState<api.OrgMember | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const load = (q: string) => {
    setStatus('loading')
    setError(null)
    api
      .getMembers(orgId, { q: q || undefined })
      .then((page) => {
        setMembers(page.members)
        setNextCursor(page.nextCursor)
        setStatus('ok')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('admin.members.failedToLoad'))
        setStatus('error')
      })
  }

  useEffect(() => {
    load(debouncedQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable enough for this list of deps
  }, [orgId, debouncedQuery])

  const loadMore = () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    api
      .getMembers(orgId, { q: debouncedQuery || undefined, after: nextCursor })
      .then((page) => {
        setMembers((prev) => [...prev, ...page.members])
        setNextCursor(page.nextCursor)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('admin.members.failedToLoadMore')))
      .finally(() => setLoadingMore(false))
  }

  const handleRoleChange = async (member: api.OrgMember, role: 'admin' | 'member') => {
    setRoleError((prev) => ({ ...prev, [member.userId]: '' }))
    setRoleBusy((prev) => ({ ...prev, [member.userId]: true }))
    try {
      await api.updateMemberRole(orgId, member.userId, role)
      setMembers((prev) => prev.map((m) => (m.userId === member.userId ? { ...m, role } : m)))
    } catch (err) {
      if (err instanceof api.OrgAdminApiError && err.code === 'last-admin') {
        setRoleError((prev) => ({
          ...prev,
          [member.userId]: t('admin.members.lastAdminError'),
        }))
      } else {
        setRoleError((prev) => ({
          ...prev,
          [member.userId]: err instanceof Error ? err.message : t('admin.members.failedToChangeRole'),
        }))
      }
    } finally {
      setRoleBusy((prev) => ({ ...prev, [member.userId]: false }))
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-full max-w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            data-testid="admin-members-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('admin.members.searchPlaceholder')}
            className="h-8 w-full rounded-md border border-line bg-surface-50 pl-8 pr-3 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {status === 'error' && <InlineError message={error ?? t('admin.members.failedToLoad')} onRetry={() => load(debouncedQuery)} />}

      {status === 'loading' && <SkeletonRows rows={6} />}

      {status === 'ok' && members.length === 0 && (
        <EmptyState
          title={t('admin.members.noMembersFound')}
          description={debouncedQuery ? t('admin.members.tryDifferentSearch') : t('admin.members.inviteToGetStarted')}
        />
      )}

      {status === 'ok' && members.length > 0 && (
        <SectionCard>
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="sticky top-0 bg-surface-100">
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fg-subtle">
                <th className="px-4 py-2.5 font-medium">{t('admin.members.columnMember')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.members.columnRole')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.members.columnTeams')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.members.columnStatus')}</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} data-testid="member-row" className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium text-fg">{m.name ?? m.email}</p>
                    {m.name && <p className="text-[11.5px] text-fg-subtle">{m.email}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      data-testid="member-role-select"
                      value={m.role}
                      disabled={roleBusy[m.userId]}
                      onChange={(e) => handleRoleChange(m, e.target.value as 'admin' | 'member')}
                      className="h-7 rounded-md border border-line bg-surface-50 px-2 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
                    >
                      <option value="member">{t('admin.members.roleMember')}</option>
                      <option value="admin">{t('admin.members.roleAdmin')}</option>
                    </select>
                    {roleError[m.userId] && <p className="mt-1 max-w-[180px] text-[11px] text-error-text">{roleError[m.userId]}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {m.teams.length === 0 ? (
                        <span className="text-[11.5px] text-fg-subtle">—</span>
                      ) : (
                        m.teams.map((team) => <Chip key={team.id}>{team.name}</Chip>)
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        m.status === 'active' ? 'bg-success-bg text-success-text' : 'bg-surface-200 text-fg-subtle'
                      }`}
                    >
                      {m.status === 'active' ? t('admin.members.statusActive') : t('admin.members.statusInvited')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      data-testid="member-remove"
                      onClick={() => setRemoveTarget(m)}
                      title={t('admin.members.removeFromOrg')}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-error-bg hover:text-error-text"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="flex justify-center border-t border-line p-3">
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t('admin.members.loading') : t('admin.members.loadMore')}
              </Button>
            </div>
          )}
        </SectionCard>
      )}

      {removeTarget && (
        <RemoveMemberModal
          orgId={orgId}
          member={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            setMembers((prev) => prev.filter((m) => m.userId !== removeTarget.userId))
            setRemoveTarget(null)
          }}
        />
      )}
    </div>
  )
}

function RemoveMemberModal({
  orgId,
  member,
  onClose,
  onRemoved,
}: {
  orgId: string
  member: api.OrgMember
  onClose: () => void
  onRemoved: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.removeMember(orgId, member.userId)
      onRemoved()
    } catch (err) {
      if (err instanceof api.OrgAdminApiError && err.code === 'last-admin') {
        setError(t('admin.members.lastAdminRemoveError'))
      } else {
        setError(err instanceof Error ? err.message : t('admin.members.failedToRemove'))
      }
      setBusy(false)
    }
  }

  return (
    <TypedConfirmModal
      title={t('admin.members.removeMemberTitle')}
      description={
        <>
          {t('admin.members.removeMemberDescriptionPrefix')} <span className="font-medium text-fg">{member.email}</span>{' '}
          {t('admin.members.removeMemberDescriptionSuffix')}
        </>
      }
      expected={member.email}
      confirmLabel={t('admin.members.remove')}
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={onClose}
      testidPrefix="member-remove"
    />
  )
}

// ── Invites ───────────────────────────────────────────────────────────────

/** Checkbox dropdown for a pending invite's pre-assigned teams — commits every
 * toggle immediately via `onToggle`. */
function TeamMultiSelect({
  allTeams,
  selectedIds,
  onToggle,
  disabled,
}: {
  allTeams: api.OrgTeam[]
  selectedIds: string[]
  onToggle: (teamId: string, nowSelected: boolean) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const live = allTeams.filter((team) => !team.archivedAt)

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        data-testid="invite-teams-edit"
        disabled={disabled || live.length === 0}
        onClick={() => setOpen((v) => !v)}
        title={live.length === 0 ? t('admin.members.noTeamsYet') : t('admin.members.editPreAssignedTeams')}
        className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
      >
        {t('admin.members.edit')}
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-40 w-52 rounded-lg border border-line bg-surface-100 p-1.5 shadow-xl">
          {live.map((team) => {
            const checked = selectedIds.includes(team.id)
            return (
              <label
                key={team.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(team.id, !checked)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1 truncate">{team.name}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

function InvitesTab({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const [invites, setInvites] = useState<api.OrgInvite[]>([])
  const [allTeams, setAllTeams] = useState<api.OrgTeam[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = () => {
    setStatus('loading')
    Promise.all([api.getInvites(orgId), api.getTeams(orgId)])
      .then(([page, teams]) => {
        setInvites(page.invites)
        setNextCursor(page.nextCursor)
        setAllTeams(teams.teams)
        setStatus('ok')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('admin.members.failedToLoadInvites'))
        setStatus('error')
      })
  }

  // t is only read for the rare non-Error fallback message; refetching from the server on
  // every language switch would be wasteful.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [orgId])

  const handleRoleChange = async (invite: api.OrgInvite, role: 'admin' | 'member') => {
    setSavingId(invite.id)
    setError(null)
    try {
      await api.updateInvite(orgId, invite.id, { role })
      setInvites((prev) => prev.map((i) => (i.id === invite.id ? { ...i, role } : i)))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.members.failedToUpdateInvite'))
    } finally {
      setSavingId(null)
    }
  }

  const handleTeamToggle = async (invite: api.OrgInvite, teamId: string, nowSelected: boolean) => {
    const nextIds = nowSelected
      ? [...invite.teams.map((team) => team.id), teamId]
      : invite.teams.map((team) => team.id).filter((id) => id !== teamId)
    setSavingId(invite.id)
    setError(null)
    try {
      await api.updateInvite(orgId, invite.id, { teamIds: nextIds })
      const nextTeams = allTeams.filter((team) => nextIds.includes(team.id)).map((team) => ({ id: team.id, name: team.name }))
      setInvites((prev) => prev.map((i) => (i.id === invite.id ? { ...i, teams: nextTeams } : i)))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.members.failedToUpdateInviteTeams'))
    } finally {
      setSavingId(null)
    }
  }

  const loadMore = () => {
    if (!nextCursor) return
    api
      .getInvites(orgId, { after: nextCursor })
      .then((page) => {
        setInvites((prev) => [...prev, ...page.invites])
        setNextCursor(page.nextCursor)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('admin.members.failedToLoadMoreInvites')))
  }

  const handleRevoke = async (invite: api.OrgInvite) => {
    setRevokingId(invite.id)
    try {
      await api.revokeInvite(orgId, invite.id)
      setInvites((prev) => prev.filter((i) => i.id !== invite.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.members.failedToRevokeInvite'))
    } finally {
      setRevokingId(null)
    }
  }

  if (status === 'error') return <InlineError message={error ?? t('admin.members.failedToLoadInvites')} onRetry={load} />
  if (status === 'loading') return <SkeletonRows rows={4} />
  if (invites.length === 0)
    return <EmptyState title={t('admin.members.noPendingInvites')} description={t('admin.members.noPendingInvitesDescription')} />

  return (
    <SectionCard>
      {error && (
        <div className="border-b border-line bg-error-bg px-4 py-2 text-[12.5px] text-error-text">{error}</div>
      )}
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fg-subtle">
            <th className="px-4 py-2.5 font-medium">{t('admin.members.columnEmail')}</th>
            <th className="px-4 py-2.5 font-medium">{t('admin.members.columnRole')}</th>
            <th className="px-4 py-2.5 font-medium">{t('admin.members.columnTeams')}</th>
            <th className="px-4 py-2.5 font-medium">{t('admin.members.columnExpires')}</th>
            <th className="px-4 py-2.5 font-medium" />
          </tr>
        </thead>
        <tbody>
          {invites.map((inv) => (
            <tr key={inv.id} className="border-b border-line last:border-0">
              <td className="px-4 py-3 text-fg">{inv.email}</td>
              <td className="px-4 py-3">
                <select
                  data-testid="invite-row-role"
                  value={inv.role}
                  disabled={savingId === inv.id}
                  onChange={(e) => void handleRoleChange(inv, e.target.value as 'admin' | 'member')}
                  className="h-7 rounded-md border border-line bg-surface-50 px-2 text-[12.5px] text-fg outline-none focus:border-accent disabled:opacity-40"
                >
                  <option value="member">{t('admin.members.roleMember')}</option>
                  <option value="admin">{t('admin.members.roleAdmin')}</option>
                </select>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-1">
                  {inv.teams.map((team) => (
                    <Chip key={team.id}>{team.name}</Chip>
                  ))}
                  {inv.teams.length === 0 && <span className="text-[12px] text-fg-subtle">—</span>}
                  <TeamMultiSelect
                    allTeams={allTeams}
                    selectedIds={inv.teams.map((team) => team.id)}
                    onToggle={(teamId, nowSelected) => void handleTeamToggle(inv, teamId, nowSelected)}
                    disabled={savingId === inv.id}
                  />
                </div>
              </td>
              <td className="px-4 py-3 text-fg-secondary">
                {inv.expired ? <span className="text-error-text">{t('admin.members.expired')}</span> : timeAgo(inv.expiresAt)}
              </td>
              <td className="px-4 py-3 text-right">
                <Button
                  data-testid="invite-revoke"
                  variant="secondary"
                  size="sm"
                  disabled={revokingId === inv.id}
                  onClick={() => handleRevoke(inv)}
                >
                  {revokingId === inv.id ? t('admin.members.revoking') : t('admin.members.revoke')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {nextCursor && (
        <div className="flex justify-center border-t border-line p-3">
          <Button variant="secondary" size="sm" onClick={loadMore}>
            {t('admin.members.loadMore')}
          </Button>
        </div>
      )}
    </SectionCard>
  )
}

// ── Invite dialog ───────────────────────────────────────────────────────────

function InviteDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [teams, setTeams] = useState<api.OrgTeam[]>([])
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ acceptUrl: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .getTeams(orgId)
      .then((page) => {
        if (!cancelled) setTeams(page.teams.filter((team) => !team.archivedAt))
      })
      .catch(() => {
        // Teams unavailable — the invite still works, just without pre-assignment.
      })
    return () => {
      cancelled = true
    }
  }, [orgId])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.createInvite(orgId, email.trim(), role, teamIds)
      setResult({ acceptUrl: res.acceptUrl })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.members.failedToSendInvite'))
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.acceptUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable — the link is still visible/selectable in the field.
    }
  }

  return (
    <Modal title={t('admin.members.inviteMember')} onClose={onClose} data-testid="invite-dialog">
      {!result ? (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-fg-secondary">{t('admin.members.email')}</label>
              <input
                ref={inputRef}
                data-testid="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                className="h-9 w-full rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-fg-secondary">{t('admin.members.role')}</label>
              <select
                data-testid="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
                className="h-9 w-full rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="member">{t('admin.members.roleMember')}</option>
                <option value="admin">{t('admin.members.roleAdmin')}</option>
              </select>
            </div>
            {teams.length > 0 && (
              <div>
                <label className="mb-1 block text-[12px] font-medium text-fg-secondary">{t('admin.members.columnTeams')}</label>
                <p className="mb-1.5 text-[11.5px] text-fg-subtle">{t('admin.members.teamsAppliedNote')}</p>
                <div className="max-h-36 overflow-y-auto rounded-md border border-line bg-surface-50 p-1.5">
                  {teams.map((team) => {
                    const checked = teamIds.includes(team.id)
                    return (
                      <label
                        key={team.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover"
                      >
                        <input
                          type="checkbox"
                          data-testid={`invite-team-${team.id}`}
                          checked={checked}
                          onChange={() =>
                            setTeamIds((prev) => (checked ? prev.filter((id) => id !== team.id) : [...prev, team.id]))
                          }
                          className="accent-[var(--color-accent)]"
                        />
                        <span className="min-w-0 flex-1 truncate">{team.name}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
            {error && <p className="text-[12px] text-error-text">{error}</p>}
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" data-testid="invite-submit" variant="primary" size="sm" disabled={busy}>
                {busy ? t('admin.members.sending') : t('admin.members.sendInvite')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-fg-secondary">
              <Trans i18nKey="admin.members.inviteSentTo" values={{ email }}>
                {/* react-i18next's {{var}} children-interpolation marker isn't typed for a nested
                    DOM element's children (only Trans's own children type special-cases it) —
                    the cast is TS-only, runtime parsing is unaffected. */}
                Invite sent to <span className="font-medium text-fg">{{ email } as unknown as string}</span>. It was also emailed to them — here's the
                link in case you want to share it directly:
              </Trans>
            </p>
            <div className="flex items-center gap-2">
              <input
                data-testid="invite-accept-url"
                readOnly
                value={result.acceptUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 flex-1 rounded-md border border-line bg-surface-50 px-3 text-[12px] text-fg outline-none"
              />
              <Button variant="secondary" size="sm" onClick={handleCopy} className="gap-1.5">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? t('admin.members.copied') : t('admin.members.copy')}
              </Button>
            </div>
            <div className="mt-2 flex justify-end">
              <Button variant="primary" size="sm" onClick={onClose}>
                {t('admin.members.done')}
              </Button>
            </div>
          </div>
        )}
    </Modal>
  )
}
