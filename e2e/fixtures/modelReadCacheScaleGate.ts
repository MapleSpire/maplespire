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

import type { C4Object, C4Type, Connection } from '../../src/types'
import type { CachedConnectionInput, CachedModelEntityInput } from '../../src/lib/modelQuery/idbSchema'
import { ModelReadCacheWorkerClient } from '../../src/lib/modelQuery/workerClient'
import {
  readModelQueryDiagnostics,
  resetModelQueryDiagnostics,
} from '../../src/lib/observability/modelQueryDiagnostics'

export interface ModelReadCacheScaleOptions {
  objectCount: number
  connectionCount: number
  objectBatchSize?: number
  connectionBatchSize?: number
  iterations?: number
}

interface TimedMeasurement {
  name: string
  samplesMs: number[]
  p50Ms: number
  p95Ms: number
  maxMs: number
  resultRows: number
  averageRowsRead: number
}

export interface ModelReadCacheScaleResult {
  objectCount: number
  connectionCount: number
  objectIngestMs: number
  connectionIngestMs: number
  totalIngestMs: number
  maxHeartbeatGapMs: number
  longTasks: Array<{ startMs: number; durationMs: number }>
  measurements: TimedMeasurement[]
  searchPagination: {
    pages: number
    rows: number
    uniqueRows: number
    cursorAdvanced: boolean
  }
  cache: {
    objects: number
    connections: number
    accountedBytes: number
  }
  storage: {
    usage?: number
    quota?: number
  }
  jsHeap: {
    initialBytes?: number
    peakBytes?: number
    finalBytes?: number
  }
}

export interface ModelReadCacheScaleProgress {
  phase: 'starting' | 'objects' | 'connections' | 'queries' | 'complete'
  completed: number
  total: number
  elapsedMs: number
}

declare global {
  interface Window {
    __modelReadCacheScaleProgress?: ModelReadCacheScaleProgress
  }
}

interface ChromiumPerformanceMemory {
  usedJSHeapSize?: number
}

const TYPES: C4Type[] = ['system', 'app', 'store', 'component', 'actor']
const ROOT_COUNT = 100

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
  return value
}

function id(prefix: string, value: number, width: number): string {
  return `${prefix}-${String(value).padStart(width, '0')}`
}

function objectName(value: number): string {
  return value % 1_000 === 0 ? `Checkout service ${String(value).padStart(6, '0')}` : `Service ${String(value).padStart(6, '0')}`
}

function makeObject(value: number, objectCount: number): CachedModelEntityInput {
  const objectId = id('obj', value, 6)
  const name = objectName(value)
  const parentValue = value <= ROOT_COUNT ? null : ((value - 1) % ROOT_COUNT) + 1
  const parentId = parentValue == null ? undefined : id('obj', parentValue, 6)
  const type = TYPES[value % TYPES.length]
  const childCount = value <= ROOT_COUNT
    ? Math.floor((objectCount - ROOT_COUNT + ROOT_COUNT - value) / ROOT_COUNT)
    : 0
  const payload: C4Object = {
    id: objectId,
    type,
    name,
    description: value % 1_000 === 0 ? 'Checkout workload' : '',
    position: { x: 0, y: 0 },
    size: { width: 160, height: 96 },
    parentId,
    tagAssignments: {},
    tagOrder: [],
    scope: value % 2 === 0 ? 'internal' : 'external',
    status: value % 7 === 0 ? 'down' : 'live',
    properties: {},
  }
  return {
    id: objectId,
    kind: 'object',
    name,
    type,
    parentId,
    childCount,
    connectionCount: 0,
    diagramCount: value <= 10_000 ? 1 : 0,
    inDiagram: value <= 10_000,
    breadcrumb: parentId ? [{ id: parentId, name: objectName(parentValue!) }] : [],
    searchText: `${name} ${payload.description ?? ''}`,
    payload,
  }
}

function makeConnection(value: number, objectCount: number): CachedConnectionInput {
  const fromValue = ((value - 1) % objectCount) + 1
  const toValue = ((value + 7_918) % objectCount) + 1
  const label = value % 3_000 === 0 ? 'Checkout event' : 'Calls'
  const connection: Connection = {
    id: id('conn', value, 7),
    fromId: id('obj', fromValue, 6),
    toId: id('obj', toValue, 6),
    label,
    type: 'solid',
    kind: 'direct',
    status: 'live',
  }
  return {
    connection,
    fromName: objectName(fromValue),
    fromType: TYPES[fromValue % TYPES.length],
    toName: objectName(toValue),
    toType: TYPES[toValue % TYPES.length],
    diagramCount: value <= 30_000 ? 1 : 0,
    flowCount: 0,
  }
}

