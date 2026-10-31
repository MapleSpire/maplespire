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
import { getModelQuery } from '../../lib/modelQuery'
import type { C4Type } from '../../types'
import type { ModelObjectFilter, ObjectExplorerPage, ObjectExplorerRow } from '../../lib/modelQuery/types'

const ROOT_KEY = '\u0000root'
const PAGE_SIZE = 50
const MAX_REFRESH_PAGES = 20

type PageLoadMode = 'replace' | 'append' | 'refresh'

interface TreePageState {
  items: ObjectExplorerRow[]
  nextCursor: string | null
  loading: boolean
  loaded: boolean
  error: string | null
  coverage?: 'working-set' | 'full'
  total?: number
  projectionGeneration?: number
}

interface SearchPageState extends TreePageState {
  projectionGeneration: number
}

/** Reconcile a possibly stale parent summary after a child page has loaded.
 * A successful empty page must never leave an actionable chevron that opens
 * nothing. Partial offline caches disclose only children actually available in
 * their active generation; reconnecting/indexing the missing rows restores it. */
export function reconciledChildDisclosure(
  row: Pick<ObjectExplorerRow, 'childCount' | 'hasChildren'>,
  childPage?: Pick<TreePageState, 'items' | 'nextCursor' | 'loading' | 'loaded' | 'error' | 'coverage'>,
): { childCount: number; hasChildren: boolean } {
  const authoritativelyEmpty = Boolean(
    childPage?.loaded
    && !childPage.loading
    && !childPage.error
    && childPage.nextCursor === null
    && childPage.items.length === 0,
  )
  return authoritativelyEmpty
    ? { childCount: 0, hasChildren: false }
    : { childCount: row.childCount, hasChildren: row.hasChildren }
}

export interface ExplorerVisualRow extends ObjectExplorerRow {
  level: number
  expanded: boolean
  childLoading: boolean
  childError: boolean
  /** Bounded page state exposed to disclosure controls for accessibility,
   * diagnostics, and regression tests. */
  loadedChildCount: number
  childCoverage?: 'working-set' | 'full'
  /** When this row becomes visible, fetch the next page belonging to this key. */
  loadMoreTreeKey?: string
}

export interface ObjectExplorerFilters extends ModelObjectFilter {
  types?: Array<C4Type | 'group'>
  domainId?: string | null
}

const EMPTY_SEARCH: SearchPageState = {
  items: [], nextCursor: null, loading: false, loaded: false, error: null, projectionGeneration: 0,
}

function keyForParent(parentId: string | null): string {
  return parentId ?? ROOT_KEY
}

function parentForKey(key: string): string | null {
  return key === ROOT_KEY ? null : key
}

function appendUnique(current: ObjectExplorerRow[], incoming: ObjectExplorerRow[]): ObjectExplorerRow[] {
  if (!current.length) return incoming
  const ids = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !ids.has(item.id))]
}

