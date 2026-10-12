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

import { createServer, type Server } from 'node:http'
import { pool } from '../db.js'
import { envNumber } from '../envNumber.js'
import { redisRuntime } from '../runtime/redis.js'
import { routerReadinessReport } from '../runtime/readiness.js'
import { startMetricsListener, type MetricsListener } from '../runtime/metricsListener.js'
import { syncCellPartitionConfig } from './assignment.js'
import { FencedPartitionLeaseStore } from './ownership.js'
import { startRouterTopologyGuard, SyncCellRouterTopologyMismatchError } from './routerTopology.js'
import { createOwnerAwareWsUpgradeHandler, type OwnerAwareWsUpgradeHandler } from './ownerAwareWsRouter.js'
import { RouterPlacementRefresh } from './routerPlacement.js'
import { syncRouterMetricSamples } from './routerMetrics.js'

const port = Number(process.env.PORT ?? 3010)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}
const partition = syncCellPartitionConfig()
const ownerStore = new FencedPartitionLeaseStore(redisRuntime, partition.topologyGeneration,
  partition.placementMode, partition.reservedPartitions)

// These lifetimes exist before any awaited boot step or fatal callback. Stop
// prevents new admission immediately, then joins boot and the new refresh work
// before ending the pool used by them.
let httpServer: Server | null = null
let metricsListener: MetricsListener | null = null
let topologyMismatch = false
let topologyState: () => 'pending' | 'confirmed' = () => 'pending'
let handleUpgrade: OwnerAwareWsUpgradeHandler | null = null
let placement: RouterPlacementRefresh | null = null
let stopTopology = () => {}
let stopping = false
let stopFlight: Promise<void> | null = null
let startupFlight: Promise<void> | null = null

async function start(): Promise<void> {
  metricsListener = await startMetricsListener({
    port: envNumber('SYNC_ROUTER_METRICS_PORT', { fallback: 9464, minimum: 1, maximum: 65_535, integer: true }),
    token: process.env.METRICS_TOKEN,
    collect: () => syncRouterMetricSamples(
      topologyMismatch ? 'mismatch' : topologyState(), handleUpgrade?.metricsSnapshot(),
    ),
    log: (event, fields) => console.error(JSON.stringify({ event: `sync.router.${event}`, ...fields })),
  })
  if (stopping) return
  const connections = await Promise.allSettled([redisRuntime.start(), pool.query('SELECT 1')])
  const failed = connections.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason), 'Router connection startup failed')
  if (stopping) return
  if (!redisRuntime.ready) throw new Error('Owner-aware WebSocket router requires a ready Redis connection')

  // G6.3 remains before upgrade construction/listen: topology pending is an
  // explicit state, whereas disagreement at boot or later is still fatal.
  const topologyGuard = await startRouterTopologyGuard({
    store: ownerStore,
    partitionCount: partition.partitionCount,
    db: pool,
    onFatal: (error) => {
      topologyMismatch = true
      console.error(JSON.stringify({ event: 'sync.router.topology_mismatch_after_boot', detail: error.message }))
      void stop('topology-mismatch').then(() => process.exit(1), (cleanupError) => {
        console.error('[sync-router] fatal shutdown failed:', cleanupError)
        process.exit(1)
      })
    },
  })
  topologyState = () => topologyGuard.snapshot().state
  stopTopology = () => topologyGuard.stop()
  if (stopping) { topologyGuard.stop(); return }

  placement = new RouterPlacementRefresh({
    db: pool,
    partition,
    intervalMs: envNumber('SYNC_CELL_RECONCILE_INTERVAL_MS', {
      fallback: 5_000, minimum: 1_000, maximum: 300_000, integer: true,
    }),
    onPublished: () => handleUpgrade?.reconcileOwners() ?? Promise.resolve(),
    onError: (error) => console.error('[sync-router] placement refresh failed:', error),
  })
  const resolver = placement.resolver
  handleUpgrade = createOwnerAwareWsUpgradeHandler({
    db: pool,
    partitionCount: partition.partitionCount,
    partitionOf: (workspace, count) => resolver.partitionOf(workspace, count),
    resolveOwner: (partitionIndex) => ownerStore.resolve(partitionIndex),
  })
  // LISTEN/reconnect and generation-scoped SELECT are owned by this refresh,
  // never by an upgrade. In placed mode a failed first read prevents listen.
  await placement.start()
  if (stopping) return

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/api/ready') {
      // Ask Redis through its bounded probe, not its connection flag: a paused
      // Redis can still complete TCP handshakes.
      // The topology payload preserves pending/confirmed without changing the
      // existing policy: pending correctly serves refusals during first boot.
      redisRuntime.probe()
        .then((reachable) => routerReadinessReport({
          reachable,
          partitionCount: partition.partitionCount,
          configuredGeneration: partition.configuredGeneration,
          effectiveGeneration: partition.effectiveGeneration,
          topologyGeneration: partition.topologyGeneration,
          topology: topologyGuard.snapshot(),
        }))
        .then((report) => {
          response.writeHead(report.status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(report.body))
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ready: false, checks: { redis: false }, role: 'owner-aware-ws-router', error: 'readiness_failed' }))
        })
      return
    }
    response.writeHead(404, { 'content-length': '0' })
    response.end()
  })
  httpServer = server
  const upgrade = handleUpgrade
  server.on('upgrade', (request, socket, head) => { void upgrade(request, socket, head) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  if (stopping) return
  console.log(JSON.stringify({
    event: 'sync.router.ready', port, partitionCount: partition.partitionCount,
    placementMode: partition.placementMode, configuredGeneration: partition.configuredGeneration,
    reservedPartitions: partition.reservedPartitions,
    effectiveGeneration: partition.effectiveGeneration, topologyGeneration: partition.topologyGeneration,
  }))
}

function stop(signal: string): Promise<void> {
  if (stopFlight) return stopFlight
  stopping = true
  console.log(JSON.stringify({ event: 'sync.router.stopping', signal }))
  // Calling these before joining startup also breaks a LISTEN blocked during
  // boot and aborts upgrades already pending on the target cell.
  const topologyStopped = Promise.resolve().then(() => stopTopology())
  const placementStopped = Promise.resolve().then(() => placement?.stop())
  const upgradesStopped = Promise.resolve().then(() => handleUpgrade?.stop())
  stopFlight = (async () => {
    const results = await Promise.allSettled([
      topologyStopped, placementStopped, upgradesStopped,
      // Startup's primary error is reported by the top-level catch below.
      startupFlight?.catch(() => undefined),
    ])
    const server = httpServer
    // Re-read after joining startup: stop may have arrived while bind was in
    // flight, before metricsListener had received its handle.
    results.push(...await Promise.allSettled([metricsListener?.stop()]))
    if (server?.listening) {
      results.push(...await Promise.allSettled([new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })]))
    }
    results.push(...await Promise.allSettled([redisRuntime.stop(), pool.end()]))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Router shutdown failed')
  })()
  return stopFlight
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void stop(signal).then(() => process.exit(0), (error) => {
      console.error('[sync-router] shutdown failed:', error)
      process.exit(1)
    })
  })
}
startupFlight = start()
try {
  await startupFlight
} catch (error) {
  if (error instanceof SyncCellRouterTopologyMismatchError) topologyMismatch = true
  console.error('[sync-router] startup failed:', error)
  await stop('startup-failed').catch((cleanupError) => console.error('[sync-router] startup cleanup failed:', cleanupError))
  process.exit(1)
}
