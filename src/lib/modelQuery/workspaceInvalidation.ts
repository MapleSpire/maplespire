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
import { workspaceSearchParams } from './workspaceParams'

import { API_BASE } from '../api/base'

export interface WorkspaceInvalidation {
  workspace: WorkspaceRef
  generation: number
  kind: 'ready' | 'invalidate'
}
type Listener = (event: WorkspaceInvalidation) => void

const listeners = new Set<Listener>()
let source: EventSource | null = null
let sourceUrl: string | null = null
let workspaceUnsubscribe: (() => void) | null = null
let lifecycleInstalled = false
let pending: WorkspaceInvalidation | null = null
let flushScheduled = false

/** The generations streamed are those of the workspace the READS address
 * (`workspaceSearchParams`) when the stream opens, not of the `'current'`
 * alias: the bridge compares them with the generation of the render it fetched,
 * and after a repoint the alias's generations belong to another version's
 * projector. Opening is re-evaluated on every subscribe (the bridge subscribes
 * after each boot), a ref change, `online` and visibility — not on a hold or a
 * basis change by themselves. */
function eventUrl(): string {
  return `${API_BASE}/api/model/cache/events?${workspaceSearchParams().toString()}`
}

/**
 * REOPENING A STREAM THE BROWSER GAVE UP ON (T-DIAGDEF).
 *
 * An EventSource reconnects by itself only after a stream that OPENED; a
 * request that fails — a 503 while a cell shuts down, a 502 from the proxy in
 * front of it — moves it to `CLOSED` for good. Left there, `openSource` kept
 * the dead source (`source && sourceUrl === url`) and the tab lost every
 * invalidation until a workspace change or a reload. So on `CLOSED` the source
 * is dropped and reopened after a delay that doubles from
 * {@link REOPEN_FIRST_MS} to {@link REOPEN_MAX_MS} (no tight loop against a
 * server that keeps refusing), reset by the first event of a stream that works.
 */
export const REOPEN_FIRST_MS = 2_000
export const REOPEN_MAX_MS = 60_000
let reopenTimer: ReturnType<typeof setTimeout> | null = null
let reopenDelayMs = REOPEN_FIRST_MS

function cancelReopen(): void {
  if (reopenTimer) clearTimeout(reopenTimer)
  reopenTimer = null
}

function scheduleReopen(): void {
  if (reopenTimer) return
  const delay = reopenDelayMs
  reopenDelayMs = Math.min(REOPEN_MAX_MS, reopenDelayMs * 2)
  reopenTimer = setTimeout(() => {
    reopenTimer = null
    openSource()
  }, delay)
}

function closeSource(): void {
  cancelReopen()
  source?.close()
  source = null
  sourceUrl = null
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
  const url = eventUrl()
  if (source && sourceUrl === url) return
  closeSource()
  const next = new EventSource(url, { withCredentials: true })
  source = next
  sourceUrl = url
  next.addEventListener('ready', (event) => {
    const generation = parseGeneration(event)
    if (source !== next) return
    reopenDelayMs = REOPEN_FIRST_MS
    if (generation !== null) enqueue('ready', workspace, generation)
  })
  next.addEventListener('invalidate', (event) => {
    const generation = parseGeneration(event)
    if (source === next && generation !== null) enqueue('invalidate', workspace, generation)
  })
  next.addEventListener('error', () => {
    // CONNECTING: the browser retries on its own (`retry:`), nothing to do.
    if (source !== next || next.readyState !== CLOSED_STATE) return
    source = null
    sourceUrl = null
    scheduleReopen()
  })
}

/** `EventSource.CLOSED`, without relying on the constructor's static (a test
 * double, or an environment without it). */
const CLOSED_STATE = 2

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
  cancelReopen()
  reopenDelayMs = REOPEN_FIRST_MS
}
