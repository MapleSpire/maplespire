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

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  listSelectableTechnologies,
  resolveSelectableTechnologies,
  TECHNOLOGY_SELECTOR_PAGE_SIZE,
  type CatalogTechnology,
} from '../../lib/technologies/api'
import { TechIconBadge } from '../shared/TechIconBadge'

interface TechnologyFilterSelectorProps {
  orgId: string | null
  selectedIds: readonly string[]
  onToggle: (technologyId: string) => void
  /** Keeps existing end-to-end selectors stable in both consumers. */
  testIdPrefix: 'technology-filter' | 'model-technology-filter'
  variant?: 'checklist' | 'chips'
  className?: string
}

type CatalogState = 'idle' | 'loading' | 'ready' | 'error'

const MIN_AUTOMATIC_SEARCH_LENGTH = 3
const MAX_KNOWN_TECHNOLOGIES = 1_000

function mergeTechnologies(
  current: Map<string, CatalogTechnology>,
  technologies: readonly CatalogTechnology[],
): Map<string, CatalogTechnology> {
  if (technologies.length === 0) return current
  const next = new Map(current)
  for (const technology of technologies) {
    next.delete(technology.id)
    next.set(technology.id, technology)
  }
  while (next.size > MAX_KNOWN_TECHNOLOGIES) {
    const oldestId = next.keys().next().value as string | undefined
    if (!oldestId) break
    next.delete(oldestId)
  }
  return next
}

/**
 * Search-driven Technology facet shared by Model Objects and the diagram
 * palette. The server searches the complete catalog, while the client keeps a
 * maximum 50-row result page. Existing selections are pinned above that page
 * and resolved by stable ID, so changing the search cannot hide or clear them.
 */
