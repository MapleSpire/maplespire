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
import { X, Plus, Pencil, Trash2, AlertTriangle, RefreshCw, GitMerge, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import { useDraftsStore } from '../../stores/draftsStore'
import { useUIStore } from '../../stores/uiStore'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { focusChange } from '../../lib/drafts/focusChange'
import type { DraftInfo, DraftChange, DraftConflict, ChangeKind, ChangeCollection, ConflictKind } from '../../lib/drafts/api'

const KIND_ICON: Record<ChangeKind, { icon: typeof Plus; cls: string }> = {
  created: { icon: Plus, cls: 'text-success-text bg-success-bg' },
  updated: { icon: Pencil, cls: 'text-warning-text bg-warning-bg' },
  deleted: { icon: Trash2, cls: 'text-error-text bg-error-bg' },
}

const collectionLabel = (collection: ChangeCollection, t: TFunction): string => {
  const map: Record<ChangeCollection, string> = {
    object: t('drafts.collection.object'),
    connection: t('drafts.collection.connection'),
    group: t('drafts.collection.group'),
    domain: t('drafts.collection.domain'),
    tag: t('drafts.collection.tag'),
    decisionRecord: t('drafts.collection.decisionRecord'),
    diagram: t('drafts.collection.diagram'),
    layout: t('drafts.collection.layout'),
    flow: t('drafts.collection.flow'),
  }
  return map[collection]
}

type Tab = 'all' | 'created' | 'updated' | 'deleted'

const conflictKey = (c: { collection: string; id: string; diagramId?: string }) =>
  `${c.collection}:${c.id}:${c.diagramId ?? ''}`

export function ChangesDropdown({ draft, onClose }: { draft: DraftInfo; onClose: () => void }) {
  const { t } = useTranslation()
  const changes = useDraftsStore((s) => s.changes)
  const changesFor = useDraftsStore((s) => s.changesFor)
  const loadChanges = useDraftsStore((s) => s.loadChanges)
  const setMergeModalOpen = useUIStore((s) => s.setMergeModalOpen)
  const [tab, setTab] = useState<Tab>('all')
  const [refreshing, setRefreshing] = useState(false)

  // Refresh on open so the review reflects the latest draft edits.
  useEffect(() => {
    void loadChanges(draft.landscapeId, draft.id)
  }, [draft.landscapeId, draft.id, loadChanges])

  const fresh = changes && changesFor === draft.id ? changes : null
  const counts = fresh?.counts ?? { model: 0, diagrams: 0, conflicts: 0 }
  const conflictKeys = new Set((fresh?.conflicts ?? []).map(conflictKey))
  // Conflicts the server reports that have NO matching change row (an upstream-deleted
  // or unreadable diagram). Without these the badge count wouldn't match any visible row.
  const changeKeys = new Set((fresh?.changes ?? []).map(conflictKey))
  const orphanConflicts = (fresh?.conflicts ?? []).filter((c) => !changeKeys.has(conflictKey(c)))

  const list = (fresh?.changes ?? []).filter((c) => tab === 'all' || c.kind === tab)

  const onRefresh = async () => {
    setRefreshing(true)
    await loadChanges(draft.landscapeId, draft.id)
    setRefreshing(false)
  }

  return (
    <div className="absolute top-full right-0 mt-2 bg-surface-100 border border-line rounded-lg shadow-xl z-50 w-[400px] max-h-[520px] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-fg">{t('drafts.changes.title')}</h3>
          <span className="text-[11px] text-fg-subtle truncate max-w-[140px]">{draft.label}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            title={t('drafts.changes.recompute')}
            className="p-1 text-fg-subtle hover:text-fg-secondary"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-secondary">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Summary counts */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line text-[11px]">
        <span className="text-fg-secondary">
          <span className="font-semibold text-fg tabular-nums">{counts.model}</span> {t('drafts.changes.model')}
        </span>
        <span className="text-fg-secondary">
          <span className="font-semibold text-fg tabular-nums">{counts.diagrams}</span> {t('drafts.changes.diagrams')}
        </span>
        <span className={cn('ml-auto flex items-center gap-1', counts.conflicts > 0 ? 'text-error-text' : 'text-fg-subtle')}>
          <AlertTriangle className="w-3 h-3" />
          <span className="font-semibold tabular-nums">{counts.conflicts}</span> {t('drafts.changes.conflicts')}
        </span>
      </div>

      {/* Tabs (segmented pill — same control as the sidebars) */}
      <div className="px-3 py-2.5 border-b border-line">
        <SegmentedTabs
          size="sm"
          tabs={[
            { id: 'all', label: t('drafts.tabs.all', { count: fresh?.changes.length ?? 0 }) },
            { id: 'created', label: t('drafts.tabs.created') },
            { id: 'updated', label: t('drafts.tabs.updated') },
            { id: 'deleted', label: t('drafts.tabs.deleted') },
          ] as { id: Tab; label: string }[]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2">
        {/* Conflicts without a paired change row (e.g. a diagram deleted or unreadable
            upstream) — shown so the conflict count always maps to something visible. */}
        {orphanConflicts.map((c) => (
          <ConflictRow key={`cf-${conflictKey(c)}`} conflict={c} onFocus={() => { if (focusChange(c)) onClose() }} />
        ))}
        {list.length === 0 && orphanConflicts.length === 0 ? (
          <div className="text-center py-8 text-[12px] text-fg-subtle">
            {fresh ? t('drafts.changes.empty') : t('drafts.changes.loading')}
          </div>
        ) : (
          list.map((c) => (
            <ChangeRow
              key={`${conflictKey(c)}`}
              change={c}
              conflicting={conflictKeys.has(conflictKey(c))}
              onFocus={() => { if (focusChange(c)) onClose() }}
            />
          ))
        )}
      </div>

      {/* Review & merge */}
      <div className="px-3 py-2.5 border-t border-line shrink-0">
        <button
          data-testid="review-merge-button"
          onClick={() => {
            onClose()
            setMergeModalOpen(true)
          }}
          className={cn(
            'w-full flex items-center justify-center gap-1.5 text-[12px] font-medium py-1.5 rounded-md transition-colors',
            counts.conflicts > 0
              ? 'text-error-text hover:bg-error-bg/40'
              : 'text-accent hover:text-accent-hover'
          )}
        >
          {counts.conflicts > 0 ? (
            <>
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('drafts.changes.reviewConflicts')}
            </>
          ) : (
            <>
              <GitMerge className="w-3.5 h-3.5" />
              {t('drafts.changes.reviewAndMerge')}
            </>
          )}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

const conflictLabel = (kind: ConflictKind, t: TFunction): string => {
  const map: Record<ConflictKind, string> = {
    'update/update': t('drafts.conflict.updateUpdate'),
    'update/delete': t('drafts.conflict.updateDelete'),
    'delete/update': t('drafts.conflict.deleteUpdate'),
    unresolved: t('drafts.conflict.unresolved'),
  }
  return map[kind]
}

/** A conflict that has no paired change row (e.g. an upstream-deleted/unreadable diagram). */
function ConflictRow({ conflict, onFocus }: { conflict: DraftConflict; onFocus: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-testid="conflict-row"
      onClick={onFocus}
      title={t('drafts.changes.showOnCanvas')}
      className="flex items-start gap-2 px-2 py-2 rounded-lg bg-error-bg/40 w-full text-left hover:bg-error-bg/60 transition-colors"
    >
      <span className="flex h-4 items-center shrink-0">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-error-text bg-error-bg">
          <AlertTriangle className="w-3 h-3" />
        </span>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-fg truncate">{conflict.label}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-fg-subtle uppercase tracking-wide">{collectionLabel(conflict.collection, t)}</span>
          <span className="text-[10px] text-error-text">{conflictLabel(conflict.kind, t)}</span>
        </div>
      </div>
      <span className="flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-error-text bg-error-bg px-1.5 py-0.5 rounded shrink-0">
        <AlertTriangle className="w-2.5 h-2.5" />
        {t('drafts.changes.conflictBadge')}
      </span>
    </button>
  )
}

function ChangeRow({ change, conflicting, onFocus }: { change: DraftChange; conflicting: boolean; onFocus: () => void }) {
  const { t } = useTranslation()
  const { icon: Icon, cls } = KIND_ICON[change.kind]
  return (
    <button
      type="button"
      data-testid="change-row"
      onClick={onFocus}
      title={t('drafts.changes.showOnCanvas')}
      className="flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-surface-50 transition-colors w-full text-left"
    >
      <span className="flex h-4 items-center shrink-0">
        <span className={cn('inline-flex items-center justify-center w-5 h-5 rounded-full', cls)}>
          <Icon className="w-3 h-3" />
        </span>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-fg truncate">{change.label}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-fg-subtle uppercase tracking-wide">{collectionLabel(change.collection, t)}</span>
          <span className="text-[10px] text-fg-subtle capitalize">{t(`drafts.tabs.${change.kind}`)}</span>
        </div>
      </div>
      {conflicting && (
        <span className="flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-error-text bg-error-bg px-1.5 py-0.5 rounded shrink-0">
          <AlertTriangle className="w-2.5 h-2.5" />
          {t('drafts.changes.conflictBadge')}
        </span>
      )}
    </button>
  )
}
