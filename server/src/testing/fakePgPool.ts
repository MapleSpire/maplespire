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

/**
 * A `pg.Pool` stand-in that refuses to be more forgiving than the real one.
 *
 * Three properties a simpler fake gets wrong, each of which would make a test
 * pass that should not:
 *
 *  1. **`on`/`off` track listeners, not calls.** Event name and function
 *     identity both matter: a real `EventEmitter` removes nothing when handed a
 *     different function, so `off('close', someOtherFunction)` must not satisfy
 *     `expect(listeners).toBe(0)` — the listener leaks onto a client that goes
 *     back into the pool.
 *  2. **It can emit `'error'`.** Otherwise the whole `connection-error` branch —
 *     and the crash an unguarded `'error'` causes, which is why callers attach a
 *     listener at all — is unreachable from the fast suite.
 *  3. **A double `release()` and a query on a released client throw.**
 *     `pg-pool` throws `Release called on client which has already been
 *     released to the pool` on the first and `Cannot use a released client` on
 *     the second, so an ordering mistake surfaces here as it would in
 *     production.
 *
 * The rule this file exists to enforce on itself: **every behaviour modelled
 * here must be one the real `pg`/`pg-pool` actually has.** A fake that can
 * produce a state production cannot is worse than no fake at all — this
 * codebase has paid for that lesson twice already (`DocHandle.state`, and the
 * repo fixture that made a document unavailable by throwing from `whenReady`).
 */

/**
 * An `AbortSignal` that records who is listening to it, by IDENTITY.
 *
 * The one thing a real `AbortSignal` cannot be asked: whether a listener was
 * removed. That question is not academic here — the drill scheduler's stop
 * signal lives for the WHOLE PROCESS, so a tick that registers a listener and
 * never removes it leaks one per tick and warns at ten. Two mutation runs
 * proved the omission survives every behavioural assertion in the tree, which
 * is what a resource-lifetime hole always looks like.
 *
 * Identity-sensitive on purpose, exactly like `FakePoolClient.off`: a
 * `removeEventListener` handed a fresh closure removes nothing, and that has to
 * be visible rather than pass.
 */
export interface RecordingAbortSignal {
  readonly signal: AbortSignal
  /** Listeners currently attached for `abort`. */
  readonly listeners: () => number
  readonly abort: (reason?: unknown) => void
}

export function recordingAbortSignal(): RecordingAbortSignal {
  const controller = new AbortController()
  const attached = new Set<unknown>()
  const real = controller.signal
  const signal = {
    get aborted(): boolean { return real.aborted },
    get reason(): unknown { return real.reason },
    addEventListener(type: string, handler: unknown, options?: unknown): void {
      if (type === 'abort') attached.add(handler)
      real.addEventListener(type, handler as EventListener, options as AddEventListenerOptions)
    },
    removeEventListener(type: string, handler: unknown): void {
      if (type === 'abort') attached.delete(handler)
      real.removeEventListener(type, handler as EventListener)
    },
    throwIfAborted(): void { real.throwIfAborted() },
  } as unknown as AbortSignal
  return {
    signal,
    listeners: () => attached.size,
    abort: (reason?: unknown) => {
      controller.abort(reason)
      // `{ once: true }` listeners are gone from the real target after a
      // dispatch, so the record has to follow or it would report a leak that
      // the platform already cleaned up.
      attached.clear()
    },
  }
}

export interface FakeQueryResult {
  readonly rows: readonly unknown[]
}

/** Answers one statement. Return `undefined` to fall through to the next
 *  responder; throw to make the statement reject, as Postgres would. */
export type FakeResponder = (
  sql: string,
  values: readonly unknown[],
) => FakeQueryResult | Promise<FakeQueryResult> | undefined