export function TechnologyFilterSelector({
  orgId,
  selectedIds,
  onToggle,
  testIdPrefix,
  variant = 'checklist',
  className = '',
}: TechnologyFilterSelectorProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogTechnology[]>([])
  const [knownTechnologies, setKnownTechnologies] = useState<Map<string, CatalogTechnology>>(new Map())
  const [catalogState, setCatalogState] = useState<CatalogState>('idle')
  const [source, setSource] = useState<'network' | 'cache' | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [forceShortSearch, setForceShortSearch] = useState(false)
  const uniqueSelectedIds = useMemo(() => [...new Set(selectedIds)], [selectedIds])
  const selectedKey = uniqueSelectedIds.join('\u0000')
  const trimmedQuery = query.trim()
  const isShortAutomaticQuery = trimmedQuery.length > 0
    && trimmedQuery.length < MIN_AUTOMATIC_SEARCH_LENGTH
    && !forceShortSearch

  useEffect(() => {
    setQuery('')
    setResults([])
    setKnownTechnologies(new Map())
    setCatalogState(orgId ? 'loading' : 'idle')
    setSource(null)
    setHasMore(false)
    setForceShortSearch(false)
  }, [orgId])

  useEffect(() => {
    if (!orgId) return
    if (isShortAutomaticQuery) {
      // Trigram indexes cannot make a 1-2 character contains query selective.
      // Keep the bounded first page visible and wait for a meaningful query;
      // Enter still lets users find intentionally short names such as Go/C#.
      setCatalogState('ready')
      return
    }
    const controller = new AbortController()
    setCatalogState('loading')
    const timer = window.setTimeout(() => {
      void listSelectableTechnologies(orgId, query, controller.signal)
        .then((result) => {
          setResults(result.technologies)
          setKnownTechnologies((current) => mergeTechnologies(current, result.technologies))
          setSource(result.source)
          setHasMore(result.hasMore)
          setCatalogState('ready')
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResults([])
            setSource(null)
            setHasMore(false)
            setCatalogState('error')
          }
        })
    }, forceShortSearch ? 0 : trimmedQuery ? 200 : 0)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [forceShortSearch, isShortAutomaticQuery, orgId, query, trimmedQuery])

  useEffect(() => {
    if (!orgId || uniqueSelectedIds.length === 0) return
    const controller = new AbortController()
    // A pathological imported filter cannot fan out 50k detail requests. The
    // full ID selection remains untouched; only the visible pinned window is
    // resolved to labels.
    const idsToResolve = uniqueSelectedIds.slice(0, TECHNOLOGY_SELECTOR_PAGE_SIZE)
    void resolveSelectableTechnologies(orgId, idsToResolve, controller.signal)
      .then((result) => {
        setKnownTechnologies((current) => mergeTechnologies(current, result.technologies))
      })
      .catch(() => {
        // The stable IDs remain visible as fallbacks and continue to filter the
        // read model even when catalog metadata is unavailable.
      })
    return () => controller.abort()
    // The joined key tracks the value of the selection instead of its array
    // identity, avoiding duplicate resolver calls during unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, selectedKey])

  const selectedSet = useMemo(() => new Set(uniqueSelectedIds), [uniqueSelectedIds])
  const pinnedIds = uniqueSelectedIds.slice(0, TECHNOLOGY_SELECTOR_PAGE_SIZE)
  const unselectedResults = results.filter((technology) => !selectedSet.has(technology.id))
  const visibleRowCount = pinnedIds.length + unselectedResults.length

  const option = (technologyId: string, technology: CatalogTechnology | undefined, pinned: boolean) => {
    const name = technology?.revision.name ?? technologyId
    const selected = selectedSet.has(technologyId)
    if (variant === 'chips') {
      return (
        <button
          key={technologyId}
          type="button"
          data-testid={`${testIdPrefix}-${technologyId}`}
          aria-pressed={selected}
          onClick={() => onToggle(technologyId)}
          title={name}
          className={selected
            ? 'inline-flex max-w-full items-center rounded-full border border-accent/35 bg-accent-subtle px-2.5 py-1 text-[11.5px] font-medium text-accent transition-colors'
            : 'inline-flex max-w-full items-center rounded-full border border-line bg-surface-50 px-2.5 py-1 text-[11.5px] font-medium text-fg-secondary transition-colors hover:bg-surface-200'}
        >
          <span className="shrink-0">
            <TechIconBadge
              name={name}
              size="sm"
              decorative
              iconLightPath={technology?.revision.iconLightPath ?? undefined}
              iconDarkPath={technology?.revision.iconDarkPath ?? undefined}
            />
          </span>
          <span className="truncate">{name}</span>
        </button>
      )
    }
    return (
      <label
        key={technologyId}
        className="flex min-h-7 cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-50"
        title={name}
      >
        <input
          type="checkbox"
          data-testid={`${testIdPrefix}-${technologyId}`}
          checked={selected}
          onChange={() => onToggle(technologyId)}
          className="h-3.5 w-3.5 shrink-0 rounded border-line-strong text-accent focus:ring-accent"
        />
        <span className="shrink-0">
          <TechIconBadge
            name={name}
            size="sm"
            decorative
            iconLightPath={technology?.revision.iconLightPath ?? undefined}
            iconDarkPath={technology?.revision.iconDarkPath ?? undefined}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-secondary">{name}</span>
        {pinned && (
          <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-accent">
            {t('common.technologyFilter.selected')}
          </span>
        )}
      </label>
    )
  }

  return (
    <div data-testid={testIdPrefix} className={className}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
        <input
          type="search"
          autoComplete="off"
          data-testid={`${testIdPrefix}-search`}
          aria-label={t('common.technologyFilter.searchLabel')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setForceShortSearch(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && trimmedQuery.length > 0 && trimmedQuery.length < MIN_AUTOMATIC_SEARCH_LENGTH) {
              event.preventDefault()
              setForceShortSearch(true)
            }
          }}
          placeholder={t('common.technologyFilter.searchPlaceholder')}
          className="h-8 w-full rounded-lg border border-line bg-surface-50 pl-8 pr-8 text-[11.5px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent/20"
        />
        {catalogState === 'loading' && orgId && (
          <Loader2 className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-fg-subtle" />
        )}
      </div>

      {source === 'cache' && (
        <p className="px-1 pt-1.5 text-[10px] text-warning-text">
          {t('common.technologyFilter.catalogOffline')}
        </p>
      )}

      {isShortAutomaticQuery && (
        <p className="px-1 pt-1.5 text-[10px] leading-4 text-fg-subtle">
          {t('common.technologyFilter.shortQuery')}
        </p>
      )}

      <div
        className={variant === 'chips'
          ? 'mt-1.5 flex max-h-44 flex-wrap content-start gap-1.5 overflow-y-auto'
          : 'mt-1.5 max-h-44 overflow-y-auto'}
        aria-live="polite"
      >
        {!orgId && (
          <p className="w-full px-2 py-1.5 text-[11px] text-fg-subtle">
            {t('common.technologyFilter.noOrganization')}
          </p>
        )}
        {orgId && catalogState === 'error' && (
          <p className="w-full px-2 py-1.5 text-[11px] text-error-text">
            {t('common.technologyFilter.unavailable')}
          </p>
        )}
        {orgId && catalogState === 'loading' && visibleRowCount === 0 && (
          <p className="w-full px-2 py-1.5 text-[11px] text-fg-subtle">
            {t('common.technologyFilter.loading')}
          </p>
        )}

        {pinnedIds.map((technologyId) => option(technologyId, knownTechnologies.get(technologyId), true))}
        {variant === 'checklist' && pinnedIds.length > 0 && unselectedResults.length > 0 && (
          <div className="my-1 border-t border-line-soft" />
        )}
        {unselectedResults.map((technology) => option(technology.id, technology, false))}

        {orgId && catalogState === 'ready' && visibleRowCount === 0 && (
          <p className="w-full px-2 py-1.5 text-[11px] text-fg-subtle">
            {t('common.technologyFilter.noResults')}
          </p>
        )}
      </div>

      {uniqueSelectedIds.length > TECHNOLOGY_SELECTOR_PAGE_SIZE && (
        <p className="px-1 pt-1 text-[10px] text-fg-subtle">
          {t('common.technologyFilter.moreSelected', {
            count: uniqueSelectedIds.length - TECHNOLOGY_SELECTOR_PAGE_SIZE,
          })}
        </p>
      )}
      {hasMore && catalogState === 'ready' && (
        <p className="px-1 pt-1 text-[10px] leading-4 text-fg-subtle">
          {t('common.technologyFilter.resultsLimited', { count: TECHNOLOGY_SELECTOR_PAGE_SIZE })}
        </p>
      )}
    </div>
  )
}
