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
import { Shapes, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/authStore'
import { cn, generateId } from '../../lib/utils'
import { createTechnologyUsage } from '../../lib/technologyUsage'
import {
  listSelectableTechnologyPage,
  listTechnologyCatalogFacets,
  type CatalogTechnology,
  type TechnologyCatalogFacets,
} from '../../lib/technologies/api'
import type { ShapeType, TechnologyRole, TechnologyShapeType, TechnologyUsage } from '../../types'
import { FloatingPicker } from '../ui/floating-picker'
import { TechIconBadge } from '../shared/TechIconBadge'
import { CatalogBrowser } from '../catalog/CatalogBrowser'
import { CatalogRowCheckbox } from '../catalog/CatalogRowCheckbox'
import { CatalogSelectionTray } from '../catalog/CatalogSelectionTray'
import { TechnologyShapeWarning } from './TechnologyShapeWarning'

interface TechnologyPickerModalProps {
  isOpen: boolean
  assignedTechnologyIds: string[]
  shapeType?: ShapeType
  onClose: () => void
  onSelect: (usage: TechnologyUsage, technology: CatalogTechnology) => void
  title?: string
  allowAssignedSelection?: boolean
  onBrowseGenericIcons?: () => void
  onRemoveIcon?: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
  /**
   * Stage several technologies across several searches and commit them in one
   * write. Opt-in: the icon picker and the admin reconcile/merge flows pick
   * exactly one thing, and replacing an existing usage is a swap, not an add.
   * Requires `onSelectMany` — the caller must fold the batch into a single
   * store write (see `assignTechnologyUsages`).
   */
  multiple?: boolean
  onSelectMany?: (usages: TechnologyUsage[], technologies: CatalogTechnology[]) => void
}

const EMPTY_FACETS: TechnologyCatalogFacets = { categories: [], shapeTypes: [], roles: [] }

function mergeUnique(current: CatalogTechnology[], incoming: CatalogTechnology[]): CatalogTechnology[] {
  const merged = new Map(current.map((technology) => [technology.id, technology]))
  for (const technology of incoming) merged.set(technology.id, technology)
  return [...merged.values()]
}

function TechnologyMark({ technology }: { technology: CatalogTechnology }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-100 shadow-xs">
      <TechIconBadge
        name={technology.revision.name}
        iconLightPath={technology.revision.iconLightPath ?? undefined}
        iconDarkPath={technology.revision.iconDarkPath ?? undefined}
        allowCatalogFallback={false}
        size="md"
      />
    </span>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
  testId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
  testId: string
}) {
  return (
    <label className="min-w-0 flex-1">
      <span className="sr-only">{label}</span>
      <select
        data-testid={testId}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-8 w-full rounded-lg border px-2 text-[11px] font-medium outline-none transition-colors',
          value
            ? 'border-accent/40 bg-accent-subtle text-accent'
            : 'border-line bg-surface-50 text-fg-secondary hover:bg-surface-100',
          'focus:border-accent focus:ring-1 focus:ring-accent',
        )}
      >
        {children}
      </select>
    </label>
  )
}