export interface FakeStatement {
  readonly sql: string
  readonly values: readonly unknown[]
  /** How many `'error'` listeners the client carried while this statement ran.
   *
   *  Recorded because ZERO is the crash: `pg-pool` removes its own idle
   *  listener at checkout and `Client._handleErrorEvent` emits unconditionally,
   *  so a socket reset during a statement with no listener is an uncaught
   *  `ERR_UNHANDLED_ERROR`. Any statement issued on a checked-out client must
   *  see at least one. */
  readonly errorListeners: number
}

export class FakePoolClient {
  readonly statements: FakeStatement[] = []
  /** One entry per `release()`, holding whatever was passed. A truthy value is
   *  what makes the real pool DESTROY the client instead of reusing it. */
  readonly releases: unknown[] = []
  /** `'error'` listeners still attached AT release time, one entry per call.
   *
   *  The ordering witness. `pg-pool` reinstalls its own listener as the first
   *  act of `release()`, so a caller that removes its own listener BEFORE
   *  releasing leaves the client unguarded for the whole gap — which is where
   *  the unlock statement runs. A zero here is that mistake. */
  readonly releaseErrorListeners: number[] = []
  private readonly handlers = new Map<string, Set<(argument: never) => void>>()
  private released = false

  constructor(private readonly responder: FakeResponder) {}

  async query(sql: string, values: readonly unknown[] = []): Promise<FakeQueryResult> {
    if (this.released) {
      // pg-pool's exact behaviour, and the reason it is modelled: an ordering
      // mistake that returns the client before its last statement is an
      // exception in production, so it must be one here too.
      throw new Error('Cannot use a released client. You must call pool.connect() again')
    }
    this.statements.push({ sql, values, errorListeners: this.listenerCount('error') })
    const answer = await this.responder(sql, values)
    if (answer === undefined) throw new Error(`fake pool has no answer for: ${sql}`)
    return answer
  }

  on(event: string, handler: (argument: never) => void): this {
    const set = this.handlers.get(event) ?? new Set()
    set.add(handler)
    this.handlers.set(event, set)
    return this
  }

  off(event: string, handler: (argument: never) => void): this {
    // Identity-sensitive, exactly like EventEmitter. Handing a fresh closure
    // here removes NOTHING, and that has to be visible.
    this.handlers.get(event)?.delete(handler)
    return this
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0
  }

  /** Deliver an event the way `pg.Client` does — and throw when nobody is
   *  listening for `'error'`, which is Node's `ERR_UNHANDLED_ERROR`. */
  emit(event: string, argument: unknown): void {
    const set = this.handlers.get(event)
    if ((set === undefined || set.size === 0) && event === 'error') {
      throw new Error(`Unhandled error. (${String(argument)})`)
    }
    for (const handler of [...(set ?? [])]) (handler as (argument: unknown) => void)(argument)
  }

  release(broken?: unknown): void {
    if (this.released) {
      throw new Error('Release called on client which has already been released to the pool.')
    }
    this.released = true
    this.releases.push(broken)
    this.releaseErrorListeners.push(this.listenerCount('error'))
  }

  get isReleased(): boolean {
    return this.released
  }
}

export interface FakePool {
  readonly pool: Pool
  /** Every client handed out, in order. */
  readonly clients: FakePoolClient[]
  /** The single client, for the common case; throws if none or several. */
  readonly only: FakePoolClient
}

/** The fencing token the acquire statement reports by default. Sixteen digits,
 *  like real epoch microseconds, so a test that trims it notices. */
export const DEFAULT_FAKE_TOKEN = '1787454350107573'

