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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { getModelQuery } from '../../lib/modelQuery'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { isServerReadModelEnabled } from '../../lib/modelQuery/tierFlag'
import {
  EMPTY_VIEWER_WINDOW,
  mergeViewerLevelWindow,
  type ViewerLevelWindow,
} from '../../lib/modelQuery/viewerWindow'
import { LevelStore } from '../../lib/modelViewer/levelStore'
import { buildViewerModel, type ParentId, type ViewerModel } from '../../lib/modelViewer/levels'
import { currentWorkspaceRef, workspaceRefKey } from '../../lib/automerge/workspace'
import type { Connection } from '../../types'

/** The data one level is drawn from. */
export interface ViewerLevelData {
  model: ViewerModel
  connections: Connection[]
}

export interface ViewerData {
  model: ViewerModel
  connections: Connection[]
  loaded: boolean
  /** The level `model`/`connections` describe (null = context level); undefined
   * until a first page lands. A parent change keeps serving the PREVIOUS level
   * until the new page arrives, so this can lag `input.parentId` — the drill
   * zoom waits on it instead of animating an empty level. */
  levelParentId: string | null | undefined
  totalObjects: number
  connectionsTruncated: boolean
  coverage: 'working-set' | 'full'
  hasMoreObjects: boolean
  loadingMore: boolean
  loadMore: () => void
  /** A level already in memory (visited, or warmed by `prefetchLevel`), or
   * undefined. The drill zoom starts from this on the click itself, so it never
   * waits on a round trip. */
  peekLevel: (parentId: ParentId) => ViewerLevelData | undefined
  /** Express the intent to open a level soon so it is in memory by then. Bounded
   * and best effort (see `LevelStore`): it may do nothing — already warm, over
   * the rate budget, offline, data saver — and failures are silent. `force`
   * marks a press, which is exempt from the hover rate budget. */
  prefetchLevel: (parentId: ParentId, force?: boolean) => void
}

const EMPTY_MODEL = buildViewerModel([])

const modelByWindow = new WeakMap<ViewerLevelWindow, ViewerModel>()

/** The model of a window — memoized per window so the same window always yields
 * the same model object (layout caches and memoized tiles key on it). */
function modelOfWindow(win: ViewerLevelWindow): ViewerModel {
  if (!win.loaded) return EMPTY_MODEL
  let model = modelByWindow.get(win)
  if (!model) {
    const byId = new Map(win.ancestors.map((object) => [object.id, object]))
    for (const item of win.objects) byId.set(item.object.id, item.object)
    const childCounts = new Map(win.objects.map((item) => [item.object.id, item.childCount]))
    model = buildViewerModel([...byId.values()], childCounts)
    modelByWindow.set(win, model)
  }
  return model
}

interface HeldWindow {
  window: ViewerLevelWindow
  parentId: string | null | undefined
  workspaceKey: string | null
}

const EMPTY_HELD: HeldWindow = { window: EMPTY_VIEWER_WINDOW, parentId: undefined, workspaceKey: null }

/** Warm-up bounds. A level is one page (≤200 objects, ≤1 000 connections), so
 * the weight cap keeps memory flat no matter how large the model is; the
 * request caps keep a pointer sweeping a 200-tile grid from becoming 200
 * requests (see LevelStore). */
const LEVEL_STORE = {
  maxEntries: 8,
  maxWeight: 6_000,
  weigh: (win: ViewerLevelWindow) => win.objects.length + win.connections.length,
  concurrency: 2,
  queueTtlMs: 1_500,
  budget: { count: 8, windowMs: 5_000 },
}

/** Speculative work yields to the user's own network and battery constraints. */
function mayWarmLevels(): boolean {
  if (typeof navigator !== 'undefined') {
    if (navigator.onLine === false) return false
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    if (connection?.saveData) return false
  }
  return !(typeof document !== 'undefined' && document.visibilityState === 'hidden')
}

