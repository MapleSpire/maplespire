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

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Mail,
  Plus,
  Trash2,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OwnerAssignment, OwnerPersonSnapshot } from '../../types'
import { useAuthStore } from '../../stores/authStore'
import {
  getMembers,
  getTeam,
  getTeams,
  type OrgMember,
  type OrgTeam,
  type TeamMember,
} from '../../lib/orgAdmin/api'
import {
  externalContactOwnerAssignment,
  platformPersonOwnerAssignment,
  teamOwnerAssignment,
} from '../../lib/owners'
import { copyToClipboard } from '../../lib/clipboard'
import { cn } from '../../lib/utils'
import { FloatingPicker } from '../ui/floating-picker'

interface OwnerEditorProps {
  assignments: readonly OwnerAssignment[]
  disabled?: boolean
  onAdd: (assignment: OwnerAssignment) => void
  onRemove: (assignmentId: string) => void
}

interface TeamDetail {
  members: TeamMember[]
  nextCursor: string | null
}

function ownerSecondary(owner: OwnerAssignment): string | null {
  if (owner.kind === 'team') return null
  return [owner.title, owner.organization, owner.email].filter(Boolean).join(' · ') || null
}

function CopyEmailButton({
  emails,
  label,
  loadEmails,
}: {
  emails: readonly string[]
  label: string
  loadEmails?: () => Promise<readonly string[]>
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const uniqueEmails = useMemo(
    () => [...new Set(emails.map((email) => email.trim()).filter(Boolean))],
    [emails],
  )

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
  }, [])

  if (uniqueEmails.length === 0 && !loadEmails) return null

  return (
    <button
      type="button"
      disabled={copying}
      onClick={(event) => {
        event.stopPropagation()
        void (async () => {
          setCopying(true)
          try {
            const resolvedEmails = uniqueEmails.length > 0
              ? uniqueEmails
              : [...new Set((await loadEmails?.() ?? []).map((email) => email.trim()).filter(Boolean))]
            if (resolvedEmails.length === 0 || !await copyToClipboard(resolvedEmails.join('; '))) return
            setCopied(true)
            if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
            resetTimerRef.current = window.setTimeout(() => setCopied(false), 1600)
          } finally {
            setCopying(false)
          }
        })()
      }}
      aria-label={copied ? t('layoutNav.rightSidebar.emailsCopied') : label}
      title={copied ? t('layoutNav.rightSidebar.emailsCopied') : label}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {copying
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        : copied
        ? <Check className="h-3.5 w-3.5 text-success-text" aria-hidden="true" />
        : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  )
}

function OwnerMemberRow({ member }: { member: OwnerPersonSnapshot }) {
  const { t } = useTranslation()
  const tooltipId = useId()
  const rowRef = useRef<HTMLLIElement>(null)
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number; side: 'left' | 'right' } | null>(null)
  const hideTooltip = useCallback(() => setTooltipPosition(null), [])
  const showTooltip = useCallback(() => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (!rect) return
    const showOnLeft = rect.left >= 280
    setTooltipPosition({
      left: showOnLeft ? rect.left - 8 : rect.right + 8,
      top: rect.top + rect.height / 2,
      side: showOnLeft ? 'left' : 'right',
    })
  }, [])

  useEffect(() => {
    if (!tooltipPosition) return
    window.addEventListener('resize', hideTooltip)
    window.addEventListener('scroll', hideTooltip, true)
    return () => {
      window.removeEventListener('resize', hideTooltip)
      window.removeEventListener('scroll', hideTooltip, true)
    }
  }, [hideTooltip, tooltipPosition])

  return (
    <>
      <li
        ref={rowRef}
        data-testid={`owner-member-${member.id}`}
        title={member.name}
        tabIndex={0}
        aria-describedby={tooltipId}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        className="flex cursor-help items-center gap-2 rounded-sm py-0.5 text-[11px] text-fg-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <UserRound className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span data-testid="owner-member-name" className="block truncate font-medium text-fg-secondary">
            {member.name}
          </span>
          {member.email && (
            <span data-testid="owner-member-email" className="block truncate text-[10px] text-fg-subtle">
              {member.email}
            </span>
          )}
        </span>
        {member.email && (
          <CopyEmailButton
            emails={[member.email]}
            label={t('layoutNav.rightSidebar.copyEmail', { email: member.email })}
          />
        )}
      </li>
      {typeof document !== 'undefined' && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          aria-hidden={tooltipPosition ? undefined : true}
          style={tooltipPosition ? {
            left: tooltipPosition.left,
            top: tooltipPosition.top,
            transform: tooltipPosition.side === 'left' ? 'translate(-100%, -50%)' : 'translateY(-50%)',
          } : undefined}
          className={`pointer-events-none fixed z-[100] w-max max-w-[260px] rounded-md bg-inverse px-2.5 py-1.5 text-[11px] font-medium leading-snug text-on-inverse shadow-lg transition-opacity ${tooltipPosition ? 'visible opacity-100' : 'invisible opacity-0'}`}
        >
          {member.name}
        </span>,
        document.body,
      )}
    </>
  )
}

