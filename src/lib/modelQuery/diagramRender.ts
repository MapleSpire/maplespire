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

import { withWorkspaceParams } from './workspaceParams'
import { workspaceApiFetch } from '../api/http'
import type { C4Object, Connection, Group } from '../../types'
import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import { getModelReadCacheWorker } from './workerClient'
import type { CachedDiagramRenderRecord } from './idbSchema'
import { scheduleDerivedCacheMaintenance } from '../offline/cacheRetention'
import { markClientTimeline, startClientTimelineMeasure } from '../observability/clientTimeline'

/**
 * Client fetch for a server-rendered diagram (used by boot-from-server).
 *
 * `GET /api/model/diagram-render?id=` returns everything needed to draw a diagram —
 * its objects, groups, and connections INCLUDING the lower-connection roll-ups the
 * client would otherwise have to derive from the whole connection set. With this,
 * the bridge can project the active diagram into the store without materializing
 * the rest of the model (the boot win), provided the server runs with READ_MODEL=on
 * (+ AM_SELECTIVE_SYNC so the model shards aren't pushed).
 *
 * The request carries the active workspace (`landscapeId`/`versionId`), so a
 * non-default workspace boots from ITS OWN server render. Read-only.
 *
 * Returns undefined for an unknown diagram (404) or when the read model is off; the
 * caller falls back to the normal (full-model) projection.
 */
export interface DiagramRenderResult {
  projectionGeneration: number
  /** Current workspace invalidation cursor. It may be newer than the immutable
   * render snapshot when a dependency-scoped cache hit is still valid. */
  workspaceGeneration?: number
  renderGeneration?: number
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
}

import { API_BASE } from '../api/base'

/** Wall-clock ceiling on the boot diagram-render fetch (mirrors
 * BOOT_HTTP_TIMEOUT_MS in automerge/repo.ts — duplicated, not imported, so
 * this module never pulls the Repo construction into its dependents). The
 * TimeoutError lands in loadDiagramRenderForProjection's catch (bridge.ts):
 * offline badge + cached-render fallback — the transient path, never an
 * authoritative failure. No caller passes its own signal into this fetcher. */
const BOOT_HTTP_TIMEOUT_MS = 10_000

type Fetcher = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>
let fetcher: Fetcher = (url, init) => workspaceApiFetch(url, init)

interface DiagramRenderCache {
  putDiagramRender(input: { record: CachedDiagramRenderRecord }): Promise<{ stored: true }>
  getDiagramRender(input: {
    workspaceKey: string
    diagramId: string
    generation?: number
    allowLatest?: boolean
  }): Promise<CachedDiagramRenderRecord | null>
  buildDiagramRender?(input: {
    workspaceKey: string
    diagramId: string
  }): Promise<CachedDiagramRenderRecord | null>
}

let cacheProvider: () => DiagramRenderCache = () => getModelReadCacheWorker()

type CacheWrite = () => void | Promise<void>
type CacheWriteScheduler = (write: CacheWrite) => void

function scheduleCacheWriteAfterPaint(write: CacheWrite): void {
  if (typeof window === 'undefined') {
    setTimeout(() => { void write() }, 0)
    return
  }
  window.requestAnimationFrame(() => {
    const host = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }
    if (typeof host.requestIdleCallback === 'function') {
      host.requestIdleCallback(() => { void write() }, { timeout: 2_000 })
    } else {
      setTimeout(() => { void write() }, 0)
    }
  })
}

let cacheWriteScheduler: CacheWriteScheduler = scheduleCacheWriteAfterPaint

/** Test hook: back the fetch with a fake. */
export function __setDiagramRenderFetchForTest(f: Fetcher | null): void {
  fetcher = f ?? ((url, init) => workspaceApiFetch(url, init))
}

/** Test hook; production always uses the dedicated data Worker. */
export function __setDiagramRenderCacheForTest(cache: DiagramRenderCache | null): void {
  cacheProvider = cache ? () => cache : () => getModelReadCacheWorker()
}

/** Test hook: production schedules writes after a paint and an idle turn. */
export function __setDiagramRenderCacheSchedulerForTest(scheduler: CacheWriteScheduler | null): void {
  cacheWriteScheduler = scheduler ?? scheduleCacheWriteAfterPaint
}

function isDiagramRender(value: unknown): value is DiagramRenderResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DiagramRenderResult>
  return Number.isSafeInteger(candidate.projectionGeneration)
    && (candidate.projectionGeneration ?? -1) >= 0
    && Array.isArray(candidate.objects)
    && Array.isArray(candidate.connections)
    && Array.isArray(candidate.groups)
}

