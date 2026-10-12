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
import { Archive, ArchiveRestore, Check, Pencil, Plus, UserMinus, UserPlus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import * as api from '../../lib/orgAdmin/api'
import { Button } from '../ui/button'
import { InlineError, SkeletonRows, EmptyState, SectionCard } from './shared'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'

/** Teams: create/rename/archive + a member-management drawer per team. */
export function AdminTeams() {
  const { orgId } = useParams({ from: '/org/$orgId/admin/teams' })
  const { t } = useTranslation()
  const [teams, setTeams] = useState<api.OrgTeam[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [openTeamId, setOpenTeamId] = useState<string | null>(null)

  const load = () => {
    setStatus('loading')
    api
      .getTeams(orgId)
      .then((page) => {
        setTeams(page.teams)
        setNextCursor(page.nextCursor)
        setStatus('ok')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('admin.teams.failedToLoad'))
        setStatus('error')
      })
  }

  // t is only read for the rare non-Error fallback message; refetching from the server on
  // every language switch would be wasteful.
  useEffect(() => {
    const timeout = window.setTimeout(load, 0)
    return () => window.clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

  const loadMore = () => {
    if (!nextCursor) return
    api
      .getTeams(orgId, { after: nextCursor })
      .then((page) => {
        setTeams((prev) => [...prev, ...page.teams])
        setNextCursor(page.nextCursor)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('admin.teams.failedToLoadMore')))
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim() || creating) return
    setCreating(true)
    setError(null)
    try {
      const team = await api.createTeam(orgId, newName.trim())
      setTeams((prev) => [...prev, team])
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.teams.failedToCreate'))
    } finally {
      setCreating(false)
    }
  }

  const handleRenameSubmit = async (team: api.OrgTeam) => {
    if (!renameValue.trim() || renameValue === team.name) {
      setRenamingId(null)
      return
    }
    setBusyId(team.id)
    try {
      const updated = await api.updateTeam(orgId, team.id, { name: renameValue.trim() })
      setTeams((prev) => prev.map((existing) => (existing.id === team.id ? { ...existing, name: updated.name } : existing)))
      setRenamingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.teams.failedToRename'))
    } finally {
      setBusyId(null)
    }
  }

  const handleArchiveToggle = async (team: api.OrgTeam) => {
    setBusyId(team.id)
    try {
      const updated = await api.updateTeam(orgId, team.id, { archived: !team.archivedAt })
      setTeams((prev) => prev.map((existing) => (existing.id === team.id ? { ...existing, archivedAt: updated.archivedAt } : existing)))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.teams.failedToUpdate'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div data-testid="admin-teams" className="mx-auto max-w-5xl px-8 py-8">
      <h1 className="mb-1 text-[20px] font-semibold text-fg">{t('admin.teams.title')}</h1>
      <p className="mb-6 text-[13px] text-fg-secondary">{t('admin.teams.subtitle')}</p>

      <form onSubmit={handleCreate} className="mb-4 flex items-center gap-2">
        <input
          data-testid="team-create-name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('admin.teams.newTeamNamePlaceholder')}
          className="h-9 w-full max-w-[280px] rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <Button type="submit" data-testid="team-create-submit" variant="primary" size="md" disabled={creating || !newName.trim()} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          {creating ? t('admin.teams.creating') : t('admin.teams.createTeam')}
        </Button>
      </form>

      {error && <div className="mb-3"><InlineError message={error} onRetry={load} /></div>}

      {status === 'loading' && <SkeletonRows rows={5} />}

      {status === 'ok' && teams.length === 0 && (
        <EmptyState title={t('admin.teams.noTeamsYet')} description={t('admin.teams.noTeamsDescription')} />
      )}

      {status === 'ok' && teams.length > 0 && (
        <SectionCard>
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fg-subtle">
                <th className="px-4 py-2.5 font-medium">{t('admin.teams.columnName')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.teams.columnMembers')}</th>
                <th className="px-4 py-2.5 font-medium">{t('admin.teams.columnStatus')}</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.id} data-testid="team-row" className="border-b border-line last:border-0">
                  <td className="px-4 py-3">
                    {renamingId === team.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameSubmit(team)
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          className="h-7 w-full max-w-[200px] rounded-md border border-line bg-surface-50 px-2 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                        />
                        <button
                          onClick={() => handleRenameSubmit(team)}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-success-text hover:bg-success-bg"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setRenamingId(null)}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-hover"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        data-testid="team-open"
                        onClick={() => setOpenTeamId(team.id)}
                        className="font-medium text-fg hover:text-accent hover:underline"
                      >
                        {team.name}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-fg-secondary">{team.memberCount}</td>
                  <td className="px-4 py-3">
                    {team.archivedAt ? (
                      <span className="inline-flex rounded-full bg-surface-200 px-2 py-0.5 text-[11px] font-medium text-fg-subtle">
                        {t('admin.teams.archived')}
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success-text">
                        {t('admin.teams.active')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {renamingId !== team.id && (
                        <button
                          onClick={() => {
                            setRenamingId(team.id)
                            setRenameValue(team.name)
                          }}
                          title={t('admin.teams.rename')}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        data-testid="team-archive"
                        onClick={() => handleArchiveToggle(team)}
                        disabled={busyId === team.id}
                        title={team.archivedAt ? t('admin.teams.unarchive') : t('admin.teams.archive')}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover disabled:opacity-50"
                      >
                        {team.archivedAt ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="flex justify-center border-t border-line p-3">
              <Button variant="secondary" size="sm" onClick={loadMore}>
                {t('admin.teams.loadMore')}
              </Button>
            </div>
          )}
        </SectionCard>
      )}

      {openTeamId && (
        <TeamDrawer
          orgId={orgId}
          teamId={openTeamId}
          onClose={() => setOpenTeamId(null)}
          onMemberCountChange={(delta) =>
            setTeams((prev) => prev.map((team) => (team.id === openTeamId ? { ...team, memberCount: team.memberCount + delta } : team)))
          }
        />
      )}
    </div>
  )
}

// ── Team detail drawer ──────────────────────────────────────────────────────

function TeamDrawer({
  orgId,
  teamId,
  onClose,
  onMemberCountChange,
}: {
  orgId: string
  teamId: string
  onClose: () => void
  onMemberCountChange: (delta: number) => void
}) {
  const { t } = useTranslation()
  const [teamMembers, setTeamMembers] = useState<api.TeamMember[]>([])
  const [teamNextCursor, setTeamNextCursor] = useState<string | null>(null)
  const [loadedTeamId, setLoadedTeamId] = useState<string | null>(null)
  const [loadingMoreMembers, setLoadingMoreMembers] = useState(false)
  const [candidates, setCandidates] = useState<api.OrgMember[]>([])
  const [loadedCandidateKey, setLoadedCandidateKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query, 180)
  const candidateKey = `${teamId}\u0000${debouncedQuery.trim()}`
  const membersLoaded = loadedTeamId === teamId
  const candidatesLoaded = loadedCandidateKey === candidateKey
  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Current members and candidates are independent server-paged windows. A
  // 10k-member enterprise team never becomes a 10k-element React state copy.
  useEffect(() => {
    let cancelled = false
    api
      .getTeam(orgId, teamId, { limit: 100 })
      .then((page) => {
        if (cancelled) return
        setTeamMembers(page.members)
        setTeamNextCursor(page.nextCursor)
        setLoadedTeamId(teamId)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load team members')
      })
    return () => { cancelled = true }
  }, [orgId, teamId])

  useEffect(() => {
    let cancelled = false
    api.getMembers(orgId, {
      q: debouncedQuery.trim() || undefined,
      excludeTeamId: teamId,
      limit: 50,
    }).then((page) => {
      if (cancelled) return
      setCandidates(page.members)
      setLoadedCandidateKey(candidateKey)
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load organization members')
    })
    return () => { cancelled = true }
  }, [candidateKey, debouncedQuery, orgId, teamId])

  const loadMoreMembers = async () => {
    if (!teamNextCursor || loadingMoreMembers) return
    setLoadingMoreMembers(true)
    try {
      const page = await api.getTeam(orgId, teamId, { after: teamNextCursor, limit: 100 })
      setTeamMembers((previous) => {
        const known = new Set(previous.map((member) => member.userId))
        return [...previous, ...page.members.filter((member) => !known.has(member.userId))]
      })
      setTeamNextCursor(page.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.teams.failedToLoadMembers'))
    } finally {
      setLoadingMoreMembers(false)
    }
  }

  const handleAdd = async (member: api.OrgMember) => {
    setBusyUserId(member.userId)
    setError(null)
    try {
      await api.addTeamMember(orgId, teamId, member.userId)
      setTeamMembers((previous) => [...previous, {
        userId: member.userId,
        email: member.email,
        name: member.name,
      }])
      setCandidates((previous) => previous.filter((candidate) => candidate.userId !== member.userId))
      onMemberCountChange(1)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.teams.failedToAddMember'))
    } finally {
      setBusyUserId(null)
    }
  }

  const handleRemove = async (member: api.TeamMember) => {
    setBusyUserId(member.userId)
    setError(null)
    try {
      await api.removeTeamMember(orgId, teamId, member.userId)
      setTeamMembers((previous) => previous.filter((existing) => existing.userId !== member.userId))
      onMemberCountChange(-1)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.teams.failedToRemoveMember'))
    } finally {
      setBusyUserId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-modal-backdrop">
      <div className="flex h-full w-full max-w-[420px] flex-col border-l border-line bg-surface-100 shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-semibold text-fg">{t('admin.teams.teamMembers')}</h2>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-hover">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && <div className="mb-3"><InlineError message={error} onRetry={() => setError(null)} /></div>}

          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{t('admin.teams.currentMembers')}</h3>
          {!membersLoaded ? (
            <SkeletonRows rows={3} />
          ) : teamMembers.length === 0 ? (
            <p className="mb-4 text-[12.5px] text-fg-subtle">{t('admin.teams.noMembersYet')}</p>
          ) : (
            <ul className="mb-5 flex flex-col gap-1">
              {teamMembers.map((m) => (
                <li key={m.userId} data-testid="team-member-row" className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface-hover">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-fg">{m.name ?? m.email}</p>
                    {m.name && <p className="truncate text-[11px] text-fg-subtle">{m.email}</p>}
                  </div>
                  <button
                    onClick={() => handleRemove(m)}
                    disabled={busyUserId === m.userId}
                    title={t('admin.teams.removeFromTeam')}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-error-bg hover:text-error-text disabled:opacity-50"
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {teamNextCursor && (
            <Button
              data-testid="team-members-load-more"
              variant="secondary"
              size="sm"
              onClick={loadMoreMembers}
              disabled={loadingMoreMembers}
              className="mb-5"
            >
              {loadingMoreMembers ? t('admin.members.loading') : t('admin.members.loadMore')}
            </Button>
          )}

          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{t('admin.teams.addMembers')}</h3>
          <input
            data-testid="admin-add-member-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('admin.teams.searchOrgMembersPlaceholder')}
            className="mb-2 h-8 w-full rounded-md border border-line bg-surface-50 px-3 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <ul className="flex flex-col gap-1">
            {(candidatesLoaded ? candidates : []).map((m) => (
              <li key={m.userId} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface-hover">
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-fg">{m.name ?? m.email}</p>
                  {m.name && <p className="truncate text-[11px] text-fg-subtle">{m.email}</p>}
                </div>
                <button
                  data-testid="team-add-member"
                  onClick={() => handleAdd(m)}
                  disabled={busyUserId === m.userId}
                  title={t('admin.teams.addToTeam')}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-accent-subtle hover:text-accent disabled:opacity-50"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            {candidatesLoaded && candidates.length === 0 && <p className="px-2 py-1.5 text-[12px] text-fg-subtle">{t('admin.teams.noMatches')}</p>}
          </ul>
        </div>
      </div>
    </div>
  )
}
