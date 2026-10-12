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

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Pool } from 'pg'
import type { WorkspaceKey } from '../rbac/docScope.js'
import { rejectUpgrade } from '../auth/wsAuth.js'
import { workspacePartition } from './assignment.js'
import type { SyncCellOwnerRoute } from './ownership.js'
import {
  proxyWorkspaceUpgrade,
  type ProxiedWorkspaceTunnel,
  type UpgradeSocket,
} from './upgradeProxy.js'
import { createSingleFlightWorkspaceRouteResolver, parseWorkspaceRoute } from './workspaceRoute.js'
import { createRouterMetrics, type RouterAdmissionOutcome, type RouterMetricsSnapshot } from './routerMetrics.js'

export interface OwnerAwareWsRouterOptions {
  db: Pool
  partitionCount: number
  sourceId?: string
  resolveWorkspace?: (db: Pool, requested: WorkspaceKey) => Promise<WorkspaceKey | null>
  partitionOf?: (workspace: WorkspaceKey, partitionCount: number) => number
  resolveOwner: (partition: number) => Promise<SyncCellOwnerRoute | null>
  proxyUpgrade?: typeof proxyWorkspaceUpgrade
  ownerRecheckMs?: number
  ownerRouteCacheMs?: number
  now?: () => number
  /** Monotonic milliseconds for telemetry; independent of the route-cache clock. */
  metricsNow?: () => number
}

interface ActiveTunnel {
  workspace: WorkspaceKey
  owner: SyncCellOwnerRoute
  tunnel: ProxiedWorkspaceTunnel
}

interface PendingUpgrade {
  workspace: WorkspaceKey
  owner: SyncCellOwnerRoute
  abort: () => void
}

function sameOwner(left: SyncCellOwnerRoute | null, right: SyncCellOwnerRoute): boolean {
  return Boolean(
    left
    && left.partition === right.partition
    && left.cellId === right.cellId
    && left.token === right.token
    && left.advertiseUrl === right.advertiseUrl,
  )
}

function createAdmissionOwnerResolver(
  resolveOwner: (partition: number) => Promise<SyncCellOwnerRoute | null>,
  cacheMs: number,
  now: () => number,
): (partition: number) => Promise<SyncCellOwnerRoute | null> {
  const inFlight = new Map<number, Promise<SyncCellOwnerRoute | null>>()
  const cache = new Map<number, { owner: SyncCellOwnerRoute; expiresAt: number }>()
  return (partition) => {
    const cached = cache.get(partition)
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.owner)
    if (cached) cache.delete(partition)
    const existing = inFlight.get(partition)
    if (existing) return existing
    const pending = resolveOwner(partition)
    inFlight.set(partition, pending)
    const clear = () => {
      if (inFlight.get(partition) === pending) inFlight.delete(partition)
    }
    void pending.then((owner) => {
      clear()
      // Never negative-cache an ownerless partition: a standby may acquire it
      // during the very next retry. Stale positive routes are bounded to one
      // recheck interval and are independently rejected by the target cell.
      if (owner && cacheMs > 0) cache.set(partition, { owner, expiresAt: now() + cacheMs })
    }, clear)
    return pending
  }
}

export class OwnerRouteTunnelTracker {
  private readonly active = new Map<number, Set<ActiveTunnel>>()
  private readonly pending = new Map<number, Set<PendingUpgrade>>()
  private flight: Promise<void> | null = null
  private dirty = false
  private stopped = false

  constructor(private readonly partitionOf: (workspace: WorkspaceKey) => number) {}

  registerPending(workspace: WorkspaceKey, partition: number, owner: SyncCellOwnerRoute, abort: () => void): () => void {
    if (this.stopped || this.partitionOf(workspace) !== partition) {
      abort()
      return () => undefined
    }
    let entries = this.pending.get(partition)
    if (!entries) {
      entries = new Set()
      this.pending.set(partition, entries)
    }
    const entry = { workspace, owner, abort }
    entries.add(entry)
    return () => {
      entries?.delete(entry)
      if (entries?.size === 0 && this.pending.get(partition) === entries) this.pending.delete(partition)
    }
  }

