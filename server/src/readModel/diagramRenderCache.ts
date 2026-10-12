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

import type { WorkspaceKey } from './projector.js'

export interface DiagramRenderCacheKey extends WorkspaceKey {
  diagramId: string
  projectionGeneration: number
  variant?: 'full' | 'diagram-full' | 'first-paint'
  /** Static baseline identity; distinct from the per-diagram mutation token. */
  baselineEpoch?: string
}

/** The cache keeps the already-serialized response. Besides avoiding the
 * workspace-wide SQL render, this means a fan-out does not repeatedly stringify
 * the same payload on Node's event loop. */
export interface SerializedDiagramRender {
  projectionGeneration: number
  /** Cache dependency token. Defaults to the workspace snapshot generation. */
  cacheGeneration?: number
  body: string
}

export type DiagramRenderCacheStatus = 'hit' | 'shared-hit' | 'miss' | 'coalesced'

export interface DiagramRenderCacheResult {
  value: SerializedDiagramRender | undefined
  status: DiagramRenderCacheStatus
}

export interface DiagramRenderCacheConfig {
  maxEntries: number
  /** Approximate JavaScript heap bytes, not UTF-8 wire bytes. */
  maxBytes: number
  maxEntryBytes: number
}

export interface DiagramRenderCacheStats {
  entries: number
  bytes: number
  inFlight: number
  hits: number
  misses: number
  coalesced: number
  loads: number
  loadErrors: number
  evictions: number
  bypassedEntries: number
  sharedHits: number
  sharedMisses: number
  sharedErrors: number
}

export interface DiagramRenderSharedCache {
  get(key: DiagramRenderCacheKey): Promise<SerializedDiagramRender | undefined>
  set(key: DiagramRenderCacheKey, value: SerializedDiagramRender): Promise<void>
}

const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024

function boundedInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback
}

export function diagramRenderCacheConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): DiagramRenderCacheConfig {
  const maxEntries = boundedInteger(env.READ_MODEL_RENDER_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES, 10_000)
  const maxBytes = boundedInteger(env.READ_MODEL_RENDER_CACHE_MAX_BYTES, DEFAULT_MAX_BYTES, 2 * 1024 * 1024 * 1024)
  const configuredMaxEntryBytes = boundedInteger(
    env.READ_MODEL_RENDER_CACHE_MAX_ENTRY_BYTES,
    DEFAULT_MAX_ENTRY_BYTES,
    512 * 1024 * 1024
  )
  return {
    maxEntries,
    maxBytes,
    maxEntryBytes: Math.min(configuredMaxEntryBytes, maxBytes),
  }
}

interface CacheEntry {
  value: SerializedDiagramRender
  bytes: number
}

function cacheKey(key: DiagramRenderCacheKey): string {
  // JSON tuple encoding avoids delimiter collisions with user-controlled IDs.
  return JSON.stringify([
    key.landscapeId,
    key.versionId,
    key.diagramId,
    key.projectionGeneration,
    key.variant ?? 'full',
    key.baselineEpoch ?? '',
  ])
}

/** A process-local, generation-addressed L1 LRU with exact-key single-flight.
 *
 * Every API pod owns its L1; an optional shared Redis L2 is consulted on L1
 * misses. PostgreSQL's projected_generation remains the shared authority, so no
 * distributed invalidation is required for correctness: after a commit,
 * requests use a new key and can no longer hit either old entry.
 */
export class DiagramRenderCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly pending = new Map<string, Promise<SerializedDiagramRender | undefined>>()
  private bytes = 0
  private readonly counters = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    loads: 0,
    loadErrors: 0,
    evictions: 0,
    bypassedEntries: 0,
    sharedHits: 0,
    sharedMisses: 0,
    sharedErrors: 0,
  }

  constructor(
    private readonly config: DiagramRenderCacheConfig = diagramRenderCacheConfig(),
    private readonly shared?: DiagramRenderSharedCache,
  ) {}

  async getOrLoad(
    key: DiagramRenderCacheKey,
    load: () => Promise<SerializedDiagramRender | undefined>
  ): Promise<DiagramRenderCacheResult> {
    const requestedKey = cacheKey(key)
    const cached = this.entries.get(requestedKey)
    if (cached) {
      this.counters.hits += 1
      // Map insertion order is the LRU order. Refresh this entry to MRU.
      this.entries.delete(requestedKey)
      this.entries.set(requestedKey, cached)
      return { value: cached.value, status: 'hit' }
    }

    const running = this.pending.get(requestedKey)
    if (running) {
      this.counters.coalesced += 1
      return { value: await running, status: 'coalesced' }
    }

    this.counters.misses += 1
    let resolvedFromShared = false
    const promise: Promise<SerializedDiagramRender | undefined> = Promise.resolve()
      .then(async () => {
        if (this.shared) {
          try {
            const shared = await this.shared.get(key)
            if (shared) {
              this.counters.sharedHits += 1
              resolvedFromShared = true
              return { value: shared, shared: true }
            }
            this.counters.sharedMisses += 1
          } catch {
            // Redis is an optimization only. A cache outage must fall through
            // to the authoritative PostgreSQL render transaction.
            this.counters.sharedErrors += 1
          }
        }
        this.counters.loads += 1
        return { value: await load(), shared: false }
      })
      .then(async ({ value, shared }) => {
        if (!shared && value && this.shared) {
          const actualKey = { ...key, projectionGeneration: value.cacheGeneration ?? value.projectionGeneration }
          await this.shared.set(actualKey, value).catch(() => { this.counters.sharedErrors += 1 })
        }
        return value
      })
      .then((value) => {
        if (value) {
          // A projector may commit between the cheap generation lookup and the
          // repeatable-read render transaction. Cache under the generation that
          // actually produced the body, never under the stale observed key.
          this.store({ ...key, projectionGeneration: value.cacheGeneration ?? value.projectionGeneration }, value)
        }
        return value
      })
      .catch((error: unknown) => {
        this.counters.loadErrors += 1
        throw error
      })
      .finally(() => {
        if (this.pending.get(requestedKey) === promise) this.pending.delete(requestedKey)
      })
    this.pending.set(requestedKey, promise)
    const value = await promise
    return {
      value,
      status: resolvedFromShared ? 'shared-hit' : 'miss',
    }
  }

  snapshot(): DiagramRenderCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      inFlight: this.pending.size,
      ...this.counters,
    }
  }

  private store(key: DiagramRenderCacheKey, value: SerializedDiagramRender): void {
    // V8 strings may occupy two bytes per UTF-16 code unit. This deliberately
    // conservative estimate prevents an ASCII-heavy JSON cache from claiming
    // only its smaller UTF-8 wire size while consuming more JavaScript heap.
    const bytes = value.body.length * 2
    if (
      this.config.maxEntries === 0 ||
      this.config.maxBytes === 0 ||
      bytes > this.config.maxEntryBytes ||
      bytes > this.config.maxBytes
    ) {
      this.counters.bypassedEntries += 1
      return
    }

    const id = cacheKey(key)
    const previous = this.entries.get(id)
    if (previous) {
      this.entries.delete(id)
      this.bytes -= previous.bytes
    }
    this.entries.set(id, { value, bytes })
    this.bytes += bytes

    while (this.entries.size > this.config.maxEntries || this.bytes > this.config.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.bytes -= oldest[1].bytes
      this.counters.evictions += 1
    }
  }
}