function percentile(samples: number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function measure<Result extends object>(
  name: string,
  diagnosticOperation: string,
  iterations: number,
  operation: () => Promise<Result>,
): Promise<TimedMeasurement> {
  resetModelQueryDiagnostics()
  for (let index = 0; index < 3; index += 1) await operation()
  const samplesMs: number[] = []
  let resultRows = 0
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    const result = await operation()
    samplesMs.push(performance.now() - startedAt)
    const page = result as Result & { items?: unknown[]; objects?: unknown[] }
    resultRows = page.items?.length
      ?? page.objects?.length
      ?? 0
  }
  const metric = readModelQueryDiagnostics().operations[diagnosticOperation]
  return {
    name,
    samplesMs,
    p50Ms: percentile(samplesMs, 0.5),
    p95Ms: percentile(samplesMs, 0.95),
    maxMs: Math.max(...samplesMs),
    resultRows,
    averageRowsRead: metric ? metric.rowsRead / Math.max(1, metric.calls) : 0,
  }
}

export async function runModelReadCacheScaleGate(
  options: ModelReadCacheScaleOptions,
): Promise<ModelReadCacheScaleResult> {
  const objectCount = positiveInteger(options.objectCount, 'objectCount')
  const connectionCount = positiveInteger(options.connectionCount, 'connectionCount')
  const objectBatchSize = positiveInteger(options.objectBatchSize ?? 500, 'objectBatchSize')
  const connectionBatchSize = positiveInteger(options.connectionBatchSize ?? 2_000, 'connectionBatchSize')
  const iterations = positiveInteger(options.iterations ?? 15, 'iterations')
  const workspaceKey = `scale-gate:${Date.now()}:${crypto.randomUUID()}`
  const generation = 1
  const client = new ModelReadCacheWorkerClient()
  const gateStartedAt = performance.now()
  const progress = (
    phase: ModelReadCacheScaleProgress['phase'],
    completed: number,
    total: number,
  ) => {
    const event = { phase, completed, total, elapsedMs: performance.now() - gateStartedAt }
    window.__modelReadCacheScaleProgress = event
    console.info(`[model-cache-scale] ${JSON.stringify(event)}`)
  }
  progress('starting', 0, objectCount + connectionCount)

  const heartbeatStartedAt = performance.now()
  let previousHeartbeat = heartbeatStartedAt
  let maxHeartbeatGapMs = 0
  const heartbeat = window.setInterval(() => {
    const current = performance.now()
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, current - previousHeartbeat)
    previousHeartbeat = current
  }, 50)

  const longTasks: Array<{ startMs: number; durationMs: number }> = []
  let longTaskObserver: PerformanceObserver | undefined
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startMs: entry.startTime, durationMs: entry.duration })
      }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch {
    // Older browsers still produce a heartbeat measurement.
  }

  const performanceMemory = performance as Performance & { memory?: ChromiumPerformanceMemory }
  const initialHeapBytes = performanceMemory.memory?.usedJSHeapSize
  let peakHeapBytes = initialHeapBytes
  const heapSampler = window.setInterval(() => {
    const current = performanceMemory.memory?.usedJSHeapSize
    if (current != null) peakHeapBytes = Math.max(peakHeapBytes ?? 0, current)
  }, 100)

  try {
    await client.activateGeneration({
      workspaceKey,
      generation,
      serverGeneration: generation,
      coverage: 'full',
      pinned: true,
    })

    const totalStartedAt = performance.now()
    const objectsStartedAt = performance.now()
    for (let start = 1; start <= objectCount; start += objectBatchSize) {
      const end = Math.min(objectCount, start + objectBatchSize - 1)
      const items: CachedModelEntityInput[] = []
      for (let value = start; value <= end; value += 1) items.push(makeObject(value, objectCount))
      await client.upsertObjects({ workspaceKey, generation, items, assumeAbsent: true })
      if (end === objectCount || Math.floor((start - 1) / objectBatchSize) % 10 === 0) {
        progress('objects', end, objectCount)
      }
      await yieldToBrowser()
    }
    const objectIngestMs = performance.now() - objectsStartedAt

    const connectionsStartedAt = performance.now()
    for (let start = 1; start <= connectionCount; start += connectionBatchSize) {
      const end = Math.min(connectionCount, start + connectionBatchSize - 1)
      const items: CachedConnectionInput[] = []
      for (let value = start; value <= end; value += 1) items.push(makeConnection(value, objectCount))
      await client.upsertConnections({ workspaceKey, generation, items, assumeAbsent: true })
      if (end === connectionCount || Math.floor((start - 1) / connectionBatchSize) % 10 === 0) {
        progress('connections', end, connectionCount)
      }
      await yieldToBrowser()
    }
    const connectionIngestMs = performance.now() - connectionsStartedAt
    const totalIngestMs = performance.now() - totalStartedAt

    await client.commitServerGeneration({ workspaceKey, serverGeneration: generation })

    const measurements: TimedMeasurement[] = []
    progress('queries', 0, 7)
    measurements.push(await measure('object-tree-roots', 'worker.queryChildren', iterations, () => client.queryChildren({
      workspaceKey, parentId: null, limit: 50,
    })))
    progress('queries', 1, 7)
    measurements.push(await measure('object-search-checkout', 'worker.searchObjects', iterations, () => client.searchObjects({
      workspaceKey, query: 'checkout', limit: 50,
    })))
    progress('queries', 2, 7)
    measurements.push(await measure('object-search-prefix-ch', 'worker.searchObjects', iterations, () => client.searchObjects({
      workspaceKey, query: 'ch', limit: 50,
    })))
    progress('queries', 3, 7)
    measurements.push(await measure('connection-page', 'worker.queryConnections', iterations, () => client.queryConnections({
      workspaceKey, limit: 50,
    })))
    progress('queries', 4, 7)
    measurements.push(await measure('connection-search-checkout', 'worker.queryConnections', iterations, () => client.queryConnections({
      workspaceKey, query: 'checkout', limit: 50,
    })))
    progress('queries', 5, 7)
    measurements.push(await measure('dependency-fanout', 'worker.queryDependencyPeers', iterations, () => client.queryDependencyPeers({
      workspaceKey, focusId: 'obj-000001', direction: 'outgoing', limit: 50,
    })))
    progress('queries', 6, 7)
    measurements.push(await measure('viewer-root-level', 'worker.queryViewerLevel', iterations, () => client.queryViewerLevel({
      workspaceKey, parentId: null, limit: 50, connectionLimit: 500,
    })))
    progress('queries', 7, 7)

    const pagedConnectionIds: string[] = []
    const seenCursors = new Set<string>()
    let searchCursor: string | null = null
    let searchPages = 0
    let cursorAdvanced = true
    do {
      const page = await client.queryConnections({
        workspaceKey, query: 'service', limit: 50, after: searchCursor,
      })
      pagedConnectionIds.push(...page.items.map((record) => record.id))
      searchPages += 1
      searchCursor = page.nextCursor
      if (searchCursor && seenCursors.has(searchCursor)) cursorAdvanced = false
      if (searchCursor) seenCursors.add(searchCursor)
    } while (searchCursor && searchPages < 4)
    const searchPagination = {
      pages: searchPages,
      rows: pagedConnectionIds.length,
      uniqueRows: new Set(pagedConnectionIds).size,
      cursorAdvanced,
    }

    const [meta] = await client.storageStatus({ workspaceKey })
    const estimate = await navigator.storage.estimate()
    const finalHeapBytes = performanceMemory.memory?.usedJSHeapSize
    const accountedBytes = Object.values(meta?.accountedBytes ?? {}).reduce((sum, value) => sum + value, 0)
    progress('complete', objectCount + connectionCount, objectCount + connectionCount)
    return {
      objectCount,
      connectionCount,
      objectIngestMs,
      connectionIngestMs,
      totalIngestMs,
      maxHeartbeatGapMs,
      longTasks: [...longTasks].sort((left, right) => right.durationMs - left.durationMs).slice(0, 20),
      measurements,
      searchPagination,
      cache: {
        objects: meta?.objectCount ?? 0,
        connections: meta?.connectionCount ?? 0,
        accountedBytes,
      },
      storage: { usage: estimate.usage, quota: estimate.quota },
      jsHeap: { initialBytes: initialHeapBytes, peakBytes: peakHeapBytes, finalBytes: finalHeapBytes },
    }
  } finally {
    window.clearInterval(heartbeat)
    window.clearInterval(heapSampler)
    longTaskObserver?.disconnect()
    client.dispose()
  }
}