  register(workspace: WorkspaceKey, partition: number, owner: SyncCellOwnerRoute, tunnel: ProxiedWorkspaceTunnel): () => void {
    if (this.stopped || this.partitionOf(workspace) !== partition) {
      tunnel.close(1012, this.stopped ? 'Router stopping' : 'Workspace placement changed')
      return () => undefined
    }
    let entries = this.active.get(partition)
    if (!entries) {
      entries = new Set()
      this.active.set(partition, entries)
    }
    const entry = { workspace, owner, tunnel }
    entries.add(entry)
    return () => {
      entries?.delete(entry)
      if (entries?.size === 0 && this.active.get(partition) === entries) this.active.delete(partition)
    }
  }

  reconcile(resolveOwner: (partition: number) => Promise<SyncCellOwnerRoute | null>, invalidate = true): Promise<void> {
    if (this.stopped) return Promise.resolve()
    // A slow owner read must not become an endless flight merely because the
    // periodic timer is faster. Only an explicit placement invalidation asks
    // for a further pass while one is already running.
    if (this.flight && !invalidate) return this.flight
    this.dirty = true
    if (this.flight) return this.flight
    const running = Promise.resolve().then(() => this.run(resolveOwner)).finally(() => {
      if (this.flight === running) this.flight = null
      if (this.dirty && !this.stopped) void this.reconcile(resolveOwner).catch((error) => {
        console.error('[sync-router] deferred active owner reconciliation failed:', error)
      })
    })
    this.flight = running
    return running
  }

  private async run(resolveOwner: (partition: number) => Promise<SyncCellOwnerRoute | null>): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false
      const partitions = new Set([...this.active.keys(), ...this.pending.keys()])
      for (const partition of partitions) {
        const current = await resolveOwner(partition)
        if (this.stopped) return
        const pendingEntries = this.pending.get(partition)
        if (pendingEntries) {
          for (const entry of [...pendingEntries]) {
            if (this.partitionOf(entry.workspace) === partition && sameOwner(current, entry.owner)) continue
            pendingEntries.delete(entry)
            entry.abort()
          }
          if (pendingEntries.size === 0) this.pending.delete(partition)
        }
        const entries = this.active.get(partition)
        if (!entries) continue
        let closed = 0
        let moved = 0
        for (const entry of [...entries]) {
          const placementChanged = this.partitionOf(entry.workspace) !== partition
          if (!placementChanged && sameOwner(current, entry.owner)) continue
          entries.delete(entry)
          entry.tunnel.close(1012, placementChanged ? 'Workspace placement changed' : 'Workspace owner changed')
          if (placementChanged) moved += 1
          else closed += 1
        }
        // THE OTHER HALF OF THE 1012, logged so it is not silent.
        //
        // Two mechanisms close the same connection when ownership moves: this
        // one, and the owning cell's `ConnectionRegistry.drainWorkspace`, which
        // skips a socket already at `readyState >= 2`. Whichever notices first
        // makes the other count zero — so a cell log reading
        // `{"event":"sync.cell.workspace_drained","drainedSockets":0}` beside a
        // client that DID receive 1012 is explained by this line: the drain
        // found a socket the router had already closed.
        if (closed > 0) {
          console.warn(JSON.stringify({
            event: 'sync.router.tunnels_closed',
            reason: 'owner-changed',
            partition,
            closedTunnels: closed,
          }))
        }
        if (moved > 0) {
          console.warn(JSON.stringify({
            event: 'sync.router.tunnels_closed',
            reason: 'workspace-moved',
            partition,
            closedTunnels: moved,
          }))
        }
        if (entries.size === 0) this.active.delete(partition)
      }
    }
  }

  stop(): Promise<void> {
    this.stopped = true
    this.dirty = false
    for (const entries of this.pending.values()) {
      for (const entry of entries) entry.abort()
    }
    this.pending.clear()
    for (const entries of this.active.values()) {
      for (const entry of entries) entry.tunnel.close(1012, 'Router stopping')
    }
    this.active.clear()
    return this.flight ?? Promise.resolve()
  }
}

