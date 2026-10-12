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
import { useModelStore } from '../../stores/modelStore'
import { getModelQuery } from '../../lib/modelQuery'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { isServerReadModelEnabled } from '../../lib/modelQuery/tierFlag'
import {
  EMPTY_VIEWER_WINDOW,
  mergeViewerLevelWindow,
  type ViewerLevelWindow,
} from '../../lib/modelQuery/viewerWindow'
import { buildViewerModel, type ViewerModel } from '../../lib/modelViewer/levels'
import type { Connection } from '../../types'

export interface ViewerData {
  model: ViewerModel
  connections: Connection[]
  loaded: boolean
  totalObjects: number
  connectionsTruncated: boolean
  coverage: 'working-set' | 'full'
  hasMoreObjects: boolean
  loadingMore: boolean
  loadMore: () => void
}

const EMPTY_MODEL = buildViewerModel([])

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
  const [viewerWindow, setViewerWindow] = useState<ViewerLevelWindow>(EMPTY_VIEWER_WINDOW)
  const [loadingMore, setLoadingMore] = useState(false)
  const requestRef = useRef(0)
  const windowRef = useRef(viewerWindow)
  const domainKey = [...(input.domainIds ?? [])].sort().join('\u0000')

  useEffect(() => {
    windowRef.current = viewerWindow
  }, [viewerWindow])

  const requestPage = useCallback(async (
    cursor: string | null,
    append: boolean,
    signal?: AbortSignal,
  ) => {
    const request = ++requestRef.current
    if (append) setLoadingMore(true)
    try {
      const page = await getModelQuery().viewerLevel({
        parentId: input.parentId,
        query: input.query,
        domainIds: domainKey ? domainKey.split('\u0000') : [],
        cursor,
        limit: 200,
        connectionLimit: 1_000,
      }, signal)
      if (signal?.aborted || request !== requestRef.current) return
      setViewerWindow((current) => mergeViewerLevelWindow(current, page, append))
    } catch (error) {
      if (!signal?.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn('model viewer level fetch failed:', error)
      }
    } finally {
      if (request === requestRef.current) setLoadingMore(false)
    }
  }, [domainKey, input.parentId, input.query])

  useEffect(() => {
    const controller = new AbortController()
    const request = ++requestRef.current
    const delay = input.query?.trim() ? 200 : 0
    const timer = window.setTimeout(() => {
      setViewerWindow(EMPTY_VIEWER_WINDOW)
      setLoadingMore(false)
      // requestPage owns the live request id; invalidate the reset marker first.
      if (request === requestRef.current) void requestPage(null, false, controller.signal)
    }, delay)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [input.query, requestPage, residentObjectsRef, residentConnectionsRef, indexVersion])

  const loadMore = useCallback(() => {
    const cursor = windowRef.current.nextCursor
    if (!cursor || loadingMore) return
    void requestPage(cursor, true)
  }, [loadingMore, requestPage])

  const model = useMemo(() => {
    if (!viewerWindow.loaded) return EMPTY_MODEL
    const byId = new Map(viewerWindow.ancestors.map((object) => [object.id, object]))
    for (const item of viewerWindow.objects) byId.set(item.object.id, item.object)
    const childCounts = new Map(viewerWindow.objects.map((item) => [item.object.id, item.childCount]))
    return buildViewerModel([...byId.values()], childCounts)
  }, [viewerWindow.ancestors, viewerWindow.loaded, viewerWindow.objects])

  return {
    model,
    connections: viewerWindow.connections,
    loaded: viewerWindow.loaded,
    totalObjects: viewerWindow.totalObjects,
    connectionsTruncated: viewerWindow.connectionsTruncated,
    coverage: viewerWindow.coverage ?? 'full',
    hasMoreObjects: viewerWindow.nextCursor !== null,
    loadingMore,
    loadMore,
  }
}
