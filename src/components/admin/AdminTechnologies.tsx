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
import { useParams } from '@tanstack/react-router'
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  ExternalLink,
  GitMerge,
  Globe2,
  Layers3,
  Loader2,
  LockKeyhole,
  MessageSquareWarning,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import * as api from '../../lib/orgAdmin/api'
import { runInBatches } from '../../lib/asyncBatch'
import { cn } from '../../lib/utils'
import type { TechnologyRole, TechnologyShapeType } from '../../types'
import { TechIconBadge } from '../shared/TechIconBadge'
import { VirtualList } from '../common/VirtualList'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'
import { SelectionCheckbox } from '../ui/selection-checkbox'
import { TechnologyIconFields } from '../technologies/TechnologyIconFields'
import { TechnologyIdentityMergeModal } from '../technologies/TechnologyIdentityMergeModal'
import { EmptyState, InlineError, SectionCard, SkeletonRows } from './shared'

type PageStatus = 'loading' | 'ok' | 'error'

const TECHNOLOGY_SHAPE_OPTIONS: TechnologyShapeType[] = ['system', 'app', 'store', 'component', 'group']
const TECHNOLOGY_ROLE_OPTIONS: TechnologyRole[] = [
  'primary', 'language', 'runtime', 'framework', 'library', 'database', 'storage',
  'messaging', 'protocol', 'platform', 'infrastructure', 'tooling', 'other',
]

