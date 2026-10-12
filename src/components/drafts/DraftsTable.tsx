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

import { useState, useMemo, useEffect } from 'react'
import {
  GitBranch,
  MoreHorizontal,
  Archive,
  Trash2,
  RotateCcw,
  FolderOpen,
  Plus,
  Pencil,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useDraftsStore } from '../../stores/draftsStore'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { cn } from '../../lib/utils'
import { DraftStatusBadge } from './DraftStatusBadge'
import * as api from '../../lib/drafts/api'
import type { DraftInfo } from '../../lib/drafts/api'
import {
  WorkspaceShell,
  WorkspacePill,
  PageColumnHeader,
  ShellRightPanel,
  ShellFieldRow,
  ShellSection,
} from '../layout/WorkspaceShell'

const ROW_GRID = 'minmax(150px, 1.6fr) 110px 130px'

// Change-kind → the kit's activity pill (icon + tone).
const changePill = (t: TFunction): Record<api.ChangeKind, { label: string; icon: React.ElementType; cls: string }> => ({
  created: { label: t('drafts.pill.added'), icon: Plus, cls: 'bg-success-bg text-success-text' },
  updated: { label: t('drafts.pill.edited'), icon: Pencil, cls: 'bg-warning-bg text-warning-text' },
  deleted: { label: t('drafts.pill.removed'), icon: Trash2, cls: 'bg-error-bg text-error-text' },
})

/** Drafts — the landscape's draft table on the shared WorkspaceShell. Selecting
 * a row shows the draft's 3-way changes in the details panel; opening switches
 * the workspace into the draft (unchanged flow). */
