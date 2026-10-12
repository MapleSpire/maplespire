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

import {
  currentWorkspaceRef,
  subscribeWorkspaceRef,
  workspaceRefKey,
  type WorkspaceRef,
} from '../automerge/workspace'

import { API_BASE } from '../api/base'

export interface WorkspaceInvalidation {
  workspace: WorkspaceRef
  generation: number
  kind: 'ready' | 'invalidate'
}
type Listener = (event: WorkspaceInvalidation) => void

const listeners = new Set<Listener>()
let source: EventSource | null = null
let sourceWorkspaceKey: string | null = null
let workspaceUnsubscribe: (() => void) | null = null
let lifecycleInstalled = false
let pending: WorkspaceInvalidation | null = null
let flushScheduled = false

function eventUrl(workspace: WorkspaceRef): string {
  const params = new URLSearchParams({
    landscapeId: workspace.landscapeId,
    versionId: workspace.versionId,
  })
  return `${API_BASE}/api/model/cache/events?${params.toString()}`
}

function closeSource(): void {
  source?.close()
  source = null
  sourceWorkspaceKey = null
}

function parseGeneration(event: Event): number | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return null
  try {
    const generation = Number((JSON.parse(event.data) as { generation?: unknown }).generation)
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : null
  } catch {
    return null
  }
}

function enqueue(kind: WorkspaceInvalidation['kind'], workspace: WorkspaceRef, generation: number): void {
  const workspaceKey = workspaceRefKey(workspace)
  if (workspaceKey !== workspaceRefKey(currentWorkspaceRef())) return
  if (!pending || generation > pending.generation) {
    pending = { kind, workspace, generation }
  } else if (generation === pending.generation && kind === 'invalidate') {
    pending = { kind, workspace, generation }
  }
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    const next = pending
    pending = null
    if (!next || workspaceRefKey(next.workspace) !== workspaceRefKey(currentWorkspaceRef())) return
    for (const listener of [...listeners]) {
      try {
        listener(next)
      } catch (error) {
        console.error('[model-read-cache] workspace invalidation listener failed', error)
      }
    }
  })
}

function openSource(): void {
  if (
    listeners.size === 0
    || typeof EventSource === 'undefined'
    || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    || (typeof navigator !== 'undefined' && navigator.onLine === false)
  ) {
    closeSource()
    return
  }
  const workspace = currentWorkspaceRef()
  const workspaceKey = workspaceRefKey(workspace)
  if (source && sourceWorkspaceKey === workspaceKey) return
  closeSource()
  const next = new EventSource(eventUrl(workspace), { withCredentials: true })
  source = next
  sourceWorkspaceKey = workspaceKey
  next.addEventListener('ready', (event) => {
    const generation = parseGeneration(event)
    if (source === next && generation !== null) enqueue('ready', workspace, generation)
  })
  next.addEventListener('invalidate', (event) => {
    const generation = parseGeneration(event)
    if (source === next && generation !== null) enqueue('invalidate', workspace, generation)
  })
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') openSource()
  else closeSource()
}

function installLifecycle(): void {
  if (lifecycleInstalled || typeof window === 'undefined') return
  lifecycleInstalled = true
  workspaceUnsubscribe = subscribeWorkspaceRef(() => {
    pending = null
    closeSource()
    openSource()
  })
  window.addEventListener('online', openSource)
  window.addEventListener('offline', closeSource)
  document.addEventListener('visibilitychange', onVisibility)
}

function uninstallLifecycle(): void {
  if (!lifecycleInstalled || typeof window === 'undefined') return
  lifecycleInstalled = false
  workspaceUnsubscribe?.()
  workspaceUnsubscribe = null
  window.removeEventListener('online', openSource)
  window.removeEventListener('offline', closeSource)
  document.removeEventListener('visibilitychange', onVisibility)
  pending = null
  closeSource()
}

/** One lazy EventSource per browser tab. Every active consumer shares it; the
 * connection is closed when the last consumer unsubscribes. The event is only a
 * generation invalidation — consumers still read their authoritative endpoint. */
export function subscribeCurrentWorkspaceInvalidations(listener: Listener): () => void {
  listeners.add(listener)
  installLifecycle()
  openSource()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) uninstallLifecycle()
  }
}

export function __resetWorkspaceInvalidationForTests(): void {
  listeners.clear()
  uninstallLifecycle()
  pending = null
  flushScheduled = false
}
