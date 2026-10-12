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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Archive, ArrowRight, CheckCircle2, Clock3, CloudOff, Database, FolderInput, FolderTree, GitMerge, History, Link2, Palette, Pencil, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Tags, Trash2, TriangleAlert } from 'lucide-react'
import { useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import {
  createCatalogTag,
  createCatalogTagGroup,
  batchUpdateCatalogTags,
  discardTagCatalogOutboxEntry,
  getCatalogTagUsageSummary,
  getTagOperationSummary,
  listTagCatalogOutbox,
  listTagGroupPage,
  listTagPage,
  mergeCatalogTags,
  reconcileTagCatalogOutboxEntry,
  reconcileTagGroupOutboxEntry,
  retryTagCatalogOutboxEntry,
  setCatalogTagGroupLifecycle,
  setCatalogTagLifecycle,
  subscribeTagCatalogOutbox,
  updateCatalogTag,
  updateCatalogTagGroup,
  type CatalogTag,
  type CatalogTagBatchAction,
  type CatalogTagGroup,
  type CatalogTagGroupLifecycle,
  type CatalogTagLifecycle,
  type CatalogTagUsageCount,
  type TagCatalogOutboxItem,
  type TagOperationSummary,
  type TagOperationWindow,
} from '../../lib/tags/api'
import { VirtualList } from '../common/VirtualList'
import { TagCatalogPicker } from '../tags/TagCatalogPicker'
import { TagGroupCatalogPicker } from '../tags/TagGroupCatalogPicker'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'
import { EmptyState, InlineError } from './shared'
import { TagGovernanceDetails } from './TagGovernanceDetails'
import { getReadModelHealth, type OrgReadModelHealth, type ReadModelWorkspaceStatus } from '../../lib/orgAdmin/api'

type View = 'tags' | 'groups'
type Editor =
  | { kind: 'tag'; value?: CatalogTag }
  | { kind: 'group'; value?: CatalogTagGroup }

function mergeUnique<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) merged.set(item.id, item)
  return [...merged.values()]
}

