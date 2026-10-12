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
import { User, Monitor, Box, Database, Shapes } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useAuthStore } from '../../stores/authStore'
import { getModelQuery } from '../../lib/modelQuery'
import { cn } from '../../lib/utils'
import {
  WorkspaceShell,
  WorkspacePill,
  PillFilterPopover,
} from '../layout/WorkspaceShell'
import { RightSidebar } from '../layout/RightSidebar'
import { TechnologyFilterSelector } from '../technologies/TechnologyFilterSelector'
import { TagFilterSelector } from '../tags/TagFilterSelector'
import { ModelObjectsTable } from './ModelObjectsTable'
import type { C4Type } from '../../types'

const addOptions = (t: TFunction): { type: C4Type | 'group'; label: string; icon: React.ElementType; testid: string }[] => [
  { type: 'system', label: t('dataViewsB.view.types.system'), icon: Monitor, testid: 'mo-add-system' },
  { type: 'actor', label: t('dataViewsB.view.types.actor'), icon: User, testid: 'mo-add-actor' },
  { type: 'app', label: t('dataViewsB.view.types.app'), icon: Box, testid: 'mo-add-app' },
  { type: 'store', label: t('dataViewsB.view.types.store'), icon: Database, testid: 'mo-add-store' },
  { type: 'group', label: t('dataViewsB.view.types.group'), icon: Shapes, testid: 'mo-add-group' },
]

// New objects land at a slightly scattered spot so consecutive adds don't
// stack exactly (module-level: keeps the impure Math.random out of render).
const scatteredPosition = () => ({
  x: 100 + Math.random() * 200,
  y: 100 + Math.random() * 200,
})

const typeFilters = (t: TFunction): { type: C4Type | 'group'; label: string }[] => [
  { type: 'actor', label: t('dataViewsB.view.types.actor') },
  { type: 'system', label: t('dataViewsB.view.types.system') },
  { type: 'app', label: t('dataViewsB.view.types.app') },
  { type: 'store', label: t('dataViewsB.view.types.store') },
  { type: 'component', label: t('dataViewsB.view.types.component') },
  { type: 'group', label: t('dataViewsB.view.types.group') },
]

/**
 * Model objects — the whole-model tree table on the shared WorkspaceShell.
 * The table reads via getModelQuery() (the seam); do NOT gate on the windowed
 * store's s.objects/s.groups here — under boot-from-server that's the
 * active-diagram window (empty on this page).
 */