export function OwnerEditor({ assignments, disabled, onAdd, onRemove }: OwnerEditorProps) {
  const { t } = useTranslation()
  const orgId = useAuthStore((state) => state.orgId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const triggerRef = useMemo(() => ({ current: trigger }), [trigger])
  const [expandedOwnerId, setExpandedOwnerId] = useState<string | null>(null)
  const [teamDetails, setTeamDetails] = useState<Record<string, TeamDetail>>({})
  const [teamNames, setTeamNames] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!orgId || assignments.every((assignment) => assignment.kind !== 'team')) return
    let cancelled = false
    void getTeams(orgId, { limit: 100 }).then((page) => {
      if (cancelled) return
      setTeamNames(Object.fromEntries(page.teams.map((team) => [team.id, team.name])))
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [assignments, orgId])

  const toggleOwner = (owner: OwnerAssignment) => {
    if (expandedOwnerId === owner.id) {
      setExpandedOwnerId(null)
      return
    }
    setExpandedOwnerId(owner.id)
    if (owner.kind !== 'team') return
    if (owner.members?.length || teamDetails[owner.id] || !orgId) return
    const teamId = owner.catalogId ?? owner.id
    void getTeam(orgId, teamId, { limit: 100 })
      .then((page) => setTeamDetails((current) => ({
        ...current,
        [owner.id]: { members: page.members, nextCursor: page.nextCursor },
      })))
      .catch(() => undefined)
  }

  return (
    <div className="space-y-2">
      {assignments.length === 0 && (
        <p className="text-[11px] text-fg-subtle">
          {t('layoutNav.rightSidebar.noOwners', { defaultValue: 'No owners assigned' })}
        </p>
      )}
      {assignments.map((owner) => {
        const detail = teamDetails[owner.id]
        const members: OwnerPersonSnapshot[] = detail
          ? detail.members.map((member) => ({
            id: member.userId,
            name: member.name?.trim() || member.email,
            email: member.email,
          }))
          : owner.members ?? []
        const label = owner.kind === 'team'
          ? teamNames[owner.catalogId ?? owner.id] ?? owner.name
          : owner.name
        const secondary = owner.kind === 'team' && owner.memberCount !== undefined
          ? t('layoutNav.rightSidebar.teamMemberCount', { count: owner.memberCount })
          : ownerSecondary(owner)
        const expanded = expandedOwnerId === owner.id
        const ownerEmails = owner.kind === 'team'
          ? members.flatMap((member) => member.email ? [member.email] : [])
          : owner.email ? [owner.email] : []
        const copyLabel = owner.kind === 'team'
          ? ownerEmails.length > 0
            ? t('layoutNav.rightSidebar.copyTeamEmails', { count: ownerEmails.length, team: label })
            : t('layoutNav.rightSidebar.copyTeamEmailsUnknown', { team: label })
          : t('layoutNav.rightSidebar.copyEmail', { email: owner.email })
        const loadOwnerEmails = owner.kind === 'team' && ownerEmails.length === 0 && orgId
          ? async () => {
            const page = await getTeam(orgId, owner.catalogId ?? owner.id, { limit: 100 })
            setTeamDetails((current) => ({
              ...current,
              [owner.id]: { members: page.members, nextCursor: page.nextCursor },
            }))
            return page.members.map((member) => member.email)
          }
          : undefined
        return (
          <div key={owner.id} className="rounded-lg border border-line bg-surface-50" data-testid={`owner-${owner.id}`}>
            <div className="flex items-center gap-2 px-2.5 py-2">
              {owner.kind === 'team'
                ? <UsersRound className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                : <UserRound className="h-4 w-4 shrink-0 text-fg-secondary" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-fg">{label}</div>
                {secondary && <div className="truncate text-[10px] text-fg-subtle">{secondary}</div>}
              </div>
              <CopyEmailButton emails={ownerEmails} label={copyLabel} loadEmails={loadOwnerEmails} />
              <button
                type="button"
                onClick={() => toggleOwner(owner)}
                aria-label={owner.kind === 'team'
                  ? t('layoutNav.rightSidebar.showTeamMembers', { defaultValue: 'Show members of {{team}}', team: label })
                  : t('layoutNav.rightSidebar.showPersonDetails', { defaultValue: 'Show details for {{person}}', person: label })}
                aria-expanded={expanded}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg"
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onRemove(owner.id)}
                  aria-label={t('layoutNav.rightSidebar.removeOwner', { defaultValue: 'Remove {{owner}}', owner: label })}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-error-bg hover:text-error-text"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
            {owner.kind === 'team' && expanded && (
              <div className="border-t border-line-soft px-3 py-2">
                {members.length > 0 ? (
                  <ul className="max-h-40 space-y-1 overflow-y-auto">
                    {members.map((member) => <OwnerMemberRow key={member.id} member={member} />)}
                  </ul>
                ) : (
                  <p className="text-[10px] text-fg-subtle">
                    {t('layoutNav.rightSidebar.noTeamMembers', { defaultValue: 'No team members available' })}
                  </p>
                )}
                {(owner.memberCount ?? members.length) > members.length && (
                  <p className="mt-1.5 text-[10px] text-fg-subtle">
                    {t('layoutNav.rightSidebar.teamMembersSnapshot', {
                      defaultValue: '{{shown}} of {{total}} members available offline',
                      shown: members.length,
                      total: owner.memberCount,
                    })}
                  </p>
                )}
              </div>
            )}
            {owner.kind === 'person' && expanded && (
              <dl className="space-y-1.5 border-t border-line-soft px-3 py-2 text-[10px]">
                {[
                  [t('layoutNav.rightSidebar.ownerName', { defaultValue: 'Name' }), owner.name],
                  [t('layoutNav.rightSidebar.ownerEmail', { defaultValue: 'Email' }), owner.email],
                  [t('layoutNav.rightSidebar.ownerTitle', { defaultValue: 'Role / title' }), owner.title],
                  [t('layoutNav.rightSidebar.ownerOrganization', { defaultValue: 'Organization' }), owner.organization],
                ].filter((field): field is [string, string] => Boolean(field[1])).map(([fieldLabel, value]) => (
                  <div key={fieldLabel} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                    <dt className="font-semibold text-fg-subtle">{fieldLabel}</dt>
                    <dd className="min-w-0 break-words text-fg-secondary">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )
      })}
      {!disabled && (
        <button
          ref={setTrigger}
          type="button"
          data-testid="owner-add"
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-1 rounded-md bg-accent-subtle px-2 py-1 text-[11px] font-semibold text-accent hover:bg-surface-hover"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('layoutNav.rightSidebar.addOwner', { defaultValue: 'Add owner' })}
        </button>
      )}
      <OwnerPickerModal
        isOpen={pickerOpen}
        assignedOwnerIds={assignments.map((assignment) => assignment.id)}
        triggerRef={triggerRef}
        onClose={() => setPickerOpen(false)}
        onSelect={(assignment) => {
          onAdd(assignment)
          setPickerOpen(false)
        }}
      />
    </div>
  )
}

export function OwnerPickerModal({
  isOpen,
  assignedOwnerIds,
  onClose,
  onSelect,
  triggerRef,
}: {
  isOpen: boolean
  assignedOwnerIds: readonly string[]
  onClose: () => void
  onSelect: (assignment: OwnerAssignment) => void
  triggerRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const orgId = useAuthStore((state) => state.orgId)
  const [mode, setMode] = useState<'teams' | 'people' | 'contact'>('teams')
  const [query, setQuery] = useState('')
  const [teams, setTeams] = useState<OrgTeam[]>([])
  const [people, setPeople] = useState<OrgMember[]>([])
  const [teamDetails, setTeamDetails] = useState<Record<string, TeamDetail>>({})
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [addingId, setAddingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contact, setContact] = useState({ name: '', email: '', title: '', organization: '' })
  const assigned = useMemo(() => new Set(assignedOwnerIds), [assignedOwnerIds])

  useEffect(() => {
    if (!isOpen || !orgId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.all([
      getTeams(orgId, { limit: 100 }),
      getMembers(orgId, { q: query.trim() || undefined, limit: 100 }),
    ]).then(([teamPage, memberPage]) => {
      if (cancelled) return
      setTeams(teamPage.teams.filter((team) => !team.archivedAt))
      setPeople(memberPage.members)
    }).catch(() => {
      if (!cancelled) setError(t('layoutNav.rightSidebar.ownersUnavailable', { defaultValue: 'Organization owners are unavailable. Saved owners remain editable offline.' }))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, orgId, query, t])

  if (!isOpen) return null

  const inspectTeam = (team: OrgTeam) => {
    if (expandedTeamId === team.id) {
      setExpandedTeamId(null)
      return
    }
    setExpandedTeamId(team.id)
    if (teamDetails[team.id] || !orgId) return
    void getTeam(orgId, team.id, { limit: 100 })
      .then((page) => setTeamDetails((current) => ({
        ...current,
        [team.id]: { members: page.members, nextCursor: page.nextCursor },
      })))
      .catch(() => setError(t('layoutNav.rightSidebar.teamMembersUnavailable', { defaultValue: 'Unable to load team members.' })))
  }

  const selectTeam = (team: OrgTeam) => {
    if (assigned.has(team.id) || !orgId) return
    const cached = teamDetails[team.id]
    if (cached) {
      onSelect(teamOwnerAssignment(team, cached.members))
      return
    }
    setAddingId(team.id)
    void getTeam(orgId, team.id, { limit: 100 })
      .then((page) => onSelect(teamOwnerAssignment(team, page.members)))
      .catch(() => onSelect(teamOwnerAssignment(team)))
      .finally(() => setAddingId(null))
  }

  const submitContact = (event: FormEvent) => {
    event.preventDefault()
    if (!contact.name.trim()) return
    onSelect(externalContactOwnerAssignment(contact))
  }

  const filteredTeams = teams.filter((team) => team.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  return (
    <FloatingPicker
      isOpen
      title={t('layoutNav.rightSidebar.chooseOwner', { defaultValue: 'Choose an owner' })}
      onClose={onClose}
      triggerRef={triggerRef}
      className="w-[620px] max-w-[calc(100vw-32px)]"
      testId="owner-picker"
    >
      <div className="flex border-b border-line px-4 pt-2">
        {(['teams', 'people', 'contact'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={cn(
              'border-b-2 px-3 py-2 text-[11px] font-semibold',
              mode === value ? 'border-accent text-accent' : 'border-transparent text-fg-subtle hover:text-fg',
            )}
          >
            {t(`layoutNav.rightSidebar.ownerMode.${value}`, { defaultValue: value })}
          </button>
        ))}
      </div>
      {mode !== 'contact' && (
        <label className="mx-4 mt-3 block">
          <span className="sr-only">{t('layoutNav.rightSidebar.searchOwners', { defaultValue: 'Search owners' })}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('layoutNav.rightSidebar.searchOwners', { defaultValue: 'Search owners' })}
            className="h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px] text-fg outline-none focus:border-accent"
          />
        </label>
      )}
      {error && <p role="alert" className="mx-4 mt-2 text-[11px] text-error-text">{error}</p>}
      {loading && mode !== 'contact' && <p className="p-4 text-[12px] text-fg-subtle">{t('common.loading', { defaultValue: 'Loading…' })}</p>}
      {!loading && mode === 'teams' && (
        <div className="max-h-[420px] overflow-y-auto p-3">
          {filteredTeams.map((team) => {
            const detail = teamDetails[team.id]
            return (
              <div key={team.id} className="mb-1 rounded-lg border border-line-soft bg-surface-50">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => selectTeam(team)}
                    disabled={assigned.has(team.id) || addingId === team.id}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover disabled:opacity-50"
                  >
                    <UsersRound className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg">{team.name}</span>
                    <span className="text-[10px] text-fg-subtle">{team.memberCount}</span>
                    {assigned.has(team.id) && <span className="text-[10px] text-accent">{t('layoutNav.rightSidebar.assigned')}</span>}
                  </button>
                  <button
                    type="button"
                    onClick={() => inspectTeam(team)}
                    aria-label={t('layoutNav.rightSidebar.showTeamMembers', { defaultValue: 'Show members of {{team}}', team: team.name })}
                    aria-expanded={expandedTeamId === team.id}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200"
                  >
                    {expandedTeamId === team.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                </div>
                {expandedTeamId === team.id && (
                  <div className="border-t border-line-soft px-4 py-2">
                    {detail && (
                      <ul className="space-y-1">
                        {detail.members.map((member) => (
                          <OwnerMemberRow
                            key={member.userId}
                            member={{ id: member.userId, name: member.name?.trim() || member.email, email: member.email }}
                          />
                        ))}
                      </ul>
                    )}
                    {!detail && <p className="text-[10px] text-fg-subtle">{t('common.loading', { defaultValue: 'Loading…' })}</p>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {!loading && mode === 'people' && (
        <div className="max-h-[420px] overflow-y-auto p-3">
          {people.map((person) => {
            const id = `user:${person.userId}`
            return (
              <button
                key={person.userId}
                type="button"
                disabled={assigned.has(id)}
                onClick={() => onSelect(platformPersonOwnerAssignment(person))}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-hover disabled:opacity-50"
              >
                <UserRound className="h-4 w-4 shrink-0 text-fg-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-fg">{person.name?.trim() || person.email}</span>
                  <span className="block truncate text-[10px] text-fg-subtle">{person.email}</span>
                </span>
                {assigned.has(id) && <span className="text-[10px] text-accent">{t('layoutNav.rightSidebar.assigned')}</span>}
              </button>
            )
          })}
        </div>
      )}
      {mode === 'contact' && (
        <form className="grid grid-cols-2 gap-3 p-4" onSubmit={submitContact}>
          <label className="col-span-2 text-[11px] font-semibold text-fg-secondary">
            {t('layoutNav.rightSidebar.ownerName', { defaultValue: 'Name' })}
            <input
              autoFocus
              required
              value={contact.name}
              onChange={(event) => setContact((current) => ({ ...current, name: event.target.value }))}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px]"
            />
          </label>
          <label className="text-[11px] font-semibold text-fg-secondary">
            <Mail className="mr-1 inline h-3 w-3" />
            {t('layoutNav.rightSidebar.ownerEmail', { defaultValue: 'Email' })}
            <input
              type="email"
              value={contact.email}
              onChange={(event) => setContact((current) => ({ ...current, email: event.target.value }))}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px]"
            />
          </label>
          <label className="text-[11px] font-semibold text-fg-secondary">
            {t('layoutNav.rightSidebar.ownerTitle', { defaultValue: 'Role / title' })}
            <input
              value={contact.title}
              onChange={(event) => setContact((current) => ({ ...current, title: event.target.value }))}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px]"
            />
          </label>
          <label className="col-span-2 text-[11px] font-semibold text-fg-secondary">
            <Building2 className="mr-1 inline h-3 w-3" />
            {t('layoutNav.rightSidebar.ownerOrganization', { defaultValue: 'Organization' })}
            <input
              value={contact.organization}
              onChange={(event) => setContact((current) => ({ ...current, organization: event.target.value }))}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px]"
            />
          </label>
          <div className="col-span-2 flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[11px] text-fg-secondary hover:bg-surface-hover">
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button type="submit" disabled={!contact.name.trim()} className="rounded-lg bg-accent px-3 py-2 text-[11px] font-semibold text-accent-text disabled:opacity-50">
              {t('layoutNav.rightSidebar.addOwner', { defaultValue: 'Add owner' })}
            </button>
          </div>
        </form>
      )}
    </FloatingPicker>
  )
}
