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
 * The `/api/ready` answer, computed in a module a test can load.
 *
 * Kept out of `index.ts`, which listens at import, so it can be unit-tested.
 *
 * The contract: every check that can ask, asks. Reading a flag is not enough —
 * node-redis's `client.isReady` stays true for a paused Redis container because
 * the kernel still completes the TCP handshake, so a cell would answer 200
 * while it had already lost its partition lease. Redis is therefore asked with
 * a bounded PING (`RedisRuntime.probe`), just as the database is asked
 * (`SELECT 1`). During a total Redis outage a cell answers 503 — it can neither
 * hold a lease nor forward to an owner, so "can you take a request" is honestly
 * no. A NON-owner cell with a HEALTHY Redis still answers 200, because
 * `canServe` (not `ready`) is what ownership contributes here — see the
 * caller's comment in `index.ts` and `ownership.ts`.
 *
 * Two layers, so each can be tested alone: `readinessReport` is pure — inputs
 * in, status and body out — and `collectReadiness` runs the probes (all of
 * them in parallel, so the door's latency is the SLOWEST probe, not the sum)
 * and hands the results to it. The Redis probes are bounded by their command
 * timeout; the database probe is bounded only by the pool's own
 * `connectionTimeoutMillis` (10 s in `dbConfig.ts`) and, on a checked-out
 * connection to a stalled PostgreSQL, by nothing at all — deliberately not
 * shortened here (a ceiling shorter than the pool's patience is a known
 * resource-lifetime trap); a healthcheck reads that as a fetch
 * timeout, which is the same verdict as 503.
 *
 * The owner-aware WebSocket router has its own door with one check; its answer
 * is `routerReadinessReport`, pure for the same reason.
 */

/** One Redis instance as the readiness door sees it: is it configured at all,
 *  does readiness depend on it, and — asked, not read — is it reachable now. */
export interface RedisReadinessSource {
  configured: boolean
  required: boolean
  /** Resolves `false` on timeout, error or absent client; never rejects. */
  reachable(): Promise<boolean>
}

export interface OwnershipReadiness {
  enabled: boolean
  canServe: boolean
  ready: boolean
}

export interface ReadinessInputs {
  database: boolean
  automerge: boolean
  readModel: boolean
  shuttingDown: boolean
  redis: { configured: boolean; required: boolean; reachable: boolean | null }
  renderCacheRedis: { configured: boolean; reachable: boolean | null }
  ownership: OwnershipReadiness | null
}

export interface ReadinessReport {
  status: 200 | 503
  body: {
    status: 'ready' | 'not-ready'
    checks: {
      database: boolean
      automerge: boolean
      readModel: boolean
      /** `null` when no Redis is configured; otherwise the PROBE's answer. */
      redis: boolean | null
      renderCacheRedis: boolean | null
      syncCellOwnership: boolean | null
      syncCellConverged: boolean | null
    }
    shuttingDown: boolean
  }
}

/** Pure: the same inputs always give the same answer. */
export function readinessReport(inputs: ReadinessInputs): ReadinessReport {
  const { redis, ownership } = inputs
  // `canServe`, NOT `ready`. `ready` means "I hold my partition and
  // every workspace I should own"; this endpoint is asked "can you take a
  // request", and a cell that owns nothing answers yes by forwarding.
  // `redis.reachable` is the probe's answer: `required` Redis that does not
  // answer a PING within the command timeout makes the cell not ready.
  const ready = inputs.database && inputs.automerge && inputs.readModel
    && (!redis.required || redis.reachable === true)
    && (!ownership?.enabled || ownership.canServe)
    && !inputs.shuttingDown
  return {
    status: ready ? 200 : 503,
    body: {
      status: ready ? 'ready' : 'not-ready',
      checks: {
        database: inputs.database,
        automerge: inputs.automerge,
        readModel: inputs.readModel,
        redis: redis.configured ? redis.reachable : null,
        renderCacheRedis: inputs.renderCacheRedis.configured ? inputs.renderCacheRedis.reachable : null,
        syncCellOwnership: ownership?.enabled ? ownership.canServe : null,
        // Reported BESIDE the serving answer rather than folded into it: an
        // operator asking "why is this cell not doing any work" needs to see
        // that it is healthy AND owns nothing, which one boolean cannot say.
        syncCellConverged: ownership?.enabled ? ownership.ready : null,
      },
      shuttingDown: inputs.shuttingDown,
    },
  }
}

export interface ReadinessDependencies {
  /** Asks PostgreSQL (`SELECT 1`); resolves `false` on any failure. */
  database(): Promise<boolean>
  redis: RedisReadinessSource
  renderCacheRedis: Pick<RedisReadinessSource, 'configured' | 'reachable'>
  automerge: boolean
  readModel: boolean
  shuttingDown: boolean
  ownership: OwnershipReadiness | null
}

/** Runs every probe in parallel, never lets one of them throw past this door,
 *  and reports. An unconfigured Redis is `null`, not `false`: the absence of a
 *  dependency is not an outage. */
export async function collectReadiness(deps: ReadinessDependencies): Promise<ReadinessReport> {
  // `Promise.resolve().then(probe)`, not `probe().then(...)`: the second form
  // lets a SYNCHRONOUS throw out of `probe()` escape the door —
  // `f().then(ok, fail)` never sees a throw from `f` itself.
  const safely = (probe: () => Promise<boolean>) => Promise.resolve().then(probe).then((value) => value === true, () => false)
  const [database, redisReachable, renderCacheReachable] = await Promise.all([
    safely(deps.database),
    deps.redis.configured ? safely(() => deps.redis.reachable()) : Promise.resolve<boolean | null>(null),
    deps.renderCacheRedis.configured ? safely(() => deps.renderCacheRedis.reachable()) : Promise.resolve<boolean | null>(null),
  ])
  return readinessReport({
    database,
    automerge: deps.automerge,
    readModel: deps.readModel,
    shuttingDown: deps.shuttingDown,
    redis: { configured: deps.redis.configured, required: deps.redis.required, reachable: redisReachable },
    renderCacheRedis: { configured: deps.renderCacheRedis.configured, reachable: renderCacheReachable },
    ownership: deps.ownership,
  })
}

export interface RouterReadinessInputs {
  /** The probe's answer for the router's one dependency, the critical Redis. */
  reachable: boolean
  partitionCount: number
  configuredGeneration: string
  effectiveGeneration: string
  topologyGeneration: string
  /** The topology guard's snapshot — PUBLISHED, deliberately NOT part of the
   *  200/503 decision (see `syncCells/routerMain.ts`): a router that cannot yet find a
   *  contract is still correctly serving refusals. */
  topology: unknown
}

export interface RouterReadinessReport {
  status: 200 | 503
  body: {
    ready: boolean
    checks: { redis: boolean }
    role: 'owner-aware-ws-router'
    partitionCount: number
    configuredGeneration: string
    effectiveGeneration: string
    topologyGeneration: string
    topology: unknown
  }
}

/** Pure: the owner-aware router's `/api/ready`. It resolves owners in Redis and
 *  nothing else, so its readiness IS the probe's answer. */
export function routerReadinessReport(inputs: RouterReadinessInputs): RouterReadinessReport {
  return {
    status: inputs.reachable ? 200 : 503,
    body: {
      ready: inputs.reachable,
      checks: { redis: inputs.reachable },
      role: 'owner-aware-ws-router',
      partitionCount: inputs.partitionCount,
      configuredGeneration: inputs.configuredGeneration,
      effectiveGeneration: inputs.effectiveGeneration,
      topologyGeneration: inputs.topologyGeneration,
      topology: inputs.topology,
    },
  }
}