export function AdminTechnologies() {
  const { orgId } = useParams({ from: '/org/$orgId/admin/technologies' })
  const { t } = useTranslation()
  const [rows, setRows] = useState<api.OrgTechnology[]>([])
  const [status, setStatus] = useState<PageStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [catalogView, setCatalogView] = useState<'effective' | 'submissions'>('effective')
  const [scope, setScope] = useState<'all' | api.TechnologyScope>('all')
  const [workflow, setWorkflow] = useState<'all' | api.TechnologyRevisionStatus>('all')
  const [lifecycle, setLifecycle] = useState<'all' | api.TechnologyLifecycleStatus>('all')
  const [policy, setPolicy] = useState<'all' | 'none'>('all')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [revisionTechnology, setRevisionTechnology] = useState<api.OrgTechnology | null>(null)
  const [mergeTechnology, setMergeTechnology] = useState<api.OrgTechnology | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedTechnologyIds, setSelectedTechnologyIds] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const load = useCallback(
    async (append = false) => {
      if (!append) setStatus('loading')
      else setLoadingMore(true)
      setError(null)
      try {
        const page = await api.getTechnologies(orgId, {
          q: appliedQuery || undefined,
          scope,
          status: workflow,
          lifecycle,
          view: catalogView,
          after: append ? nextCursor : null,
          limit: 50,
        })
        setRows((current) => (append ? [...current, ...page.technologies] : page.technologies))
        setNextCursor(page.nextCursor)
        setPolicy(page.policy)
        setStatus('ok')
        if (!append) setSelectedTechnologyIds(new Set())
      } catch (err) {
        setError(err instanceof Error ? err.message : t('admin.technologies.failedToLoad'))
        setStatus('error')
      } finally {
        setLoadingMore(false)
      }
    },
    [appliedQuery, catalogView, lifecycle, nextCursor, orgId, scope, t, workflow]
  )

  useEffect(() => {
    // Data loading owns the status transition; this is the route/filter sync point.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(false)
    // `load` includes nextCursor for the append path; a cursor update must not
    // reload page one, so the initial/filter fetch is intentionally scoped here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, appliedQuery, scope, workflow, lifecycle, catalogView])

  const selected = rows.find((row) => row.id === selectedId) ?? null
  const selectableTechnologies = useMemo(
    () => catalogView === 'effective'
      ? rows.filter((technology) => technology.scope === 'public' && technology.lifecycleStatus !== 'merged')
      : [],
    [catalogView, rows],
  )
  const selectedCount = selectableTechnologies.filter((technology) => selectedTechnologyIds.has(technology.id)).length
  const allSelectableSelected = selectableTechnologies.length > 0 && selectedCount === selectableTechnologies.length
  const searchMergeTargets = useCallback(
    (searchQuery: string) => api.searchTechnologies(orgId, searchQuery, 12),
    [orgId],
  )

  const changePolicy = async (next: 'all' | 'none') => {
    if (next === policy) return
    const previous = policy
    setPolicy(next)
    try {
      await api.setTechnologyPolicy(orgId, next)
      await load(false)
    } catch (err) {
      setPolicy(previous)
      setError(err instanceof Error ? err.message : t('admin.technologies.failedToUpdatePolicy'))
    }
  }

  const changeOverride = async (technology: api.OrgTechnology, state: 'enabled' | 'hidden' | null) => {
    setBusyId(technology.id)
    setError(null)
    try {
      await api.setTechnologyOverride(orgId, technology.id, state)
      await load(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.technologies.failedToUpdate'))
    } finally {
      setBusyId(null)
    }
  }

  const changePrivateLifecycle = async (technology: api.OrgTechnology, lifecycleStatus: 'active' | 'retired') => {
    setBusyId(technology.id)
    setError(null)
    try {
      await api.setPrivateTechnologyLifecycle(orgId, technology.id, lifecycleStatus)
      await load(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.technologies.failedToUpdate'))
    } finally {
      setBusyId(null)
    }
  }

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore || status === 'loading') return
    void load(true)
  }, [load, loadingMore, nextCursor, status])

  const toggleAllSelectable = (checked: boolean) => {
    setSelectedTechnologyIds((current) => {
      const next = new Set(current)
      selectableTechnologies.forEach((technology) => {
        if (checked) next.add(technology.id)
        else next.delete(technology.id)
      })
      return next
    })
  }

  const bulkChangeOverride = async (state: 'enabled' | 'hidden') => {
    const selectedTechnologies = selectableTechnologies.filter((technology) => selectedTechnologyIds.has(technology.id))
    if (selectedTechnologies.length === 0) return
    setBulkBusy(true)
    setError(null)
    const results = await runInBatches(
      selectedTechnologies,
      (technology) => api.setTechnologyOverride(orgId, technology.id, state),
    )
    const failedIds = new Set(results.filter((result) => result.status === 'rejected').map((result) => result.item.id))
    setSelectedTechnologyIds(failedIds)
    if (failedIds.size > 0) {
      setError(t('admin.technologies.bulkUpdateFailed', {
        count: failedIds.size,
        defaultValue: '{{count}} technologies could not be updated. They remain selected.',
      }))
    }
    setBulkBusy(false)
    if (failedIds.size === 0) await load(false)
  }

  return (
    <div data-testid="admin-technologies" className="mx-auto flex max-w-[1380px] flex-col px-8 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Layers3 className="h-5 w-5 text-accent" />
            <h1 className="text-[20px] font-semibold text-fg">{t('admin.technologies.title')}</h1>
          </div>
          <p className="max-w-2xl text-[13px] leading-relaxed text-fg-secondary">
            {t('admin.technologies.subtitle')}
          </p>
        </div>
        <Button data-testid="technology-add" size="lg" className="gap-2" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('admin.technologies.add')}
        </Button>
      </div>

      <div className="mb-4 inline-flex w-fit rounded-lg border border-line bg-surface-100 p-1" role="tablist">
        {(['effective', 'submissions'] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={catalogView === view}
            onClick={() => {
              setCatalogView(view)
              setScope('all')
              setWorkflow('all')
              setLifecycle('all')
              setSelectedId(null)
            }}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
              catalogView === view
                ? 'bg-inverse text-on-inverse shadow-sm'
                : 'text-fg-secondary hover:bg-surface-200 hover:text-fg',
            )}
          >
            {view === 'effective'
              ? t('admin.technologies.effectiveCatalog')
              : t('admin.technologies.submissionsHistory')}
          </button>
        ))}
      </div>

      <SectionCard className="mb-4 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <form
            role="search"
            className="relative min-w-[260px] flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              setAppliedQuery(query.trim())
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              data-testid="technology-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('admin.technologies.searchPlaceholder')}
              className="h-9 w-full rounded-lg border border-line bg-surface-50 pl-9 pr-9 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent"
            />
            {query && (
              <button
                type="button"
                aria-label={t('admin.technologies.clearSearch')}
                onClick={() => {
                  setQuery('')
                  setAppliedQuery('')
                }}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </form>
          <FilterSelect
            label={t('admin.technologies.scope')}
            value={scope}
            onChange={(value) => setScope(value as typeof scope)}
            options={[
              ['all', t('admin.technologies.allScopes')],
              ['public', t('admin.technologies.public')],
              ['org_private', t('admin.technologies.private')],
            ]}
          />
          <FilterSelect
            label={t('admin.technologies.workflowStatus')}
            value={workflow}
            onChange={(value) => setWorkflow(value as typeof workflow)}
            options={[
              ['all', t('admin.technologies.allWorkflowStatuses')],
              ['draft', t('admin.technologies.draft')],
              ['in_review', t('admin.technologies.waitingPublicReview')],
              ['changes_requested', t('admin.technologies.statusChangesRequested')],
              ['approved', t('admin.technologies.statusApproved')],
              ['rejected', t('admin.technologies.statusRejected')],
            ]}
          />
          <FilterSelect
            label={t('admin.technologies.lifecycle')}
            value={lifecycle}
            onChange={(value) => setLifecycle(value as typeof lifecycle)}
            options={[
              ['all', t('admin.technologies.allLifecycles')],
              ['active', t('admin.technologies.active')],
              ['deprecated', t('admin.technologies.deprecated')],
              ['retired', t('admin.technologies.retired')],
              ...(catalogView === 'submissions'
                ? [['merged', t('admin.technologies.merged')] as [string, string]]
                : []),
            ]}
          />
        </div>
        {catalogView === 'effective' && <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-50 px-4 py-2.5">
          <div className="flex items-center gap-2 text-[12px] text-fg-secondary">
            <span className="font-medium text-fg">{t('admin.technologies.publicCatalogPolicy')}</span>
            <span>{t('admin.technologies.policyDescription')}</span>
          </div>
          <div className="inline-flex rounded-lg border border-line bg-surface-100 p-0.5" role="group">
            {(['all', 'none'] as const).map((value) => (
              <button
                key={value}
                onClick={() => void changePolicy(value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[11.5px] font-medium transition-colors',
                  policy === value ? 'bg-inverse text-on-inverse' : 'text-fg-secondary hover:bg-surface-200'
                )}
              >
                {value === 'all' ? t('admin.technologies.policyAll') : t('admin.technologies.policyNone')}
              </button>
            ))}
          </div>
        </div>}
      </SectionCard>

      {error && <div className="mb-4"><InlineError message={error} onRetry={() => void load(false)} /></div>}
      {status === 'loading' && <SkeletonRows rows={8} />}
      {status === 'ok' && rows.length === 0 && (
        <EmptyState title={t('admin.technologies.emptyTitle')} description={t('admin.technologies.emptyDescription')} />
      )}
      {status === 'ok' && rows.length > 0 && (
        <SectionCard className="overflow-hidden">
          {selectedCount > 0 && (
            <div data-testid="technology-bulk-toolbar" className="flex flex-wrap items-center justify-between gap-3 border-b border-accent/25 bg-accent-subtle px-4 py-2.5">
              <span className="text-[12px] font-medium text-fg">
                {t('admin.technologies.selectedCount', { count: selectedCount, defaultValue: '{{count}} selected' })}
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => void bulkChangeOverride('hidden')}>
                  {t('admin.technologies.hideSelected', { defaultValue: 'Hide selected' })}
                </Button>
                <Button size="sm" disabled={bulkBusy} onClick={() => void bulkChangeOverride('enabled')}>
                  {bulkBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {t('admin.technologies.enableSelected', { defaultValue: 'Enable selected' })}
                </Button>
                <button type="button" disabled={bulkBusy} onClick={() => setSelectedTechnologyIds(new Set())} className="rounded-md px-2 py-1 text-[11px] text-fg-secondary hover:bg-surface-200 hover:text-fg">
                  {t('admin.technologies.clearSelection', { defaultValue: 'Clear' })}
                </button>
              </div>
            </div>
          )}
          <div role="table" aria-rowcount={rows.length} className="min-w-[980px]">
            <div role="row" className="grid grid-cols-[42px_minmax(280px,1.4fr)_110px_minmax(150px,.7fr)_80px_minmax(300px,1fr)_42px] items-center gap-2 border-b border-line bg-surface-50 px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
              <span role="columnheader" className="flex justify-center">
                {catalogView === 'effective' && (
                  <SelectionCheckbox checked={allSelectableSelected} indeterminate={selectedCount > 0 && !allSelectableSelected} disabled={selectableTechnologies.length === 0 || bulkBusy} label={t('admin.technologies.selectLoaded', { defaultValue: 'Select loaded public technologies' })} onChange={toggleAllSelectable} testId="technology-select-all" />
                )}
              </span>
              <span role="columnheader">{t('admin.technologies.columnTechnology')}</span>
              <span role="columnheader">{t('admin.technologies.columnScope')}</span>
              <span role="columnheader">{t('admin.technologies.columnCategory')}</span>
              <span role="columnheader">{t('admin.technologies.columnRevision')}</span>
              <span role="columnheader">{t('admin.technologies.columnAvailability')}</span>
              <span role="columnheader" />
            </div>
            <div data-testid="technology-virtual-list">
              <VirtualList
                items={rows}
                estimateSize={64}
                maxHeight="min(68vh, 720px)"
                overscan={8}
                getKey={(technology) => technology.id}
                onEndReached={loadMore}
                renderRow={(technology) => (
                  <TechnologyRow
                    technology={technology}
                    policy={policy}
                    busy={busyId === technology.id || bulkBusy}
                    selectable={catalogView === 'effective' && technology.scope === 'public' && technology.lifecycleStatus !== 'merged'}
                    selected={selectedTechnologyIds.has(technology.id)}
                    onSelect={(checked) => setSelectedTechnologyIds((current) => {
                      const next = new Set(current)
                      if (checked) next.add(technology.id)
                      else next.delete(technology.id)
                      return next
                    })}
                    onOpen={() => setSelectedId(technology.id)}
                    onOverride={(state) => void changeOverride(technology, state)}
                    onPrivateLifecycle={(state) => void changePrivateLifecycle(technology, state)}
                    onMerge={() => setMergeTechnology(technology)}
                  />
                )}
                footer={loadingMore ? (
                  <div className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-[11px] text-fg-subtle">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t('admin.technologies.loadingMore')}
                  </div>
                ) : null}
              />
            </div>
          </div>
        </SectionCard>
      )}

      {selected && (
        <TechnologyDetail
          technology={selected}
          orgId={orgId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load(false)}
          onCreateRevision={() => {
            setRevisionTechnology(selected)
            setSelectedId(null)
          }}
        />
      )}
      {revisionTechnology && (
        <CreateTechnologyRevisionFlow
          orgId={orgId}
          technology={revisionTechnology}
          onClose={() => setRevisionTechnology(null)}
          onChanged={() => {
            setRevisionTechnology(null)
            void load(false)
          }}
        />
      )}
      {createOpen && (
        <CreateTechnologyFlow
          orgId={orgId}
          policy={policy}
          onClose={() => setCreateOpen(false)}
          onSelectExisting={(technology) => {
            setCreateOpen(false)
            setSelectedId(technology.id)
            setQuery(technology.revision.name)
            setAppliedQuery(technology.revision.name)
            setScope('all')
            setWorkflow('all')
            setLifecycle('all')
          }}
          onChanged={() => {
            setCreateOpen(false)
            void load(false)
          }}
        />
      )}
      {mergeTechnology && (
        <TechnologyIdentityMergeModal
          source={mergeTechnology}
          search={searchMergeTargets}
          onClose={() => setMergeTechnology(null)}
          onMerge={(targetTechnologyId) => api.mergePrivateTechnologyIdentity(
            orgId,
            mergeTechnology.id,
            targetTechnologyId,
          )}
          onMerged={() => {
            setMergeTechnology(null)
            setSelectedId(null)
            void load(false)
          }}
        />
      )}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<[string, string]>
  onChange: (value: string) => void
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] font-medium text-fg-subtle">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-lg border border-line bg-surface-100 px-3 text-[12px] text-fg-secondary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  )
}

