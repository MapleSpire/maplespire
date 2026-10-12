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

import type { Pool } from 'pg'
import type { FencedPartitionLeaseStore, TopologyVerification } from './ownership.js'
import { SyncCellTopologyContractFormatError } from './topologyContract.js'

/**
 * EVERYTHING THE OWNER-AWARE ROUTER DOES ABOUT TOPOLOGY.
 *
 * It is a module rather than a few lines inside `routerMain.ts` because
 * `routerMain.ts` is a top-level script with side effects — importing it starts
 * an HTTP server, a Redis connection and a PostgreSQL pool — so a test cannot
 * execute its boot path. Here the policy is executed, not just read.
 *
 * WHAT A DISAGREEMENT ACTUALLY COSTS. It does NOT silently route to the wrong
 * cell. Both halves fail closed downstream:
 *
 *   - a wrong COUNT sends the upgrade to a cell that does not own the workspace;
 *     that cell recomputes the partition with its own count, finds `owns()`
 *     false, and refuses with 503 because the routed header is present — it does
 *     not re-proxy (`automergeServer.ts`);
 *   - a wrong GENERATION reads owner keys under another prefix, `resolve()`
 *     returns nothing, and the router itself refuses with 503
 *     (`ownerAwareWsRouter.ts`).
 *
 * So the symptom is a PARTIAL 503 OUTAGE over the fraction of workspaces jump
 * hash re-buckets, logged as `sync.cell.route_rejected` /
 * `sync.router.route_rejected`. This guard buys a named refusal instead of a
 * diffuse half-outage: a diagnostic upgrade, not a barrier against corruption.
 */

/** The router read a contract it does not agree with. */
export class SyncCellRouterTopologyMismatchError extends Error {
  readonly code = 'sync_cell_router_topology_mismatch'
  constructor(readonly expected: string, readonly found: string, readonly corruption?: TopologyVerification['corruption']) {
    super(
      `The owner-aware router computes topology "${expected}" but the fleet's contract says "${found}". `
      + 'It would hash workspaces to partitions the cells do not own, or read owner keys under another '
      + 'generation and find none — every affected upgrade is refused with 503. Make '
      + 'SYNC_CELL_PARTITION_COUNT, SYNC_CELL_PLACEMENT_MODE, configured generation and build mapping fingerprint agree for '
      + 'the router and cells. Use the coordinated rollout/rollback recipe B3d1 in '
      + 'maplespire-sponsor-kit/docs/operations/sync-cell-ownership.md for a generation or build change.'
      + (corruption ? ` Invalid stored contract: ${corruption.code} (${corruption.reason}).` : ''),
    )
    this.name = 'SyncCellRouterTopologyMismatchError'
  }
}

/**
 * The router could not ASK. A distinct type from the mismatch above, and the
 * distinction is the whole point of this class existing.
 *
 * `redisRuntime.send` replaces the underlying cause with a generic
 * `RedisUnavailableError: Distributed runtime is unavailable`, so without this
 * class a Redis stall at boot and a genuine fleet-wide topology disagreement
 * would produce the same line in the log. An operator cannot act on that: one
 * says "your manifests disagree", the other says "Redis
 * was slow for 750 ms". Both are fatal at boot — see `startRouterTopologyGuard`
 * for why degrading is the wrong answer here — but they are not the same
 * incident and must not read as one.
 */
export class SyncCellRouterTopologyUnreadableError extends Error {
  readonly code = 'sync_cell_router_topology_unreadable'
  constructor(readonly expected: string, readonly cause: unknown) {
    super(
      `The owner-aware router could not READ the fleet's topology contract (it computes "${expected}"). `
      + 'This is a transport failure, not a disagreement: Redis was unreachable, slow past the command '
      + `timeout, or the connection was recycled. Underlying error: ${String(
        (cause as { message?: unknown })?.message ?? cause,
      )}`,
    )
    this.name = 'SyncCellRouterTopologyUnreadableError'
  }
}

/** What the guard currently knows, for `/api/ready`. */
export interface RouterTopologySnapshot {
  /** `confirmed` — a contract exists and this router agrees with it.
   *  `pending` — no contract exists yet; the router is serving and re-reading.
   *  A router cannot be live in any other state: a disagreement is fatal. */
  state: 'confirmed' | 'pending'
  /** Canonical contract: `generation|partitionCount`, with the codec's v1
   *  extension when placement mode or reserved partitions require it. */
  contract: string
  /** Whether a contract has ever been observed. `false` while `pending`. */
  contractPresent: boolean
  /** How many re-reads have run since boot. Zero while `confirmed` at boot. */
  rechecks: number
}

