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

import { create } from 'zustand'
import { useModelStore } from '../../stores/modelStore'
import { workspaceKvStore } from './kvStore'
import { coldBuildIndexFromShards } from './shardIndexSync'
import { recoverTechnologyPostingsIfNeeded } from './technologyPostings'
import { recoverTagPostingsIfNeeded } from './tagPostings'
import { notifyModelIndexChanged } from './indexSync'
import { currentWorkspaceRef, workspaceRefKey } from '../automerge/workspace'
import { workspaceSearchParams } from './workspaceParams'
import { workspaceApiFetch } from '../api/http'
import type { ModelIndexInput } from './modelIndex'
import type { C4Object, Connection } from '../../types'
import { recordModelQueryOperation } from '../observability/modelQueryDiagnostics'

/**
 * Hybrid offline read model.
 *
 * Under boot-from-server the app paints the active diagram from the server render
 * and the resident store holds ONLY that window. The global tables (Model Objects /
 * Connections / picker) need the WHOLE model, so we make the persisted IndexedDB
 * index the complete local read model — built in the BACKGROUND so it never blocks
 * boot, and resilient to the two things an enterprise environment can take away:
 *
 *   1. the web worker (blocked by CSP) — the build runs on a time-sliced main
 *      thread as the fallback;
 *   2. Postgres (unreachable) — the build falls back to the local Automerge shards,
 *      which a returning client already has on disk.
 *
 * Resilience matrix (always lands on a working local index):
 *   warm index (prior build) ............... instant, no server, no worker
 *   cold + server up ....................... page the read-model API → build
 *   cold + server down + shards local ...... merge local shards → build
 *
 * Once ready, `getModelQuery()` serves the tables from the index (the whole model,
 * expandable + searchable) regardless of the windowed store. Until then the tables
 * fall back to the server tier (zero-wait) or the resident window.
 */

import { API_BASE } from '../api/base'
/** Marks that a FULL cold-build has populated the index (vs a windowed store-fed
 * write). Its presence ⇒ the index is the complete read model and usable offline.
 * Stored INSIDE the per-workspace namespaced store, so it never needs the workspace
 * folded into the key itself. */
const BUILT_KEY = 'idx:complete'
/**
 * Bump when the index's shape OR its freshness guarantees change so EXISTING warm
 * indices are rebuilt from the server read model instead of trusted (e.g. indices
 * that may hold stale pre-edit records). Going forward applyOffWindowEditsToIndex
 * keeps the index fresh.
 */
const INDEX_VERSION = 3

export type IndexSource = 'warm' | 'server' | 'shards'

interface IndexReadyState {
  /** The index is the complete read model and `getModelQuery()` may serve tables from it. */
  ready: boolean
  /** A background build is in flight. */
  building: boolean
  /** Where the ready index came from (telemetry / DEV). */
  source: IndexSource | null
  /** Last build error (the tables stay on the server/resident fallback). */
  error: string | null
}

const READY_DEFAULT: IndexReadyState = { ready: false, building: false, source: null, error: null }

/**
 * Readiness is PER WORKSPACE — a workspace switch must never report the
 * previous workspace's "index complete" state (which would make `getModelQuery()`
 * serve `pagedModelQuery` against a namespace that hasn't been built yet, or skip
 * rebuilding one that has gone stale). Keyed by `workspaceRefKey`; entries are
 * created lazily and default to not-ready.
 *
 * `setReadyState`/`getReadyState` take an EXPLICIT key so a build in flight for
 * workspace A (started, then the user switches to B before it resolves) always
 * writes A's entry, never B's — see `ensureIndexReady`. `useIndexReady` (the public,
 * Zustand-shaped façade below) always reads/writes the CURRENTLY ACTIVE workspace,
 * for callers (e.g. a "building index…" banner) that just want "is my index ready".
 */
const readyByWorkspace = new Map<string, IndexReadyState>()