function TechnologyRow({
  technology,
  policy,
  busy,
  onOpen,
  onOverride,
  onPrivateLifecycle,
  onMerge,
  selectable,
  selected,
  onSelect,
}: {
  technology: api.OrgTechnology
  policy: 'all' | 'none'
  busy: boolean
  onOpen: () => void
  onOverride: (state: 'enabled' | 'hidden' | null) => void
  onPrivateLifecycle: (state: 'active' | 'retired') => void
  onMerge: () => void
  selectable: boolean
  selected: boolean
  onSelect: (checked: boolean) => void
}) {
  const { t } = useTranslation()
  const available = isTechnologyAvailable(technology)
  return (
    <div role="row" data-testid="technology-row" className={cn(
      'group grid min-h-16 grid-cols-[42px_minmax(280px,1.4fr)_110px_minmax(150px,.7fr)_80px_minmax(300px,1fr)_42px] items-center gap-2 border-b border-line px-3 hover:bg-surface-50',
      selected && 'bg-accent-subtle/70',
    )}>
      <div role="cell" className="flex justify-center">
        {selectable && (
          <SelectionCheckbox
            checked={selected}
            disabled={busy}
            label={t('admin.technologies.selectTechnology', { name: technology.revision.name, defaultValue: 'Select {{name}}' })}
            onChange={onSelect}
            testId={`technology-select-${technology.id}`}
          />
        )}
      </div>
      <div role="cell" className="py-3">
        <button onClick={onOpen} className="flex min-w-0 items-center gap-3 text-left">
          <TechnologyMark technology={technology} />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-fg">{technology.revision.name}</span>
            <span className="block truncate text-[11px] text-fg-subtle">
              {technology.revision.publisher || technology.revision.websiteUrl || technology.id}
            </span>
          </span>
        </button>
      </div>
      <div role="cell" className="py-3">
        <ScopeBadge scope={technology.scope} />
      </div>
      <div role="cell" className="py-3 text-[12px] text-fg-secondary">{technology.revision.category || '—'}</div>
      <div role="cell" className="py-3">
        <span className="font-mono text-[11px] text-fg-subtle">r{technology.revision.revision}</span>
      </div>
      <div role="cell" className="py-3">
        <div className="flex items-center gap-2">
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
            available ? 'bg-success-bg text-success-text' : 'bg-surface-200 text-fg-subtle'
          )}>
            {available && <Check className="h-3 w-3" />}
            {availabilityLabel(technology, policy, t)}
          </span>
          {technology.scope === 'public' && (
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {available ? (
                <button
                  disabled={busy}
                  onClick={() => onOverride('hidden')}
                  className="rounded-md px-2 py-1 text-[10.5px] text-fg-subtle hover:bg-surface-200 hover:text-fg"
                >
                  {t('admin.technologies.hide')}
                </button>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => onOverride('enabled')}
                  className="rounded-md px-2 py-1 text-[10.5px] text-accent hover:bg-accent-subtle"
                >
                  {t('admin.technologies.enable')}
                </button>
              )}
              {technology.orgOverride !== null && (
                <button
                  title={t('admin.technologies.resetPolicy')}
                  disabled={busy}
                  onClick={() => onOverride(null)}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          {technology.scope === 'org_private' && technology.lifecycleStatus !== 'merged' && (
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                disabled={busy}
                onClick={onMerge}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] text-accent hover:bg-accent-subtle"
              >
                <GitMerge className="h-3 w-3" aria-hidden="true" />
                {t('admin.technologies.merge', { defaultValue: 'Merge' })}
              </button>
              <button
                disabled={busy}
                onClick={() => onPrivateLifecycle(technology.lifecycleStatus === 'retired' ? 'active' : 'retired')}
                className="rounded-md px-2 py-1 text-[10.5px] text-fg-subtle hover:bg-surface-200 hover:text-fg"
              >
                {technology.lifecycleStatus === 'retired'
                  ? t('admin.technologies.restoreToCatalog')
                  : t('admin.technologies.removeFromCatalog')}
              </button>
            </div>
          )}
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-subtle" />}
        </div>
      </div>
      <div role="cell" className="py-3">
        <button
          aria-label={t('admin.technologies.openDetails')}
          onClick={onOpen}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function TechnologyMark({ technology, size = 'md' }: { technology: api.OrgTechnology; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cn(
      'flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-100 font-semibold text-accent',
      size === 'sm' && 'h-7 w-7 text-[9px]',
      size === 'md' && 'h-9 w-9 text-[10px]',
      size === 'lg' && 'h-12 w-12 text-[12px]'
    )}>
      <TechIconBadge
        name={technology.revision.name}
        iconLightPath={technology.revision.iconLightPath ?? undefined}
        iconDarkPath={technology.revision.iconDarkPath ?? undefined}
        size={size}
      />
    </span>
  )
}

function ScopeBadge({ scope }: { scope: api.TechnologyScope }) {
  const { t } = useTranslation()
  const Icon = scope === 'public' ? Globe2 : LockKeyhole
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
      scope === 'public' ? 'border-accent/25 bg-accent-subtle text-accent' : 'border-line bg-surface-200 text-fg-secondary'
    )}>
      <Icon className="h-3 w-3" />
      {scope === 'public' ? t('admin.technologies.public') : t('admin.technologies.private')}
    </span>
  )
}

function isTechnologyAvailable(technology: api.OrgTechnology): boolean {
  if (!['active', 'deprecated'].includes(technology.lifecycleStatus)) return false
  if (technology.scope === 'org_private') return technology.revision.privateApproved
  return technology.revision.status === 'approved' && technology.orgState === 'enabled'
}

