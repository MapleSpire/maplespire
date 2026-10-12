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
import { X, Plus, Pencil, Trash2, AlertTriangle, ArrowRight, GitMerge } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { useUIStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useDraftsStore } from '../../stores/draftsStore'
import type { DraftChange, ChangeKind, ChangeCollection, ConflictKind, ConflictResolution } from '../../lib/drafts/api'

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
const conflictLabel = (kind: ConflictKind, t: TFunction): string => {
  const map: Record<ConflictKind, string> = {
    'update/update': t('drafts.conflict.updateUpdate'),
    'update/delete': t('drafts.conflict.updateDelete'),
    'delete/update': t('drafts.conflict.deleteUpdate'),
    unresolved: t('drafts.conflict.unresolved'),
  }
  return map[kind]
}

type Tab = 'all' | 'created' | 'updated' | 'deleted'
const conflictKey = (c: { collection: string; id: string; diagramId?: string }) =>
  `${c.collection}:${c.id}:${c.diagramId ?? ''}`

/** The "Merge changes" modal: reviews the draft's changeset and merges it into the
 * live model. Blocked behind a red "Merge conflicts" button while conflicts exist. */
export function MergeChangesModal() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.mergeModalOpen)
  const setOpen = useUIStore((s) => s.setMergeModalOpen)
  const ref = useWorkspaceStore((s) => s.ref)
  const drafts = useDraftsStore((s) => s.drafts)
  const changes = useDraftsStore((s) => s.changes)
  const changesFor = useDraftsStore((s) => s.changesFor)
  const busy = useDraftsStore((s) => s.busy)
  const error = useDraftsStore((s) => s.error)
  const loadChanges = useDraftsStore((s) => s.loadChanges)
  const clearError = useDraftsStore((s) => s.clearError)
  const merge = useDraftsStore((s) => s.merge)
  const [tab, setTab] = useState<Tab>('all')
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({})

  const draft = drafts.find((d) => d.id === ref.versionId && d.landscapeId === ref.landscapeId) ?? null

  useEffect(() => {
    if (open && draft) {
      clearError() // drop any stale error from a previous action when (re)opening
      setResolutions({}) // reset choices each time the modal opens
      void loadChanges(draft.landscapeId, draft.id)
    }
  }, [open, draft, loadChanges, clearError])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open || !draft) return null

  const fresh = changes && changesFor === draft.id ? changes : null
  const counts = fresh?.counts ?? { model: 0, diagrams: 0, conflicts: 0 }
  const total = fresh?.changes.length ?? 0
  const hasConflicts = counts.conflicts > 0
  const conflictKeys = new Set((fresh?.conflicts ?? []).map(conflictKey))
  const changeKeys = new Set((fresh?.changes ?? []).map(conflictKey))
  const orphanConflicts = (fresh?.conflicts ?? []).filter((c) => !changeKeys.has(conflictKey(c)))
  const list = (fresh?.changes ?? []).filter((c) => tab === 'all' || c.kind === tab)

  // Conflict resolution: each resolvable conflict needs a Keep-mine/Keep-live choice;
  // 'unresolved'-kind conflicts (an unreadable diagram) can't be resolved here.
  const allConflicts = fresh?.conflicts ?? []
  const hardConflicts = allConflicts.filter((c) => c.kind === 'unresolved')
  const resolvableConflicts = allConflicts.filter((c) => c.kind !== 'unresolved')
  const unresolvedCount = resolvableConflicts.filter((c) => !(conflictKey(c) in resolutions)).length
  const canMerge = hardConflicts.length === 0 && unresolvedCount === 0
  const setResolution = (key: string, choice: ConflictResolution) =>
    setResolutions((r) => ({ ...r, [key]: choice }))

  const doMerge = async () => {
    if (!canMerge) return
    const r = await merge(draft.landscapeId, draft.id, resolutions)
    if (r.ok) setOpen(false) // merged + switched out of the draft by the store
    // on conflicts the store refreshed changes → still blocked; resolve & retry
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-modal-backdrop" />
      <div
        className="relative w-full max-w-2xl bg-surface-100 rounded-xl shadow-xl border border-line overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <div className="flex items-center gap-2">
            <GitMerge className="w-4 h-4 text-fg-secondary" />
            <h2 className="text-sm font-semibold text-fg">{t('drafts.merge.title')}</h2>
            <span className="text-[12px] text-fg-subtle truncate max-w-[200px]">{draft.label}</span>
          </div>
          <button onClick={() => setOpen(false)} className="p-1 rounded-md hover:bg-surface-hover text-fg-subtle hover:text-fg-secondary" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary — Current model → + changes → Updated model */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <SummaryBox title={t('drafts.merge.currentModel')} sub={t('drafts.merge.live')} />
          <ArrowRight className="w-4 h-4 text-fg-subtle shrink-0" />
          <div className="flex-1 flex items-center justify-center gap-3 px-3 py-2 rounded-lg bg-accent-subtle">
            <Counter n={counts.model} label={t('drafts.changes.model')} />
            <span className="text-fg-subtle">·</span>
            <Counter n={counts.diagrams} label={t('drafts.changes.diagrams')} />
            {hasConflicts && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="flex items-center gap-1 text-error-text text-[12px]">
                  <AlertTriangle className="w-3 h-3" />
                  <span className="font-semibold tabular-nums">{counts.conflicts}</span> {t('drafts.changes.conflicts')}
                </span>
              </>
            )}
          </div>
          <ArrowRight className="w-4 h-4 text-fg-subtle shrink-0" />
          <SummaryBox title={t('drafts.merge.updatedModel')} sub={hasConflicts ? t('drafts.merge.blocked') : `+${total}`} accent={!hasConflicts} />
        </div>

        {/* Conflict resolution — choose keep-mine vs keep-live for each conflict */}
        {(resolvableConflicts.length > 0 || hardConflicts.length > 0) && (
          <div className="border-b border-line shrink-0 max-h-[190px] overflow-y-auto">
            <div className="flex items-center gap-1.5 px-5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-error-text">
              <AlertTriangle className="w-3 h-3" />
              {t('drafts.merge.conflictsResolveEach')}
            </div>
            <div className="px-3 pb-2 space-y-1">
              {resolvableConflicts.map((c) => {
                const key = conflictKey(c)
                const choice = resolutions[key]
                return (
                  <div key={`res-${key}`} className="px-2 py-1.5 rounded-lg bg-error-bg/30">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] text-fg truncate">{c.label}</p>
                        <p className="text-[10px] text-fg-subtle">{collectionLabel(c.collection, t)} · {conflictLabel(c.kind, t)}</p>
                      </div>
                      <div className="flex items-center rounded-md border border-line overflow-hidden shrink-0">
                        <button
                          data-testid={`resolve-mine-${key}`}
                          onClick={() => setResolution(key, 'draft')}
                          className={cn('px-2 py-1 text-[11px]', choice === 'draft' ? 'bg-accent text-on-inverse font-medium' : 'text-fg-secondary hover:bg-surface-50')}
                        >
                          {t('drafts.merge.keepMine')}
                        </button>
                        <button
                          data-testid={`resolve-live-${key}`}
                          onClick={() => setResolution(key, 'live')}
                          className={cn('px-2 py-1 text-[11px] border-l border-line', choice === 'live' ? 'bg-accent text-on-inverse font-medium' : 'text-fg-secondary hover:bg-surface-50')}
                        >
                          {t('drafts.merge.keepLive')}
                        </button>
                      </div>
                    </div>
                    {/* Field-level comparison so the user can decide without switching to the live model. */}
                    {c.details && c.details.length > 0 && (
                      <div className="mt-1.5 ml-0.5 space-y-0.5">
                        {c.details.map((d) => (
                          <div key={d.field} className="grid grid-cols-[5.5rem_1fr_1fr] gap-x-2 items-baseline text-[10px]">
                            <span className="text-fg-subtle truncate">{d.field}</span>
                            <span className={cn('truncate', choice === 'draft' ? 'text-success-text font-medium' : 'text-fg-secondary')} title={d.mine}>
                              {t('drafts.merge.mineValue', { value: d.mine })}
                            </span>
                            <span className={cn('truncate', choice === 'live' ? 'text-warning-text font-medium' : 'text-fg-secondary')} title={d.live}>
                              {t('drafts.merge.liveValue', { value: d.live })}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {hardConflicts.map((c) => (
                <div key={`hard-${conflictKey(c)}`} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-error-bg/30">
                  <AlertTriangle className="w-3.5 h-3.5 text-error-text shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] text-fg truncate">{c.label}</p>
                    <p className="text-[10px] text-error-text">{t('drafts.merge.cannotResolveHere', { reason: conflictLabel(c.kind, t) })}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tabs (segmented pill — same control as the sidebars) */}
        <div className="px-3 py-2.5 border-b border-line shrink-0">
          <SegmentedTabs
            size="sm"
            tabs={[
              { id: 'all', label: t('drafts.tabs.all', { count: total }) },
              { id: 'created', label: t('drafts.tabs.created') },
              { id: 'updated', label: t('drafts.tabs.updated') },
              { id: 'deleted', label: t('drafts.tabs.deleted') },
            ] as { id: Tab; label: string }[]}
            value={tab}
            onChange={setTab}
          />
        </div>

        {/* Change list */}
        <div className="flex-1 overflow-y-auto p-2 min-h-[120px]">
          {orphanConflicts.map((c) => (
            <Row key={`cf-${conflictKey(c)}`} icon={AlertTriangle} iconCls="text-error-text bg-error-bg"
              label={c.label} sub={`${collectionLabel(c.collection, t)} · ${conflictLabel(c.kind, t)}`} conflict />
          ))}
          {list.length === 0 && orphanConflicts.length === 0 ? (
            <div className="text-center py-10 text-[12px] text-fg-subtle">
              {fresh ? t('drafts.merge.noChangesToMerge') : t('drafts.changes.loading')}
            </div>
          ) : (
            list.map((c) => <ChangeRow key={conflictKey(c)} change={c} conflicting={conflictKeys.has(conflictKey(c))} />)
          )}
        </div>

        {/* Footer — merge action / conflict gate */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-line shrink-0">
          <span className={cn('text-[11px]', error && !hasConflicts ? 'text-error-text' : 'text-fg-subtle')}>
            {error && !hasConflicts
              ? error
              : hardConflicts.length > 0
                ? t('drafts.merge.someConflictsCannotAutoResolve')
                : !canMerge
                  ? t('drafts.merge.chooseForEachConflict', { count: unresolvedCount })
                  : t('drafts.merge.mergeExplainer')}
          </span>
          {canMerge ? (
            <button
              data-testid="merge-button"
              onClick={doMerge}
              disabled={busy || total === 0}
              className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-semibold text-on-inverse bg-inverse rounded-md hover:bg-inverse-hover disabled:opacity-50 shrink-0 transition-colors"
            >
              <GitMerge className="w-3.5 h-3.5" />
              {busy ? t('drafts.merge.merging') : t('drafts.merge.mergeChanges', { count: total })}
            </button>
          ) : (
            <button
              data-testid="merge-conflicts-button"
              disabled
              title={hardConflicts.length > 0 ? t('drafts.merge.mustBeFixedInDraft') : t('drafts.merge.resolveAllToMerge')}
              className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-semibold text-on-inverse bg-error rounded-md cursor-not-allowed shrink-0"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('drafts.merge.mergeConflictsCount', { count: hardConflicts.length + unresolvedCount })}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryBox({ title, sub, accent }: { title: string; sub: string; accent?: boolean }) {
  return (
    <div className={cn('px-3 py-2 rounded-lg border text-center min-w-[120px]', accent ? 'border-accent bg-accent-subtle' : 'border-line bg-surface-50')}>
      <div className="text-[12px] font-medium text-fg">{title}</div>
      <div className="text-[10px] text-fg-subtle">{sub}</div>
    </div>
  )
}
function Counter({ n, label }: { n: number; label: string }) {
  return (
    <span className="text-[12px] text-fg-secondary">
      <span className="font-semibold text-fg tabular-nums">{n}</span> {label}
    </span>
  )
}
function Row({ icon: Icon, iconCls, label, sub, conflict }: { icon: typeof Plus; iconCls: string; label: string; sub: string; conflict?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-start gap-2 px-2 py-2 rounded-lg', conflict ? 'bg-error-bg/40' : 'hover:bg-surface-50')}>
      <span className="flex h-4 items-center shrink-0">
        <span className={cn('inline-flex items-center justify-center w-5 h-5 rounded-full', iconCls)}>
          <Icon className="w-3 h-3" />
        </span>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-fg truncate">{label}</p>
        <p className="text-[10px] text-fg-subtle mt-0.5">{sub}</p>
      </div>
      {conflict && (
        <span className="flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-error-text bg-error-bg px-1.5 py-0.5 rounded shrink-0">
          <AlertTriangle className="w-2.5 h-2.5" /> {t('drafts.changes.conflictBadge')}
        </span>
      )}
    </div>
  )
}
function ChangeRow({ change, conflicting }: { change: DraftChange; conflicting: boolean }) {
  const { t } = useTranslation()
  const { icon, cls } = KIND_ICON[change.kind]
  return (
    <Row
      icon={icon}
      iconCls={cls}
      label={change.label}
      sub={`${collectionLabel(change.collection, t)} · ${t(`drafts.tabs.${change.kind}`)}`}
      conflict={conflicting}
    />
  )
}
