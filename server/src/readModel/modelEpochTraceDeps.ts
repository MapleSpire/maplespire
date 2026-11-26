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
 * DIAGNOSTICS ONLY (G4-16f): where an
 * event-driven forward pass spends its time, measured from OUTSIDE the
 * forwarder — the dependencies the trigger hands `sweepModelEpochs` are
 * wrapped, the forwarder itself is untouched. Active only when the server
 * traces (MODEL_EPOCH_TRACE_FILE); otherwise the real dependencies are used.
 *
 * Per pass, the totals: `repo.find` / `repo.flush` (count, ms), pool and
 * pinned-client queries (count, ms, the slowest statements), connection
 * acquisition. The rest of the pass's wall time is CPU in the forwarder
 * (history decoding, planning) or awaiting something not wrapped here.
 */
export interface PassTimings {
  find: { n: number; ms: number }
  flush: { n: number; ms: number }
  query: { n: number; ms: number }
  connect: { n: number; ms: number }
  slowest: Array<{ ms: number; what: string }>
}

export function emptyTimings(): PassTimings {
  return { find: { n: 0, ms: 0 }, flush: { n: 0, ms: 0 }, query: { n: 0, ms: 0 }, connect: { n: 0, ms: 0 }, slowest: [] }
}

function note(t: PassTimings, bucket: 'find' | 'flush' | 'query' | 'connect', ms: number, what: string): void {
  t[bucket].n += 1
  t[bucket].ms += ms
  t.slowest.push({ ms: Math.round(ms), what: `${bucket}: ${what}`.slice(0, 120) })
  t.slowest.sort((a, b) => b.ms - a.ms)
  if (t.slowest.length > 6) t.slowest.length = 6
}

async function timed<T>(t: PassTimings, bucket: 'find' | 'flush' | 'query' | 'connect', what: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { return await run() } finally { note(t, bucket, performance.now() - started, what) }
}

type AnyFn = (...args: unknown[]) => unknown

/** A repo whose `find` and `flush` are timed into `t`. */
export function timedRepo<R extends object>(repo: R, t: () => PassTimings): R {
  return new Proxy(repo, {
    get(target, prop) {
      // `target` as the receiver: a getter reading a `#private` field would
      // throw with the proxy as `this`.
      const value = Reflect.get(target, prop, target) as unknown
      if ((prop === 'find' || prop === 'flush') && typeof value === 'function') {
        return (...args: unknown[]) => timed(t(), prop, String(args[0] ?? '').slice(0, 60),
          () => Promise.resolve((value as AnyFn).apply(target, args)))
      }
      return typeof value === 'function' ? (value as AnyFn).bind(target) : value
    },
  })
}

/** A queryable (pool or client) whose `query` is timed into `t`. */
export function timedQueryable<Q extends object>(q: Q, t: () => PassTimings): Q {
  return new Proxy(q, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (prop === 'query' && typeof value === 'function') {
        return (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string } | undefined)?.text ?? '')
          return timed(t(), 'query', sql.replace(/\s+/g, ' ').trim().slice(0, 80), () => Promise.resolve((value as AnyFn).apply(target, args)))
        }
      }
      return typeof value === 'function' ? (value as AnyFn).bind(target) : value
    },
  })
}

/** `connect()` timed, and the client it returns timed too. */
export function timedConnect<C extends object>(connect: () => Promise<C>, t: () => PassTimings): () => Promise<C> {
  return async () => timedQueryable(await timed(t(), 'connect', 'pool.connect', connect), t)
}