function formatOperationDuration(value: number | null): string {
  if (value === null) return '—'
  if (value < 1_000) return `${value} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
  if (value < 3_600_000) return `${(value / 60_000).toFixed(1)} min`
  return `${(value / 3_600_000).toFixed(1)} h`
}

export function AdminTags() {
  const { orgId } = useParams({ from: '/org/$orgId/admin/tags' })
  const { t } = useTranslation()
  const [view, setView] = useState<View>('tags')
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query, 180)
  const [tagStatus, setTagStatus] = useState<CatalogTagLifecycle | 'all'>('active')
  const [groupStatus, setGroupStatus] = useState<CatalogTagGroupLifecycle | 'all'>('active')
  const [groupId, setGroupId] = useState('')
  const [groupOptions, setGroupOptions] = useState<CatalogTagGroup[]>([])
  const [groups, setGroups] = useState<CatalogTagGroup[]>([])
  const [tags, setTags] = useState<CatalogTag[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [detailsTag, setDetailsTag] = useState<CatalogTag | null>(null)
  const [mergeSource, setMergeSource] = useState<CatalogTag | null>(null)
  const [mergeTarget, setMergeTarget] = useState<CatalogTag | null>(null)
  const [mergePickerOpen, setMergePickerOpen] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkAction, setBulkAction] = useState<CatalogTagBatchAction | null>(null)
  const [bulkColor, setBulkColor] = useState('#D97A3D')
  const [bulkGroupId, setBulkGroupId] = useState('')
  const [bulkUsage, setBulkUsage] = useState<CatalogTagUsageCount[] | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [outboxItems, setOutboxItems] = useState<TagCatalogOutboxItem[]>([])
  const [outboxOpen, setOutboxOpen] = useState(false)
  const [outboxBusyIds, setOutboxBusyIds] = useState<Set<string>>(new Set())
  const [discardOutboxId, setDiscardOutboxId] = useState<string | null>(null)
  const [resolutionEntry, setResolutionEntry] = useState<TagCatalogOutboxItem | null>(null)
  const [resolutionTagTarget, setResolutionTagTarget] = useState<CatalogTag | null>(null)
  const [resolutionGroupTarget, setResolutionGroupTarget] = useState<CatalogTagGroup | null>(null)
  const [resolutionPickerOpen, setResolutionPickerOpen] = useState(false)
  const [resolutionError, setResolutionError] = useState<string | null>(null)
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [operationWindow, setOperationWindow] = useState<TagOperationWindow>('7d')
  const [operationSummary, setOperationSummary] = useState<TagOperationSummary | null>(null)
  const [operationsLoading, setOperationsLoading] = useState(false)
  const [operationsError, setOperationsError] = useState<string | null>(null)
  const [operationsRefreshKey, setOperationsRefreshKey] = useState(0)
  const [readModelHealth, setReadModelHealth] = useState<OrgReadModelHealth | null>(null)
  const [readModelHealthLoading, setReadModelHealthLoading] = useState(false)
  const [readModelHealthError, setReadModelHealthError] = useState<string | null>(null)
  const mergeTriggerRef = useRef<HTMLElement | null>(null)
  const resolutionTriggerRef = useRef<HTMLElement | null>(null)

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), [])
  const refreshOutbox = useCallback(() => {
    void listTagCatalogOutbox(orgId).then(setOutboxItems).catch(() => {})
  }, [orgId])

  useEffect(() => {
    refreshOutbox()
    return subscribeTagCatalogOutbox((changedOrgId) => {
      if (changedOrgId === orgId) refreshOutbox()
    })
  }, [orgId, refreshOutbox])

  useEffect(() => {
    if (!operationsOpen) return
    const controller = new AbortController()
    setOperationsLoading(true)
    setOperationsError(null)
    void getTagOperationSummary(orgId, operationWindow, controller.signal)
      .then(setOperationSummary)
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setOperationsError(cause instanceof Error ? cause.message : t('admin.tags.operations.loadFailed'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setOperationsLoading(false)
      })
    return () => controller.abort()
  }, [operationWindow, operationsOpen, operationsRefreshKey, orgId, t])

  useEffect(() => {
    if (!operationsOpen) return
    const controller = new AbortController()
    setReadModelHealthLoading(true)
    setReadModelHealthError(null)
    void getReadModelHealth(orgId, controller.signal)
      .then(setReadModelHealth)
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setReadModelHealthError(cause instanceof Error ? cause.message : t('admin.tags.operations.readModel.loadFailed'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setReadModelHealthLoading(false)
      })
    return () => controller.abort()
  }, [operationsOpen, operationsRefreshKey, orgId, t])

  useEffect(() => {
    const controller = new AbortController()
    void listTagGroupPage(orgId, { status: 'active', limit: 100 }, controller.signal)
      .then((page) => setGroupOptions(page.items))
      .catch(() => {})
    return () => controller.abort()
  }, [orgId, refreshKey])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setNextCursor(null)
    const request = view === 'tags'
      ? listTagPage(orgId, {
          query: debouncedQuery,
          groupIds: groupId ? [groupId] : undefined,
          status: tagStatus,
        }, controller.signal)
      : listTagGroupPage(orgId, { query: debouncedQuery, status: groupStatus }, controller.signal)
    void request
      .then((page) => {
        if (view === 'tags') setTags(page.items as CatalogTag[])
        else setGroups(page.items as CatalogTagGroup[])
        setNextCursor(page.nextCursor)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('admin.tags.loadFailed'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [debouncedQuery, groupId, groupStatus, orgId, refreshKey, t, tagStatus, view])

  const loadMore = useCallback(() => {
    if (!nextCursor || loading || loadingMore) return
    setLoadingMore(true)
    const request = view === 'tags'
      ? listTagPage(orgId, {
          query: debouncedQuery,
          groupIds: groupId ? [groupId] : undefined,
          status: tagStatus,
          after: nextCursor,
        })
      : listTagGroupPage(orgId, { query: debouncedQuery, status: groupStatus, after: nextCursor })
    void request
      .then((page) => {
        if (view === 'tags') setTags((current) => mergeUnique(current, page.items as CatalogTag[]))
        else setGroups((current) => mergeUnique(current, page.items as CatalogTagGroup[]))
        setNextCursor(page.nextCursor)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('admin.tags.loadFailed')))
      .finally(() => setLoadingMore(false))
  }, [debouncedQuery, groupId, groupStatus, loading, loadingMore, nextCursor, orgId, t, tagStatus, view])

  const activeGroups = useMemo(() => groupOptions.filter((group) => group.lifecycleStatus === 'active'), [groupOptions])
  const outboxByClientId = useMemo(() => new Map(outboxItems.map((item) => [item.clientId, item])), [outboxItems])
  const attentionCount = useMemo(() => outboxItems.filter((item) => item.state === 'attention').length, [outboxItems])
  const resolutionDependentCount = useMemo(
    () => resolutionEntry?.kind === 'group'
      ? outboxItems.filter((item) => item.kind === 'tag' && item.groupId === resolutionEntry.clientId).length
      : 0,
    [outboxItems, resolutionEntry],
  )
  const selectableTags = useMemo(() => tags.filter((tag) => tag.lifecycleStatus !== 'merged'), [tags])
  const selectedTags = useMemo(() => tags.filter((tag) => selectedIds.has(tag.id)), [selectedIds, tags])
  const allLoadedSelected = selectableTags.length > 0 && selectableTags.every((tag) => selectedIds.has(tag.id))
  const usageTotals = useMemo(() => (bulkUsage ?? []).reduce((total, usage) => ({
    objects: total.objects + usage.objectAssignments,
    groups: total.groups + usage.groupAssignments,
    assignments: total.assignments + usage.totalAssignments,
  }), { objects: 0, groups: 0, assignments: 0 }), [bulkUsage])

  useEffect(() => {
    setSelectedIds(new Set())
    setBulkAction(null)
  }, [debouncedQuery, groupId, orgId, tagStatus, view])

  const toggleSelected = (tagId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(tagId)) next.delete(tagId)
      else if (next.size < 100) next.add(tagId)
      return next
    })
  }

  const toggleLoaded = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allLoadedSelected) {
        for (const tag of selectableTags) next.delete(tag.id)
      } else {
        for (const tag of selectableTags) {
          if (next.size >= 100) break
          next.add(tag.id)
        }
      }
      return next
    })
  }

  const openBulkAction = (action: CatalogTagBatchAction) => {
    setBulkAction(action)
    setBulkUsage(null)
    if (action === 'move') setBulkGroupId(activeGroups[0]?.id ?? '')
    if (action !== 'archive') return
    setImpactLoading(true)
    void getCatalogTagUsageSummary(orgId, selectedTags.map((tag) => tag.id))
      .then(setBulkUsage)
      .catch((cause) => {
        setBulkAction(null)
        setError(cause instanceof Error ? cause.message : t('admin.tags.usageFailed'))
      })
      .finally(() => setImpactLoading(false))
  }

  const runBulkAction = async () => {
    if (!bulkAction || selectedTags.length === 0) return
    setActionBusy(true)
    setError(null)
    try {
      await batchUpdateCatalogTags(orgId, selectedTags, bulkAction, {
        color: bulkColor,
        groupId: bulkGroupId,
      })
      setBulkAction(null)
      setSelectedIds(new Set())
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('admin.tags.bulkFailed'))
    } finally {
      setActionBusy(false)
    }
  }

  const changeLifecycle = async (item: CatalogTag | CatalogTagGroup) => {
    setActionBusy(true)
    setError(null)
    try {
      if ('groupId' in item) {
        await setCatalogTagLifecycle(orgId, item, item.lifecycleStatus === 'active' ? 'archived' : 'active')
      } else {
        await setCatalogTagGroupLifecycle(orgId, item, item.lifecycleStatus === 'active' ? 'archived' : 'active')
      }
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('admin.tags.actionFailed'))
    } finally {
      setActionBusy(false)
    }
  }

  const runOutboxAction = async (entryId: string, action: 'retry' | 'discard') => {
    setOutboxBusyIds((current) => new Set(current).add(entryId))
    try {
      const catalogChanged = action === 'retry'
        ? await retryTagCatalogOutboxEntry(orgId, entryId)
        : await discardTagCatalogOutboxEntry(orgId, entryId)
      setDiscardOutboxId(null)
      refreshOutbox()
      if (catalogChanged) refresh()
    } finally {
      setOutboxBusyIds((current) => {
        const next = new Set(current)
        next.delete(entryId)
        return next
      })
    }
  }

  const retryAllOutbox = async () => {
    const ids = outboxItems.map((item) => item.id)
    setOutboxBusyIds(new Set(ids))
    try {
      let catalogChanged = false
      for (const id of ids) catalogChanged = await retryTagCatalogOutboxEntry(orgId, id) || catalogChanged
      refreshOutbox()
      if (catalogChanged) refresh()
    } finally {
      setOutboxBusyIds(new Set())
    }
  }

  const openOutboxResolution = (item: TagCatalogOutboxItem, trigger: HTMLElement) => {
    resolutionTriggerRef.current = trigger
    setResolutionEntry(item)
    setResolutionTagTarget(null)
    setResolutionGroupTarget(null)
    setResolutionError(null)
    setResolutionPickerOpen(true)
  }

  const closeOutboxResolution = () => {
    setResolutionPickerOpen(false)
    setResolutionEntry(null)
    setResolutionTagTarget(null)
    setResolutionGroupTarget(null)
    setResolutionError(null)
  }

  const confirmOutboxResolution = async () => {
    if (!resolutionEntry) return
    const target = resolutionEntry.kind === 'tag' ? resolutionTagTarget : resolutionGroupTarget
    if (!target) return
    setOutboxBusyIds((current) => new Set(current).add(resolutionEntry.id))
    setResolutionError(null)
    try {
      if (resolutionEntry.kind === 'tag') {
        await reconcileTagCatalogOutboxEntry(orgId, resolutionEntry.id, target as CatalogTag)
      } else {
        await reconcileTagGroupOutboxEntry(orgId, resolutionEntry.id, target as CatalogTagGroup)
      }
      closeOutboxResolution()
      refreshOutbox()
      refresh()
    } catch (cause) {
      setResolutionError(cause instanceof Error ? cause.message : t('admin.tags.outbox.resolveFailed'))
    } finally {
      setOutboxBusyIds((current) => {
        const next = new Set(current)
        next.delete(resolutionEntry.id)
        return next
      })
    }
  }

  return (
    <div data-testid="admin-tags" className="mx-auto flex h-full min-h-0 w-full max-w-[1380px] flex-col px-8 py-8">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-100">
            <Tags className="h-4 w-4 text-fg-secondary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-[20px] font-semibold text-fg">{t('admin.tags.title')}</h1>
            <p className="mt-1 max-w-2xl text-[13px] text-fg-secondary">{t('admin.tags.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setOperationsOpen(true)}
            aria-label={t('admin.tags.operations.open')}
          >
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            {t('admin.tags.operations.button')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setOutboxOpen(true)}
            aria-label={t('admin.tags.outbox.open')}
            className={attentionCount > 0 ? 'border-error-border bg-error-bg text-error-text' : undefined}
          >
            {attentionCount > 0
              ? <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
              : outboxItems.length > 0
                ? <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />
                : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
            {attentionCount > 0
              ? t('admin.tags.outbox.attentionCount', { count: attentionCount })
              : outboxItems.length > 0
                ? t('admin.tags.outbox.pendingCount', { count: outboxItems.length })
                : t('admin.tags.outbox.synced')}
          </Button>
          <Button onClick={() => setEditor({ kind: view === 'tags' ? 'tag' : 'group' })} disabled={view === 'tags' && activeGroups.length === 0}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {view === 'tags' ? t('admin.tags.addTag') : t('admin.tags.addGroup')}
          </Button>
        </div>
      </div>

      <div className="mb-3 flex items-center gap-1 rounded-lg bg-surface-200 p-1 self-start">
        {(['tags', 'groups'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setView(tab)}
            className={`h-7 rounded-md px-3 text-[11px] font-semibold transition-colors ${view === tab ? 'bg-surface-100 text-fg shadow-xs' : 'text-fg-secondary hover:text-fg'}`}
          >
            {tab === 'tags' ? t('admin.tags.tagsTab') : t('admin.tags.groupsTab')}
          </button>
        ))}
      </div>

      <div className="mb-3 grid grid-cols-[minmax(240px,1fr)_180px_220px] gap-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={view === 'tags' ? t('admin.tags.searchTags') : t('admin.tags.searchGroups')}
            className="h-9 w-full rounded-lg border border-line bg-surface-100 pl-9 pr-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </label>
        <select
          value={view === 'tags' ? tagStatus : groupStatus}
          onChange={(event) => view === 'tags'
            ? setTagStatus(event.target.value as CatalogTagLifecycle | 'all')
            : setGroupStatus(event.target.value as CatalogTagGroupLifecycle | 'all')}
          className="h-9 rounded-lg border border-line bg-surface-100 px-2.5 text-[11px] text-fg-secondary outline-none focus:border-accent"
        >
          <option value="all">{t('admin.tags.allStatuses')}</option>
          <option value="active">{t('admin.tags.active')}</option>
          <option value="archived">{t('admin.tags.archived')}</option>
          {view === 'tags' && <option value="merged">{t('admin.tags.merged')}</option>}
        </select>
        {view === 'tags' ? (
          <select
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            className="h-9 rounded-lg border border-line bg-surface-100 px-2.5 text-[11px] text-fg-secondary outline-none focus:border-accent"
          >
            <option value="">{t('admin.tags.allGroups')}</option>
            {activeGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        ) : <div />}
      </div>

      {view === 'tags' && !loading && tags.length > 0 && (
        <div
          data-testid="admin-tags-bulk-toolbar"
          className="mb-3 flex min-h-10 flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-100 px-3 py-2"
        >
          <label className="inline-flex items-center gap-2 text-[11px] font-semibold text-fg-secondary">
            <input
              type="checkbox"
              checked={allLoadedSelected}
              onChange={toggleLoaded}
              aria-label={t('admin.tags.selectLoaded')}
              className="h-3.5 w-3.5 rounded border-line accent-[var(--color-accent)]"
            />
            {t('admin.tags.selectLoaded')}
          </label>
          <span className="h-5 w-px bg-line" aria-hidden="true" />
          <span className="text-[11px] text-fg-subtle">
            {t('admin.tags.selectedCount', { count: selectedTags.length })}
          </span>
          {selectedTags.length > 0 && <>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => openBulkAction('recolor')} disabled={actionBusy}>
                <Palette className="h-3 w-3" />{t('admin.tags.recolorSelected')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => openBulkAction('move')} disabled={actionBusy || activeGroups.length === 0}>
                <FolderInput className="h-3 w-3" />{t('admin.tags.moveSelected')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => openBulkAction('restore')} disabled={actionBusy}>
                <RotateCcw className="h-3 w-3" />{t('admin.tags.restoreSelected')}
              </Button>
              <Button variant="danger" size="sm" onClick={() => openBulkAction('archive')} disabled={actionBusy}>
                <Archive className="h-3 w-3" />{t('admin.tags.archiveSelected')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())} disabled={actionBusy}>
                {t('admin.tags.clearSelection')}
              </Button>
            </div>
          </>}
        </div>
      )}

      {error && <div className="mb-3"><InlineError message={error} onRetry={refresh} /></div>}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-surface-100">
        {loading ? (
          <div className="h-full min-h-[320px] animate-pulse bg-surface-50" />
        ) : view === 'tags' ? (
          tags.length === 0 ? <EmptyState title={t('admin.tags.emptyTags')} description={t('admin.tags.emptyTagsDescription')} /> : (
            <VirtualList
              items={tags}
              estimateSize={52}
              className="h-full min-h-[320px]"
              getKey={(tag) => tag.id}
              onEndReached={loadMore}
              footer={loadingMore ? <LoadingMore label={t('admin.tags.loadingMore')} /> : undefined}
              renderRow={(tag) => (
                <CatalogRow
                  key={tag.id}
                  selected={selectedIds.has(tag.id)}
                  selectionDisabled={tag.lifecycleStatus === 'merged'}
                  selectLabel={t('admin.tags.selectTag', { value: tag.value })}
                  onSelect={() => toggleSelected(tag.id)}
                  mark={<span className="h-3 w-3 rounded-[3px] border border-black/10" style={{ backgroundColor: tag.color }} />}
                  title={tag.value}
                  subtitle={tag.groupName}
                  status={tag.lifecycleStatus}
                  revision={tag.version}
                  syncState={outboxByClientId.get(tag.id)?.state}
                  busy={actionBusy}
                  onEdit={tag.lifecycleStatus !== 'merged' ? () => setEditor({ kind: 'tag', value: tag }) : undefined}
                  onDetails={() => setDetailsTag(tag)}
                  onLifecycle={tag.lifecycleStatus !== 'merged' ? () => void changeLifecycle(tag) : undefined}
                  onMerge={tag.lifecycleStatus === 'active' ? (element) => {
                    mergeTriggerRef.current = element
                    setMergeSource(tag)
                    setMergeTarget(null)
                    setMergePickerOpen(true)
                  } : undefined}
                  labels={t}
                />
              )}
            />
          )
        ) : groups.length === 0 ? <EmptyState title={t('admin.tags.emptyGroups')} description={t('admin.tags.emptyGroupsDescription')} /> : (
          <VirtualList
            items={groups}
            estimateSize={56}
            className="h-full min-h-[320px]"
            getKey={(group) => group.id}
            onEndReached={loadMore}
            footer={loadingMore ? <LoadingMore label={t('admin.tags.loadingMore')} /> : undefined}
            renderRow={(group) => (
              <CatalogRow
                key={group.id}
                mark={<span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-200"><FolderTree className="h-3.5 w-3.5 text-fg-secondary" /></span>}
                title={group.name}
                subtitle={group.description || t('admin.tags.noDescription')}
                status={group.lifecycleStatus}
                revision={group.version}
                syncState={outboxByClientId.get(group.id)?.state}
                busy={actionBusy}
                onEdit={() => setEditor({ kind: 'group', value: group })}
                onLifecycle={() => void changeLifecycle(group)}
                labels={t}
              />
            )}
          />
        )}
      </div>

      {editor && (
        <CatalogEditorModal
          editor={editor}
          groups={activeGroups}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            refresh()
          }}
          orgId={orgId}
        />
      )}

      {detailsTag && <TagGovernanceDetails orgId={orgId} tag={detailsTag} onClose={() => setDetailsTag(null)} />}

      {operationsOpen && (
        <Modal
          data-testid="admin-tags-operations-dialog"
          title={t('admin.tags.operations.title')}
          onClose={() => setOperationsOpen(false)}
          maxWidthClassName="max-w-[760px]"
          contentClassName="min-h-0"
          footer={<>
            <Button
              variant="secondary"
              onClick={() => setOperationsRefreshKey((value) => value + 1)}
              disabled={operationsLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${operationsLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              {t('admin.tags.operations.refresh')}
            </Button>
            <Button onClick={() => setOperationsOpen(false)}>{t('common.close')}</Button>
          </>}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <p className="max-w-[490px] text-[11px] leading-relaxed text-fg-secondary">
              {t('admin.tags.operations.description')}
            </p>
            <label className="shrink-0">
              <span className="sr-only">{t('admin.tags.operations.window')}</span>
              <select
                aria-label={t('admin.tags.operations.window')}
                value={operationWindow}
                onChange={(event) => setOperationWindow(event.target.value as TagOperationWindow)}
                className="h-8 rounded-lg border border-line bg-surface-50 px-2.5 text-[11px] font-semibold text-fg outline-none focus:border-accent"
              >
                <option value="24h">{t('admin.tags.operations.windows.24h')}</option>
                <option value="7d">{t('admin.tags.operations.windows.7d')}</option>
                <option value="30d">{t('admin.tags.operations.windows.30d')}</option>
              </select>
            </label>
          </div>

          {operationsError ? (
            <InlineError message={operationsError} onRetry={() => setOperationsRefreshKey((value) => value + 1)} />
          ) : operationsLoading && !operationSummary ? (
            <div className="grid grid-cols-5 gap-2" aria-label={t('admin.tags.operations.loading')}>
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="h-[86px] animate-pulse rounded-xl border border-line bg-surface-50" />
              ))}
            </div>
          ) : operationSummary ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <OperationMetric label={t('admin.tags.operations.queued')} value={operationSummary.counts.queued} tone="neutral" />
                <OperationMetric label={t('admin.tags.operations.synchronized')} value={operationSummary.counts.replay_succeeded} tone="success" />
                <OperationMetric label={t('admin.tags.operations.attention')} value={operationSummary.counts.attention} tone="warning" />
                <OperationMetric label={t('admin.tags.operations.reconciled')} value={operationSummary.counts.reconciled} tone="accent" />
                <OperationMetric label={t('admin.tags.operations.discarded')} value={operationSummary.counts.discarded} tone="muted" />
              </div>

              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr]">
                <div className="rounded-xl border border-line bg-surface-50 px-3.5 py-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                    <Clock3 className="h-3 w-3" aria-hidden="true" />{t('admin.tags.operations.p50')}
                  </div>
                  <div className="mt-1.5 text-[18px] font-semibold tabular-nums text-fg">{formatOperationDuration(operationSummary.p50ResolutionMs)}</div>
                </div>
                <div className="rounded-xl border border-line bg-surface-50 px-3.5 py-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                    <Clock3 className="h-3 w-3" aria-hidden="true" />{t('admin.tags.operations.p95')}
                  </div>
                  <div className="mt-1.5 text-[18px] font-semibold tabular-nums text-fg">{formatOperationDuration(operationSummary.p95ResolutionMs)}</div>
                </div>
                <div className="rounded-xl border border-line bg-surface-50 px-3.5 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{t('admin.tags.operations.lastEvent')}</div>
                  <div className="mt-1.5 text-[12px] font-medium text-fg">
                    {operationSummary.lastEventAt ? new Date(operationSummary.lastEventAt).toLocaleString() : '—'}
                  </div>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-[1fr_1.15fr]">
                <div className="rounded-xl border border-line bg-surface-50 px-3.5 py-3">
                  <h3 className="text-[11px] font-semibold text-fg">{t('admin.tags.operations.topReasons')}</h3>
                  {operationSummary.topAttentionReasons.length === 0 ? (
                    <p className="mt-2 text-[10.5px] text-fg-subtle">{t('admin.tags.operations.noReasons')}</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {operationSummary.topAttentionReasons.map((reason) => (
                        <li key={reason.code} className="flex items-center justify-between gap-3 text-[10.5px]">
                          <span className="truncate font-medium text-fg-secondary">{t(`admin.tags.operations.reasons.${reason.code}`, { defaultValue: reason.code })}</span>
                          <span className="rounded-md bg-surface-200 px-1.5 py-0.5 font-semibold tabular-nums text-fg">{reason.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex items-start gap-2.5 rounded-xl border border-line bg-surface-50 px-3.5 py-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success-text" aria-hidden="true" />
                  <div>
                    <h3 className="text-[11px] font-semibold text-fg">{t('admin.tags.operations.privacyTitle')}</h3>
                    <p className="mt-1 text-[10.5px] leading-relaxed text-fg-secondary">{t('admin.tags.operations.privacyDescription')}</p>
                  </div>
                </div>
              </div>

              <ReadModelHealthPanel
                health={readModelHealth}
                loading={readModelHealthLoading}
                error={readModelHealthError}
                onRetry={() => setOperationsRefreshKey((value) => value + 1)}
                labels={t}
              />
            </div>
          ) : null}
        </Modal>
      )}

      {outboxOpen && (
        <Modal
          data-testid="admin-tags-outbox-dialog"
          title={t('admin.tags.outbox.title')}
          onClose={() => {
            setOutboxOpen(false)
            setDiscardOutboxId(null)
          }}
          maxWidthClassName="max-w-[620px]"
          contentClassName="min-h-0"
          footer={<>
            <Button variant="secondary" onClick={() => setOutboxOpen(false)}>{t('common.close')}</Button>
            {outboxItems.length > 0 && (
              <Button onClick={() => void retryAllOutbox()} disabled={outboxBusyIds.size > 0}>
                <RefreshCw className="h-3.5 w-3.5" />{t('admin.tags.outbox.retryAll')}
              </Button>
            )}
          </>}
        >
          <p className="mb-3 text-[11px] leading-relaxed text-fg-secondary">{t('admin.tags.outbox.description')}</p>
          {outboxItems.length === 0 ? (
            <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-line bg-surface-50 px-5 text-center">
              <CheckCircle2 className="mb-2 h-5 w-5 text-success-text" aria-hidden="true" />
              <div className="text-[12px] font-semibold text-fg">{t('admin.tags.outbox.empty')}</div>
              <p className="mt-1 max-w-sm text-[10px] leading-relaxed text-fg-subtle">{t('admin.tags.outbox.emptyDescription')}</p>
            </div>
          ) : (
            <VirtualList
              items={outboxItems}
              estimateSize={82}
              maxHeight={360}
              className="rounded-xl border border-line bg-surface-50"
              getKey={(item) => item.id}
              renderRow={(item) => (
                <OutboxRow
                  item={item}
                  busy={outboxBusyIds.has(item.id)}
                  confirmingDiscard={discardOutboxId === item.id}
                  onRetry={() => void runOutboxAction(item.id, 'retry')}
                  onResolve={(trigger) => openOutboxResolution(item, trigger)}
                  onRequestDiscard={() => setDiscardOutboxId(item.id)}
                  onCancelDiscard={() => setDiscardOutboxId(null)}
                  onDiscard={() => void runOutboxAction(item.id, 'discard')}
                  labels={t}
                />
              )}
            />
          )}
        </Modal>
      )}

      <TagCatalogPicker
        isOpen={resolutionPickerOpen && resolutionEntry?.kind === 'tag'}
        assignedTagIds={resolutionEntry ? [resolutionEntry.clientId] : []}
        initialGroupId={resolutionEntry?.groupId}
        allowAssignedSelection
        triggerRef={resolutionTriggerRef}
        title={t('admin.tags.outbox.chooseExistingTag')}
        onClose={() => setResolutionPickerOpen(false)}
        onSelect={(_snapshot, tag) => {
          setResolutionPickerOpen(false)
          setResolutionTagTarget(tag)
        }}
      />

      <TagGroupCatalogPicker
        isOpen={resolutionPickerOpen && resolutionEntry?.kind === 'group'}
        triggerRef={resolutionTriggerRef}
        title={t('admin.tags.outbox.chooseExistingGroup')}
        onClose={() => setResolutionPickerOpen(false)}
        onSelect={(group) => {
          setResolutionPickerOpen(false)
          setResolutionGroupTarget(group)
        }}
      />

      {resolutionEntry && (resolutionTagTarget || resolutionGroupTarget) && (
        <Modal
          data-testid="tag-outbox-resolution-dialog"
          title={t('admin.tags.outbox.resolveTitle')}
          onClose={closeOutboxResolution}
          closeDisabled={outboxBusyIds.has(resolutionEntry.id)}
          maxWidthClassName="max-w-[680px]"
          footer={<>
            <Button variant="secondary" onClick={closeOutboxResolution} disabled={outboxBusyIds.has(resolutionEntry.id)}>{t('common.cancel')}</Button>
            <Button
              onClick={() => void confirmOutboxResolution()}
              disabled={outboxBusyIds.has(resolutionEntry.id)}
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t('admin.tags.outbox.mapToExisting')}
            </Button>
          </>}
        >
          <div className="space-y-4">
            <div className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-bg px-3.5 py-3 text-warning-text">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p className="text-[11px] leading-relaxed">
                {resolutionEntry.kind === 'tag'
                  ? t('admin.tags.outbox.tagMappingExplanation')
                  : t('admin.tags.outbox.groupMappingExplanation', { count: resolutionDependentCount })}
              </p>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-stretch gap-2">
              <ResolutionCard
                eyebrow={t('admin.tags.outbox.localDraft')}
                title={resolutionEntry.label}
                subtitle={resolutionEntry.kind === 'tag' ? resolutionEntry.groupName : resolutionEntry.description}
                color={resolutionEntry.color}
                tone="local"
              />
              <div className="flex items-center justify-center text-fg-subtle">
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </div>
              <ResolutionCard
                eyebrow={t('admin.tags.outbox.canonicalValue')}
                title={resolutionTagTarget?.value ?? resolutionGroupTarget?.name ?? ''}
                subtitle={resolutionTagTarget?.groupName ?? resolutionGroupTarget?.description ?? null}
                color={resolutionTagTarget?.color ?? null}
                tone="canonical"
              />
            </div>
            <p className="rounded-lg border border-line bg-surface-50 px-3 py-2.5 text-[10.5px] leading-relaxed text-fg-secondary">
              {t('admin.tags.outbox.auditExplanation')}
            </p>
            {resolutionError && <p role="alert" className="text-[11px] text-error-text">{resolutionError}</p>}
          </div>
        </Modal>
      )}

      {bulkAction && (
        <Modal
          data-testid="admin-tags-bulk-dialog"
          title={t(`admin.tags.bulk.${bulkAction}Title`)}
          onClose={() => setBulkAction(null)}
          closeDisabled={actionBusy}
          footer={<>
            <Button variant="secondary" onClick={() => setBulkAction(null)} disabled={actionBusy}>{t('common.cancel')}</Button>
            <Button
              variant={bulkAction === 'archive' ? 'danger' : 'primary'}
              onClick={() => void runBulkAction()}
              disabled={actionBusy || impactLoading
                || (bulkAction === 'move' && !bulkGroupId)
                || (bulkAction === 'recolor' && !/^#[0-9A-F]{6}$/.test(bulkColor))}
            >
              {actionBusy ? t('admin.tags.bulk.applying') : t(`admin.tags.bulk.${bulkAction}Action`)}
            </Button>
          </>}
        >
          <div className="space-y-4">
            <p className="text-[12px] leading-relaxed text-fg-secondary">
              {t('admin.tags.bulk.selectionSummary', { count: selectedTags.length })}
            </p>
            {bulkAction === 'recolor' && (
              <label className="block text-[11px] font-medium text-fg-secondary">
                {t('admin.tags.color')}
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="color"
                    value={bulkColor}
                    onChange={(event) => setBulkColor(event.target.value.toUpperCase())}
                    aria-label={t('admin.tags.bulk.colorPicker')}
                    className="h-9 w-12 rounded-lg border border-line bg-surface-50 p-1"
                  />
                  <input
                    value={bulkColor}
                    onChange={(event) => setBulkColor(event.target.value.toUpperCase())}
                    aria-label={t('admin.tags.bulk.colorHex')}
                    className="h-9 flex-1 rounded-lg border border-line bg-surface-50 px-3 font-mono text-[12px] text-fg outline-none focus:border-accent"
                  />
                </div>
              </label>
            )}
            {bulkAction === 'move' && (
              <label className="block text-[11px] font-medium text-fg-secondary">
                {t('admin.tags.bulk.destinationGroup')}
                <select
                  value={bulkGroupId}
                  onChange={(event) => setBulkGroupId(event.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-2.5 text-[12px] text-fg outline-none focus:border-accent"
                >
                  {activeGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </label>
            )}
            {bulkAction === 'archive' && (
              impactLoading ? (
                <div className="h-20 animate-pulse rounded-lg bg-surface-200" role="status" aria-label={t('admin.tags.bulk.loadingImpact')} />
              ) : (
                <div className="rounded-xl border border-warning-border bg-warning-bg p-3">
                  <div className="text-[11px] font-semibold text-warning-text">{t('admin.tags.bulk.impactTitle')}</div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <ImpactMetric value={usageTotals.assignments} label={t('admin.tags.bulk.assignments')} />
                    <ImpactMetric value={usageTotals.objects} label={t('admin.tags.bulk.objects')} />
                    <ImpactMetric value={usageTotals.groups} label={t('admin.tags.bulk.groups')} />
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-warning-text">{t('admin.tags.bulk.archiveKeepsAssignments')}</p>
                </div>
              )
            )}
            {bulkAction === 'restore' && (
              <p className="rounded-lg border border-line bg-surface-50 p-3 text-[11px] leading-relaxed text-fg-secondary">
                {t('admin.tags.bulk.restoreDescription')}
              </p>
            )}
          </div>
        </Modal>
      )}

      <TagCatalogPicker
        isOpen={mergePickerOpen}
        assignedTagIds={mergeSource ? [mergeSource.id] : []}
        triggerRef={mergeTriggerRef}
        title={t('admin.tags.chooseMergeTarget')}
        onClose={() => setMergePickerOpen(false)}
        onSelect={(_snapshot, tag) => {
          setMergePickerOpen(false)
          setMergeTarget(tag)
        }}
      />

      {mergeSource && mergeTarget && (
        <Modal
          title={t('admin.tags.mergeTitle')}
          onClose={() => setMergeTarget(null)}
          closeDisabled={actionBusy}
          footer={<>
            <Button variant="secondary" onClick={() => setMergeTarget(null)} disabled={actionBusy}>{t('common.cancel')}</Button>
            <Button
              onClick={() => {
                setActionBusy(true)
                void mergeCatalogTags(orgId, mergeSource, mergeTarget)
                  .then(() => {
                    setMergeTarget(null)
                    setMergeSource(null)
                    refresh()
                  })
                  .catch((cause) => setError(cause instanceof Error ? cause.message : t('admin.tags.actionFailed')))
                  .finally(() => setActionBusy(false))
              }}
              disabled={actionBusy}
            >
              <GitMerge className="h-3.5 w-3.5" />{t('admin.tags.mergeAction')}
            </Button>
          </>}
        >
          <p className="text-[12px] leading-relaxed text-fg-secondary">
            {t('admin.tags.mergeDescription', { source: mergeSource.value, target: mergeTarget.value })}
          </p>
        </Modal>
      )}
    </div>
  )
}

function LoadingMore({ label }: { label: string }) {
  return <div className="border-t border-line py-3 text-center text-[11px] text-fg-subtle" role="status">{label}</div>
}

function ReadModelHealthPanel({ health, loading, error, onRetry, labels }: {
  health: OrgReadModelHealth | null
  loading: boolean
  error: string | null
  onRetry: () => void
  labels: ReturnType<typeof useTranslation>['t']
}) {
  const statusTone: Record<ReadModelWorkspaceStatus, string> = {
    healthy: 'bg-success-bg text-success-text',
    // Serving its last coherent read model with a subsystem behind: closer to
    // failed than to a transient backlog.
    degraded: 'bg-warning-bg text-warning-text',
    // Durable writes the projector never saw. Nothing is coming to fix it on its
    // own, so it reads as a warning rather than as a backlog.
    stale: 'bg-warning-bg text-warning-text',
    catching_up: 'bg-accent-subtle text-accent',
    failed: 'bg-error-bg text-error-text',
    idle: 'bg-surface-200 text-fg-secondary',
    uninitialized: 'bg-warning-bg text-warning-text',
  }
  const issueCount = health ? Math.max(0, health.totalWorkspaceCount - health.counts.healthy) : 0

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface-50" aria-labelledby="read-model-health-title">
      <div className="flex items-start justify-between gap-3 border-b border-line px-3.5 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-200 text-fg-secondary">
            <Database className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 id="read-model-health-title" className="text-[11px] font-semibold text-fg">{labels('admin.tags.operations.readModel.title')}</h3>
            <p className="mt-0.5 text-[10px] leading-relaxed text-fg-subtle">{labels('admin.tags.operations.readModel.description')}</p>
          </div>
        </div>
        {health?.enabled && (
          <div className="shrink-0 text-right">
            <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{labels('admin.tags.operations.readModel.worstLag')}</div>
            <div className="mt-0.5 text-[13px] font-semibold tabular-nums text-fg">{formatOperationDuration(health.worstLagMs)}</div>
          </div>
        )}
      </div>

      {error ? (
        <div className="p-3"><InlineError message={error} onRetry={onRetry} /></div>
      ) : loading && !health ? (
        <div className="grid grid-cols-5 gap-2 p-3" aria-label={labels('admin.tags.operations.readModel.loading')}>
          {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-surface-200" />)}
        </div>
      ) : health && !health.enabled ? (
        <div className="flex items-start gap-2.5 p-3 text-[10.5px] text-fg-secondary">
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          {labels('admin.tags.operations.readModel.disabled')}
        </div>
      ) : health ? (
        <div>
          <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-7">
            {(['healthy', 'degraded', 'stale', 'catching_up', 'failed', 'idle', 'uninitialized'] as const).map((status) => (
              <div key={status} className="min-w-0 bg-surface-50 px-3 py-2.5">
                {/* `?? 0`, not `health.counts[status]`: during a rolling deploy this
                    page can be served by a new frontend and answered by an older
                    server that has never heard of a status added since. An
                    undefined here threw and took the whole Operations dialog with
                    it — the one place an operator goes to find out what is wrong. */}
                <div className="text-[15px] font-semibold tabular-nums text-fg">{(health.counts[status] ?? 0).toLocaleString()}</div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusTone[status]}`} aria-hidden="true" />
                  <span className="truncate text-[9px] font-semibold uppercase tracking-[0.06em] text-fg-subtle" title={labels(`admin.tags.operations.readModel.statuses.${status}`)}>
                    {labels(`admin.tags.operations.readModel.statuses.${status}`)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {issueCount === 0 ? (
            <div className="flex items-center gap-2 border-t border-line px-3.5 py-3 text-[10.5px] text-success-text">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {labels('admin.tags.operations.readModel.allHealthy')}
            </div>
          ) : (
            <div className="border-t border-line">
              <div className="flex items-center justify-between gap-3 px-3.5 py-2">
                <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                  {labels('admin.tags.operations.readModel.requiresAttention', { count: issueCount })}
                </span>
                {health.listedWorkspaceCount < issueCount && (
                  <span className="text-[9px] text-fg-subtle">{labels('admin.tags.operations.readModel.showing', { count: health.listedWorkspaceCount })}</span>
                )}
              </div>
              <ul className="max-h-40 overflow-y-auto border-t border-line">
                {health.workspaces.map((workspace) => (
                  <li key={`${workspace.landscapeId}/${workspace.versionId}`} className="flex min-w-0 items-center justify-between gap-3 border-b border-line px-3.5 py-2 last:border-b-0">
                    <div className="min-w-0">
                      <div className="truncate text-[10.5px] font-semibold text-fg">{workspace.landscapeName}</div>
                      <div className="truncate text-[9.5px] text-fg-subtle">
                        {workspace.versionName}
                        {workspace.lastErrorCode ? ` · ${workspace.lastErrorCode}` : ''}
                        {!workspace.lastErrorCode && workspace.degradedErrorCode
                          ? ` · ${workspace.degradedKind ?? ''} ${workspace.degradedErrorCode}`.trimEnd()
                          : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {workspace.pendingGenerations > 0 && (
                        <span className="text-[9.5px] tabular-nums text-fg-subtle">
                          {labels('admin.tags.operations.readModel.pending', { count: workspace.pendingGenerations, lag: formatOperationDuration(workspace.lagMs) })}
                        </span>
                      )}
                      <span className={`rounded-full px-2 py-1 text-[9px] font-semibold ${statusTone[workspace.status]}`}>
                        {labels(`admin.tags.operations.readModel.statuses.${workspace.status}`)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

function OperationMetric({ label, value, tone }: {
  label: string
  value: number
  tone: 'neutral' | 'success' | 'warning' | 'accent' | 'muted'
}) {
  const toneClass = {
    neutral: 'bg-surface-200 text-fg-secondary',
    success: 'bg-success-bg text-success-text',
    warning: 'bg-warning-bg text-warning-text',
    accent: 'bg-accent-subtle text-accent',
    muted: 'bg-surface-200 text-fg-subtle',
  }[tone]
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-50 px-3 py-3">
      <span className={`mb-2 block h-1.5 w-6 rounded-full ${toneClass}`} aria-hidden="true" />
      <div className="text-[20px] font-semibold tabular-nums text-fg">{value.toLocaleString()}</div>
      <div className="mt-0.5 truncate text-[9.5px] font-semibold uppercase tracking-[0.07em] text-fg-subtle" title={label}>{label}</div>
    </div>
  )
}

function ImpactMetric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-warning-border/60 bg-surface-100/50 px-2.5 py-2">
      <div className="font-mono text-[14px] font-semibold text-fg">{value}</div>
      <div className="mt-0.5 text-[9px] font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
    </div>
  )
}

function ResolutionCard({ eyebrow, title, subtitle, color, tone }: {
  eyebrow: string
  title: string
  subtitle: string | null
  color: string | null
  tone: 'local' | 'canonical'
}) {
  return (
    <div className={`min-w-0 rounded-xl border p-3.5 ${tone === 'canonical' ? 'border-accent/40 bg-accent-subtle' : 'border-line bg-surface-50'}`}>
      <div className="mb-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">{eyebrow}</div>
      <div className="flex min-w-0 items-center gap-2">
        {color && <span className="h-3 w-3 shrink-0 rounded-[3px] border border-black/10" style={{ backgroundColor: color }} aria-hidden="true" />}
        <span className="truncate text-[12px] font-semibold text-fg">{title}</span>
      </div>
      <div className="mt-1 min-h-4 truncate text-[10px] text-fg-secondary">{subtitle || '—'}</div>
    </div>
  )
}

function OutboxRow({ item, busy, confirmingDiscard, onRetry, onResolve, onRequestDiscard, onCancelDiscard, onDiscard, labels }: {
  item: TagCatalogOutboxItem
  busy: boolean
  confirmingDiscard: boolean
  onRetry: () => void
  onResolve: (trigger: HTMLElement) => void
  onRequestDiscard: () => void
  onCancelDiscard: () => void
  onDiscard: () => void
  labels: ReturnType<typeof useTranslation>['t']
}) {
  const attention = item.state === 'attention'
  // Any non-retryable catalog conflict may be reconciled to an existing
  // canonical value. The server remains authoritative for capability and
  // target validation, so the UI does not depend on a brittle error-code list.
  const canResolve = attention
  return (
    <div className="grid min-h-[82px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${attention ? 'bg-error-bg text-error-text' : 'bg-warning-bg text-warning-text'}`}>
            {attention ? <TriangleAlert className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-semibold text-fg">{item.label}</div>
            <div className="truncate text-[9.5px] text-fg-subtle">
              {item.kind === 'tag'
                ? labels('admin.tags.outbox.tagInGroup', { group: item.groupName })
                : labels('admin.tags.outbox.tagGroup')}
              {' · '}
              <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
            </div>
          </div>
        </div>
        <p className={`mt-1.5 truncate text-[10px] ${attention ? 'text-error-text' : 'text-fg-secondary'}`} title={item.lastError?.message}>
          {item.lastError?.message ?? labels('admin.tags.outbox.waitingForConnection')}
          {item.attemptCount > 0 && ` · ${labels('admin.tags.outbox.attemptCount', { count: item.attemptCount })}`}
        </p>
      </div>
      {confirmingDiscard ? (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onCancelDiscard} disabled={busy}>{labels('common.cancel')}</Button>
          <Button variant="danger" size="sm" onClick={onDiscard} disabled={busy}>
            <Trash2 className="h-3 w-3" />{labels('admin.tags.outbox.confirmDiscard')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          {canResolve && (
            <Button variant="secondary" size="sm" onClick={(event) => onResolve(event.currentTarget)} disabled={busy}>
              <Link2 className="h-3 w-3" />{labels('admin.tags.outbox.resolve')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onRetry} disabled={busy}>
            <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />{labels('admin.tags.outbox.retry')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRequestDiscard} disabled={busy} aria-label={labels('admin.tags.outbox.discardLabel', { label: item.label })}>
            <Trash2 className="h-3 w-3" />{labels('admin.tags.outbox.discard')}
          </Button>
        </div>
      )}
    </div>
  )
}

function CatalogRow({
  mark, title, subtitle, status, revision, busy, selected, selectionDisabled, selectLabel, syncState,
  onSelect, onEdit, onDetails, onLifecycle, onMerge, labels,
}: {
  mark: React.ReactNode
  title: string
  subtitle: string
  status: string
  revision: number
  busy: boolean
  syncState?: TagCatalogOutboxItem['state']
  selected?: boolean
  selectionDisabled?: boolean
  selectLabel?: string
  onSelect?: () => void
  onEdit?: () => void
  onDetails?: () => void
  onLifecycle?: () => void
  onMerge?: (element: HTMLElement) => void
  labels: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className={`grid h-[52px] ${onSelect ? 'grid-cols-[20px_minmax(220px,1fr)_110px_70px_auto]' : 'grid-cols-[minmax(220px,1fr)_110px_70px_auto]'} items-center gap-3 border-b border-line px-4`}>
      {onSelect && (
        <input
          type="checkbox"
          checked={selected}
          disabled={selectionDisabled || busy}
          onChange={onSelect}
          aria-label={selectLabel}
          className="h-3.5 w-3.5 rounded border-line accent-[var(--color-accent)]"
        />
      )}
      <div className="flex min-w-0 items-center gap-3">
        {mark}
        <div className="min-w-0"><div className="truncate text-[12px] font-semibold text-fg">{title}</div><div className="truncate text-[10px] text-fg-subtle">{subtitle}</div></div>
      </div>
      <span className={`w-fit rounded-full px-2 py-1 text-[9px] font-semibold uppercase tracking-wide ${syncState === 'attention' ? 'bg-error-bg text-error-text' : syncState === 'pending' ? 'bg-warning-bg text-warning-text' : 'bg-surface-200 text-fg-secondary'}`}>
        {syncState ? labels(`admin.tags.outbox.states.${syncState}`) : status}
      </span>
      <span className="font-mono text-[10px] text-fg-subtle">r{revision}</span>
      <div className="flex justify-end gap-1">
        {onDetails && <Button variant="ghost" size="sm" onClick={onDetails} disabled={busy}><History className="h-3 w-3" />{labels('admin.tags.details.open')}</Button>}
        {onEdit && <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}><Pencil className="h-3 w-3" />{labels('admin.tags.edit')}</Button>}
        {onMerge && <Button variant="ghost" size="sm" onClick={(event) => onMerge(event.currentTarget)} disabled={busy}><GitMerge className="h-3 w-3" />{labels('admin.tags.merge')}</Button>}
        {onLifecycle && <Button variant="ghost" size="sm" onClick={onLifecycle} disabled={busy}>
          {status === 'active' ? <Archive className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
          {status === 'active' ? labels('admin.tags.archive') : labels('admin.tags.restore')}
        </Button>}
      </div>
    </div>
  )
}

function CatalogEditorModal({ editor, groups, orgId, onClose, onSaved }: {
  editor: Editor
  groups: CatalogTagGroup[]
  orgId: string
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const isTag = editor.kind === 'tag'
  const existingTag = isTag ? editor.value : undefined
  const existingGroup = !isTag ? editor.value : undefined
  const [name, setName] = useState(existingTag?.value ?? existingGroup?.name ?? '')
  const [description, setDescription] = useState(existingGroup?.description ?? '')
  const [selectedGroupId, setSelectedGroupId] = useState(existingTag?.groupId ?? groups[0]?.id ?? '')
  const [color, setColor] = useState(existingTag?.color ?? '#D97A3D')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim() || (isTag && !selectedGroupId)) return
    setBusy(true)
    setError(null)
    try {
      if (isTag) {
        if (existingTag) await updateCatalogTag(orgId, existingTag.id, { value: name, groupId: selectedGroupId, color }, existingTag.version)
        else await createCatalogTag(orgId, { value: name, groupId: selectedGroupId, color })
      } else if (existingGroup) {
        await updateCatalogTagGroup(orgId, existingGroup.id, { name, description: description || null }, existingGroup.version)
      } else {
        await createCatalogTagGroup(orgId, { name, description: description || null })
      }
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('admin.tags.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={existingTag || existingGroup ? t('admin.tags.editTitle') : isTag ? t('admin.tags.createTagTitle') : t('admin.tags.createGroupTitle')}
      onClose={onClose}
      closeDisabled={busy}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button onClick={() => void save()} disabled={busy || !name.trim() || (isTag && !selectedGroupId)}>{t('common.save')}</Button></>}
    >
      <div className="space-y-3">
        <label className="block text-[11px] font-medium text-fg-secondary">
          {isTag ? t('admin.tags.value') : t('admin.tags.groupName')}
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={256} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent" />
        </label>
        {isTag ? <>
          <label className="block text-[11px] font-medium text-fg-secondary">{t('admin.tags.group')}
            <select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-2.5 text-[12px] text-fg outline-none focus:border-accent">
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </label>
          <label className="block text-[11px] font-medium text-fg-secondary">{t('admin.tags.color')}
            <div className="mt-1 flex items-center gap-2"><input type="color" aria-label={t('admin.tags.colorPicker')} value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} className="h-9 w-12 rounded-lg border border-line bg-surface-50 p-1" /><input aria-label={t('admin.tags.colorHex')} value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} pattern="^#[0-9A-Fa-f]{6}$" className="h-9 flex-1 rounded-lg border border-line bg-surface-50 px-3 font-mono text-[12px] text-fg outline-none focus:border-accent" /></div>
          </label>
        </> : <label className="block text-[11px] font-medium text-fg-secondary">{t('admin.tags.description')}
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1 min-h-20 w-full resize-y rounded-lg border border-line bg-surface-50 px-3 py-2 text-[12px] text-fg outline-none focus:border-accent" />
        </label>}
        {error && <p role="alert" className="text-[11px] text-error-text">{error}</p>}
      </div>
    </Modal>
  )
}