export type OwnerAwareWsUpgradeHandler = (
  (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>
) & { reconcileOwners(): Promise<void>; stop(): Promise<void>; metricsSnapshot(): RouterMetricsSnapshot }

function canonicalizeWorkspaceUrl(request: IncomingMessage, workspace: WorkspaceKey): void {
  const url = new URL(request.url ?? '/automerge', 'http://sync.invalid')
  url.searchParams.set('landscapeId', workspace.landscapeId)
  url.searchParams.set('versionId', workspace.versionId)
  request.url = `${url.pathname}${url.search}`
}

/**
 * Resolve a public Automerge upgrade directly to the current partition owner.
 *
 * This process deliberately owns no Repo and accepts no document bytes. The
 * target cell authenticates the untouched cookie and authorizes the canonical
 * workspace before accepting the WebSocket. A routed request is marked by the
 * proxy helper, so an ownership change races to a retryable 503 instead of
 * creating a proxy loop through another cell.
 */
export function createOwnerAwareWsUpgradeHandler(options: OwnerAwareWsRouterOptions): OwnerAwareWsUpgradeHandler {
  const resolveWorkspace = options.resolveWorkspace ?? createSingleFlightWorkspaceRouteResolver()
  const proxyUpgrade = options.proxyUpgrade ?? proxyWorkspaceUpgrade
  const sourceId = options.sourceId ?? 'owner-aware-ws-router'
  const partitionOf = options.partitionOf ?? workspacePartition
  const tracker = new OwnerRouteTunnelTracker((workspace) => partitionOf(workspace, options.partitionCount))
  const metrics = createRouterMetrics(options.metricsNow)
  const resolveOwner = async (partition: number) => {
    const owner = await options.resolveOwner(partition)
    metrics.ownerReadSucceeded()
    return owner
  }
  let stopped = false
  let stopFlight: Promise<void> | null = null
  const upgrades = new Set<Promise<void>>()
  const configuredRecheckMs = options.ownerRecheckMs ?? Number(process.env.SYNC_WS_OWNER_RECHECK_MS ?? 100)
  if (!Number.isSafeInteger(configuredRecheckMs) || configuredRecheckMs < 50 || configuredRecheckMs > 60_000) {
    throw new Error('SYNC_WS_OWNER_RECHECK_MS must be an integer between 50 and 60000')
  }
  const configuredOwnerCacheMs = options.ownerRouteCacheMs
    ?? Number(process.env.SYNC_WS_OWNER_BURST_CACHE_MS ?? 50)
  if (!Number.isSafeInteger(configuredOwnerCacheMs)
    || configuredOwnerCacheMs < 0
    || configuredOwnerCacheMs > 250) {
    throw new Error('SYNC_WS_OWNER_BURST_CACHE_MS must be an integer between 0 and 250')
  }
  const resolveAdmissionOwner = createAdmissionOwnerResolver(
    resolveOwner,
    configuredOwnerCacheMs,
    options.now ?? Date.now,
  )

  const handler = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<RouterAdmissionOutcome> => {
    const upgradeSocket = socket as UpgradeSocket
    if (stopped) {
      rejectUpgrade(upgradeSocket, 503)
      return 'rejected'
    }
    const parsed = parseWorkspaceRoute(request.url)
    if (parsed.kind === 'not-automerge') {
      rejectUpgrade(upgradeSocket, 404)
      return 'rejected'
    }
    if (parsed.kind !== 'workspace') {
      rejectUpgrade(upgradeSocket, 400)
      return 'rejected'
    }

    try {
      const workspace = await resolveWorkspace(options.db, parsed.workspace)
      if (stopped) {
        rejectUpgrade(upgradeSocket, 503)
        return 'rejected'
      }
      if (!workspace) {
        rejectUpgrade(upgradeSocket, 404)
        return 'rejected'
      }

      const partition = partitionOf(workspace, options.partitionCount)
      const owner = await resolveAdmissionOwner(partition)
      if (stopped || partitionOf(workspace, options.partitionCount) !== partition) {
        rejectUpgrade(upgradeSocket, 503)
        return 'rejected'
      }
      if (!owner?.advertiseUrl || owner.partition !== partition) {
        console.warn(JSON.stringify({
          event: 'sync.router.route_rejected',
          reason: 'owner-route-unavailable',
          assignedPartition: partition,
        }))
        rejectUpgrade(upgradeSocket, 503)
        return 'rejected'
      }

      // Bind the tunnel to the same concrete version that selected the owner.
      // This closes the small race where a moving `current` alias changes
      // between the router's lookup and the target cell's authorization.
      canonicalizeWorkspaceUrl(request, workspace)
      const pendingController = new AbortController()
      const unregisterPending = tracker.registerPending(
        workspace,
        partition,
        owner,
        () => pendingController.abort(),
      )
      let unregister: () => void = () => undefined
      let proxied = false
      let retiredOnConnect = false
      try {
        proxied = await proxyUpgrade({
          request,
          socket: upgradeSocket,
          head,
          advertiseUrl: owner.advertiseUrl,
          sourceCellId: sourceId,
          signal: pendingController.signal,
          onConnected: (tunnel) => {
            unregisterPending()
            if (stopped || pendingController.signal.aborted || partitionOf(workspace, options.partitionCount) !== partition) {
              retiredOnConnect = true
              tunnel.close(1012, stopped ? 'Router stopping' : 'Workspace placement changed')
              return
            }
            unregister = tracker.register(workspace, partition, owner, tunnel)
          },
          onClosed: () => unregister(),
        })
      } finally {
        unregisterPending()
      }
      const outcome = proxied && !retiredOnConnect ? 'connected' : 'failed'
      console.log(JSON.stringify({
        event: 'sync.router.route_result',
        outcome,
        assignedPartition: partition,
      }))
      return outcome
    } catch (error) {
      console.error('[sync-router] owner resolution failed:', error)
      rejectUpgrade(upgradeSocket, 503)
      return 'failed'
    }
  }
  const reconcileOwners = () => tracker.reconcile(resolveOwner)
  const timer = setInterval(() => {
    void tracker.reconcile(resolveOwner, false).catch((error) => {
      console.error('[sync-router] active owner reconciliation failed:', error)
    })
  }, configuredRecheckMs)
  timer.unref?.()
  const upgradeHandler = ((request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // One terminal outcome per attempt, including errors before route resolution.
    const flight = handler(request, socket, head).then(
      (outcome) => { metrics.admission(outcome) },
      (error: unknown) => { metrics.admission('failed'); throw error },
    )
    upgrades.add(flight)
    void flight.then(() => upgrades.delete(flight), () => upgrades.delete(flight))
    return flight
  }) as OwnerAwareWsUpgradeHandler
  upgradeHandler.reconcileOwners = reconcileOwners
  upgradeHandler.metricsSnapshot = () => metrics.snapshot()
  upgradeHandler.stop = () => {
    if (stopFlight) return stopFlight
    stopped = true
    clearInterval(timer)
    const trackerStopped = Promise.resolve().then(() => tracker.stop())
    stopFlight = Promise.allSettled([trackerStopped, ...upgrades]).then((results) => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Router upgrade shutdown failed')
    })
    return stopFlight
  }
  return upgradeHandler
}