/** Build a pool whose statements are answered by `responder`. */
export function fakePgPool(responder: FakeResponder, max = 2): FakePool {
  const clients: FakePoolClient[] = []
  const connect = async (): Promise<FakePoolClient> => {
    const client = new FakePoolClient(responder)
    clients.push(client)
    return client
  }
  const pool = {
    // A real `pg.Pool` always exposes the config it was built with, and a
    // caller now READS it — `runDrillTick` warns when the pool has no room for
    // the second client its ownership check needs. A fake without `options`
    // would make that branch unreachable, which is how a guard becomes
    // decoration.
    options: { max },
    connect,
    /**
     * `pool.query`, modelled the way pg-pool actually implements it — because
     * the difference between this and a hand-rolled `connect`/`release` is a
     * process death.
     *
     * pg-pool attaches `client.once('error', …)` for the statement's duration
     * and releases the client with that error, so a socket reset mid-statement
     * is handled rather than becoming an uncaught `ERR_UNHANDLED_ERROR`. A
     * caller that checks the client out itself gets ZERO listeners — measured —
     * and `drillScheduler` is a standalone entrypoint with no
     * `uncaughtException` handler.
     *
     * Modelling the listener is what lets `FakeStatement.errorListeners` gate
     * this: a caller that goes back to a manual checkout drops it to 0 and the
     * test says so.
     */
    query: async (
      sql: string | { text: string; values?: readonly unknown[]; query_timeout?: number },
      values?: readonly unknown[],
    ): Promise<FakeQueryResult> => {
      // A CONFIG OBJECT IS A REAL CALLING CONVENTION, not a convenience: pg
      // reads `query_timeout` from it per query (`pg/lib/client.js`) and
      // rejects the statement when it expires, and rejection is the path
      // pg-pool releases the client on. Modelling it is what lets a test see
      // the difference between a bounded question and one that holds a client
      // until `tcp_retries2` (the leak behind
      // `backup.drill_lock_pool_end_timeout`). Verified against pg 8.21.0 with
      // a socket that answers nothing.
      const text = typeof sql === 'string' ? sql : sql.text
      const args = (typeof sql === 'string' ? values : sql.values ?? values) ?? []
      const timeout = typeof sql === 'string' ? undefined : sql.query_timeout
      const client = await connect()
      const onError = (): void => {}
      client.on('error', onError)
      let answer: FakeQueryResult
      try {
        // `if (readTimeout)` in pg means 0 DISABLES the timer rather than
        // expiring instantly — a timeout of 0 must not look bounded here.
        answer = timeout
          ? await Promise.race([
            client.query(text, args),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('Query read timeout')), timeout).unref?.()
            }),
          ])
          : await client.query(text, args)
      } catch (error) {
        // pg-pool releases WITH the error, which destroys the client rather
        // than returning a poisoned one to the next borrower.
        client.off('error', onError)
        client.release(error)
        throw error
      }
      client.off('error', onError)
      client.release()
      return answer
    },
  } as unknown as Pool
  return {
    pool,
    clients,
    get only(): FakePoolClient {
      if (clients.length !== 1) throw new Error(`expected exactly one client, got ${clients.length}`)
      return clients[0]!
    },
  }
}

/** The statements this codebase's advisory-lock module issues, answered from a
 *  small script. Anything not covered falls through so the caller can add its
 *  own responder in front. */
