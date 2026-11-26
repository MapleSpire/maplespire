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
 * THE GRACEFUL SHUTDOWN SEQUENCE of `index.ts`, as one function of its
 * resources (T-ZEROWM-2 (2)): what used to be an inline closure in `main`,
 * which no test could import, so its ORDER was never measured. `index.ts`
 * hands it closures over the real resources; `serverShutdown.integration.test.ts`
 * hands it real ones (Repo on the PostgreSQL storage adapter, residency,
 * static projector, durable-heads decoder, pools) and checks that nothing
 * writes after the closure of what it depends on.
 *
 * The order, and why:
 *  0. the forced exit is armed;
 *  1. intake stops (readiness, ordinary fleet, cold builds, listeners);
 *     the static projector's `stop()` STARTS (it drains its own in-flight
 *     work, bounded by its ceiling, before it releases a lease); the
 *     background builds' stop STARTS (it cancels a
 *     running `CREATE INDEX CONCURRENTLY`, bounded ~1 s); maintenance
 *     stops accepting;
 *  2. maintenance drains (its jobs hold Automerge documents);
 *  3. in parallel: the static projector's stop, then the durable-heads decoder
 *     (its draining rotations verify their ModelMeta through it); the
 *     Automerge drain (sockets, residency, final flush); the change hub; HTTP
 *     (which waits for the HTTP handlers, against an absolute deadline from
 *     the signal — `httpShutdown.ts`);
 *  4. the LATE-WRITE flush (T-DIAGDEF): an HTTP handler
 *     that finished AFTER the Automerge drain's final flush wrote into the
 *     Repo after it; that write must be durable before the lease goes, or the
 *     next owner loads without a write the client was answered 200 for.
 *     Bounded (`lateWriteFlushMs`, 4 s); a failure or a timeout keeps
 *     ownership;
 *  5. ownership released, Automerge shut down (the Repo's last flush, the
 *     adapter's retries), Redis, the background builds' stop awaited (a
 *     build's checked-out connection would hold `pool.end()`), then the pools.
 *
 * Each step's start and end (ms since the signal) is logged once, at the end,
 * as `server.shutdown_trace`.
 */

export interface GracefulShutdownResources {
  /** Synchronous intake stops: readiness, `readModelFleet.stopAll()`, cold
   * build admission, listeners. */
  stopIntake: () => void
  /** The static projector's `stop()`, STARTED here (undefined: none). */
  stopStaticProjector: () => Promise<void> | undefined
  /** Maintenance stops accepting; its schedules stop. */
  stopMaintenanceIntake: () => void
  drainMaintenance: () => Promise<void>
  closeDurableHeadsDecoder: () => Promise<void>
  drainAutomerge: () => Promise<void>
  stopChangeHub: () => Promise<void>
  /** `signalAt`: the signal's instant (`performance.now()`), so the HTTP
   * step's handler deadline is ABSOLUTE. */
  closeHttp: (signalAt: number) => Promise<void>
  /** The late-write flush (step 4): the Repo's documents written since the
   * Automerge drain's final flush. Optional only for the callers that have no
   * Repo; `index.ts` passes it. */
  flushLateWrites?: () => Promise<void>
  /** Bound of {@link flushLateWrites}; past it ownership is retained. */
  lateWriteFlushMs?: number
  /** The BACKGROUND builds' stop: the static membership
   * head index build, whose `CREATE INDEX CONCURRENTLY` holds a primary-pool
   * connection — `pool.end()` waited for it, to the forced exit. STARTED
   * right after intake (it cancels from another connection, which needs the
   * pools open), bounded by itself, awaited before the pools. Never throws
   * into the sequence: a failure is traced, not a reason to keep ownership. */
  stopBackgroundBuilds?: () => Promise<unknown>
  stopOwnership: () => Promise<void>
  shutdownAutomerge: () => Promise<void>
  stopRedis: () => Promise<unknown>
  /** Every pool, ended in order. Failures logged, not thrown. */
  endPools: () => Promise<void>
  exit: (code: number) => void
  log?: (line: string) => void
  forcedExitMs?: number
}

export interface ShutdownTraceStep { step: string; startMs: number; endMs?: number; failed?: boolean }

export function runGracefulShutdown(signal: string, resources: GracefulShutdownResources): Promise<void> {
  const log = resources.log ?? ((line: string) => console.log(line))
  const startedAt = performance.now()
  const trace: ShutdownTraceStep[] = []
  const elapsed = () => Math.round((performance.now() - startedAt) * 10) / 10
  const step = <T>(name: string, run: () => T): T => {
    const entry: ShutdownTraceStep = { step: name, startMs: elapsed() }
    trace.push(entry)
    let result: T
    try {
      result = run()
    } catch (error) {
      entry.endMs = elapsed()
      entry.failed = true
      throw error
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void (result as unknown as Promise<unknown>).then(
        () => { entry.endMs = elapsed() },
        () => { entry.endMs = elapsed(); entry.failed = true },
      )
    } else {
      entry.endMs = elapsed()
    }
    return result
  }
  const emitTrace = (outcome: string) => {
    log(JSON.stringify({ event: 'server.shutdown_trace', signal, outcome, totalMs: elapsed(), steps: trace }))
  }
  return (async () => {
    log(`[server] ${signal} received; draining HTTP and Automerge connections`)
    // Armed FIRST: before T-ZEROWM-2 it was armed after the
    // synchronous intake steps, so one of them throwing left no forced exit
    // while `index.ts` said "forced-exit deadline remains active".
    const forcedExit = setTimeout(() => {
      emitTrace('forced-exit')
      console.error('[server] graceful shutdown deadline exceeded')
      resources.exit(1)
    }, resources.forcedExitMs ?? 30_000)
    forcedExit.unref()
    try {
      // Reject queued cold starts before closing transport/DB. ProjectorFleet
      // prevents active builds from registering listeners after this stop.
      // Closing the proof decoder below rejects unfinished pure decoding;
      // it does not cancel SQL/drains or join every cold-build continuation.
      step('intake', resources.stopIntake)
      // Started here, awaited before the pools.
      const stopBackgroundBuilds = resources.stopBackgroundBuilds
        ? Promise.resolve(step('background builds stop', resources.stopBackgroundBuilds)).catch(() => undefined)
        : undefined
      const stopStaticDeltaProjector = step('static projector stop', resources.stopStaticProjector)
      step('maintenance intake', resources.stopMaintenanceIntake)
      const closeHttp = step('http', () => resources.closeHttp(startedAt))
      // Maintenance jobs can hold and mutate Automerge documents, so let an
      // active one finish before closing the repo or its PostgreSQL session.
      await step('maintenance drain', resources.drainMaintenance)
      const drainResults = await Promise.allSettled([
        // T-ZEROWM (B): AFTER the static projector's stop, which drains its
        // in-flight rotations (bounded) — a rotation verifies its ModelMeta
        // is durable through this decoder before it marks itself `published`;
        // closed under it, it would be left `admitted` until the next boot.
        Promise.resolve(stopStaticDeltaProjector).catch(() => undefined)
          .then(() => step('durable heads decoder close', resources.closeDurableHeadsDecoder)),
        stopStaticDeltaProjector,
        step('automerge drain', resources.drainAutomerge),
        step('change hub', resources.stopChangeHub),
        closeHttp,
      ])
      const failedDrains = drainResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      // A rejected drain can mean an unjoined operation or failed persistence.
      // Keep ownership until forced process exit; never compare-release on an
      // allSettled result that did not certify transport closure and flush.
      if (failedDrains.length) throw new AggregateError(failedDrains.map(result => result.reason), 'Server drain incomplete; ownership retained')
      // T-ZEROWM-2 (2), MEASURED (`serverShutdown.integration.test.ts`): the
      // static projector releases its leases AFTER its own drain, so the
      // evictions they start begin AFTER the Automerge drain's residency step
      // above (≈ 200 ms later past a 200 ms ceiling, ≈ 600 ms with a pass held
      // 600 ms) — but each settles in the same turn (`Repo.removeFromCache`
      // is synchronous under its `async`), before `stop()` itself returns, so
      // none is running when the Repo shuts down. No second residency drain
      // is needed here, and none is added.
      // Keep the critical Redis connection alive until Automerge has stopped
      // accepting writes and flushed. Only then compare-release our leases.
      //
      // NOT "drainAutomerge persisted all accepted writes" (the comment this
      // replaces): it closed every Automerge
      // TRANSPORT and flushed what had been written by then, but an HTTP
      // handler still running (the `http` step waits for it) can write into
      // the Repo AFTER that flush. Those writes are made durable HERE, bounded,
      // before the lease goes; a failure or a timeout throws — ownership
      // retained, forced exit — rather than hand the workspace to an owner that
      // would load without a write its client was answered 200 for. After that
      // flush nothing writes (no transport, no handler), so Repo.shutdown can
      // still take longer than an orchestrator's stop window after ownership.
      if (resources.flushLateWrites) {
        await step('late writes flush', () => boundedFlush(resources.flushLateWrites!, resources.lateWriteFlushMs ?? 4_000))
      }
      await step('ownership', resources.stopOwnership)
      await step('automerge shutdown', resources.shutdownAutomerge)
      await step('redis', resources.stopRedis)
      // A background build's connection is checked out of the primary pool;
      // `pool.end()` would wait for it.
      await stopBackgroundBuilds
      await step('pools', resources.endPools)
      clearTimeout(forcedExit)
      emitTrace('complete')
      log('[server] graceful shutdown complete')
      resources.exit(0)
    } catch (error) {
      emitTrace('failed')
      throw error
    }
  })()
}

export class LateWriteFlushTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`late-write flush did not settle within ${ms} ms; ownership retained`)
    this.name = 'LateWriteFlushTimeoutError'
  }
}

function boundedFlush(flush: () => Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LateWriteFlushTimeoutError(ms)), ms)
    timer.unref()
    flush().then(
      () => { clearTimeout(timer); resolve() },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}