export function TechnologyPickerModal({
  isOpen,
  assignedTechnologyIds,
  shapeType,
  onClose,
  onSelect,
  title,
  allowAssignedSelection = false,
  onBrowseGenericIcons,
  onRemoveIcon,
  triggerRef,
  multiple = false,
  onSelectMany,
}: TechnologyPickerModalProps) {
  const { t } = useTranslation()
  const orgId = useAuthStore((state) => state.orgId)
  const [staged, setStaged] = useState<CatalogTechnology[]>([])
  const [openedWith, setOpenedWith] = useState(isOpen)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [recommendedShape, setRecommendedShape] = useState<TechnologyShapeType | ''>('')
  const [role, setRole] = useState<TechnologyRole | ''>('')
  const [facets, setFacets] = useState<TechnologyCatalogFacets>(EMPTY_FACETS)
  const [technologies, setTechnologies] = useState<CatalogTechnology[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [offline, setOffline] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const assigned = useMemo(() => new Set(assignedTechnologyIds), [assignedTechnologyIds])
  // A basket is scoped to one opening: reopening the picker on another shape
  // must not offer to commit what was staged against the previous one. Adjust
  // during render rather than from an effect, so the stale basket never gets a
  // frame in which it could be committed.
  if (openedWith !== isOpen) {
    setOpenedWith(isOpen)
    if (staged.length > 0) setStaged([])
  }
  const multiSelect = multiple && Boolean(onSelectMany)
  const stagedIds = useMemo(() => new Set(staged.map((technology) => technology.id)), [staged])
  const activeFilterCount = Number(Boolean(category)) + Number(Boolean(recommendedShape)) + Number(Boolean(role))
  const catalogUnavailableMessage = t('layoutNav.rightSidebar.technologyCatalogUnavailable', { defaultValue: 'Catalog unavailable. Connect once to cache technologies for offline use.' })

  useEffect(() => {
    if (!isOpen || !orgId) return
    const controller = new AbortController()
    void listTechnologyCatalogFacets(orgId, controller.signal)
      .then(setFacets)
      .catch(() => {
        if (!controller.signal.aborted) setFacets(EMPTY_FACETS)
      })
    return () => controller.abort()
  }, [isOpen, orgId])

  // Synchronously, NOT inside the debounce below. A cursor belongs to the query
  // that minted it — the server refuses a mismatch — and clearing it 200ms late
  // leaves a window where `loadMore` sends the previous query's cursor with the
  // new query text. Its `loading` guard is still false during that window.
  useEffect(() => {
    setNextCursor(null)
  }, [query, category, recommendedShape, role])

  useEffect(() => {
    if (!isOpen || !orgId) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setTechnologies([])
      setNextCursor(null)
      setLoading(true)
      setError(null)
      void listSelectableTechnologyPage(orgId, {
        query,
        category: category || undefined,
        shapeType: recommendedShape || undefined,
        role: role || undefined,
      }, controller.signal)
        .then((result) => {
          setTechnologies(result.technologies)
          setNextCursor(result.nextCursor)
          setOffline(result.source === 'cache')
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setTechnologies([])
            setOffline(false)
            setError(catalogUnavailableMessage)
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 200)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [catalogUnavailableMessage, category, isOpen, orgId, query, recommendedShape, role])

  const loadMore = useCallback(() => {
    if (!orgId || !nextCursor || loading || loadingMore) return
    setLoadingMore(true)
    void listSelectableTechnologyPage(orgId, {
      query,
      after: nextCursor,
      category: category || undefined,
      shapeType: recommendedShape || undefined,
      role: role || undefined,
    })
      .then((result) => {
        setTechnologies((current) => mergeUnique(current, result.technologies))
        setNextCursor(result.nextCursor)
        setOffline(result.source === 'cache')
      })
      .catch(() => setError(catalogUnavailableMessage))
      .finally(() => setLoadingMore(false))
  }, [catalogUnavailableMessage, category, loading, loadingMore, nextCursor, orgId, query, recommendedShape, role])

  const toggleStaged = useCallback((technology: CatalogTechnology) => {
    setStaged((current) => (
      current.some((entry) => entry.id === technology.id)
        ? current.filter((entry) => entry.id !== technology.id)
        : [...current, technology]
    ))
  }, [])

  const commitStaged = useCallback(() => {
    if (staged.length === 0) return
    // Mint the usage ids at commit time, not at stage time, so un-staging and
    // re-staging a row cannot leave a stale id behind.
    const usages = staged.map((technology) => createTechnologyUsage({
      id: generateId(),
      technologyId: technology.id,
      catalogRevision: technology.revision.revision,
      name: technology.revision.name,
      iconLightPath: technology.revision.iconLightPath ?? undefined,
      iconDarkPath: technology.revision.iconDarkPath ?? undefined,
      recommendedShapeTypes: technology.revision.recommendedShapeTypes,
      defaultRole: technology.revision.defaultRole,
    }))
    onSelectMany?.(usages, staged)
    setStaged([])
    onClose()
  }, [onClose, onSelectMany, staged])

  if (!isOpen) return null
  const displayError = !orgId
    ? t('layoutNav.rightSidebar.technologyCatalogNoOrg', { defaultValue: 'Technology catalog requires an organization.' })
    : error

  const controls = (
    <div className="border-t border-line px-4 pb-3 pt-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        {t('layoutNav.rightSidebar.technologyFilters', { defaultValue: 'Filters' })}
        {activeFilterCount > 0 && (
          <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] text-accent-text">{activeFilterCount}</span>
        )}
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => {
              setCategory('')
              setRecommendedShape('')
              setRole('')
            }}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] normal-case tracking-normal text-fg-secondary hover:bg-surface-200"
          >
            <X className="h-3 w-3" aria-hidden="true" />
            {t('layoutNav.rightSidebar.clearTechnologyFilters', { defaultValue: 'Clear' })}
          </button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <FilterSelect
          testId="technology-category-filter"
          label={t('layoutNav.rightSidebar.technologyCategory', { defaultValue: 'Category' })}
          value={category}
          onChange={setCategory}
        >
          <option value="">{t('layoutNav.rightSidebar.allTechnologyCategories', { defaultValue: 'All categories' })}</option>
          {facets.categories.map((facet) => <option key={facet.value} value={facet.value}>{facet.value} ({facet.count})</option>)}
        </FilterSelect>
        <FilterSelect
          testId="technology-shape-filter"
          label={t('layoutNav.rightSidebar.recommendedShape', { defaultValue: 'Shape type' })}
          value={recommendedShape}
          onChange={(value) => setRecommendedShape(value as TechnologyShapeType | '')}
        >
          <option value="">{t('layoutNav.rightSidebar.allTechnologyShapes', { defaultValue: 'All shapes' })}</option>
          {facets.shapeTypes.map((facet) => (
            <option key={facet.value} value={facet.value}>
              {t(`layoutNav.rightSidebar.technologyShapeType.${facet.value}`, { defaultValue: facet.value })} ({facet.count})
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          testId="technology-role-filter"
          label={t('layoutNav.rightSidebar.technologyRoleLabel', { defaultValue: 'Role' })}
          value={role}
          onChange={(value) => setRole(value as TechnologyRole | '')}
        >
          <option value="">{t('layoutNav.rightSidebar.allTechnologyRoles', { defaultValue: 'All roles' })}</option>
          {facets.roles.map((facet) => (
            <option key={facet.value} value={facet.value}>
              {t(`layoutNav.rightSidebar.technologyRole.${facet.value}`, { defaultValue: facet.value })} ({facet.count})
            </option>
          ))}
        </FilterSelect>
      </div>
      {offline && (
        <p className="mt-2 text-[10px] text-warning-text">
          {t('layoutNav.rightSidebar.technologyCatalogOffline', { defaultValue: 'Offline catalog cache' })}
        </p>
      )}
    </div>
  )

  return (
    <FloatingPicker
      isOpen={isOpen}
      title={title ?? t('layoutNav.rightSidebar.chooseTechnology', { defaultValue: 'Choose a technology' })}
      onClose={onClose}
      triggerRef={triggerRef}
      testId="technology-picker"
      className="h-[min(72vh,680px)] min-h-[440px] w-[min(680px,calc(100vw-32px))]"
    >
      {displayError ? (
        <p className="m-4 rounded-lg border border-error-border bg-error-bg p-4 text-[12px] text-error-text">{displayError}</p>
      ) : (
        <>
        <CatalogBrowser
          items={technologies}
          query={query}
          onQueryChange={setQuery}
          searchTestId="technology-picker-search"
          searchLabel={t('layoutNav.rightSidebar.searchTechnologyCatalog', { defaultValue: 'Search the organization catalog' })}
          searchPlaceholder={t('layoutNav.rightSidebar.searchTechnologyCatalog', { defaultValue: 'Search the organization catalog' })}
          controls={controls}
          loading={loading}
          loadingMore={loadingMore}
          onEndReached={loadMore}
          estimateSize={57}
          getKey={(technology) => technology.id}
          emptyState={(
            <div className="flex flex-1 items-center justify-center py-10 text-[12px] text-fg-subtle">
              {t('layoutNav.rightSidebar.noCatalogTechnologies', { defaultValue: 'No selectable technology found.' })}
            </div>
          )}
          renderRow={(technology) => {
            const alreadyAssigned = assigned.has(technology.id)
            const isStaged = stagedIds.has(technology.id)
            return (
              <div className="flex h-[57px] w-full items-center gap-3 border-b border-line px-4 text-left hover:bg-surface-hover">
                <button
                  type="button"
                  data-testid={`technology-option-${technology.id}`}
                  disabled={alreadyAssigned && !allowAssignedSelection}
                  // The label replaces the row's whole accessible name, so it
                  // has to carry the category too: a catalog search returns
                  // near-neighbours by design, and toggling among them by ear
                  // needs more than the bare name.
                  aria-label={[technology.revision.name, technology.revision.category]
                    .filter(Boolean)
                    .join(', ')}
                  {...(multiSelect ? { 'aria-pressed': isStaged } : {})}
                  onClick={() => {
                    if (multiSelect) {
                      toggleStaged(technology)
                      return
                    }
                    const usage = createTechnologyUsage({
                      id: generateId(),
                      technologyId: technology.id,
                      catalogRevision: technology.revision.revision,
                      name: technology.revision.name,
                      iconLightPath: technology.revision.iconLightPath ?? undefined,
                      iconDarkPath: technology.revision.iconDarkPath ?? undefined,
                      recommendedShapeTypes: technology.revision.recommendedShapeTypes,
                      defaultRole: technology.revision.defaultRole,
                    })
                    onSelect(usage, technology)
                    onClose()
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {multiSelect && <CatalogRowCheckbox checked={isStaged} />}
                  <TechnologyMark technology={technology} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold text-fg">{technology.revision.name}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-fg-subtle">
                      <span className="truncate">{technology.revision.category || t('layoutNav.rightSidebar.uncategorizedTechnology', { defaultValue: 'Uncategorized' })}</span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">{t(`layoutNav.rightSidebar.technologyRole.${technology.revision.defaultRole}`, { defaultValue: technology.revision.defaultRole })}</span>
                      {technology.scope === 'org_private' && (
                        <span className="shrink-0 rounded-full bg-accent-subtle px-1.5 py-0.5 font-semibold text-accent">
                          {t('layoutNav.rightSidebar.privateTechnology', { defaultValue: 'Organization private' })}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                {shapeType && (
                  <TechnologyShapeWarning
                    recommendedShapeTypes={technology.revision.recommendedShapeTypes}
                    shapeType={shapeType}
                  />
                )}
                {alreadyAssigned && (
                  <span className="text-[10px] font-semibold text-fg-subtle">
                    {t('layoutNav.rightSidebar.assigned', { defaultValue: 'Assigned' })}
                  </span>
                )}
              </div>
            )
          }}
        />
        {multiSelect && (
          <CatalogSelectionTray
            testId="technology-selection-tray"
            items={staged.map((technology) => ({
              id: technology.id,
              label: technology.revision.name,
              mark: (
                <TechIconBadge
                  name={technology.revision.name}
                  iconLightPath={technology.revision.iconLightPath ?? undefined}
                  iconDarkPath={technology.revision.iconDarkPath ?? undefined}
                  allowCatalogFallback={false}
                  size="sm"
                />
              ),
            }))}
            onRemove={(id) => setStaged((current) => current.filter((entry) => entry.id !== id))}
            onClear={() => setStaged([])}
            onCommit={commitStaged}
            onCancel={onClose}
            commitLabel={t('layoutNav.rightSidebar.addSelectedTechnologies', {
              count: staged.length,
              defaultValue_zero: 'Add technologies',
              defaultValue_one: 'Add technology',
              defaultValue_other: 'Add {{count}} technologies',
            })}
            emptyHint={t('layoutNav.rightSidebar.technologyStageHint', {
              defaultValue: 'Pick as many technologies as you need, then add them all at once.',
            })}
          />
        )}
        {(onBrowseGenericIcons || onRemoveIcon) && (
          <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-100 px-4 py-3">
            {onBrowseGenericIcons && (
              <button
                type="button"
                onClick={onBrowseGenericIcons}
                className="inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-surface-100 px-3 text-[11px] font-semibold text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
              >
                <Shapes className="h-3.5 w-3.5" aria-hidden="true" />
                {t('layoutNav.rightSidebar.browseGenericIcons', { defaultValue: 'Browse generic icons' })}
              </button>
            )}
            {onRemoveIcon && (
              <button
                type="button"
                onClick={() => {
                  onRemoveIcon()
                  onClose()
                }}
                className="ml-auto inline-flex h-8 items-center gap-2 rounded-lg px-3 text-[11px] font-semibold text-error-text transition-colors hover:bg-error-bg"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t('misc.iconPicker.removeIcon')}
              </button>
            )}
          </div>
        )}
        </>
      )}
    </FloatingPicker>
  )
}