export function ModelObjectsView() {
  const { t } = useTranslation()
  const ADD_OPTIONS = addOptions(t)
  const TYPE_FILTERS = typeFilters(t)
  const searchQuery = useUIStore((s) => s.modelObjectsSearchQuery)
  const setSearchQuery = useUIStore((s) => s.setModelObjectsSearchQuery)
  const filter = useUIStore((s) => s.modelObjectsFilter)
  const setFilter = useUIStore((s) => s.setModelObjectsFilter)
  const domainId = useUIStore((s) => s.modelObjectsDomainId)
  const setDomainId = useUIStore((s) => s.setModelObjectsDomainId)
  const domains = useModelStore((s) => s.domains)
  const groups = useModelStore((s) => s.groups)
  const selectedItems = useModelStore((s) => s.selectedItems)
  const addObjectToModel = useModelStore((s) => s.addObjectToModel)
  const addGroup = useModelStore((s) => s.addGroup)
  const getDefaultDomain = useModelStore((s) => s.getDefaultDomain)
  // View-only session: creating objects/groups is a model write the sync gate
  // drops, so don't offer the Add control (server enforces regardless).
  const canManage = !useModelStore((s) => s.workspaceReadOnly)
  const orgId = useAuthStore((s) => s.orgId)

  const [filterOpen, setFilterOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [totals, setTotals] = useState<{ total: number } | null>(null)
  const [teamIds, setTeamIds] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void getModelQuery().modelObjectFacets()
      .then((facets) => {
        if (!cancelled) setTeamIds(facets.teamIds)
      })
      .catch(() => {
        if (!cancelled) setTeamIds([])
      })
    return () => { cancelled = true }
  }, [])

  const activeCount =
    filter.types.length +
    (filter.scope ? 1 : 0) +
    (filter.statuses?.length ?? (filter.status ? 1 : 0)) +
    filter.tagIds.length +
    (filter.technologyIds?.length ?? 0) +
    (filter.teamIds?.length ?? 0) +
    (domainId ? 1 : 0)

  const hasSelection = selectedItems.some((s) => s.type === 'object' || s.type === 'group')

  const handleAdd = (type: C4Type | 'group') => {
    const targetDomainId = domainId || getDefaultDomain()?.id
    if (type === 'group') {
      addGroup({ name: 'New group', color: '#E0DBD2', objectIds: [], domainId: targetDomainId })
    } else {
      addObjectToModel({
        type,
        name: `New ${type}`,
        description: '',
        position: scatteredPosition(),
        size: { width: 160, height: 100 },
        tagAssignments: {},
        tagOrder: [],
        links: [],
        scope: 'internal',
        status: 'draft',
        properties: {},
        domainId: targetDomainId,
      })
    }
    setAddOpen(false)
  }

  const toggleTypeFilter = (type: C4Type | 'group') => {
    const currentTypes = filter.types || []
    if (currentTypes.includes(type as C4Type)) {
      setFilter({ types: currentTypes.filter((t) => t !== type) })
    } else {
      setFilter({ types: [...currentTypes, type as C4Type] })
    }
  }

  const toggleTagFilter = (tag: string) => {
    setFilter({ tagIds: filter.tagIds.includes(tag) ? filter.tagIds.filter((id) => id !== tag) : [...filter.tagIds, tag] })
  }

  const toggleTechnologyFilter = (technologyId: string) => {
    const selected = filter.technologyIds ?? []
    setFilter({ technologyIds: selected.includes(technologyId)
      ? selected.filter((id) => id !== technologyId)
      : [...selected, technologyId] })
  }

  const toggleStatusFilter = (status: 'live' | 'draft' | 'down' | 'unstable') => {
    const selected = filter.statuses ?? (filter.status ? [filter.status] : [])
    setFilter({
      status: undefined,
      statuses: selected.includes(status) ? selected.filter((value) => value !== status) : [...selected, status],
    })
  }

  const toggleTeamFilter = (teamId: string) => {
    const selected = filter.teamIds ?? []
    setFilter({ teamIds: selected.includes(teamId)
      ? selected.filter((id) => id !== teamId)
      : [...selected, teamId] })
  }

  const clearFilters = () => {
    setFilter({
      types: [], scope: undefined, status: undefined, statuses: [], tagIds: [],
      technologyIds: [], teamIds: [], inDiagram: undefined, hasDescription: undefined,
    })
    setDomainId(null)
  }

  const chip = (on: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
      on
        ? 'border-accent/35 bg-accent-subtle text-accent'
        : 'border-line bg-surface-50 text-fg-secondary hover:bg-surface-200'
    )

  const filterPanel = (
    <PillFilterPopover>
      <div className="pb-2.5">
        <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsB.view.filters.type')}</div>
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map(({ type, label }) => (
            <button key={type} onClick={() => toggleTypeFilter(type)} className={chip(filter.types.includes(type as C4Type))}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-line-soft py-2.5">
        <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsB.view.filters.scope')}</div>
        <div className="flex flex-wrap gap-1.5">
          {(['internal', 'external'] as const).map((scope) => (
            <button
              key={scope}
              onClick={() => setFilter({ scope: filter.scope === scope ? undefined : scope })}
              className={chip(filter.scope === scope)}
            >
              {scope === 'internal' ? t('dataViewsB.view.scope.internal') : t('dataViewsB.view.scope.external')}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-line-soft py-2.5">
        <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsB.view.filters.status')}</div>
        <div className="flex flex-wrap gap-1.5">
          {(['live', 'draft', 'down', 'unstable'] as const).map((status) => (
            <button
              key={status}
              onClick={() => toggleStatusFilter(status)}
              className={chip((filter.statuses ?? (filter.status ? [filter.status] : [])).includes(status))}
            >
              {t(`dataViewsB.view.status.${status}`)}
            </button>
          ))}
        </div>
      </div>
      {orgId && (
        <div className="border-t border-line-soft py-2.5">
          <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsB.view.filters.tags')}</div>
          <TagFilterSelector orgId={orgId} selectedIds={filter.tagIds} onToggle={toggleTagFilter} />
        </div>
      )}
      {orgId && (
        <div className="border-t border-line-soft py-2.5">
          <div className="mb-2 text-[11px] font-semibold text-fg-secondary">
            {t('dataViewsB.view.filters.technology')}
          </div>
          <TechnologyFilterSelector
            orgId={orgId}
            selectedIds={filter.technologyIds ?? []}
            onToggle={toggleTechnologyFilter}
            testIdPrefix="model-technology-filter"
            variant="chips"
          />
        </div>
      )}
      {teamIds.length > 0 && (
        <div className="border-t border-line-soft py-2.5">
          <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsB.view.filters.teams')}</div>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {teamIds.map((teamId) => (
              <button key={teamId} onClick={() => toggleTeamFilter(teamId)} className={chip((filter.teamIds ?? []).includes(teamId))}>
                {teamId}
              </button>
            ))}
          </div>
        </div>
      )}
      {domains.length > 0 && (
        <div className="border-t border-line-soft py-2.5">
          <div className="mb-2 text-[11px] font-semibold text-fg-secondary">{t('dataViewsB.view.filters.domain')}</div>
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <button key={d.id} onClick={() => setDomainId(domainId === d.id ? null : d.id)} className={chip(domainId === d.id)}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.color || 'var(--color-fg-subtle)' }} />
                {d.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {activeCount > 0 && (
        <button
          onClick={clearFilters}
          className="mt-1 w-full rounded-lg border border-line bg-surface-50 py-1.5 text-[12px] font-medium text-fg-secondary transition-colors hover:bg-surface-200"
        >
          {t('dataViewsB.view.filters.clearAll')}
        </button>
      )}
    </PillFilterPopover>
  )

  const addMenu = addOpen && (
    <div className="relative mt-2">
      <div className="fixed inset-0" onClick={() => setAddOpen(false)} />
      <div className="relative z-10 w-[200px] rounded-lg border border-line bg-surface-100 p-1.5 shadow-xl">
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
          {t('dataViewsB.view.addMenu.title')}
        </div>
        {ADD_OPTIONS.map(({ type, label, icon: Icon, testid }) => (
          <button
            key={type}
            data-testid={testid}
            onClick={() => handleAdd(type)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-50 hover:text-fg"
          >
            <Icon className="h-3.5 w-3.5 text-fg-subtle" />
            {label}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <WorkspaceShell
      active="model-objects"
      pill={
        <>
          <WorkspacePill
            searchPlaceholder={t('dataViewsB.view.searchPlaceholder')}
            searchTestId="mo-search"
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            filter={{
              active: activeCount,
              open: filterOpen,
              onToggle: setFilterOpen,
              panel: filterPanel,
              onClear: clearFilters,
            }}
            add={canManage ? { label: t('dataViewsB.view.addObject'), onClick: () => setAddOpen((o) => !o), testId: 'mo-add-object' } : undefined}
          />
          {canManage && addMenu}
        </>
      }
      right={hasSelection ? <RightSidebar /> : undefined}
      footer={[
        { label: t('dataViewsB.view.footer.totalObjects'), value: totals?.total ?? '…', testId: 'ws-footer-total-objects' },
        { label: t('dataViewsB.view.footer.groups'), value: groups.length },
      ]}
    >
      <ModelObjectsTable onTotals={setTotals} />
    </WorkspaceShell>
  )
}