function nonNegativeHeaderInteger(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export async function fetchDiagramRender(diagramId: string): Promise<DiagramRenderResult | undefined> {
  const workspace = currentWorkspaceRef()
  const finishHttp = startClientTimelineMeasure('diagram.render.http')
  let res: Response
  try {
    res = await fetcher(
      `${API_BASE}/api/model/diagram-render?${withWorkspaceParams(`id=${encodeURIComponent(diagramId)}&cacheScope=diagram`)}`,
      { signal: AbortSignal.timeout(BOOT_HTTP_TIMEOUT_MS) },
    )
    finishHttp({
      status: res.status,
      responseBytes: Number(
        res.headers.get('x-read-model-render-bytes') ?? res.headers.get('content-length'),
      ) || undefined,
      serverTiming: res.headers.get('server-timing') ?? undefined,
      cache: res.headers.get('x-read-model-render-cache') ?? undefined,
    })
  } catch (error) {
    finishHttp({ failed: true })
    throw error
  }
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`diagram-render API → HTTP ${res.status}`)
  const finishJson = startClientTimelineMeasure('diagram.render.json')
  let render: unknown
  try {
    render = await res.json() as unknown
    finishJson()
  } catch (error) {
    finishJson({ failed: true })
    throw error
  }
  if (!isDiagramRender(render)) throw new Error('diagram-render API returned an invalid generation-bound payload')
  const workspaceGeneration = nonNegativeHeaderInteger(res, 'x-read-model-workspace-generation')
  const renderGeneration = nonNegativeHeaderInteger(res, 'x-read-model-render-generation')
  const generationAwareRender: DiagramRenderResult = {
    ...render,
    ...(workspaceGeneration === undefined ? {} : { workspaceGeneration }),
    ...(renderGeneration === undefined ? {} : { renderGeneration }),
  }
  // The offline cache is derived data, not a prerequisite for drawing the
  // online response. Let the browser paint first and never await this write.
  cacheWriteScheduler(async () => {
    const finishCache = startClientTimelineMeasure('diagram.render.cache')
    try {
      await cacheProvider().putDiagramRender({
        record: {
          workspaceKey: workspaceRefKey(workspace),
          diagramId,
          generation: render.projectionGeneration,
          payload: generationAwareRender,
          accountedBytes: 0,
          cachedAt: Date.now(),
        },
      })
      scheduleDerivedCacheMaintenance()
      finishCache()
    } catch (error) {
      finishCache({ failed: true })
      console.warn('diagram-render cache write failed:', error)
    }
  })
  markClientTimeline('diagram.render.ready', {
    objects: render.objects.length,
    connections: render.connections.length,
    groups: render.groups.length,
    generation: render.projectionGeneration,
  })
  return generationAwareRender
}

/** Return only a generation-consistent cached render. The active generation is
 * preferred; `allowLatest` covers a diagram visited before the full snapshot
 * bootstrap completed. Callers must still surface offline state to the user. */
export async function readCachedDiagramRender(diagramId: string): Promise<DiagramRenderResult | undefined> {
  const workspaceKey = workspaceRefKey(currentWorkspaceRef())
  try {
    const cache = cacheProvider()
    const validPayload = (record: CachedDiagramRenderRecord | null): DiagramRenderResult | undefined => {
      if (!record || record.generation < 0 || !isDiagramRender(record.payload)) return undefined
      return record.payload.projectionGeneration === record.generation ? record.payload : undefined
    }
    // Prefer the active generation. If this diagram was never opened online,
    // construct it from the complete normalized offline copy in the Worker.
    // Only after that fails do we accept an older visited render as a degraded
    // offline fallback.
    let record = await cache.getDiagramRender({ workspaceKey, diagramId })
    let payload = validPayload(record)
    if (!payload && cache.buildDiagramRender) {
      record = await cache.buildDiagramRender({ workspaceKey, diagramId })
      payload = validPayload(record)
    }
    if (!payload) {
      record = await cache.getDiagramRender({ workspaceKey, diagramId, allowLatest: true })
      payload = validPayload(record)
    }
    return payload
  } catch (error) {
    console.warn('diagram-render cache read failed:', error)
    return undefined
  }
}

/**
 * The SERVER's current Automerge heads (raw hex) for a diagram doc — the
 * "fresh-on-load" signal. The bridge compares these to its LOCAL diagram doc's
 * heads to decide whether the on-disk copy is behind the server (so it can hold the
 * boot loader instead of flashing a stale layout). Returns undefined when the
 * server can't tell us (offline, 404, read model off) — the caller then paints the
 * local copy immediately (unchanged behavior).
 */
export async function fetchDiagramDocHeads(diagramId: string): Promise<string[] | undefined> {
  try {
    const res = await fetcher(
      `${API_BASE}/api/automerge/doc-heads?${withWorkspaceParams(`id=${encodeURIComponent(diagramId)}`)}`
    )
    if (!res.ok) return undefined
    const { heads } = (await res.json()) as { heads: string[] }
    return Array.isArray(heads) ? heads : undefined
  } catch {
    return undefined
  }
}