function availabilityLabel(technology: api.OrgTechnology, policy: 'all' | 'none', t: TFunction): string {
  if (technology.lifecycleStatus === 'merged') {
    return t('admin.technologies.mergedInto', {
      name: technology.canonicalTechnologyName ?? technology.canonicalTechnologyId ?? '—',
    })
  }
  if (technology.scope === 'org_private') {
    if (technology.revision.privateApproved) {
      if (technology.revision.status === 'in_review') return t('admin.technologies.publicReview')
      if (technology.revision.status === 'changes_requested') return t('admin.technologies.changesRequested')
      if (technology.revision.status === 'rejected') return t('admin.technologies.publicRejected')
      return t('admin.technologies.privateApproved')
    }
    return t('admin.technologies.draft')
  }
  if (technology.orgState === 'enabled') {
    return t(technology.orgOverride === 'enabled'
      ? 'admin.technologies.explicitEnabled'
      : 'admin.technologies.inheritedEnabled')
  }
  return t(technology.orgOverride === 'hidden' || policy === 'all'
    ? 'admin.technologies.explicitHidden'
    : 'admin.technologies.policyDisabled')
}

function TechnologyDetail({
  technology,
  orgId,
  onClose,
  onChanged,
  onCreateRevision,
}: {
  technology: api.OrgTechnology
  orgId: string
  onClose: () => void
  onChanged: () => void
  onCreateRevision: () => void
}) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewReason, setReviewReason] = useState('')
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const focusFirst = () => {
      const first = panelRef.current?.querySelector<HTMLElement>(focusableSelector)
      ;(first ?? panelRef.current)?.focus()
    }
    const timer = window.setTimeout(focusFirst, 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)]
      if (focusable.length === 0) {
        event.preventDefault()
        panelRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [onClose])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.technologies.failedToUpdate'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="technology-detail-title"
        tabIndex={-1}
        className="flex h-full w-full max-w-[440px] flex-col border-l border-line bg-surface-100 shadow-xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <span id="technology-detail-title" className="text-[13px] font-semibold text-fg">{t('admin.technologies.details')}</span>
          <button onClick={onClose} aria-label={t('common.close')} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-5 flex items-center gap-3">
            <TechnologyMark technology={technology} size="lg" />
            <div className="min-w-0">
              <h2 className="truncate text-[17px] font-semibold text-fg">{technology.revision.name}</h2>
              <div className="mt-1 flex items-center gap-2"><ScopeBadge scope={technology.scope} /></div>
            </div>
          </div>
          <p className="mb-5 text-[13px] leading-relaxed text-fg-secondary">
            {technology.revision.description || t('admin.technologies.noDescription')}
          </p>
          <DetailSection title={t('admin.technologies.metadata')}>
            <DetailRow label={t('admin.technologies.publisher')} value={technology.revision.publisher || '—'} />
            <DetailRow label={t('admin.technologies.category')} value={technology.revision.category || '—'} />
            <DetailRow label={t('admin.technologies.ecosystem')} value={technology.revision.ecosystem || '—'} />
            <DetailRow label={t('admin.technologies.catalogRevision')} value={`r${technology.revision.revision}`} mono />
          </DetailSection>
          <DetailSection title={t('admin.technologies.usageGuidance')}>
            <DetailRow
              label={t('admin.technologies.recommendedShapes')}
              value={(technology.revision.recommendedShapeTypes ?? [])
                .map((shapeType) => t(`admin.technologies.shapeTypes.${shapeType}`))
                .join(', ') || '\u2014'}
            />
            <DetailRow
              label={t('admin.technologies.defaultRole')}
              value={t(`layoutNav.rightSidebar.technologyRole.${technology.revision.defaultRole ?? 'other'}`)}
            />
          </DetailSection>
          <DetailSection title={t('admin.technologies.iconPreview')}>
            <div className="grid grid-cols-2 gap-2">
              <IconPreview label={t('admin.technologies.light')} path={technology.revision.iconLightPath} name={technology.revision.name} dark={false} />
              <IconPreview label={t('admin.technologies.dark')} path={technology.revision.iconDarkPath} name={technology.revision.name} dark />
            </div>
          </DetailSection>
          {(technology.revision.websiteUrl || technology.revision.documentationUrl) && (
            <DetailSection title={t('admin.technologies.links')}>
              {[technology.revision.websiteUrl, technology.revision.documentationUrl].filter(Boolean).map((url) => (
                <a key={url} href={url!} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 truncate text-[12px] text-accent hover:underline">
                  <ExternalLink className="h-3 w-3 shrink-0" />{url}
                </a>
              ))}
            </DetailSection>
          )}
          {technology.revision.decisionNote && (
            <DetailSection title={t('admin.technologies.reviewDecision')}>
              <div className="rounded-lg border border-warning-border bg-warning-bg p-3 text-[12px] leading-relaxed text-fg-secondary">
                {technology.revision.decisionNote}
              </div>
            </DetailSection>
          )}
          {error && <p className="mb-3 text-[12px] text-error-text">{error}</p>}
          {technology.scope === 'org_private' && (
            <div className="space-y-3">
              {!technology.revision.privateApproved && technology.revision.status === 'draft' && (
                <div className="rounded-xl border border-line bg-surface-50 p-3">
                  <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-fg">
                    <MessageSquareWarning className="h-4 w-4 text-warning-text" aria-hidden="true" />
                    {t('admin.technologies.organizationReview')}
                  </div>
                  <textarea
                    data-testid="private-technology-review-reason"
                    value={reviewReason}
                    onChange={(event) => setReviewReason(event.target.value)}
                    placeholder={t('admin.technologies.reviewReasonPlaceholder')}
                    className="mb-2 min-h-20 w-full resize-y rounded-lg border border-line bg-surface-100 px-3 py-2 text-[11px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => void run(() => api.approvePrivateTechnology(orgId, technology.id, technology.revision.revision))}>
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('admin.technologies.approvePrivate')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy || !reviewReason.trim()}
                      onClick={() => void run(() => api.decidePrivateTechnology(orgId, technology.id, technology.revision.revision, 'changes_requested', reviewReason.trim()))}
                    >
                      {t('admin.technologies.requestChanges')}
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy || !reviewReason.trim()}
                      onClick={() => void run(() => api.decidePrivateTechnology(orgId, technology.id, technology.revision.revision, 'rejected', reviewReason.trim()))}
                    >
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('admin.technologies.reject')}
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
              {technology.revision.status !== 'in_review' && (
                <Button variant="secondary" disabled={busy} onClick={onCreateRevision}>
                  {t('admin.technologies.createRevision')}
                </Button>
              )}
              {technology.revision.privateApproved && technology.revision.status === 'approved' && (
                <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.submitTechnologyPublic(orgId, technology.id, technology.revision.revision))}>
                  {t('admin.technologies.submitPublic')}
                </Button>
              )}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