export function advisoryLockResponder(script: {
  locked?: boolean
  pid?: number
  held?: () => boolean | Promise<boolean>
  unlock?: boolean | Error
  acquireError?: Error
  /** The fencing token the acquire statement reports. `null` models a cluster
   *  whose `pg_stat_activity` would not say, which degrades every later check
   *  to the pid alone. */
  token?: string | null
  /** Answers the INDEPENDENT ownership question — a different statement from
   *  the heartbeat's, and answered separately on purpose: the whole point of
   *  that check is that it can disagree with the connection that failed.
   *
   *  THREE outcomes, because production has three and a two-valued fixture
   *  would hide the third:
   *  `true` the pid holds it and the session matches, `false` the pid holds no
   *  such lock, `'unreadable'` the pid holds it but `pg_stat_activity` would not
   *  report `backend_start` — which is a real state (another role sees exactly
   *  that) and must read as `unknown`, never as `not-ours`. */
  holder?: () => boolean | 'unreadable' | Error
  /** What the cluster does with the acquire statement's `set_config` calls.
   *
   *  `'applied'` (the default) echoes the requested values, which is what a TCP
   *  session measurably does — `set_config` RETURNS the effective value.
   *  `'inert'` returns 0 for all three, which is what a UNIX-SOCKET session
   *  measurably does: the statement succeeds and the kernel is untouched.
   *  `'clamped'` returns the OS defaults (7200/75/9), which is what a value
   *  above the kernel's `MAX_TCP_KEEP*` measurably does — `setsockopt` refuses
   *  and Postgres reports the PREVIOUS value, with no error anywhere. That
   *  third case is the one a fake most needs to model, because every value in
   *  it is positive and plausible, so a check of positivity alone is blind to
   *  it.
   *
   *  Modelled rather than omitted because omitting it would make every fixture
   *  look like the inert case, so `db.advisory_lock_keepalives_inert` would
   *  fire on tests that have nothing to do with keepalives. */
  keepalives?: 'applied' | 'inert' | 'clamped'
  /** `-1` models a Unix-socket session, which is what `pg_stat_activity`
   *  measurably reports for one. The module reads it to decide whether the
   *  keepalive alarm applies at all. */
  clientPort?: number
}): FakeResponder {
  return (sql, values) => {
    if (sql.includes('pg_try_advisory_lock')) {
      if (script.acquireError) throw script.acquireError
      // Only when the caller ASKED for them. With `keepalives: null` the module
      // issues a statement without those columns, and a fake that answered with
      // them anyway would hide the difference between the two shapes.
      const asked = sql.includes('tcp_keepalives_idle')
      const OS_DEFAULTS = [7200, 75, 9]
      const effective = (index: number): number => {
        if (script.keepalives === 'inert') return 0
        if (script.keepalives === 'clamped') return OS_DEFAULTS[index - 1]!
        return Number(values[index])
      }
      return {
        rows: [{
          locked: script.locked ?? true,
          pid: script.pid ?? 4242,
          token: script.token === undefined ? DEFAULT_FAKE_TOKEN : script.token,
          client_port: script.clientPort ?? 51_000,
          ...(asked
            ? { ka_idle: effective(1), ka_interval: effective(2), ka_count: effective(3) }
            : {}),
        }],
      }
    }
    if (sql.includes('pg_advisory_unlock')) {
      if (script.unlock instanceof Error) throw script.unlock
      return { rows: [{ unlocked: script.unlock ?? true }] }
    }
    // REFUSED rather than answered. `TERMINATE_HOLDER_SQL` also selects from
    // `pg_locks` and reads `pg_stat_activity`, so without this it would fall
    // into a branch below and be handed a row of the wrong SHAPE — the caller
    // destructures `is_self`/`signalled` and would silently read `undefined`.
    // A fixture that quietly answers a different statement is the fake being
    // more forgiving than the real pool, which is what this file exists not to
    // be. `terminateAdvisoryLockHolder` has its own scripted runner and a real
    // cluster; nothing should reach it through here.
    if (sql.includes('pg_terminate_backend')) {
      throw new Error('advisoryLockResponder does not model pg_terminate_backend')
    }
    // BEFORE the `pg_locks` branch, and the ordering is load-bearing rather
    // than tidy: the independent ownership question selects FROM `pg_locks`
    // too, so a `pg_locks` test reached first would answer it with the
    // HEARTBEAT'S verdict — collapsing the one distinction that check exists
    // to make. `pid_holds` appears in no other statement in the module.
    if (sql.includes('pid_holds')) {
      const answer = script.holder?.() ?? true
      if (answer instanceof Error) throw answer
      const token = script.token === undefined ? DEFAULT_FAKE_TOKEN : script.token
      // The third state, which production reaches and a boolean cannot carry:
      // the pid holds the lock and the token is unreadable.
      return answer === 'unreadable'
        ? { rows: [{ pid_holds: true, token: null }] }
        : { rows: [{ pid_holds: answer, token }] }
    }
    if (sql.includes('pg_locks')) {
      const held = script.held?.() ?? true
      return Promise.resolve(held).then((value) => ({ rows: [{ held: value }] }))
    }
    return undefined
  }
}