function mergeRefreshedWindow(
  fresh: ObjectExplorerRow[],
  previous: ObjectExplorerRow[],
  complete: boolean,
): ObjectExplorerRow[] {
  return complete ? fresh : appendUnique(fresh, previous)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function useObjectExplorer({
  query,
  filters,
  diagramId,
  refreshKey,
  controlledExpandedIds,
  onToggleExpanded,
}: {
  query: string
  filters: ObjectExplorerFilters
  diagramId: string | null
  refreshKey: unknown
  controlledExpandedIds?: readonly string[]
  onToggleExpanded?: (id: string) => void
}) {
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const effectiveExpandedIds = useMemo(
    () => controlledExpandedIds ? new Set(controlledExpandedIds) : expandedIds,
    [controlledExpandedIds, expandedIds],
  )
  const [treePages, setTreePages] = useState<Record<string, TreePageState>>({})
  const treePagesRef = useRef(treePages)
  const treeControllers = useRef(new Map<string, AbortController>())
  const pendingTreeRefreshes = useRef(new Set<string>())
  const [searchPage, setSearchPage] = useState<SearchPageState>(EMPTY_SEARCH)
  const searchPageRef = useRef(searchPage)
  const searchController = useRef<AbortController | null>(null)
  const searchSequence = useRef(0)
  const pendingSearchRefresh = useRef(false)
  const lastRefreshKey = useRef(refreshKey)

  useEffect(() => { treePagesRef.current = treePages }, [treePages])
  useEffect(() => { searchPageRef.current = searchPage }, [searchPage])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 200)
    return () => window.clearTimeout(timer)
  }, [query])

  const typeKey = [...(filters.types ?? [])].sort().join('\u0000')
  const technologyKey = [...(filters.technologyIds ?? [])].sort().join('\u0000')
  const tagKey = [...(filters.tagIds ?? [])].sort().join('\u0000')
  const statusKey = [...(filters.statuses ?? (filters.status ? [filters.status] : []))].sort().join('\u0000')
  const teamKey = [...(filters.teamIds ?? [])].sort().join('\u0000')
  const hasFilters = Boolean(
    filters.types?.length || filters.scope || filters.technologyIds?.length || filters.tagIds?.length
    || filters.statuses?.length || filters.status || filters.teamIds?.length
    || filters.hasDescription !== undefined || filters.inDiagram !== undefined
    || filters.externalOnSomeDiagram !== undefined || filters.domainId,
  )
  const searchMode = hasFilters || debouncedQuery.length >= 2
  const searchTooShort = !hasFilters && query.trim().length === 1
  const queryContractKey = `${debouncedQuery}\u0001${filters.scope ?? ''}\u0001${typeKey}\u0001${technologyKey}\u0001${tagKey}\u0001${statusKey}\u0001${teamKey}\u0001${filters.hasDescription ?? ''}\u0001${filters.inDiagram ?? ''}\u0001${filters.externalOnSomeDiagram ?? ''}\u0001${filters.domainId ?? ''}\u0001${diagramId ?? ''}`

  const commitTreePages = useCallback((updater: (previous: Record<string, TreePageState>) => Record<string, TreePageState>) => {
    const next = updater(treePagesRef.current)
    treePagesRef.current = next
    setTreePages(next)
  }, [])

  const loadTreePage = useCallback(async (parentId: string | null, mode: PageLoadMode = 'replace') => {
    const key = keyForParent(parentId)
    const previous = treePagesRef.current[key]
    const append = mode === 'append'
    const refresh = mode === 'refresh'
    if ((append && !previous?.nextCursor) || (refresh && !previous?.loaded)) return
    if (previous?.loading) {
      if (refresh) pendingTreeRefreshes.current.add(key)
      return
    }
    treeControllers.current.get(key)?.abort()
    const controller = new AbortController()
    treeControllers.current.set(key, controller)
    commitTreePages((pages) => ({
      ...pages,
      [key]: {
        items: append || refresh ? (pages[key]?.items ?? []) : [],
        nextCursor: append || refresh ? (pages[key]?.nextCursor ?? null) : null,
        loading: true,
        loaded: pages[key]?.loaded ?? false,
        error: null,
        coverage: pages[key]?.coverage,
        total: pages[key]?.total,
        projectionGeneration: pages[key]?.projectionGeneration,
      },
    }))
    try {
      let cursor = append ? previous?.nextCursor ?? null : null
      let items: ObjectExplorerRow[] = []
      let page: ObjectExplorerPage | null = null
      let complete = true
      const targetCount = refresh ? Math.max(1, previous?.items.length ?? 0) : PAGE_SIZE
      const pageLimit = refresh ? MAX_REFRESH_PAGES : 1
      for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
        const next = await getModelQuery().objectTreePage({
          parentId,
          diagramId,
          cursor,
          limit: PAGE_SIZE,
        }, controller.signal)
        if (page && next.projectionGeneration !== page.projectionGeneration) {
          throw new Error('Data changed while the object tree window was being refreshed')
        }
        page = next
        items = appendUnique(items, next.items)
        cursor = next.nextCursor
        if (!refresh || !cursor || items.length >= targetCount) break
        if (pageIndex === pageLimit - 1) complete = false
      }
      if (!page) return
      if (controller.signal.aborted) return
      commitTreePages((pages) => ({
        ...pages,
        [key]: {
          items: refresh
            ? mergeRefreshedWindow(items, pages[key]?.items ?? [], complete)
            : append
              ? appendUnique(pages[key]?.items ?? [], items)
              : items,
          nextCursor: refresh && !complete ? pages[key]?.nextCursor ?? null : cursor,
          loading: false,
          loaded: true,
          error: null,
          coverage: page.coverage,
          total: page.total,
          projectionGeneration: page.projectionGeneration,
        },
      }))
    } catch (error) {
      if (controller.signal.aborted || aborted(error)) return
      commitTreePages((pages) => ({
        ...pages,
        [key]: {
          items: pages[key]?.items ?? [], nextCursor: pages[key]?.nextCursor ?? null,
          loading: false, loaded: pages[key]?.loaded ?? false, error: errorMessage(error),
          coverage: pages[key]?.coverage,
          total: pages[key]?.total,
          projectionGeneration: pages[key]?.projectionGeneration,
        },
      }))
    } finally {
      if (treeControllers.current.get(key) === controller) {
        treeControllers.current.delete(key)
        if (pendingTreeRefreshes.current.delete(key)) {
          queueMicrotask(() => void loadTreePage(parentId, 'refresh'))
        }
      }
    }
  }, [commitTreePages, diagramId])

  // A query-contract change (currently the diagram scope) starts a new tree.
  useEffect(() => {
    for (const controller of treeControllers.current.values()) controller.abort()
    treeControllers.current.clear()
    pendingTreeRefreshes.current.clear()
    treePagesRef.current = {}
    setTreePages({})
    void loadTreePage(null, 'replace')
  }, [loadTreePage])

  // Reload any still-expanded branch once its row becomes visible after refresh.
  useEffect(() => {
    const visibleIds = new Set(Object.values(treePages).flatMap((page) => page.items.map((item) => item.id)))
    for (const id of effectiveExpandedIds) {
      if (visibleIds.has(id) && !treePages[keyForParent(id)]?.loaded && !treePages[keyForParent(id)]?.loading) {
        void loadTreePage(id)
      }
    }
  }, [effectiveExpandedIds, loadTreePage, treePages])

  const loadSearch = useCallback(async (mode: PageLoadMode = 'replace') => {
    const previous = searchPageRef.current
    const append = mode === 'append'
    const refresh = mode === 'refresh'
    if ((append && !previous.nextCursor) || (refresh && !previous.loaded)) return
    if (previous.loading) {
      if (refresh) pendingSearchRefresh.current = true
      return
    }
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    const sequence = ++searchSequence.current
    const pending: SearchPageState = {
      ...previous,
      items: append || refresh ? previous.items : [],
      nextCursor: append || refresh ? previous.nextCursor : null,
      loading: true,
      error: null,
    }
    searchPageRef.current = pending
    setSearchPage(pending)
    try {
      let cursor = append ? previous.nextCursor : null
      let items: ObjectExplorerRow[] = []
      let page: ObjectExplorerPage | null = null
      let complete = true
      const targetCount = refresh ? Math.max(1, previous.items.length) : PAGE_SIZE
      const pageLimit = refresh ? MAX_REFRESH_PAGES : 1
      for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
        const nextPage = await getModelQuery().objectSearchPage({
          query: debouncedQuery,
          diagramId,
          filter: filters,
          domainId: filters.domainId,
          cursor,
          limit: PAGE_SIZE,
        }, controller.signal)
        if (page && nextPage.projectionGeneration !== page.projectionGeneration) {
          throw new Error('Data changed while the object search window was being refreshed')
        }
        page = nextPage
        items = appendUnique(items, nextPage.items)
        cursor = nextPage.nextCursor
        if (!refresh || !cursor || items.length >= targetCount) break
        if (pageIndex === pageLimit - 1) complete = false
      }
      if (!page) return
      if (controller.signal.aborted || sequence !== searchSequence.current) return
      const next: SearchPageState = {
        items: refresh
          ? mergeRefreshedWindow(items, previous.items, complete)
          : append
            ? appendUnique(previous.items, items)
            : items,
        nextCursor: refresh && !complete ? previous.nextCursor : cursor,
        loading: false,
        loaded: true,
        error: null,
        projectionGeneration: page.projectionGeneration,
        coverage: page.coverage,
        total: page.total,
      }
      searchPageRef.current = next
      setSearchPage(next)
    } catch (error) {
      if (controller.signal.aborted || sequence !== searchSequence.current || aborted(error)) return
      const failed: SearchPageState = { ...previous, loading: false, error: errorMessage(error) }
      searchPageRef.current = failed
      setSearchPage(failed)
    } finally {
      if (searchController.current === controller && sequence === searchSequence.current) {
        if (pendingSearchRefresh.current) {
          pendingSearchRefresh.current = false
          queueMicrotask(() => void loadSearch('refresh'))
        }
      }
    }
  }, [debouncedQuery, diagramId, filters])

  useEffect(() => {
    searchController.current?.abort()
    searchSequence.current += 1
    pendingSearchRefresh.current = false
    const reset = { ...EMPTY_SEARCH }
    searchPageRef.current = reset
    setSearchPage(reset)
    if (searchMode) void loadSearch('replace')
    return () => searchController.current?.abort()
    // Sets are represented in queryContractKey so their identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryContractKey, searchMode])

  // A model/index revision is not a new user query. Revalidate the currently
  // loaded search or disclosure windows in the background so virtual scroll and
  // expanded chevrons do not collapse to page one during concurrent edits.
  useEffect(() => {
    if (Object.is(lastRefreshKey.current, refreshKey)) return
    lastRefreshKey.current = refreshKey
    if (searchMode) {
      if (searchPageRef.current.loaded) void loadSearch('refresh')
      return
    }
    for (const [key, page] of Object.entries(treePagesRef.current)) {
      if (page.loaded) void loadTreePage(parentForKey(key), 'refresh')
    }
  }, [loadSearch, loadTreePage, refreshKey, searchMode])

  useEffect(() => () => {
    searchController.current?.abort()
    pendingSearchRefresh.current = false
    pendingTreeRefreshes.current.clear()
    for (const controller of treeControllers.current.values()) controller.abort()
  }, [])

  const toggleExpanded = useCallback((row: ExplorerVisualRow) => {
    if (!row.hasChildren) return
    if (row.childError) {
      void loadTreePage(row.id)
      return
    }
    if (controlledExpandedIds) {
      onToggleExpanded?.(row.id)
      if (!effectiveExpandedIds.has(row.id)) {
        const childPage = treePagesRef.current[keyForParent(row.id)]
        if (!childPage?.loaded && !childPage?.loading) void loadTreePage(row.id)
      }
      return
    }
    setExpandedIds((previous) => {
      const next = new Set(previous)
      if (next.has(row.id)) next.delete(row.id)
      else {
        next.add(row.id)
        const childPage = treePagesRef.current[keyForParent(row.id)]
        if (!childPage?.loaded && !childPage?.loading) void loadTreePage(row.id)
      }
      return next
    })
  }, [controlledExpandedIds, effectiveExpandedIds, loadTreePage, onToggleExpanded])

  const treeRows = useMemo(() => {
    const result: ExplorerVisualRow[] = []
    const visited = new Set<string>()
    const walk = (parentId: string | null, level: number) => {
      if (level > 64) return
      const page = treePages[keyForParent(parentId)]
      if (!page) return
      page.items.forEach((item, index) => {
        if (visited.has(item.id)) return
        visited.add(item.id)
        const childPage = treePages[keyForParent(item.id)]
        const disclosure = reconciledChildDisclosure(item, childPage)
        const expanded = disclosure.hasChildren && effectiveExpandedIds.has(item.id)
        result.push({
          ...item,
          ...disclosure,
          level,
          expanded,
          childLoading: expanded && Boolean(childPage?.loading),
          childError: expanded && Boolean(childPage?.error),
          loadedChildCount: childPage?.items.length ?? 0,
          childCoverage: childPage?.coverage,
          ...(index === page.items.length - 1 && page.nextCursor
            ? { loadMoreTreeKey: keyForParent(parentId) }
            : {}),
        })
        if (expanded) walk(item.id, level + 1)
      })
    }
    walk(null, 0)
    return result
  }, [effectiveExpandedIds, treePages])

  const rows: ExplorerVisualRow[] = searchMode
    ? searchPage.items.map((item) => ({
      ...item, level: 0, expanded: false, childLoading: false, childError: false,
      loadedChildCount: 0, childCoverage: searchPage.coverage,
    }))
    : treeRows

  const loadMoreTree = useCallback((key: string) => {
    void loadTreePage(parentForKey(key), 'append')
  }, [loadTreePage])

  return {
    rows,
    searchMode,
    searchTooShort,
    treeRoot: treePages[ROOT_KEY],
    searchPage,
    toggleExpanded,
    loadMoreTree,
    loadMoreSearch: () => void loadSearch('append'),
    retry: () => searchMode ? void loadSearch('replace') : void loadTreePage(null, 'replace'),
  }
}