function CreateTechnologyRevisionFlow({
  orgId,
  technology,
  onClose,
  onChanged,
}: {
  orgId: string
  technology: api.OrgTechnology
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const revision = technology.revision
  const [draft, setDraft] = useState<api.TechnologyDraftInput>({
    name: revision.name,
    description: revision.description ?? undefined,
    websiteUrl: revision.websiteUrl ?? undefined,
    documentationUrl: revision.documentationUrl ?? undefined,
    aliases: revision.aliases,
    category: revision.category ?? undefined,
    iconLightPath: revision.iconLightPath ?? undefined,
    iconDarkPath: revision.iconDarkPath ?? undefined,
    publisher: revision.publisher ?? undefined,
    ecosystem: revision.ecosystem ?? undefined,
    recommendedShapeTypes: revision.recommendedShapeTypes ?? [],
    defaultRole: revision.defaultRole ?? 'other',
  })
  const [busy, setBusy] = useState(false)
  const [iconUploading, setIconUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verifiedName, setVerifiedName] = useState<string | null>(null)
  const [matches, setMatches] = useState<api.OrgTechnology[]>([])
  const [overrideReason, setOverrideReason] = useState('')

  const updateName = (name: string) => {
    setDraft((current) => ({ ...current, name }))
    if (normalizeDuplicateName(name) !== verifiedName) {
      setVerifiedName(null)
      setMatches([])
      setOverrideReason('')
    }
  }

  const save = async () => {
    const name = draft.name.trim()
    if (!name || busy || iconUploading || !draft.recommendedShapeTypes?.length || !draft.defaultRole) return
    setBusy(true)
    setError(null)
    try {
      const normalizedName = normalizeDuplicateName(name)
      let probableMatches = matches
      if (verifiedName !== normalizedName) {
        const result = await api.searchTechnologies(orgId, name)
        probableMatches = result.matches.filter((match) => match.id !== technology.id)
        setVerifiedName(normalizedName)
        setMatches(probableMatches)
        if (probableMatches.length > 0) return
      }
      if (probableMatches.length > 0 && !overrideReason.trim()) return
      await api.createTechnologyRevision(orgId, technology.id, {
        ...draft,
        name,
        duplicateCheck: {
          query: name,
          confirmedNoMatch: true,
          overrideReason: overrideReason.trim() || undefined,
        },
      })
      onChanged()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('admin.technologies.revisionFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('admin.technologies.createRevisionTitle', { name: revision.name })}
      onClose={onClose}
      closeDisabled={iconUploading}
      maxWidthClassName="max-w-[700px]"
      data-testid="technology-revision-flow"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy || iconUploading}>{t('common.cancel')}</Button>
          <Button data-testid="technology-revision-submit" onClick={() => void save()} disabled={busy || iconUploading || !draft.name.trim() || !draft.recommendedShapeTypes?.length || !draft.defaultRole}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {verifiedName === normalizeDuplicateName(draft.name)
              ? t('admin.technologies.createRevision')
              : t('admin.technologies.verifyAndCreateRevision')}
          </Button>
        </>
      )}
    >
      <p className="mb-4 text-[12px] leading-relaxed text-fg-secondary">
        {t('admin.technologies.revisionDescription', { revision: revision.revision + 1 })}
      </p>
      <div className="grid max-h-[520px] grid-cols-2 gap-3 overflow-y-auto pr-1 max-[620px]:grid-cols-1">
        <div className="col-span-2 max-[620px]:col-span-1">
          <DraftField label={t('admin.technologies.name')} value={draft.name} onChange={updateName} required />
        </div>
        <DraftField label={t('admin.technologies.publisher')} value={draft.publisher || ''} onChange={(publisher) => setDraft({ ...draft, publisher })} />
        <DraftField label={t('admin.technologies.category')} value={draft.category || ''} onChange={(category) => setDraft({ ...draft, category })} />
        <DraftField label={t('admin.technologies.ecosystem')} value={draft.ecosystem || ''} onChange={(ecosystem) => setDraft({ ...draft, ecosystem })} />
        <DraftField label={t('admin.technologies.website')} value={draft.websiteUrl || ''} onChange={(websiteUrl) => setDraft({ ...draft, websiteUrl })} />
        <div className="col-span-2 max-[620px]:col-span-1">
          <DraftField label={t('admin.technologies.documentation')} value={draft.documentationUrl || ''} onChange={(documentationUrl) => setDraft({ ...draft, documentationUrl })} />
        </div>
        <label className="col-span-2 block text-[11px] font-medium text-fg-subtle max-[620px]:col-span-1">
          {t('admin.technologies.description')}
          <textarea
            value={draft.description || ''}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            className="mt-1.5 min-h-[88px] w-full resize-y rounded-lg border border-line bg-surface-50 p-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </label>
        <div className="col-span-2 max-[620px]:col-span-1">
          <TechnologyGuidanceFields
            recommendedShapeTypes={draft.recommendedShapeTypes ?? []}
            defaultRole={draft.defaultRole ?? 'other'}
            disabled={busy}
            onRecommendedShapeTypesChange={(recommendedShapeTypes) => setDraft((current) => ({ ...current, recommendedShapeTypes }))}
            onDefaultRoleChange={(defaultRole) => setDraft((current) => ({ ...current, defaultRole }))}
          />
        </div>
        <div className="col-span-2 max-[620px]:col-span-1">
          <TechnologyIconFields
            orgId={orgId}
            name={draft.name}
            value={draft}
            disabled={busy}
            onUploadingChange={setIconUploading}
            onChange={(field, path) => setDraft((current) => ({ ...current, [field]: path }))}
          />
        </div>
        {matches.length > 0 && (
          <div className="col-span-2 rounded-xl border border-warning-text/25 bg-warning-bg p-3.5 max-[620px]:col-span-1">
            <div className="text-[11px] font-semibold text-fg">{t('admin.technologies.revisionMatchesTitle')}</div>
            <p className="mt-1 text-[10.5px] text-fg-secondary">
              {matches.slice(0, 4).map((match) => match.revision.name).join(', ')}
            </p>
            <label className="mt-3 block text-[10.5px] font-medium text-fg-subtle">
              {t('admin.technologies.reasonLabel')}
              <textarea
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                className="mt-1.5 min-h-[64px] w-full resize-y rounded-lg border border-line bg-surface-100 p-2.5 text-[11px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </label>
          </div>
        )}
      </div>
      {error && <p className="mt-3 text-[12px] text-error-text" role="alert">{error}</p>}
    </Modal>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 border-t border-line pt-4">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[12px]">
      <span className="text-fg-subtle">{label}</span>
      <span className={cn('truncate text-right text-fg-secondary', mono && 'font-mono')}>{value}</span>
    </div>
  )
}

function IconPreview({ label, path, name, dark }: { label: string; path: string | null; name: string; dark: boolean }) {
  const initials = name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase()
  const [catalogPath, setCatalogPath] = useState<string | undefined>()
  useEffect(() => {
    if (path) return
    let active = true
    void import('../../lib/techIcons').then(({ getIconByName }) => {
      const catalogIcon = getIconByName(name)
      const resolved = dark
        ? catalogIcon?.iconDark ?? catalogIcon?.iconLight
        : catalogIcon?.iconLight ?? catalogIcon?.iconDark
      if (active) setCatalogPath(resolved)
    })
    return () => { active = false }
  }, [dark, name, path])
  const previewPath = path ?? catalogPath
  return (
    <div className={cn('rounded-lg border p-3', dark ? 'border-[#3a3835] bg-[#171615]' : 'border-line bg-[#f7f5f1]')}>
      <div className="mb-2 text-[9px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className={cn('flex h-12 items-center justify-center rounded-md', dark ? 'bg-[#242220]' : 'bg-white')}>
        {previewPath ? <img src={previewPath} alt="" className="h-8 w-8 object-contain" /> : <span className="text-[11px] font-semibold text-accent">{initials}</span>}
      </div>
    </div>
  )
}

