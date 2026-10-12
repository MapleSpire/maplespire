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

import type { TechnologyRole, TechnologyShapeType } from '../../types'
import { registerTechnologyCanonicalIds } from './canonicalIds'
import { compareTechnologyMatches } from './ranking'

export interface CatalogTechnologyRevision {
  revision: number
  status: string
  privateApproved: boolean
  name: string
  description: string | null
  aliases: string[]
  category?: string | null
  iconLightPath: string | null
  iconDarkPath: string | null
  recommendedShapeTypes: TechnologyShapeType[]
  defaultRole: TechnologyRole
}

export interface CatalogTechnology {
  id: string
  scope: 'public' | 'org_private'
  lifecycleStatus: string
  canonicalTechnologyId?: string | null
  canonicalTechnologyName?: string | null
  redirectedFromIds?: string[]
  revision: CatalogTechnologyRevision
  orgState: string
  orgOverride: 'enabled' | 'hidden' | null
}

interface TechnologyListResponse {
  technologies: CatalogTechnology[]
  nextCursor: string | null
  policy: 'all' | 'none'
}

export interface SelectableTechnologyResult {
  technologies: CatalogTechnology[]
  source: 'network' | 'cache'
  /** True when the catalog has more matches than this bounded selector page. */
  hasMore: boolean
}

export interface SelectableTechnologyPageResult extends SelectableTechnologyResult {
  nextCursor: string | null
}

export interface SelectableTechnologyFilters {
  query?: string
  after?: string | null
  category?: string
  shapeType?: TechnologyShapeType
  role?: TechnologyRole
  limit?: number
}

export interface TechnologyCatalogFacets {
  categories: Array<{ value: string; count: number }>
  shapeTypes: Array<{ value: TechnologyShapeType; count: number }>
  roles: Array<{ value: TechnologyRole; count: number }>
}

export interface ResolvedSelectableTechnologiesResult {
  technologies: CatalogTechnology[]
  source: 'network' | 'cache'
}

interface TechnologyDetailResponse {
  technology: CatalogTechnology
  resolution: {
    requestedId: string
    canonicalTechnologyId: string
    redirected: boolean
    path: string[]
  }
}

/** A selector never materializes the organization catalog. Search is executed
 * by PostgreSQL and this is the maximum number of result rows kept in the DOM. */
export const TECHNOLOGY_SELECTOR_PAGE_SIZE = 50

import { API_BASE } from '../api/base'
// v2 snapshots catalog guidance (recommended shapes + default role). Keep it
// separate so a stale v1 cache cannot silently suppress offline warnings.
const DB_NAME = 'maplespire-technology-catalog-v2'
const STORE_NAME = 'catalogs'
const MAX_TECHNOLOGY_CACHE_ENTRIES = 1_000
const memoryCache = new Map<string, CatalogTechnology[]>()

function boundCachedTechnologies(technologies: readonly CatalogTechnology[]): CatalogTechnology[] {
  return technologies.slice(-MAX_TECHNOLOGY_CACHE_ENTRIES)
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'orgId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readCache(orgId: string): Promise<CatalogTechnology[] | null> {
  if (memoryCache.has(orgId)) return memoryCache.get(orgId) ?? []
  if (typeof indexedDB === 'undefined') return null
  try {
    const db = await openCache()
    const value = await new Promise<{ orgId: string; technologies: CatalogTechnology[] } | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(orgId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (!value?.technologies) return null
    // Catalog search pages are cached for offline reuse, but a user exploring a
    // 50k catalog must not gradually materialize all 50k entries in memory.
    const bounded = boundCachedTechnologies(value.technologies)
    registerTechnologyCanonicalIds(bounded)
    memoryCache.set(orgId, bounded)
    return bounded
  } catch {
    return null
  }
}

async function mergeCache(orgId: string, technologies: CatalogTechnology[]): Promise<void> {
  registerTechnologyCanonicalIds(technologies)
  const current = await readCache(orgId) ?? []
  const merged = new Map(current.map((technology) => [technology.id, technology]))
  for (const technology of technologies) {
    // Reinsert touched rows at the tail so the bounded cache behaves as a small
    // recency window rather than preserving an arbitrary alphabetical prefix.
    merged.delete(technology.id)
    merged.set(technology.id, technology)
  }
  const next = boundCachedTechnologies([...merged.values()])
  memoryCache.set(orgId, next)
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openCache()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put({ orgId, technologies: next, updatedAt: Date.now() })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // A cache failure must never turn a successful catalog request into an error.
  }
}

export function isSelectableTechnology(technology: CatalogTechnology): boolean {
  if (!['active', 'deprecated'].includes(technology.lifecycleStatus)) return false
  if (technology.scope === 'org_private') return technology.revision.privateApproved
  return technology.revision.status === 'approved' && technology.orgState === 'enabled'
}

