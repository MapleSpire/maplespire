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

/**
 * Cross-process invalidation for the per-process caches that otherwise LIE for
 * up to their TTL across sibling server processes:
 *
 *  - the claim-coverage cache (rbac/claimCoverage.ts, 30 s): process B
 *    de-covers a workspace durably, process A keeps serving "covered" from
 *    memory and skips the pre-warm walk for up to 30 s;
 *  - the displaced scan's version-list cache (rbac/docScope.ts, 3 s): process
 *    B creates a version, process A's scan keeps reading `foreign` for ids
 *    minted against it for up to 3 s;
 *  - the canonical route resolver shared by HTTP and in-cell WS: version
 *    lifecycle and default-pointer writes invalidate its aliases and concrete
 *    version entries. Its TTLs remain the fallback when notifications cannot
 *    be received.
 *
 * WHY A NEW CHANNEL rather than the existing `workspace_access_changed`: that
 * trigger fires on `scopes` rows (grants), its payload is an ORG id, and it
 * never fires on coverage writes at all — its semantics cover neither cache,
 * and its payload cannot name the (landscape, version) the handlers need.
 * These channels follow the same pattern: emitted by DATABASE TRIGGERS
 * (DDL in syncCells/ownership.ts, beside the tables they watch) so EVERY
 * writer notifies — this server, fsck repairs, manual SQL — and NOTIFY being
 * transactional, listeners only observe committed rows.
 *
 * THIS IS A COMFORT, NOT A DEPENDENCY. Correctness still rests on the TTLs
 * bounding staleness, the route gate de-covering on proof, and the denyLedger
 * lifting what the windows pinned. A process whose LISTEN client drops merely
 * returns to TTL-bounded staleness. Workspace routing starts this listener
 * even when AUTH is off. That is why reconnect is a lazy retry cadence, and
 * why no caller may ever await this module on an admission path.
 *
 * The LISTEN client mirrors `startEpochRevocation` (auth/wsAuth.ts): one
 * dedicated pooled connection, an `error` handler that marks it dead, and an
 * interval that opportunistically re-establishes it. Payloads carry IDS ONLY
 * and the handlers DROP cache entries — never write values from the payload —
 * so a forged or foreign-suite notification can at worst cost one re-read
 * (the wsAuth precedent: re-read, don't trust the out-of-band value).
 */

import type { Pool, PoolClient } from 'pg'

/** Fired by the trigger on `workspace_claim_coverage` (INSERT OR UPDATE).
 * Payload: `<landscapeId>/<versionId>` — ids never contain '/', the same
 * WORKSPACE_ID rule `keyOf` already leans on. */
export const WORKSPACE_COVERAGE_CHANNEL = 'workspace_coverage_changed'
/** Fired by the trigger on `versions` (INSERT). Payload: `<landscapeId>`.
 * Note this also covers version creators that never call
 * `notifyWorkspaceCreated` (e.g. applyMerge's snapshot version) — the trigger
 * watches the TABLE, not the callers' discipline. */
export const WORKSPACE_VERSION_CREATED_CHANNEL = 'workspace_version_created'
/** Canonical route lifecycle: active-version changes, default repoints and
 * deletes. JSON payload: { schema, landscapeId }, null id for whole-table
 * invalidation. Filtering the DB-global channel by the listener's SQL schema
 * keeps sibling test schemas from invalidating this pool's whole cache.
 * DDL: syncCells/workspaceRouteInvalidationSchema.ts. */
export const WORKSPACE_ROUTE_CHANGED_CHANNEL = 'workspace_route_changed'
/** Lazy on purpose — see the header: losing the LISTEN client only widens
 * staleness back to the TTLs, so re-establishing it is maintenance, not
 * recovery. Plain literal, not an env parse, so it can never be NaN. */
export const WORKSPACE_CACHE_INVALIDATION_RECONNECT_MS = 60_000
/** Wall ceiling on stop()'s UNLISTEN politeness. A database that ACCEPTS the
 * statement but never answers would otherwise wedge graceful shutdown on the
 * await; past the ceiling the client is DESTROYED (release(err)) instead of
 * returned. Plain literal, not an env parse, so it can never be NaN. */
export const WORKSPACE_CACHE_INVALIDATION_STOP_CEILING_MS = 2_000