export interface RouterTopologyGuard {
  snapshot(): RouterTopologySnapshot
  /** Re-read now. Exposed so a test drives the deferred path without a timer,
   *  and so an operator-facing endpoint could force one. */
  recheckNow(): Promise<void>
  stop(): void
}

export interface RouterTopologyGuardOptions {
  store: Pick<FencedPartitionLeaseStore, 'verifyTopology'>
  partitionCount: number
  /** Used ONLY for the absent-contract pairing below. Optional: without it the
   *  guard still works, and says so rather than pretending it checked. */
  db?: Pick<Pool, 'query'> | null
  log?: (line: string) => void
  warn?: (line: string) => void
  /** Called when a re-read AFTER boot finds a disagreement. Boot-time
   *  disagreements throw instead — the caller has not started serving yet. */
  onFatal?: (error: Error) => void
  recheckIntervalMs?: number
  setInterval?: (handler: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

/** Reads the contract, turning a transport rejection into a NAMED error rather
 *  than letting a generic Redis failure impersonate a topology disagreement. */
export async function readRouterTopology(
  store: Pick<FencedPartitionLeaseStore, 'verifyTopology'>,
  partitionCount: number,
): Promise<TopologyVerification> {
  try {
    return await store.verifyTopology(partitionCount)
  } catch (error) {
    // An invalid local expected contract is a configuration defect, never a
    // Redis transport failure. A malformed stored value is returned as mismatch.
    if (error instanceof SyncCellTopologyContractFormatError) throw error
    // The expected value is recomputed here rather than read off the failed
    // verification, which does not exist. It must match `verifyTopology`'s own
    // format; `topologyIdentity.integration.test.ts` pins that against the real
    // Lua writer, and this string is only ever shown to a human.
    throw new SyncCellRouterTopologyUnreadableError(`(partitionCount ${partitionCount})`, error)
  }
}

/**
 * Verify at boot, then keep verifying until there is something to verify.
 *
 * An ABSENT contract is accepted — it must be, because the router legitimately
 * boots before any cell has claimed a partition, and `sync-cell-failover.yml`
 * gates it on the cells with `condition: service_started`, not
 * `service_healthy`. So on a first deployment the router reliably WINS that race
 * and reads nothing. A boot-only check would then report success having
 * examined nothing, and never look again: a cell writing a disagreeing
 * contract one second later would leave the router mis-hashing for the life of
 * the process.
 *
 * So absence defers the verification instead of passing it. The router serves
 * while pending — it must, or router liveness is coupled to cell boot order —
 * but a disagreement discovered later is still fatal, because a router that
 * knows it is mis-hashing must not keep going.
 *
 * WHY A TRANSPORT FAILURE IS FATAL AT BOOT AND NOT AFTERWARDS. The cells answer
 * this differently: fatal on disagreement, DEGRADED when they cannot ask.
 * That is safe for a cell only because it then refuses to acquire
 * anything until the contract is confirmed — the precondition
 * `bootDegraded.test.ts` states explicitly. The router has no such refusal
 * state: a "degraded" router would either route unverified, which is exactly
 * what this guard forbids, or 503 everything while reporting ready. And it
 * cannot serve a single upgrade without Redis anyway, since every admission is a
 * Redis read. After boot the calculus inverts: the process is already serving,
 * a blip is self-healing, and killing it would turn a 750 ms stall into an
 * outage — so a failed re-read is reported and retried, never fatal.
 */
export async function startRouterTopologyGuard(
  options: RouterTopologyGuardOptions,
): Promise<RouterTopologyGuard> {
  const {
    store,
    partitionCount,
    db = null,
    log = console.log,
    warn = console.warn,
    onFatal = () => {},
    recheckIntervalMs = 5_000,
    // Wrapped rather than passed by reference: the real pair is typed on
    // `Timeout`, the injected pair on an opaque handle, and handing the globals
    // over directly makes the injected shape unassignable.
    setInterval: schedule = (handler: () => void, ms: number) => globalThis.setInterval(handler, ms),
    clearInterval: unschedule = (handle: unknown) => {
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>)
    },
  } = options

  const boot = await readRouterTopology(store, partitionCount)
  if (!boot.agreed) {
    throw new SyncCellRouterTopologyMismatchError(boot.expected, boot.found ?? '<absent>', boot.corruption)
  }

  let state: 'confirmed' | 'pending' = boot.known ? 'confirmed' : 'pending'
  let rechecks = 0
  let handle: unknown = null
  let inFlight = false

  const announce = (verification: TopologyVerification, deferred: boolean) => {
    log(JSON.stringify({
      event: 'sync.router.topology_verified',
      contract: verification.expected,
      // A cold start is not a fault, but it is not a verification either. Said
      // out loud in both directions because from outside, a router that resolves
      // no owners because nothing has booted looks exactly like a broken one.
      contractPresent: verification.known,
      pending: !verification.known,
      deferred,
    }))
  }

  const stop = () => {
    if (handle !== null) { unschedule(handle); handle = null }
  }

  const recheckNow = async (): Promise<void> => {
    // Single-flight. Without `inFlight`, a slow read that the interval fires
    // over again costs a second GET and, on a disagreement, a SECOND `onFatal`
    // delivery; without the `confirmed` check a late-arriving read re-reads a
    // settled contract. Neither corrupts `state` (it is only ever assigned
    // `'confirmed'`), so this deduplicates a redundant round trip and a
    // duplicate fatal; it is not a correctness barrier.
    if (inFlight || state === 'confirmed') return
    inFlight = true
    try {
      const again = await readRouterTopology(store, partitionCount)
      rechecks += 1
      if (!again.agreed) {
        stop()
        // FATAL, but delivered rather than thrown: nothing is awaiting this call
        // — it runs from a timer — so a throw here would surface as an unhandled
        // rejection and the exit code would depend on Node's flags. The caller
        // owns how the process dies.
        onFatal(new SyncCellRouterTopologyMismatchError(again.expected, again.found ?? '<absent>', again.corruption))
        return
      }
      if (again.known) {
        state = 'confirmed'
        stop()
        announce(again, true)
      }
    } catch (error) {
      // REPORTED, never swallowed, and never fatal after boot. A catch on a path
      // that decides whether the fleet agrees must never fail silently: the
      // retry is the recovery, the log line
      // is the witness that the recovery is still needed.
      warn(JSON.stringify({
        event: 'sync.router.topology_recheck_failed',
        detail: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      inFlight = false
    }
  }

  if (state === 'pending') {
    // THE PAIRING, borrowed from the cells' topology-created detector, because the
    // absent branch has a blind spot of its own: `topologyKey()` is
    // `${prefix}:sync-cell:topology`, so a router pointed at a different Redis
    // or a different REDIS_KEY_PREFIX reads nothing and calls it a cold start —
    // then resolves no owner for any workspace, forever, having reported
    // success. Absence paired with durable ownership rows says PostgreSQL has
    // been serving workspaces while this router's Redis has never seen a cell.
    //
    // A WARNING, not a refusal, and symmetric with the cells on purpose: the
    // same three causes are indistinguishable from in here — Redis rebuilt, the
    // router pointed elsewhere, or the contract deleted on purpose for a
    // rescale — and the third is a documented procedure. `restore:reset-routing
    // --apply` releases every row and is run BEFORE the restart, so this counts
    // EVERY row rather than the unreleased ones; counting only live rows would
    // be silent on exactly that procedure.
    if (db) {
      try {
        const { rows } = await db.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM sync_workspace_ownership',
        )
        const ownershipRows = Number(rows[0]?.count ?? '0')
        // ENUMERATED rather than `> 0`, and the difference is fail-silent versus
        // fail-LOUD. `Number()` of anything non-numeric is NaN and `NaN > 0` is
        // FALSE, so a reply this decode does not recognise would report NOTHING
        // — the detector silently disarmed by a malformed answer (the same
        // hazard `ensureTopology` enumerates against in `ownership.ts`).
        // Reachable via a driver returning a number, a proxy answering a
        // string, a stub in a test.
        if (!Number.isFinite(ownershipRows)) {
          warn(JSON.stringify({
            event: 'sync.router.durable_row_survey_failed',
            detail: `the ownership row count did not decode as a number: ${JSON.stringify(rows[0]?.count)}`,
          }))
        } else if (ownershipRows > 0) {
          warn(JSON.stringify({
            event: 'sync.router.contract_absent_with_durable_rows',
            contract: boot.expected,
            ownershipRows,
            detail: 'this router found no topology contract while PostgreSQL holds ownership rows. '
              + 'Indistinguishable from in here: Redis was rebuilt, this router points at a different '
              + 'Redis or REDIS_KEY_PREFIX than the cells, or the contract was deleted to change the '
              + 'generation or partition count. Check REDIS_URL and REDIS_KEY_PREFIX against the cells. '
              + 'Until a contract appears this router verifies nothing and will resolve no owner.',
          }))
        }
      } catch (error) {
        // The detector failing must not take the router down, and must not look
        // like "no rows" either.
        warn(JSON.stringify({
          event: 'sync.router.durable_row_survey_failed',
          detail: error instanceof Error ? error.message : String(error),
        }))
      }
    }
    handle = schedule(() => { void recheckNow() }, recheckIntervalMs)
  }

  announce(boot, false)

  return {
    snapshot: () => ({ state, contract: boot.expected, contractPresent: state === 'confirmed', rechecks }),
    recheckNow,
    stop,
  }
}
