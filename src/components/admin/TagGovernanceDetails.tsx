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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Box, ExternalLink, FolderTree, GitMerge, History, Layers3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  getCatalogTagUsageSummary,
  listCatalogTagAssignments,
  listCatalogTagAudit,
  type CatalogTag,
  type CatalogTagAssignment,
  type CatalogTagAssignmentKind,
  type CatalogTagAuditEntry,
  type CatalogTagUsageCount,
} from '../../lib/tags/api'
import { timeAgo } from '../../lib/orgAdmin/timeAgo'
import { VirtualList } from '../common/VirtualList'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'
import { EmptyState, InlineError } from './shared'

type DetailTab = 'assignments' | 'activity'
type AssignmentFilter = CatalogTagAssignmentKind | 'all'

interface TagGovernanceDetailsProps {
  orgId: string
  tag: CatalogTag
  onClose: () => void
}

export function TagGovernanceDetails({ orgId, tag, onClose }: TagGovernanceDetailsProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<DetailTab>('assignments')
  const [assignmentFilter, setAssignmentFilter] = useState<AssignmentFilter>('all')
  const [auditAction, setAuditAction] = useState('')
  const [assignments, setAssignments] = useState<CatalogTagAssignment[]>([])
  const [auditEntries, setAuditEntries] = useState<CatalogTagAuditEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState<CatalogTagUsageCount | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void getCatalogTagUsageSummary(orgId, [tag.id], controller.signal)
      .then((items) => setUsage(items[0] ?? null))
      .catch(() => setUsage(null))
    return () => controller.abort()
  }, [orgId, tag.id])

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    setNextCursor(null)
    const request = tab === 'assignments'
      ? listCatalogTagAssignments(orgId, tag.id, { kind: assignmentFilter, limit: 50 }, signal)
      : listCatalogTagAudit(orgId, tag.id, { action: auditAction || undefined, limit: 50 }, signal)
    void request
      .then((page) => {
        if (tab === 'assignments') setAssignments(page.items as CatalogTagAssignment[])
        else setAuditEntries(page.items as CatalogTagAuditEntry[])
        setNextCursor(page.nextCursor)
      })
      .catch((cause) => {
        if (!signal?.aborted) setError(cause instanceof Error ? cause.message : t('admin.tags.details.loadFailed'))
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false)
      })
  }, [assignmentFilter, auditAction, orgId, t, tab, tag.id])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const loadMore = useCallback(() => {
    if (!nextCursor || loading || loadingMore) return
    setLoadingMore(true)
    const request = tab === 'assignments'
      ? listCatalogTagAssignments(orgId, tag.id, { kind: assignmentFilter, after: nextCursor, limit: 50 })
      : listCatalogTagAudit(orgId, tag.id, { action: auditAction || undefined, after: nextCursor, limit: 50 })
    void request
      .then((page) => {
        if (tab === 'assignments') setAssignments((current) => mergePage(current, page.items as CatalogTagAssignment[], assignmentKey))
        else setAuditEntries((current) => mergePage(current, page.items as CatalogTagAuditEntry[], (entry) => entry.id))
        setNextCursor(page.nextCursor)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('admin.tags.details.loadFailed')))
      .finally(() => setLoadingMore(false))
  }, [assignmentFilter, auditAction, loading, loadingMore, nextCursor, orgId, t, tab, tag.id])

  const usageLabel = useMemo(() => usage ? t('admin.tags.details.assignmentCount', {
    count: usage.totalAssignments,
    objects: usage.objectAssignments,
    groups: usage.groupAssignments,
  }) : t('admin.tags.details.assignmentCountLoading'), [t, usage])

  return (
    <Modal
      data-testid="tag-governance-details"
      title={t('admin.tags.details.title', { value: tag.value })}
      onClose={onClose}
      maxWidthClassName="max-w-[760px]"
      contentClassName="min-h-[500px]"
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-50 px-3.5 py-3">
        <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-fg">{tag.value}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-fg-subtle">
            <span>{tag.groupName}</span>
            <span aria-hidden="true">·</span>
            <span className="uppercase tracking-wide">{tag.lifecycleStatus}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">r{tag.version}</span>
            {tag.canonicalTagId && <span className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-1.5 py-0.5 text-warning-text">
              <GitMerge className="h-2.5 w-2.5" />{t('admin.tags.details.mergedIdentity')}
            </span>}
          </div>
        </div>
        <div className="hidden text-right sm:block">
          <div className="font-mono text-[11px] text-fg-secondary">{usage?.totalAssignments ?? '—'}</div>
          <div className="text-[9px] uppercase tracking-wide text-fg-subtle">{t('admin.tags.details.assignments')}</div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-1 rounded-lg bg-surface-200 p-1" role="tablist">
        <DetailTabButton active={tab === 'assignments'} onClick={() => setTab('assignments')}>
          <Layers3 className="h-3.5 w-3.5" />{t('admin.tags.details.assignments')}
        </DetailTabButton>
        <DetailTabButton active={tab === 'activity'} onClick={() => setTab('activity')}>
          <History className="h-3.5 w-3.5" />{t('admin.tags.details.activity')}
        </DetailTabButton>
      </div>

      {tab === 'assignments' ? (
        <div className="mt-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10.5px] text-fg-subtle">{usageLabel}</span>
            <div className="flex items-center gap-1" aria-label={t('admin.tags.details.assignmentFilter')}>
              {(['all', 'object', 'group'] as const).map((kind) => (
                <FilterButton key={kind} active={assignmentFilter === kind} onClick={() => setAssignmentFilter(kind)}>
                  {t(`admin.tags.details.${kind === 'all' ? 'all' : kind === 'object' ? 'objects' : 'groups'}`)}
                </FilterButton>
              ))}
            </div>
          </div>
          <DetailsBody
            loading={loading}
            error={error}
            onRetry={() => load()}
            empty={assignments.length === 0}
            emptyTitle={t('admin.tags.details.noAssignments')}
            emptyDescription={t('admin.tags.details.noAssignmentsDescription')}
          >
            <VirtualList
              items={assignments}
              estimateSize={62}
              className="h-[350px] rounded-xl border border-line bg-surface-50"
              getKey={assignmentKey}
              onEndReached={nextCursor ? loadMore : undefined}
              footer={loadingMore ? <LoadingFooter label={t('admin.tags.loadingMore')} /> : undefined}
              renderRow={(assignment) => <AssignmentRow assignment={assignment} />}
            />
          </DetailsBody>
        </div>
      ) : (
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-fg-subtle">{t('admin.tags.details.appendOnlyHistory')}</span>
            <label className="flex items-center gap-2 text-[10px] text-fg-subtle">
              {t('admin.tags.details.filterAction')}
              <select
                value={auditAction}
                onChange={(event) => setAuditAction(event.target.value)}
                className="h-7 rounded-md border border-line bg-surface-50 px-2 text-[10.5px] text-fg outline-none focus:border-accent"
              >
                <option value="">{t('admin.tags.details.allActions')}</option>
                <option value="tag.create">{t('admin.tags.details.created')}</option>
                <option value="tag.update">{t('admin.tags.details.updated')}</option>
                <option value="tag.archive">{t('admin.tags.archive')}</option>
                <option value="tag.restore">{t('admin.tags.restore')}</option>
                <option value="tag.merge">{t('admin.tags.merge')}</option>
                <option value="tag.batch.">{t('admin.tags.details.bulkActions')}</option>
              </select>
            </label>
          </div>
          <DetailsBody
            loading={loading}
            error={error}
            onRetry={() => load()}
            empty={auditEntries.length === 0}
            emptyTitle={t('admin.tags.details.noActivity')}
            emptyDescription={t('admin.tags.details.noActivityDescription')}
          >
            <VirtualList
              items={auditEntries}
              estimateSize={82}
              className="h-[350px] rounded-xl border border-line bg-surface-50"
              getKey={(entry) => entry.id}
              onEndReached={nextCursor ? loadMore : undefined}
              footer={loadingMore ? <LoadingFooter label={t('admin.tags.loadingMore')} /> : undefined}
              renderRow={(entry) => <AuditRow entry={entry} currentTagId={tag.id} />}
            />
          </DetailsBody>
        </div>
      )}
    </Modal>
  )
}

function DetailTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors ${active ? 'bg-surface-100 text-fg shadow-sm' : 'text-fg-subtle hover:text-fg'}`}>{children}</button>
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`h-6 rounded-md px-2 text-[10px] font-medium transition-colors ${active ? 'bg-inverse text-on-inverse' : 'bg-surface-200 text-fg-secondary hover:bg-surface-hover'}`}>{children}</button>
}

function DetailsBody({ loading, error, onRetry, empty, emptyTitle, emptyDescription, children }: {
  loading: boolean
  error: string | null
  onRetry: () => void
  empty: boolean
  emptyTitle: string
  emptyDescription: string
  children: React.ReactNode
}) {
  if (loading) return <div className="h-[350px] animate-pulse rounded-xl bg-surface-200" />
  if (error) return <div className="pt-3"><InlineError message={error} onRetry={onRetry} /></div>
  if (empty) return <div className="flex h-[350px] items-center justify-center rounded-xl border border-line bg-surface-50 px-6"><EmptyState title={emptyTitle} description={emptyDescription} /></div>
  return children
}

function AssignmentRow({ assignment }: { assignment: CatalogTagAssignment }) {
  const { t } = useTranslation()
  const url = `/app/landscape/${encodeURIComponent(assignment.landscapeId)}/version/${encodeURIComponent(assignment.versionId)}/model`
  return (
    <div className="flex h-[62px] items-center gap-3 border-b border-line px-3.5 last:border-0">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-200 text-fg-secondary">
        {assignment.kind === 'object' ? <Box className="h-3.5 w-3.5" /> : <FolderTree className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] font-medium text-fg">{assignment.entityName}</span>
          <span className="shrink-0 rounded-full bg-surface-200 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-fg-subtle">
            {assignment.entityType || t(`admin.tags.details.${assignment.kind}`)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-fg-subtle">
          {assignment.landscapeName} · {assignment.versionName} · <span className="font-mono">{shortId(assignment.entityId)}</span>
        </div>
      </div>
      <a href={url} target="_blank" rel="noreferrer" aria-label={t('admin.tags.details.openWorkspace', { name: assignment.entityName })} title={t('admin.tags.details.openWorkspace', { name: assignment.entityName })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg">
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  )
}

function AuditRow({ entry, currentTagId }: { entry: CatalogTagAuditEntry; currentTagId: string }) {
  const { t } = useTranslation()
  const changes = auditChanges(entry.detail)
  const actor = entry.actorEmail || shortId(entry.actorUserId)
  return (
    <div className="min-h-[82px] border-b border-line px-3.5 py-2.5 last:border-0">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-200 text-fg-secondary">
          <Activity className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11.5px] font-semibold text-fg">{actionLabel(entry.action, t)}</span>
            {entry.targetId !== currentTagId && <span className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-1.5 py-0.5 font-mono text-[8.5px] text-warning-text"><GitMerge className="h-2.5 w-2.5" />{shortId(entry.targetId)}</span>}
            <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()} className="ml-auto shrink-0 text-[9.5px] text-fg-subtle">{timeAgo(entry.at)}</time>
          </div>
          <div className="mt-0.5 text-[9.5px] text-fg-subtle">
            {t('admin.tags.details.byActor', { actor })}
            {entry.impersonatorUserId ? ` · ${t('admin.tags.details.impersonatedBy', { actor: entry.impersonatorEmail || shortId(entry.impersonatorUserId) })}` : ''}
          </div>
          {changes.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">
            {changes.map((change) => <span key={change.field} className="max-w-full truncate rounded-md border border-line bg-surface-100 px-1.5 py-0.5 text-[9px] text-fg-secondary" title={`${change.before} → ${change.after}`}>
              <span className="font-medium text-fg">{humanize(change.field)}</span> {change.before} → {change.after}
            </span>)}
          </div>}
        </div>
      </div>
    </div>
  )
}

function auditChanges(detail: unknown): Array<{ field: string; before: string; after: string }> {
  const record = asRecord(detail)
  const before = asRecord(record?.before)
  const after = asRecord(record?.after)
  if (!before && !after) return []
  const ignored = new Set(['id', 'orgId', 'groupId', 'createdAt', 'updatedAt', 'version'])
  const preferred = ['value', 'groupName', 'color', 'lifecycleStatus', 'canonicalTagId', 'description', 'name', 'iconKey']
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((key) => !ignored.has(key) && !equalValue(before?.[key], after?.[key]))
    .sort((left, right) => preferredRank(left, preferred) - preferredRank(right, preferred))
  return keys.slice(0, 4).map((field) => ({
    field,
    before: compactValue(before?.[field]),
    after: compactValue(after?.[field]),
  }))
}

function preferredRank(field: string, preferred: readonly string[]): number {
  const index = preferred.indexOf(field)
  return index === -1 ? preferred.length : index
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function compactValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  const serialized = JSON.stringify(value)
  return serialized.length > 42 ? `${serialized.slice(0, 39)}…` : serialized
}

function actionLabel(action: string, t: ReturnType<typeof useTranslation>['t']): string {
  const translated = t(`admin.tags.details.actions.${action.replaceAll('.', '_')}`, { defaultValue: '' })
  return translated || humanize(action.replace(/^tag\./, ''))
}

function humanize(value: string): string {
  return value.replace(/[._-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
}

function assignmentKey(assignment: CatalogTagAssignment): string {
  return `${assignment.kind}:${assignment.landscapeId}:${assignment.versionId}:${assignment.entityId}`
}

function mergePage<T>(current: readonly T[], incoming: readonly T[], key: (item: T) => string): T[] {
  const merged = new Map(current.map((item) => [key(item), item]))
  for (const item of incoming) merged.set(key(item), item)
  return [...merged.values()]
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id
}

function LoadingFooter({ label }: { label: string }) {
  return <div className="border-t border-line py-2 text-center text-[10px] text-fg-subtle" role="status">{label}</div>
}