export interface WorkspaceCacheInvalidationHandlers {
  /** Another process committed a write to a workspace's durable coverage
   * marker. Wiring: `dropWorkspaceCoverageLocally` (claimCoverage.ts). */
  onCoverageChanged: (key: { landscapeId: string; versionId: string }) => void
  /** Another process committed an INSERT INTO versions for this landscape.
   * Wiring: `WorkspaceDocIndex.noteRemoteVersionCreated`. */
  onVersionCreated: (landscapeId: string) => void
  /** Drop canonical route entries only. Null means clear all after a listener
   * gap or TRUNCATE; notification data never supplies an authoritative route. */
  onRouteChanged?: (landscapeId: string | null) => void
}

export interface WorkspaceCacheInvalidationOptions {
  /** Injectable so the reconnect test does not wait a minute. */
  reconnectMs?: number
}

export interface WorkspaceCacheInvalidationHandle {
  stop: () => Promise<void>
}

export function startWorkspaceCacheInvalidation(
  pool: Pool,
  handlers: WorkspaceCacheInvalidationHandlers,
  options: WorkspaceCacheInvalidationOptions = {},
): WorkspaceCacheInvalidationHandle {
  let listenClient: PoolClient | null = null
  let routeSchema: string | null = null
  let stopped = false
  /** Explicit single-flight for the (re)connect. The interval fires
   * on wall time, not on the previous attempt having settled, so without this
   * a `pool.connect` slower than the cadence stacks a second checkout whose
   * `listenClient` overwrite leaks the first for the life of the process. The
   * guard makes the property structural instead of resting on
   * connectionTimeoutMillis < reconnectMs. */
  let connecting: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  let releaseFailure: unknown = null
  const released = new WeakSet<PoolClient>()
  const channels = [WORKSPACE_COVERAGE_CHANNEL, WORKSPACE_VERSION_CREATED_CHANNEL, WORKSPACE_ROUTE_CHANGED_CHANNEL]
  const release = (client: PoolClient, error?: Error): void => {
    if (released.has(client)) return
    released.add(client)
    try { client.release(error) } catch (failure) { releaseFailure = failure }
  }
  const dropRoutes = (): void => {
    try { handlers.onRouteChanged?.(null) } catch (error) {
      console.warn('[workspace-cache-invalidation] route reset failed:', error)
    }
  }
  const join = async (flight: Promise<void>, label: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([flight, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle before the invalidation stop ceiling`)),
          WORKSPACE_CACHE_INVALIDATION_STOP_CEILING_MS)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }

  const dispatch = (channel: string, payload: string): void => {
    if (channel === WORKSPACE_COVERAGE_CHANNEL) {
      // Split at the FIRST slash: landscape ids never contain one, so the
      // remainder is the version id verbatim. Malformed payloads are ignored
      // — dropping nothing is always safe, and the TTL remains the net.
      const slash = payload.indexOf('/')
      if (slash <= 0 || slash === payload.length - 1) return
      handlers.onCoverageChanged({
        landscapeId: payload.slice(0, slash),
        versionId: payload.slice(slash + 1),
      })
      return
    }
    if (channel === WORKSPACE_VERSION_CREATED_CHANNEL) {
      handlers.onVersionCreated(payload)
    }
    if (channel === WORKSPACE_ROUTE_CHANGED_CHANNEL) {
      let value: unknown
      try { value = JSON.parse(payload) } catch { return }
      if (!value || typeof value !== 'object' || routeSchema === null) return
      const { schema, landscapeId } = value as { schema?: unknown; landscapeId?: unknown }
      if (schema !== routeSchema) return
      if (landscapeId === null) handlers.onRouteChanged?.(null)
      else if (typeof landscapeId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(landscapeId)) handlers.onRouteChanged?.(landscapeId)
    }
  }

  const connectOnce = async (): Promise<void> => {
    let client: PoolClient | null = null
    try {
      client = await pool.connect()
      // The stop/connect race: stop() can flip `stopped` while the
      // checkout above is in the air (the race is one await wide, but a leaked
      // slot is forever). Nothing else will ever release this client, so hand
      // it back here.
      if (stopped) {
        release(client)
        return
      }
      listenClient = client
      client.on('notification', (msg) => {
        if (stopped || listenClient !== client || released.has(client!) || !msg.payload) return
        try {
          dispatch(msg.channel, msg.payload)
        } catch (err) {
          // A throwing handler must not kill the pump for every later
          // notification on this connection.
          console.warn('[workspace-cache-invalidation] handler failed:', err)
        }
      })
      const deadClient = client
      client.on('error', (err) => {
        console.warn(
          '[workspace-cache-invalidation] LISTEN client error, will reconnect on the retry cadence:',
          err.message,
        )
        // A checked-out client whose connection died is still
        // COUNTED by the shared pool until release() is called: nulling the
        // reference alone leaks one DB_POOL_MAX slot per incident, for the
        // life of the process. release(err) DESTROYS the dead connection
        // instead of recycling it into the next checkout. The shared release
        // guard prevents double release when stop races this event.
        release(deadClient, err)
        // Identity-guarded: a late 'error' from an already-replaced client
        // must not discard the reconnect's fresh one.
        if (listenClient === deadClient) {
          listenClient = null
          routeSchema = null
          dropRoutes()
        }
      })
      if (handlers.onRouteChanged) {
        const result = await client.query<{ schema: string | null }>('SELECT current_schema() AS schema')
        if (stopped || listenClient !== client || released.has(client)) return
        const schema = result.rows[0]?.schema
        if (typeof schema !== 'string' || schema.length === 0) throw new Error('Route invalidation listener has no current schema')
        routeSchema = schema
      }
      for (const channel of channels) {
        if (stopped || listenClient !== client || released.has(client)) return
        await client.query(`LISTEN ${channel}`)
      }
      // A cache may have warmed before LISTEN committed or while its previous
      // client was disconnected. Force the next read through SQL at recovery.
      if (!stopped && listenClient === client) dropRoutes()
    } catch (err) {
      console.warn(
        '[workspace-cache-invalidation] failed to establish LISTEN client (TTL fallback still active):',
        err,
      )
      // The LISTEN statements can fail with the client
      // already checked out; that client occupies its slot exactly like the
      // 'error' case above and must be destroyed, not just forgotten.
      if (client) {
        if (listenClient === client) {
          listenClient = null
          routeSchema = null
        }
        release(client, err instanceof Error ? err : new Error(String(err)))
      }
      if (!stopped) dropRoutes()
    }
  }
  const connectListener = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (connecting) return connecting
    const flight = connectOnce()
    connecting = flight
    const clear = () => { if (connecting === flight) connecting = null }
    void flight.then(clear, clear)
    return flight
  }
  void connectListener()

  const reconnectMs = options.reconnectMs ?? WORKSPACE_CACHE_INVALIDATION_RECONNECT_MS
  const reconnectTimer = setInterval(() => {
    if (!listenClient) void connectListener()
  }, reconnectMs)
  // Never .unref() — the wsAuth/gc.ts precedent: an unref'd interval was
  // observed not to fire under tsx in this codebase.

  return {
    stop: () => {
      if (stopping) return stopping
      stopped = true
      clearInterval(reconnectTimer)
      dropRoutes()
      stopping = (async () => {
        // Joining is separate from cancellation: pg has no AbortSignal for a
        // pool checkout. On an unconfirmed join we reject stop; the stopped
        // continuation still releases a late checkout when it eventually lands.
        if (connecting) {
          try { await join(connecting, 'connect/LISTEN') } catch (error) {
            if (listenClient) {
              release(listenClient, error instanceof Error ? error : new Error(String(error)))
              listenClient = null
            }
            throw error
          }
        }
        const client = listenClient
        listenClient = null
        if (!client) {
          if (releaseFailure) throw releaseFailure
          return
        }
        // The UNLISTENs are politeness, not correctness (the
        // connection is about to go away either way), so they get a short wall
        // ceiling: a database that accepts without answering must not wedge
        // graceful shutdown. An unfinished command rejects this stop instead
        // of treating a deadline as proof that pg cancelled its statement.
        let unlistened = false
        let active = true
        let incomplete: unknown = null
        const unlisten = (async () => {
          for (const channel of channels) {
            if (!active || released.has(client)) return
            await client.query(`UNLISTEN ${channel}`)
          }
        })()
        try {
          await join(unlisten, 'UNLISTEN')
          unlistened = true
        } catch (error) {
          incomplete = error
        } finally {
          active = false
        }
        // A clean UNLISTEN returns the connection to the pool; a failed or
        // wedged one is destroyed rather than recycled with LISTEN state — or
        // a still-pending statement — attached.
        release(client, unlistened ? undefined : new Error('workspace-cache-invalidation stop: UNLISTEN failed or timed out'))
        if (incomplete) throw incomplete
        if (releaseFailure) throw releaseFailure
      })()
      return stopping
    },
  }
}