type CreateStage = 'search' | 'results' | 'confirm' | 'draft'

function normalizeDuplicateName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function mergeAiProposalIntoDraft(
  current: api.TechnologyDraftInput,
  draftAtRequest: api.TechnologyDraftInput,
  proposal: api.TechnologyAiProposal,
  versionsAtRequest: Partial<Record<keyof api.TechnologyDraftInput, number>>,
  currentVersions: Partial<Record<keyof api.TechnologyDraftInput, number>>
): api.TechnologyDraftInput {
  const empty = (value: api.TechnologyDraftInput[keyof api.TechnologyDraftInput]) =>
    value === undefined
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0)
  const canPrefill = (field: keyof api.TechnologyDraftInput) =>
    (versionsAtRequest[field] ?? 0) === (currentVersions[field] ?? 0)
    && empty(draftAtRequest[field])
    && empty(current[field])
  // `other` is the safe form default, not an administrator decision. AI Assist
  // may replace it until the role field has actually been touched; once it has,
  // the normal optimistic field-version guard protects the human choice.
  const canPrefillUntouchedDefaultRole =
    (versionsAtRequest.defaultRole ?? 0) === (currentVersions.defaultRole ?? 0)
    && (currentVersions.defaultRole ?? 0) === 0
    && draftAtRequest.defaultRole === 'other'
    && current.defaultRole === 'other'
  return {
    ...current,
    ...(canPrefill('name') && proposal.name ? { name: proposal.name } : {}),
    ...(canPrefill('description') && proposal.description !== undefined
      ? { description: proposal.description }
      : {}),
    ...(canPrefill('websiteUrl') && proposal.websiteUrl !== undefined
      ? { websiteUrl: proposal.websiteUrl }
      : {}),
    ...(canPrefill('documentationUrl') && proposal.documentationUrl !== undefined
      ? { documentationUrl: proposal.documentationUrl }
      : {}),
    ...(canPrefill('aliases') && proposal.aliases !== undefined ? { aliases: proposal.aliases } : {}),
    ...(canPrefill('category') && proposal.category !== undefined ? { category: proposal.category } : {}),
    ...(canPrefill('publisher') && proposal.publisher !== undefined ? { publisher: proposal.publisher } : {}),
    ...(canPrefill('ecosystem') && proposal.ecosystem !== undefined ? { ecosystem: proposal.ecosystem } : {}),
    ...(canPrefill('recommendedShapeTypes') && proposal.recommendedShapeTypes !== undefined
      ? { recommendedShapeTypes: proposal.recommendedShapeTypes }
      : {}),
    ...((canPrefill('defaultRole') || canPrefillUntouchedDefaultRole) && proposal.defaultRole !== undefined
      ? { defaultRole: proposal.defaultRole }
      : {}),
  }
}