function getReadyState(key: string): IndexReadyState {
  return readyByWorkspace.get(key) ?? READY_DEFAULT
}

function setReadyState(
  key: string,
  patch: Partial<IndexReadyState> | ((s: IndexReadyState) => Partial<IndexReadyState>)
): void {
  const prevState = getReadyState(key)
  const next = { ...prevState, ...(typeof patch === 'function' ? patch(prevState) : patch) }
  readyByWorkspace.set(key, next)
  listeners.forEach((fn) => fn())
}

const listeners = new Set<() => void>()

/** Zustand-shaped façade over the ACTIVE workspace's ready state (existing
 * subscribers — e.g. a status banner — read/subscribe exactly as before; which
 * workspace they see just now follows `currentWorkspaceRef()`).
 *
 * NOTE: only `getState`/`setState`/`subscribe` are wired to the per-workspace map —
 * there is currently no React consumer that calls `useIndexReady()` as a selector
 * hook (verified: every call site today is `.getState()`). If one is added, it must
 * ALSO re-render on a workspace switch (not just a ready-state change within one
 * workspace); wire `subscribe` into it via `useSyncExternalStore` rather than
 * `create()`'s built-in hook, which this façade intentionally bypasses. */
export const useIndexReady = create<IndexReadyState>(() => READY_DEFAULT) as unknown as {
  getState: () => IndexReadyState
  setState: (patch: Partial<IndexReadyState> | ((s: IndexReadyState) => Partial<IndexReadyState>)) => void
  subscribe: (fn: () => void) => () => void
}
useIndexReady.getState = () => getReadyState(workspaceRefKey(currentWorkspaceRef()))
useIndexReady.setState = (patch) => setReadyState(workspaceRefKey(currentWorkspaceRef()), patch)
useIndexReady.subscribe = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Synchronous gate for `getModelQuery()` — true once the ACTIVE workspace's local
 * index is complete. */
export function isIndexReady(): boolean {
  return getReadyState(workspaceRefKey(currentWorkspaceRef())).ready
}

/** Test / teardown hook. Clears EVERY workspace's ready state (tests reset globally
 * between cases) and drops in-flight build promises. */
export function __resetIndexReady(): void {
  readyByWorkspace.clear()
  inFlightByWorkspace.clear()
}

function markReady(key: string, source: IndexSource): void {
  setReadyState(key, { ready: true, building: false, source, error: null })
  // Heavy-view readers cache on the index version; bump it so the now-complete
  // index is picked up by tables that already rendered (windowed/server) data.
  notifyModelIndexChanged()
  // Do not prewarm the legacy whole-model arrays here. At 100k/300k that turns a
  // successful background build into another full IndexedDB read + large JS
  // allocation. Consumers must request bounded pages; the legacy arrays remain a
  // temporary fallback until the Worker-backed stores are active.
}

// ── sources ───────────────────────────────────────────────────────────────────

/** Keyset-page through a read-model page endpoint into a flat array, scoped to the
 * ACTIVE workspace (`workspaceSearchParams`) so a non-default workspace assembles ITS
 * OWN model instead of always paging the default landscape's ro_* rows. The workspace
 * params are captured ONCE before the loop — if the active workspace changes mid-page
 * (a fast double-switch), every remaining page still targets the workspace this build
 * started for, rather than silently splicing pages from two different workspaces. */
async function pageAll<T>(path: string, key: 'objects' | 'connections'): Promise<T[]> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const ws = workspaceSearchParams().toString()
  const out: T[] = []
  let after: string | null = null
  // Safety cap (≫ any real workspace): 1000/page × 100000 pages.
  for (let i = 0; i < 100000; i++) {
    const url = `${API_BASE}${path}?limit=1000${after ? `&after=${encodeURIComponent(after)}` : ''}&${ws}`
    const res = await workspaceApiFetch(url)
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
    const page = (await res.json()) as Record<string, unknown> & { nextCursor: string | null }
    out.push(...((page[key] as T[]) ?? []))
    after = page.nextCursor
    if (!after) break
  }
  recordModelQueryOperation({
    operation: `offline-index.page-all-${key}`,
    durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started,
    rowsRead: out.length,
    resultRows: out.length,
    fullScan: true,
  })
  return out
}