export function DraftsTable() {
  const { t, i18n } = useTranslation()
  const landscapeId = useWorkspaceStore((s) => s.ref.landscapeId)
  const landscapes = useWorkspaceStore((s) => s.landscapes)
  const drafts = useDraftsStore((s) => s.drafts)
  const loading = useDraftsStore((s) => s.loading)
  const busy = useDraftsStore((s) => s.busy)
  const error = useDraftsStore((s) => s.error)
  const clearError = useDraftsStore((s) => s.clearError)
  const load = useDraftsStore((s) => s.load)
  const create = useDraftsStore((s) => s.create)
  const open = useDraftsStore((s) => s.open)
  const setStatus = useDraftsStore((s) => s.setStatus)
  const setCurrentView = useUIStore((s) => s.setCurrentView)
  // A draft is a forked version, so creating/archiving/deleting one needs write
  // on the landscape — the server 403s these for a view-only session. Hide the
  // controls to match (enforcement is server-side regardless).
  const canManage = !useModelStore((s) => s.workspaceReadOnly)

  const [searchQuery, setSearchQuery] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The SELECTED draft's changes (page-local — the drafts store's `changes`
  // belongs to the ACTIVE draft and guards against exactly this kind of reuse).
  const [selChanges, setSelChanges] = useState<api.DraftChanges | null>(null)
  const [selChangesFor, setSelChangesFor] = useState<string | null>(null)

  // Load drafts for the active landscape (and whenever it changes).
  useEffect(() => {
    load(landscapeId)
  }, [landscapeId, load])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return q ? drafts.filter((d) => d.label.toLowerCase().includes(q)) : drafts
  }, [drafts, searchQuery])

  const selected = drafts.find((d) => d.id === selectedId) ?? null

  // Fetch the selected draft's 3-way diff for the panel (latest request wins).
  useEffect(() => {
    if (!selected) {
      setSelChanges(null)
      setSelChangesFor(null)
      return
    }
    let cancelled = false
    setSelChanges(null)
    setSelChangesFor(null)
    api
      .getDraftChanges(selected.landscapeId, selected.id)
      .then((c) => {
        if (!cancelled) {
          setSelChanges(c)
          setSelChangesFor(selected.id)
        }
      })
      .catch(() => {
        /* offline / merged draft — the panel just shows no changes list */
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const goToCanvas = () => {
    setCurrentView('diagram')
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name || busy) return
    const draft = await create(landscapeId, name)
    if (draft) {
      setNewName('')
      setNewOpen(false)
      goToCanvas()
    }
  }

  const handleOpen = async (d: DraftInfo) => {
    setOpenMenuId(null)
    await open(d)
    goToCanvas()
  }

  const fmtDate = (iso: string) => {
    const d = new Date(iso)
    return isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  const parentLabel = (d: DraftInfo) => {
    const versions = landscapes.find((l) => l.id === d.landscapeId)?.versions ?? []
    return versions.find((v) => v.id === d.parentVersionId)?.label ?? t('drafts.table.current')
  }

  const newDraftPopover = newOpen && (
    <div className="relative mt-2">
      <div className="fixed inset-0" onClick={() => setNewOpen(false)} />
      <div className="relative z-10 w-[260px] rounded-lg border border-line bg-surface-100 p-3 shadow-xl">
        <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
          {t('drafts.table.draftName')}
        </label>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate()
            if (e.key === 'Escape') setNewOpen(false)
          }}
          placeholder={t('drafts.table.draftNamePlaceholder')}
          autoFocus
          className="w-full rounded border border-line bg-surface-50 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button
          data-testid="create-draft-confirm"
          onClick={() => void handleCreate()}
          disabled={!newName.trim() || busy}
          className="mt-2 w-full rounded-[10px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-text transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? t('drafts.table.creating') : t('drafts.table.createDraft')}
        </button>
        {error && (
          <p role="alert" className="mt-2 text-[11px] leading-4 text-error-text">
            {error}
          </p>
        )}
      </div>
    </div>
  )

  const rightPanel = selected && (
    <ShellRightPanel title={t('drafts.table.draft')}>
      <div className="text-[15px] font-semibold text-fg">{selected.label}</div>
      <div className="mb-1 text-[11px] text-fg-subtle">{t('drafts.table.branchedFrom', { parent: parentLabel(selected) })}</div>
      <ShellFieldRow label={t('drafts.table.status')}>
        <DraftStatusBadge status={selected.status} />
      </ShellFieldRow>
      <ShellFieldRow label={t('drafts.table.created')}>
        <span>{fmtDate(selected.createdAt)}</span>
      </ShellFieldRow>
      <ShellFieldRow label={t('drafts.table.changes')}>
        <span className="font-mono tabular-nums">
          {selChangesFor === selected.id && selChanges
            ? selChanges.counts.model + selChanges.counts.diagrams
            : '…'}
        </span>
      </ShellFieldRow>
      {selChangesFor === selected.id && selChanges && selChanges.counts.conflicts > 0 && (
        <ShellFieldRow label={t('drafts.table.conflicts')}>
          <span className="font-mono tabular-nums text-error-text">{selChanges.counts.conflicts}</span>
        </ShellFieldRow>
      )}
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => void handleOpen(selected)}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-accent px-3 text-[12px] font-semibold text-accent-text transition-colors hover:bg-accent-hover"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t('drafts.table.openDraft')}
        </button>
        {canManage && (selected.status === 'active' ? (
          <button
            onClick={() => void setStatus(landscapeId, selected.id, 'archived')}
            title={t('drafts.table.archiveDraft')}
            className="flex h-8 items-center justify-center gap-1.5 rounded-[10px] border border-line px-3 text-[12px] font-medium text-fg-secondary transition-colors hover:bg-surface-hover"
          >
            <Archive className="h-3.5 w-3.5" />
            {t('drafts.table.archive')}
          </button>
        ) : (
          <button
            onClick={() => void setStatus(landscapeId, selected.id, 'active')}
            title={t('drafts.table.restoreDraft')}
            className="flex h-8 items-center justify-center gap-1.5 rounded-[10px] border border-line px-3 text-[12px] font-medium text-fg-secondary transition-colors hover:bg-surface-hover"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('drafts.table.restore')}
          </button>
        ))}
      </div>
      {selChangesFor === selected.id && selChanges && selChanges.changes.length > 0 && (
        <ShellSection title={t('drafts.table.changesCount', { count: selChanges.changes.length })}>
          <div className="mt-1.5">
            {selChanges.changes.map((c, i) => {
              const pill = changePill(t)[c.kind]
              const PillIcon = pill.icon
              return (
                <div key={`${c.collection}-${c.id}-${i}`} className="border-b border-line-soft py-2.5 last:border-b-0">
                  <div className="text-[12.5px] text-fg-secondary">
                    <span
                      className={cn(
                        'mr-1 inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-semibold',
                        pill.cls
                      )}
                    >
                      <PillIcon className="h-2.5 w-2.5" />
                      {pill.label}
                    </span>{' '}
                    {t(`drafts.collection.${c.collection}`)} <span className="font-medium text-fg">{c.label}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </ShellSection>
      )}
    </ShellRightPanel>
  )

  return (
    <WorkspaceShell
      active="drafts"
      pill={
        <>
          <WorkspacePill
            searchPlaceholder={t('drafts.table.searchPlaceholder')}
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            add={canManage ? {
              label: t('drafts.table.newDraft'),
              onClick: () => {
                clearError()
                setNewOpen((o) => !o)
              },
              testId: 'new-draft-button',
            } : undefined}
          />
          {canManage && newDraftPopover}
        </>
      }
      right={rightPanel || undefined}
      footer={[{ label: t('drafts.table.footerLabel'), value: filtered.length }]}
    >
      <div className="flex-1 overflow-auto">
        <div style={{ padding: '20px var(--pad-r) 28px var(--pad-l)' }}>
          <PageColumnHeader
            gridTemplate={ROW_GRID}
            cols={[{ label: t('drafts.table.colDraft') }, { label: t('drafts.table.colStatus') }, { label: t('drafts.table.colCreated') }]}
          />
          {filtered.length === 0 ? (
            <p className="py-14 text-center text-[13px] text-fg-subtle">
              {loading ? t('drafts.table.loading') : t('drafts.table.empty')}
            </p>
          ) : (
            <div className="flex flex-col">
              {filtered.map((d) => {
                const isSelected = d.id === selectedId
                return (
                  <div
                    key={d.id}
                    role="button"
                    tabIndex={0}
                    data-testid={`draft-row-${d.id}`}
                    onClick={() => setSelectedId(d.id)}
                    onDoubleClick={() => void handleOpen(d)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleOpen(d)
                    }}
                    className={cn(
                      'group grid cursor-pointer items-center gap-3 rounded-none px-2 py-2.5 text-left text-[13px] transition-colors',
                      isSelected ? 'bg-accent-subtle shadow-[inset_3px_0_0_var(--color-accent)]' : 'hover:bg-surface-50'
                    )}
                    style={{ gridTemplateColumns: `${ROW_GRID} 64px` }}
                  >
                    <span className="flex min-w-0 items-center gap-2 overflow-hidden">
                      <GitBranch className="h-[15px] w-[15px] shrink-0 text-fg-subtle" />
                      <span className={cn('truncate font-semibold', isSelected ? 'text-accent' : 'text-fg')}>
                        {d.label}
                      </span>
                    </span>
                    <span>
                      <DraftStatusBadge status={d.status} />
                    </span>
                    <span className="text-[12px] text-fg-subtle">{fmtDate(d.createdAt)}</span>
                    <span className="relative flex justify-center">
                      {canManage && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenMenuId(openMenuId === d.id ? null : d.id)
                        }}
                        className={cn(
                          'rounded p-1 text-fg-subtle transition-opacity hover:bg-surface-200 hover:text-fg-secondary',
                          openMenuId === d.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        )}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      )}
                      {openMenuId === d.id && (
                        <>
                          <div
                            className="fixed inset-0 z-10"
                            onClick={(e) => {
                              e.stopPropagation()
                              setOpenMenuId(null)
                            }}
                          />
                          <div className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-lg border border-line bg-surface-100 py-1 shadow-xl">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleOpen(d)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg-secondary hover:bg-surface-50"
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                              {t('drafts.table.openDraft')}
                            </button>
                            {d.status === 'active' && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void setStatus(landscapeId, d.id, 'archived')
                                  setOpenMenuId(null)
                                }}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg-secondary hover:bg-surface-50"
                              >
                                <Archive className="h-3.5 w-3.5" />
                                {t('drafts.table.archive')}
                              </button>
                            )}
                            {(d.status === 'archived' || d.status === 'discarded') && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void setStatus(landscapeId, d.id, 'active')
                                  setOpenMenuId(null)
                                }}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg-secondary hover:bg-surface-50"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                {t('drafts.table.restore')}
                              </button>
                            )}
                            <div className="my-1 border-t border-line" />
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                void setStatus(landscapeId, d.id, 'discarded')
                                setOpenMenuId(null)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-error-text hover:bg-error-bg"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t('common.delete')}
                            </button>
                          </div>
                        </>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </WorkspaceShell>
  )
}