function CreateTechnologyFlow({
  orgId,
  policy,
  onClose,
  onSelectExisting,
  onChanged,
}: {
  orgId: string
  policy: 'all' | 'none'
  onClose: () => void
  onSelectExisting: (technology: api.OrgTechnology) => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [stage, setStage] = useState<CreateStage>('search')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<api.OrgTechnology[]>([])
  const [busy, setBusy] = useState(false)
  const [iconUploading, setIconUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const [proposal, setProposal] = useState<api.TechnologyAiProposal | null>(null)
  const [aiSetupRequired, setAiSetupRequired] = useState(false)
  const [draft, setDraft] = useState<api.TechnologyDraftInput>({
    name: '',
    recommendedShapeTypes: [],
    defaultRole: 'other',
  })
  const [lastSearchedQuery, setLastSearchedQuery] = useState('')
  const researchAbortRef = useRef<AbortController | null>(null)
  const researchRequestIdRef = useRef(0)
  const draftFieldVersionsRef = useRef<Partial<Record<keyof api.TechnologyDraftInput, number>>>({})

  useEffect(() => () => {
    researchRequestIdRef.current += 1
    researchAbortRef.current?.abort()
    researchAbortRef.current = null
  }, [])

  const updateDraftField = <K extends keyof api.TechnologyDraftInput>(
    field: K,
    value: api.TechnologyDraftInput[K]
  ) => {
    draftFieldVersionsRef.current[field] = (draftFieldVersionsRef.current[field] ?? 0) + 1
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const closeFlow = () => {
    researchRequestIdRef.current += 1
    researchAbortRef.current?.abort()
    researchAbortRef.current = null
    onClose()
  }

  const grouped = useMemo(() => ({
    organization: matches.filter(
      (match) => match.scope === 'org_private' || isTechnologyAvailable(match)
    ),
    public: matches.filter(
      (match) => match.scope === 'public' && !isTechnologyAvailable(match)
    ),
  }), [matches])

  const search = async () => {
    if (!query.trim() || busy) return
    const searchName = query.trim()
    setBusy(true)
    setError(null)
    try {
      const result = await api.searchTechnologies(orgId, searchName)
      if (normalizeDuplicateName(searchName) !== normalizeDuplicateName(lastSearchedQuery)) {
        setOverrideReason('')
      }
      setMatches(result.matches)
      setLastSearchedQuery(searchName)
      setDraft((current) => ({ ...current, name: searchName }))
      setStage('results')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.technologies.searchFailed'))
    } finally {
      setBusy(false)
    }
  }

  const useMatch = async (match: api.OrgTechnology) => {
    if (match.scope === 'org_private') {
      onSelectExisting(match)
      return
    }
    const alreadyAvailable = isTechnologyAvailable(match)
    if (alreadyAvailable) {
      onChanged()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.setTechnologyOverride(orgId, match.id, policy === 'all' && match.orgOverride === 'hidden' ? null : 'enabled')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.technologies.failedToEnable'))
    } finally {
      setBusy(false)
    }
  }

  const research = async () => {
    researchAbortRef.current?.abort()
    const controller = new AbortController()
    researchAbortRef.current = controller
    const requestId = ++researchRequestIdRef.current
    const versionsAtRequest = { ...draftFieldVersionsRef.current }
    const draftAtRequest = { ...draft, aliases: draft.aliases ? [...draft.aliases] : undefined }
    setBusy(true)
    setError(null)
    setAiSetupRequired(false)
    try {
      const result = await api.researchTechnologyMetadata(orgId, draft.name, controller.signal)
      if (controller.signal.aborted || requestId !== researchRequestIdRef.current) return
      setProposal(result.proposal)
      setDraft((current) => mergeAiProposalIntoDraft(
        current,
        draftAtRequest,
        result.proposal,
        versionsAtRequest,
        draftFieldVersionsRef.current
      ))
    } catch (err) {
      if (!controller.signal.aborted && requestId === researchRequestIdRef.current) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : null
        if (code === 'ai-not-configured') setAiSetupRequired(true)
        else setError(err instanceof Error ? err.message : t('admin.technologies.aiFailed'))
      }
    } finally {
      if (researchAbortRef.current === controller && requestId === researchRequestIdRef.current) {
        researchAbortRef.current = null
        setBusy(false)
      }
    }
  }

  const create = async () => {
    if (!draft.name.trim() || iconUploading || !draft.recommendedShapeTypes?.length || !draft.defaultRole) return
    if (normalizeDuplicateName(draft.name) !== normalizeDuplicateName(lastSearchedQuery)) {
      setQuery(draft.name.trim())
      setMatches([])
      setOverrideReason('')
      setStage('search')
      setError(t('admin.technologies.nameChangedSearchAgain'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.createTechnologyDraft(orgId, {
        ...draft,
        name: draft.name.trim(),
        duplicateCheck: {
          query: lastSearchedQuery,
          confirmedNoMatch: true,
          overrideReason: overrideReason || undefined,
        },
      })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.technologies.failedToCreate'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('admin.technologies.addTitle')}
      onClose={closeFlow}
      closeDisabled={iconUploading}
      maxWidthClassName="max-w-[760px]"
      data-testid="technology-create-flow"
      footer={stage === 'draft' ? (
        <>
          <Button variant="secondary" onClick={() => setStage('confirm')} disabled={busy || iconUploading}>{t('common.back')}</Button>
          <Button data-testid="technology-create-submit" onClick={() => void create()} disabled={busy || iconUploading || !draft.name.trim() || !draft.recommendedShapeTypes?.length || !draft.defaultRole}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {t('admin.technologies.createDraft')}
          </Button>
        </>
      ) : undefined}
    >
      <div className="mb-4 flex items-center gap-2" aria-label={t('admin.technologies.creationProgress')}>
        {(['search', 'results', 'confirm', 'draft'] as const).map((item, index) => (
          <div key={item} className="flex flex-1 items-center gap-2">
            <span className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold',
              item === stage ? 'border-accent bg-accent text-accent-text' : index < ['search', 'results', 'confirm', 'draft'].indexOf(stage) ? 'border-success-text bg-success-bg text-success-text' : 'border-line bg-surface-50 text-fg-subtle'
            )}>{index + 1}</span>
            {index < 3 && <span className="h-px flex-1 bg-line" />}
          </div>
        ))}
      </div>

      {(stage === 'search' || stage === 'results') && (
        <>
          <div className="mb-4 rounded-xl border border-accent/20 bg-accent-subtle p-4">
            <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Search className="h-4 w-4 text-accent" />
              {t('admin.technologies.searchFirstTitle')}
            </div>
            <p className="text-[12px] leading-relaxed text-fg-secondary">{t('admin.technologies.searchFirstDescription')}</p>
          </div>
          <form
            onSubmit={(event) => { event.preventDefault(); void search() }}
            className="mb-4 flex gap-2"
          >
            <input
              autoFocus
              data-testid="technology-duplicate-search"
              value={query}
              onChange={(event) => {
                const next = event.target.value
                setQuery(next)
                if (stage === 'results' && normalizeDuplicateName(next) !== normalizeDuplicateName(lastSearchedQuery)) {
                  setMatches([])
                  setStage('search')
                }
              }}
              placeholder={t('admin.technologies.technologyNamePlaceholder')}
              className="h-10 flex-1 rounded-lg border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
            <Button type="submit" size="lg" disabled={!query.trim() || busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {t('admin.technologies.searchCatalog')}
            </Button>
          </form>
        </>
      )}

      {stage === 'results' && (
        <div className="max-h-[430px] overflow-y-auto pr-1" aria-live="polite">
          {matches.length === 0 ? (
            <EmptyState title={t('admin.technologies.noMatches')} description={t('admin.technologies.noMatchesDescription')} />
          ) : (
            <>
              {grouped.organization.length > 0 && (
                <MatchSection title={t('admin.technologies.inYourOrganization')} matches={grouped.organization} busy={busy} onUse={useMatch} />
              )}
              {grouped.public.length > 0 && (
                <MatchSection title={t('admin.technologies.publicCatalog')} matches={grouped.public} busy={busy} onUse={useMatch} />
              )}
            </>
          )}
          <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
            <Button variant="ghost" onClick={() => setStage('search')}>{t('admin.technologies.changeSearch')}</Button>
            <Button variant="secondary" data-testid="technology-continue-new" onClick={() => setStage('confirm')}>
              {t('admin.technologies.continueNew')}<ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {stage === 'confirm' && (
        <div>
          <div className="rounded-xl border border-warning-text/25 bg-warning-bg p-4">
            <h3 className="mb-1 text-[13px] font-semibold text-fg">{t('admin.technologies.confirmNewTitle')}</h3>
            <p className="text-[12px] leading-relaxed text-fg-secondary">{t('admin.technologies.confirmNewDescription', { name: lastSearchedQuery })}</p>
          </div>
          <label className="mt-4 block text-[11px] font-medium text-fg-subtle">
            {t('admin.technologies.reasonLabel')}
            <textarea
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.target.value)}
              placeholder={t('admin.technologies.reasonPlaceholder')}
              className="mt-1.5 min-h-[76px] w-full resize-y rounded-lg border border-line bg-surface-50 p-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </label>
          <div className="mt-5 flex justify-between">
            <Button variant="ghost" onClick={() => setStage('results')}>{t('common.back')}</Button>
            <Button
              data-testid="technology-confirm-new"
              onClick={() => setStage('draft')}
              disabled={matches.length > 0 && !overrideReason.trim()}
            >
              {t('admin.technologies.confirmAndCreate')}<ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {stage === 'draft' && (
        <div className="grid max-h-[500px] grid-cols-[minmax(0,1fr)_260px] gap-5 overflow-y-auto pr-1 max-[760px]:grid-cols-1">
          <div className="space-y-3">
            <DraftField label={t('admin.technologies.name')} value={draft.name} onChange={(name) => updateDraftField('name', name)} required />
            <DraftField label={t('admin.technologies.publisher')} value={draft.publisher || ''} onChange={(publisher) => updateDraftField('publisher', publisher)} />
            <div className="grid grid-cols-2 gap-3">
              <DraftField label={t('admin.technologies.category')} value={draft.category || ''} onChange={(category) => updateDraftField('category', category)} />
              <DraftField label={t('admin.technologies.ecosystem')} value={draft.ecosystem || ''} onChange={(ecosystem) => updateDraftField('ecosystem', ecosystem)} />
            </div>
            <DraftField label={t('admin.technologies.website')} value={draft.websiteUrl || ''} onChange={(websiteUrl) => updateDraftField('websiteUrl', websiteUrl)} />
            <DraftField label={t('admin.technologies.documentation')} value={draft.documentationUrl || ''} onChange={(documentationUrl) => updateDraftField('documentationUrl', documentationUrl)} />
            <label className="block text-[11px] font-medium text-fg-subtle">
              {t('admin.technologies.description')}
              <textarea
                value={draft.description || ''}
                onChange={(event) => updateDraftField('description', event.target.value)}
                className="mt-1.5 min-h-[92px] w-full resize-y rounded-lg border border-line bg-surface-50 p-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </label>
            <TechnologyGuidanceFields
              recommendedShapeTypes={draft.recommendedShapeTypes ?? []}
              defaultRole={draft.defaultRole ?? 'other'}
              disabled={busy}
              onRecommendedShapeTypesChange={(recommendedShapeTypes) => updateDraftField('recommendedShapeTypes', recommendedShapeTypes)}
              onDefaultRoleChange={(defaultRole) => updateDraftField('defaultRole', defaultRole)}
            />
            <TechnologyIconFields
              orgId={orgId}
              name={draft.name}
              value={draft}
              disabled={busy}
              onUploadingChange={setIconUploading}
              onChange={(field, path) => updateDraftField(field, path)}
            />
          </div>
          <aside className="h-fit rounded-xl border border-accent/25 bg-accent-subtle p-4">
            <div className="mb-2 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-text"><Bot className="h-4 w-4" /></div>
              <div>
                <div className="text-[12px] font-semibold text-fg">AI Assist</div>
                <div className="text-[10px] text-fg-subtle">{t('admin.technologies.adminOnly')}</div>
              </div>
            </div>
            <p className="mb-3 text-[11px] leading-relaxed text-fg-secondary">{t('admin.technologies.aiDescription')}</p>
            <Button variant="secondary" size="sm" className="w-full" disabled={busy} onClick={() => void research()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-accent" />}
              {t('admin.technologies.researchAndPrefill')}
            </Button>
            {aiSetupRequired && (
              <div
                data-testid="technology-ai-setup-required"
                className="mt-3 rounded-lg border border-warning-text/20 bg-warning-bg px-3 py-2.5"
                role="alert"
              >
                <div className="text-[10.5px] font-semibold text-warning-text">
                  {t('admin.technologies.aiNotConfiguredTitle')}
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-fg-secondary">
                  {t('admin.technologies.aiNotConfiguredDescription')}
                </p>
                <a
                  href={`/org/${encodeURIComponent(orgId)}/admin/ai`}
                  className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-semibold text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {t('admin.technologies.configureAi')}
                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </a>
              </div>
            )}
            {proposal && (
              <div className="mt-3 border-t border-accent/20 pt-3">
                {proposal.sources.length > 0 && (
                  <>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{t('admin.technologies.sources')}</div>
                    <div className="space-y-1">
                      {proposal.sources.slice(0, 3).map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="block truncate text-[10.5px] text-accent hover:underline">
                          {source.title || source.url}
                        </a>
                      ))}
                    </div>
                  </>
                )}
                <div className="mt-2 text-[10px] text-fg-subtle">{t('admin.technologies.confidence', { value: Math.round(proposal.confidence * 100) })}</div>
                {proposal.warnings.length > 0 && (
                  <div
                    data-testid="technology-ai-warnings"
                    className="mt-2 rounded-lg border border-warning-text/20 bg-warning-bg px-2.5 py-2"
                    aria-label={t('admin.technologies.aiWarningsTitle')}
                  >
                    <div className="text-[10px] font-semibold text-warning-text">
                      {t('admin.technologies.aiWarningsTitle')}
                    </div>
                    <ul className="mt-1.5 space-y-1">
                      {proposal.warnings.slice(0, 4).map((warning, index) => (
                        <li key={`${index}-${warning}`} className="flex gap-1.5 text-[10px] leading-snug text-fg-secondary">
                          <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning-text" />
                          <span>{warning}</span>
                        </li>
                      ))}
                    </ul>
                    {proposal.warnings.length > 4 && (
                      <div className="mt-1.5 text-[9.5px] font-medium text-warning-text">
                        {t('admin.technologies.aiMoreWarnings', { count: proposal.warnings.length - 4 })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
      {error && <p className="mt-3 text-[12px] text-error-text" role="alert">{error}</p>}
    </Modal>
  )
}

function MatchSection({
  title,
  matches,
  busy,
  onUse,
}: {
  title: string
  matches: api.OrgTechnology[]
  busy: boolean
  onUse: (match: api.OrgTechnology) => void
}) {
  const { t } = useTranslation()
  return (
    <section className="mb-4">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      <div className="space-y-2">
        {matches.map((match) => {
          const available = isTechnologyAvailable(match)
          return (
            <div key={match.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface-50 p-3">
              <TechnologyMark technology={match} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-fg">{match.revision.name}</span>
                  <ScopeBadge scope={match.scope} />
                </div>
                <p className="mt-0.5 line-clamp-1 text-[11px] text-fg-subtle">
                  {match.revision.description || match.revision.publisher || match.revision.aliases.join(', ')}
                </p>
              </div>
              <Button size="sm" variant={available || match.scope === 'org_private' ? 'secondary' : 'primary'} disabled={busy} onClick={() => onUse(match)}>
                {match.scope === 'org_private'
                  ? t('admin.technologies.openDetails')
                  : available
                  ? t('admin.technologies.alreadyAvailable')
                  : match.orgOverride === 'hidden'
                    ? t('admin.technologies.showAgain')
                    : t('admin.technologies.enable')}
              </Button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function TechnologyGuidanceFields({
  recommendedShapeTypes,
  defaultRole,
  onRecommendedShapeTypesChange,
  onDefaultRoleChange,
  disabled = false,
}: {
  recommendedShapeTypes: TechnologyShapeType[]
  defaultRole: TechnologyRole
  onRecommendedShapeTypesChange: (shapeTypes: TechnologyShapeType[]) => void
  onDefaultRoleChange: (role: TechnologyRole) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <fieldset className="rounded-xl border border-line bg-surface-50 p-3.5">
      <legend className="px-1 text-[11px] font-semibold text-fg">
        {t('admin.technologies.usageGuidance')}
      </legend>
      <p className="mb-3 text-[10.5px] leading-relaxed text-fg-subtle">
        {t('admin.technologies.usageGuidanceDescription')}
      </p>
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[10.5px] font-medium text-fg-subtle">
            {t('admin.technologies.recommendedShapes')} <span className="text-error-text">*</span>
          </span>
          <span className={cn('text-[9.5px]', recommendedShapeTypes.length ? 'text-fg-subtle' : 'text-error-text')}>
            {recommendedShapeTypes.length
              ? t('admin.technologies.shapeSelectionCount', { count: recommendedShapeTypes.length })
              : t('admin.technologies.shapeSelectionRequired')}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TECHNOLOGY_SHAPE_OPTIONS.map((shapeType) => {
            const selected = recommendedShapeTypes.includes(shapeType)
            return (
              <button
                key={shapeType}
                type="button"
                data-testid={`technology-shape-${shapeType}`}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onRecommendedShapeTypesChange(selected
                  ? recommendedShapeTypes.filter((current) => current !== shapeType)
                  : [...recommendedShapeTypes, shapeType])}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[10.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
                  selected
                    ? 'border-accent/40 bg-accent-subtle text-accent'
                    : 'border-line bg-surface-100 text-fg-secondary hover:border-line-strong hover:text-fg',
                )}
              >
                {t(`admin.technologies.shapeTypes.${shapeType}`)}
              </button>
            )
          })}
        </div>
      </div>
      <label className="block text-[10.5px] font-medium text-fg-subtle">
        {t('admin.technologies.defaultRole')}
        <select
          data-testid="technology-default-role"
          value={defaultRole}
          disabled={disabled}
          onChange={(event) => onDefaultRoleChange(event.target.value as TechnologyRole)}
          className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface-100 px-3 text-[12px] text-fg-secondary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        >
          {TECHNOLOGY_ROLE_OPTIONS.map((role) => (
            <option key={role} value={role}>
              {t(`layoutNav.rightSidebar.technologyRole.${role}`)}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  )
}

function DraftField({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
}) {
  return (
    <label className="block text-[11px] font-medium text-fg-subtle">
      {label}{required && <span className="text-error-text"> *</span>}
      <input
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      />
    </label>
  )
}