/** Assemble the whole model from the server read-model page API (fast path).
 * groups + diagrams come from the (fully-resident) store — snapshotted BEFORE the
 * (multi-page, potentially slow) fetch so a workspace switch mid-build can't fold
 * the NEW workspace's registry into the OLD workspace's index build. */
async function assembleFromServer(): Promise<ModelIndexInput> {
  const { groups, diagrams } = useModelStore.getState()
  const [objects, connections] = await Promise.all([
    pageAll<C4Object>('/api/model/page-objects', 'objects'),
    pageAll<Connection>('/api/model/page-connections', 'connections'),
  ])
  return { objects, connections, groups, diagrams }
}

// ── orchestration ───────────────────────────────────────────────────────────────

/** In-flight build promises, one per workspace — so switching workspaces mid-build
 * starts (or joins) the NEW workspace's build rather than awaiting the old one, and
 * two calls for the SAME workspace still single-flight. */
const inFlightByWorkspace = new Map<string, Promise<void>>()

/**
 * Make the ACTIVE workspace's local index the complete read model. Idempotent +
 * single-flight per workspace: safe to call on every boot / workspace switch.
 * Resolves once that workspace's index is ready (or stays on the fallback if every
 * source fails — never throws to the caller).
 */
export function ensureIndexReady(): Promise<void> {
  const key = workspaceRefKey(currentWorkspaceRef())
  if (getReadyState(key).ready) return Promise.resolve()
  const existing = inFlightByWorkspace.get(key)
  if (existing) return existing
  // Snapshot the target workspace's store NOW — the build is async and must keep
  // writing into THIS workspace's namespace even if the active workspace changes
  // again before it finishes (the still-in-flight build for a now-inactive
  // workspace should still complete and mark ITS OWN entry ready, not the new one).
  const store = workspaceKvStore()
  const build = (async () => {
    setReadyState(key, { building: true, error: null })
    try {
      // WARM: a previous session already cold-built the full index AT THE CURRENT
      // VERSION → use it instantly (works fully offline: no server, no worker). A
      // version mismatch (older build) falls through to a clean rebuild below.
      const built = await store.get<{ v?: number }>(BUILT_KEY)
      if (built && built.v === INDEX_VERSION) {
        await Promise.all([
          recoverTechnologyPostingsIfNeeded(store),
          recoverTagPostingsIfNeeded(store),
        ])
        markReady(key, 'warm')
        return
      }
      // COLD: assemble the whole model from the best available source and build.
      // Slice 1b will add the shard fallback; for now the server is the source.
      const model = await assembleFromServer()
      // Wipe first so a prior windowed (store-fed) OR older-version index can't leave
      // stale entries behind. Scoped to THIS workspace's namespace only (namespacedKvStore
      // .clear() prefix-deletes) — other workspaces' already-built indices are untouched.
      await store.clear()
      await coldBuildIndexFromShards(store, model)
      await store.set(BUILT_KEY, { v: INDEX_VERSION })
      markReady(key, 'server')
    } catch (err) {
      console.error('[offlineIndex] background index build failed:', err)
      setReadyState(key, { building: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      inFlightByWorkspace.delete(key)
    }
  })()
  inFlightByWorkspace.set(key, build)
  return build
}

// DEV / E2E hook: observe the background index build so a test can WAIT for the
// complete local index before going offline (the offline render fallback is gated on
// it). `ready()` is the sync gate; `whenReady()` resolves once the build finishes.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__indexReady = {
    ready: () => useIndexReady.getState().ready,
    state: () => useIndexReady.getState(),
    whenReady: () => ensureIndexReady(),
  }
}