function filterCached(
  technologies: CatalogTechnology[],
  filters: SelectableTechnologyFilters,
): { technologies: CatalogTechnology[]; hasMore: boolean } {
  const needle = (filters.query ?? '').trim().toLocaleLowerCase()
  const matches = technologies
    .filter(isSelectableTechnology)
    .filter((technology) => !needle || [technology.revision.name, ...technology.revision.aliases]
      .some((term) => term.toLocaleLowerCase().includes(needle)))
    .filter((technology) => !filters.category || technology.revision.category === filters.category)
    .filter((technology) => !filters.shapeType || technology.revision.recommendedShapeTypes.includes(filters.shapeType))
    .filter((technology) => !filters.role || technology.revision.defaultRole === filters.role)
    // Same order the server sorts by, so going offline does not reshuffle the
    // picker. Unsorted, this returned cache-insertion order.
    .sort(needle
      ? compareTechnologyMatches(
        needle,
        (technology) => technology.revision.name,
        (technology) => technology.revision.aliases,
      )
      : (a, b) => a.revision.name.toLocaleLowerCase().localeCompare(b.revision.name.toLocaleLowerCase()))
  const limit = filters.limit ?? TECHNOLOGY_SELECTOR_PAGE_SIZE
  return {
    technologies: matches.slice(0, limit),
    hasMore: matches.length > limit,
  }
}

export async function listSelectableTechnologyPage(
  orgId: string,
  filters: SelectableTechnologyFilters = {},
  signal?: AbortSignal,
): Promise<SelectableTechnologyPageResult> {
  const params = new URLSearchParams({
    q: filters.query ?? '',
    selectable: 'true',
    limit: String(filters.limit ?? TECHNOLOGY_SELECTOR_PAGE_SIZE),
  })
  if (filters.after) params.set('after', filters.after)
  if (filters.category) params.set('category', filters.category)
  if (filters.shapeType) params.set('shapeType', filters.shapeType)
  if (filters.role) params.set('role', filters.role)
  try {
    const response = await fetch(`${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/technologies?${params}`, {
      credentials: 'include',
      signal,
    })
    if (!response.ok) throw new Error(`Technology catalog request failed (${response.status})`)
    const payload = await response.json() as TechnologyListResponse
    registerTechnologyCanonicalIds(payload.technologies)
    const selectable = payload.technologies.filter(isSelectableTechnology)
    await mergeCache(orgId, payload.technologies)
    return {
      technologies: selectable,
      source: 'network',
      hasMore: payload.nextCursor !== null,
      nextCursor: payload.nextCursor,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const cached = await readCache(orgId)
    if (cached !== null) {
      const page = filterCached(cached, filters)
      return { ...page, source: 'cache', nextCursor: null }
    }
    throw new Error('Technology catalog unavailable and no offline cache exists', { cause: error })
  }
}

export async function listSelectableTechnologies(
  orgId: string,
  query: string,
  signal?: AbortSignal,
): Promise<SelectableTechnologyResult> {
  const { nextCursor: _nextCursor, ...result } = await listSelectableTechnologyPage(orgId, { query }, signal)
  return result
}

export async function listTechnologyCatalogFacets(
  orgId: string,
  signal?: AbortSignal,
): Promise<TechnologyCatalogFacets> {
  const response = await fetch(
    `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/technologies/facets?selectable=true`,
    { credentials: 'include', signal },
  )
  if (!response.ok) throw new Error(`Technology catalog facets failed (${response.status})`)
  return response.json() as Promise<TechnologyCatalogFacets>
}

/** Resolve the small set of already-selected IDs independently from the
 * current search page. This prevents a search (or a fresh page load whose
 * first 50 rows do not include a selection) from silently hiding filters.
 *
 * The existing per-technology catalog route is used deliberately: the number
 * of active facet selections is small, while the searchable catalog may be
 * 50k+ entries. Cached matches are returned offline. */
export async function resolveSelectableTechnologies(
  orgId: string,
  technologyIds: readonly string[],
  signal?: AbortSignal,
): Promise<ResolvedSelectableTechnologiesResult> {
  const uniqueIds = [...new Set(technologyIds.filter(Boolean))]
  if (uniqueIds.length === 0) return { technologies: [], source: 'network' }

  const cached = await readCache(orgId)
  const cachedById = new Map((cached ?? []).map((technology) => [technology.id, technology]))
  const resolved = new Map<string, CatalogTechnology>()
  for (const technologyId of uniqueIds) {
    const technology = cachedById.get(technologyId)
    if (technology && isSelectableTechnology(technology)) resolved.set(technologyId, technology)
  }

  const missingIds = uniqueIds.filter((technologyId) => !resolved.has(technologyId))
  if (missingIds.length === 0) {
    return { technologies: uniqueIds.flatMap((id) => resolved.get(id) ?? []), source: 'cache' }
  }

  try {
    const fetched = await Promise.all(missingIds.map(async (technologyId) => {
      const response = await fetch(
        `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/technologies/${encodeURIComponent(technologyId)}`,
        { credentials: 'include', signal },
      )
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Technology catalog request failed (${response.status})`)
      const payload = await response.json() as TechnologyDetailResponse
      const technology = payload.technology
      registerTechnologyCanonicalIds([technology])
      return isSelectableTechnology(technology) ? technology : null
    }))
    const selectable = fetched.filter((technology): technology is CatalogTechnology => technology !== null)
    for (const technology of selectable) resolved.set(technology.id, technology)
    if (selectable.length > 0) await mergeCache(orgId, selectable)
    return { technologies: uniqueIds.flatMap((id) => resolved.get(id) ?? []), source: 'network' }
  } catch (error) {
    if (signal?.aborted) throw error
    if (cached !== null) {
      return { technologies: uniqueIds.flatMap((id) => resolved.get(id) ?? []), source: 'cache' }
    }
    throw new Error('Technology catalog unavailable and no offline cache exists', { cause: error })
  }
}