/** Resident mode filters the whole in-memory model on the main thread: do that
 * speculative work when the page is idle, not in the middle of a hover. */
const whenIdle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 400 })
    else window.setTimeout(resolve, 0)
  })

const abortError = () => new DOMException('Aborted', 'AbortError')

/** Fetch a bounded C4 level and progressively consume its signed cursor. Server
 * mode subscribes only to the tiny index revision, never the resident object or
 * connection arrays. Resident mode keeps reference subscriptions for parity. */
export function useViewerData(input: {
  parentId?: string | null
  query?: string
  domainIds?: string[]
}): ViewerData {
  const serverBacked = isServerReadModelEnabled()
  const residentObjectsRef = useModelStore((state) => serverBacked ? null : state.objects)
  const residentConnectionsRef = useModelStore((state) => serverBacked ? null : state.connections)
  const indexVersion = useModelIndexVersion((state) => state.version)
  // The window, the level it answers and the workspace it came from move as
  // ONE value, so a reader can never pair one level's objects with another's id.
  const [held, setHeld] = useState<HeldWindow>(EMPTY_HELD)
  const viewerWindow = held.window
  const [loadingMore, setLoadingMore] = useState(false)
  const requestRef = useRef(0)
  const windowRef = useRef(viewerWindow)
  const [store] = useState(() => new LevelStore<ViewerLevelWindow>(LEVEL_STORE))
  const domainKey = [...(input.domainIds ?? [])].sort().join('\u0000')

  useEffect(() => {
    windowRef.current = viewerWindow
  }, [viewerWindow])

  // Any change to the model drops every remembered level and aborts what is
  // coming (declared before the fetch effect so it runs first in the same
  // commit). A workspace switch needs no clearing: the workspace is part of
  // every key.
  useEffect(() => {
    store.clear()
  }, [store, residentObjectsRef, residentConnectionsRef, indexVersion])

  const keyFor = useCallback(
    (parentId: ParentId) =>
      `${workspaceRefKey(currentWorkspaceRef())}|${parentId ?? ''}|${input.query ?? ''}|${domainKey}`,
    [domainKey, input.query],
  )

  const fetchLevel = useCallback(
    (parentId: ParentId, cursor: string | null, signal?: AbortSignal) =>
      getModelQuery().viewerLevel({
        parentId,
        query: input.query,
        domainIds: domainKey ? domainKey.split('\u0000') : [],
        cursor,
        limit: 200,
        connectionLimit: 1_000,
      }, signal),
    [domainKey, input.query],
  )

  const loadFirstWindow = useCallback(
    async (parentId: ParentId, signal?: AbortSignal): Promise<ViewerLevelWindow> =>
      // A first page is merged against NOTHING: the held window may still be
      // the previous level's, and its truncation/coverage flags are not ours.
      mergeViewerLevelWindow(EMPTY_VIEWER_WINDOW, await fetchLevel(parentId, null, signal), false),
    [fetchLevel],
  )

  const prefetchLevel = useCallback((parentId: ParentId, force = false) => {
    if (!mayWarmLevels()) return
    store.prefetch(
      keyFor(parentId),
      async (signal) => {
        if (!serverBacked) await whenIdle()
        if (signal.aborted) throw abortError()
        return loadFirstWindow(parentId, signal)
      },
      { force },
    )
  }, [keyFor, loadFirstWindow, serverBacked, store])

  const requestPage = useCallback(async (
    cursor: string | null,
    append: boolean,
    signal?: AbortSignal,
  ) => {
    const request = ++requestRef.current
    const parentId = input.parentId ?? null
    const workspaceKey = workspaceRefKey(currentWorkspaceRef())
    const key = keyFor(parentId)
    const generation = store.generation
    if (append) setLoadingMore(true)
    try {
      let merged: ViewerLevelWindow
      if (append) {
        merged = mergeViewerLevelWindow(windowRef.current, await fetchLevel(parentId, cursor, signal), true)
      } else {
        // A first page already on its way (a warm-up) is joined, not
        // duplicated; if that one was aborted or failed, fetch normally.
        const shared = store.inflight(key)
        let joined: ViewerLevelWindow | undefined
        if (shared) {
          try {
            joined = await shared
          } catch {
            if (signal?.aborted) throw abortError()
          }
        }
        merged = joined ?? (await loadFirstWindow(parentId, signal))
      }
      if (signal?.aborted || request !== requestRef.current) return
      setHeld({ window: merged, parentId, workspaceKey })
      if (generation === store.generation) store.put(key, merged)
      if (!append) {
        // Warm the level above so the way back up is instant too.
        const self = merged.ancestors.find((object) => object.id === parentId)
        if (self) prefetchLevel(self.parentId ?? null, true)
      }
    } catch (error) {
      if (!signal?.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn('model viewer level fetch failed:', error)
        // A failed first page answers its level with nothing (the pre-hold
        // behaviour), so a drill waiting on it lands instead of hanging.
        if (!append && request === requestRef.current) {
          setHeld({ window: EMPTY_VIEWER_WINDOW, parentId, workspaceKey })
        }
      }
    } finally {
      if (request === requestRef.current) setLoadingMore(false)
    }
  }, [fetchLevel, input.parentId, keyFor, loadFirstWindow, prefetchLevel, store])

  useEffect(() => {
    const controller = new AbortController()
    const request = ++requestRef.current
    const delay = input.query?.trim() ? 200 : 0
    const parentId = input.parentId ?? null
    // Navigating: free the network for the level the user is going to, abandoning
    // the warm-ups of the levels they did not choose.
    store.cancelExcept(keyFor(parentId))
    const timer = window.setTimeout(() => {
      // Keep serving the current window while the next page loads — clearing
      // it here blanked both layers of the drill zoom mid-animation. Only a
      // workspace switch drops it: another landscape's objects must never show.
      const workspaceKey = workspaceRefKey(currentWorkspaceRef())
      setHeld((current) => (current.workspaceKey === workspaceKey ? current : EMPTY_HELD))
      setLoadingMore(false)
      if (request !== requestRef.current) return
      const cached = store.get(keyFor(parentId))
      if (cached) {
        setHeld({ window: cached, parentId, workspaceKey })
        return
      }
      // requestPage owns the live request id; invalidate the reset marker first.
      void requestPage(null, false, controller.signal)
    }, delay)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [input.query, input.parentId, keyFor, requestPage, store, residentObjectsRef, residentConnectionsRef, indexVersion])

  // The held window may still be the PREVIOUS level's while the requested one
  // loads. Its cursor belongs to that level: paging with it would supersede the
  // pending first page and, in resident mode (unsigned offset cursors), merge
  // two levels under the new level's key. So "more" exists only for the level
  // the caller asked for.
  const heldIsRequested = held.parentId === (input.parentId ?? null)
  const loadMore = useCallback(() => {
    const cursor = windowRef.current.nextCursor
    if (!cursor || loadingMore || !heldIsRequested) return
    void requestPage(cursor, true)
  }, [heldIsRequested, loadingMore, requestPage])

  const peekLevel = useCallback(
    (parentId: ParentId): ViewerLevelData | undefined => {
      const win = store.get(keyFor(parentId))
      return win?.loaded ? { model: modelOfWindow(win), connections: win.connections } : undefined
    },
    [keyFor, store],
  )

  return {
    model: modelOfWindow(viewerWindow),
    connections: viewerWindow.connections,
    loaded: viewerWindow.loaded,
    levelParentId: held.parentId,
    totalObjects: viewerWindow.totalObjects,
    connectionsTruncated: viewerWindow.connectionsTruncated,
    coverage: viewerWindow.coverage ?? 'full',
    hasMoreObjects: viewerWindow.nextCursor !== null && heldIsRequested,
    loadingMore,
    loadMore,
    peekLevel,
    prefetchLevel,
  }
}
