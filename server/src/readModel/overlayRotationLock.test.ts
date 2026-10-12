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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import {
  __overlayRotationStreakEntryCount,
  __resetOverlayRotationRefusalStreaks,
  acquireOverlayRotationLock,
  overlayRotationLockKey,
  overlayRotationLockMetricSamples,
  releaseOverlayRotationLock,
  reportOverlayRotationLockContended,
  type OverlayRotationLockState,
} from './overlayRotationLock.js'
import { renderPrometheus } from '../runtime/metrics.js'

/** A `PoolClient` reduced to the two things this module touches, with the
 * release ARGUMENT kept: bare and with-an-error are different hand-backs — one
 * returns the same backend to the pool, the other ends the session — and a fake
 * that drops the argument cannot tell them apart. That distinction is the whole
 * subject of half this file. */
function fakeClient(answer: (sql: string) => unknown = () => ({ rows: [{ released: true }] })) {
  const statements: string[] = []
  const released: unknown[] = []
  const query = vi.fn(async (sql: string) => {
    statements.push(String(sql))
    const result = answer(String(sql))
    if (result instanceof Error) throw result
    return result as { rows: unknown[] }
  })
  return {
    statements,
    released,
    client: { query, release: (err?: unknown) => { released.push(err) } } as unknown as PoolClient,
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('overlayRotationLockKey', () => {
  it('mints the literal the three call sites used to write out by hand', () => {
    // A CHANGE-DETECTOR ON PURPOSE, and the only one in this file.
    //
    // This string is the wire format of an exclusion: two doors agree only if
    // they spell it identically, so a build that "cleans it up" stops excluding
    // every door still running the old spelling — silently, which is the one
    // failure the lock exists to prevent.
    expect(overlayRotationLockKey('land', 'version', 'object'))
      .toBe('overlay-rotation:land:version:object')
    expect(overlayRotationLockKey('land', 'version', 'connection'))
      .toBe('overlay-rotation:land:version:connection')
  })

  it('separates the two collections of one workspace', () => {
    // The object and connection heads rotate independently; one key for both
    // would serialise them and, worse, let a fold of one claim exclusion over
    // the other's segment rows.
    expect(overlayRotationLockKey('l', 'v', 'object'))
      .not.toBe(overlayRotationLockKey('l', 'v', 'connection'))
  })
})

describe('acquireOverlayRotationLock', () => {
  it('asks the NON-BLOCKING form, and hands the key text through as a parameter', async () => {
    const { client, statements } = fakeClient(() => ({ rows: [{ locked: true }] }))
    await expect(acquireOverlayRotationLock(client, 'overlay-rotation:l:v:object'))
      .resolves.toBe('acquired')
    // `pg_try_advisory_lock`, and the `try` is asserted rather than assumed:
    // the blocking form waits without bound behind a holder that spans
    // `repo.create` and two `repo.flush`es, on a chain `start()` awaits.
    expect(statements[0]).toContain('pg_try_advisory_lock')
    expect(statements[0]).not.toContain('SELECT pg_advisory_lock(')
    // `hashtextextended($1, 0)` — the hash is taken SERVER-side from a bound
    // parameter, so every door on one cluster derives the same key from the
    // same text regardless of build or client library.
    expect(statements[0]).toContain('hashtextextended($1, 0)')
  })

  it('reports `refused` when the server says the key is held', async () => {
    const { client } = fakeClient(() => ({ rows: [{ locked: false }] }))
    await expect(acquireOverlayRotationLock(client, 'k')).resolves.toBe('refused')
  })

  it('treats a MISSING row as UNKNOWN — not refused, and certainly not acquired', async () => {
    // Three states, three answers. A missing row is "I never learned the
    // answer", which is `unknown`, never `refused`.
    //
    // It is unreachable against a real Postgres, and that is the point: every
    // fake in this tree answers `{ rows: [], rowCount: 0 }` by default, so
    // under `refused` an unstubbed lock would make the path under test silently
    // do nothing — a green, vacuous test. `unknown` reaches the same skip at the
    // call sites but reports a different `state`, and destroys the connection
    // rather than returning it clean.
    const { client } = fakeClient(() => ({ rows: [] }))
    await expect(acquireOverlayRotationLock(client, 'k')).resolves.toBe('unknown')
  })

  it('a row with a non-boolean `locked` is UNKNOWN too', async () => {
    // `rows[0]?.locked === false` and not `!== true`: a row of the wrong SHAPE
    // is a fake answering a different statement.
    const { client } = fakeClient(() => ({ rows: [{ locked: null }] }))
    await expect(acquireOverlayRotationLock(client, 'k')).resolves.toBe('unknown')
  })

  it('does NOT convert a throw into `refused`', async () => {
    // "The server said no" and "I never learned the answer" are different facts
    // with OPPOSITE hand-backs. Folding them together is exactly how a
    // lock-holding connection goes back into a pool of four.
    const { client } = fakeClient(() => new Error('connection terminated'))
    await expect(acquireOverlayRotationLock(client, 'k')).rejects.toThrow('connection terminated')
  })
})

describe('releaseOverlayRotationLock', () => {
  it('acquired: unlocks, then hands the connection back CLEAN', async () => {
    const { client, statements, released } = fakeClient(() => ({ rows: [{ released: true }] }))
    await releaseOverlayRotationLock(client, 'overlay-rotation:l:v:object', 'acquired')
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('pg_advisory_unlock')
    // THE HASH, on the statement that RETURNS the key, not only on the
    // acquire. An unlock spelled with `hashtext($1)` would hash a different
    // int64 from the one the acquisition took, so `pg_advisory_unlock`
    // answers `false` on a key the session really holds — which this module
    // then reports and destroys the connection over, on every single release.
    // The literal, not the shared helper: a test deriving its expectation from
    // the constant under test agrees with any value it is given.
    expect(statements[0]).toContain('hashtextextended($1, 0)')
    expect(released).toEqual([undefined])
  })

  it('refused: issues NO unlock, and hands the connection back clean', async () => {
    // Nothing was taken, so the connection is provably clean — the same branch
    // `acquireLifecycleApplyLock` takes for the same reason. Unlocking anyway
    // would answer `false` every time and turn the not-held detector below
    // into noise, which retires it.
    const { client, statements, released } = fakeClient()
    await releaseOverlayRotationLock(client, 'k', 'refused')
    expect(statements).toEqual([])
    expect(released).toEqual([undefined])
  })

  it('unknown: ends the SESSION, because that is the only thing that returns the key', async () => {
    // Measured against Postgres: a bare `release()` on a lock-holding client
    // leaves the key held (1 -> 1) and hands the SAME backend back; a
    // `release(err)` drops it (1 -> 0). After an acquisition that gave no
    // answer the key may or may not be held, and there is no statement that can
    // tell — so the session goes.
    const { client, statements, released } = fakeClient()
    await releaseOverlayRotationLock(client, 'k', 'unknown')
    // No unlock is attempted: the connection is the thing in doubt, so asking
    // it a question is not evidence about anything.
    expect(statements).toEqual([])
    expect(released).toHaveLength(1)
    expect(released[0]).toBeInstanceOf(Error)
  })

  it('acquired but the unlock THROWS: the connection goes back destroyed', async () => {
    // An unlock that THROWS must not be swallowed:
    // `pg_advisory_unlock(...).catch(() => undefined)` followed by a bare
    // `client.release()` is the exact pair that hands a lock-holding backend
    // to the pool.
    //
    // Reachable: a statement issued inside an ABORTED transaction raises
    // 25P02 and the key is still held afterwards.
    const boom = Object.assign(new Error('current transaction is aborted'), { code: '25P02' })
    const { client, released } = fakeClient(() => boom)
    await expect(releaseOverlayRotationLock(client, 'k', 'acquired')).resolves.toBeUndefined()
    expect(released).toEqual([boom])
  })

  it('acquired but the unlock answers FALSE: reported AND the session is ended', async () => {
    // `pg_advisory_unlock` returns `false` when the session did not hold the
    // key. "The session holds nothing" would rest on the same statement whose
    // answer has just contradicted the acquisition, so the connection is
    // destroyed, as `releaseLifecycleApplyLock` does.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { client, released } = fakeClient(() => ({ rows: [{ released: false }] }))
    await releaseOverlayRotationLock(client, 'overlay-rotation:l:v:object', 'acquired')
    expect(released).toHaveLength(1)
    expect(released[0]).toBeInstanceOf(Error)
    const event = JSON.parse(String(warn.mock.calls.at(-1)?.[0])) as Record<string, unknown>
    expect(event.event).toBe('read_model.overlay_rotation_lock_not_held')
    expect(event.lockKey).toBe('overlay-rotation:l:v:object')
  })

  it('bounds the unlock with a CEILING and ends the session when it expires', async () => {
    // `pg_try_advisory_lock` bounds the LOCK WAIT, not the ROUND TRIP. A
    // socket black-holed by a stateful firewall answers neither way for
    // `tcp_retries2` — ~15 minutes on Linux — and this await sits in a
    // `finally` on the chain `start()` awaits. Without a clock a hang here
    // would leave the pod never ready.
    //
    // A promise that never settles, raced against a fake clock. The ceiling
    // cannot cancel the query — `pg` takes no `AbortSignal` — so the only thing
    // that returns the key is ending the session, which is why the hand-back
    // must be destructive here.
    vi.useFakeTimers()
    try {
      const released: unknown[] = []
      const client = {
        query: () => new Promise(() => undefined),
        release: (err?: unknown) => { released.push(err) },
      } as unknown as PoolClient
      const done = releaseOverlayRotationLock(client, 'k', 'acquired')
      await vi.advanceTimersByTimeAsync(29_000)
      // The control: still waiting at 29 s, so the assertion below is about the
      // ceiling and not about a promise that was never going to settle anyway.
      expect(released).toEqual([])
      await vi.advanceTimersByTimeAsync(2_000)
      await done
      expect(released).toHaveLength(1)
      expect(released[0]).toBeInstanceOf(Error)
      expect(String((released[0] as Error).message)).toContain('did not answer within')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the ACQUISITION too, and the caller is left in `unknown`', async () => {
    // Same reason, other end. An acquire that never answers must not become a
    // `refused` — the session may hold the key — so it throws and the call
    // sites' `lock` stays at its `unknown` initial value.
    vi.useFakeTimers()
    try {
      const client = { query: () => new Promise(() => undefined) } as unknown as PoolClient
      const attempt = acquireOverlayRotationLock(client, 'k')
      const settled = attempt.then(() => 'resolved', (e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(String(await settled)).toContain('pg_try_advisory_lock did not answer within')
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases exactly ONCE on every path', async () => {
    // pg-pool throws on a second release, so a double hand-back turns a
    // recoverable state into an exception inside a `finally` — which replaces
    // the caller's real error with this one.
    for (const state of ['acquired', 'refused', 'unknown'] satisfies OverlayRotationLockState[]) {
      const { client, released } = fakeClient()
      await releaseOverlayRotationLock(client, 'k', state)
      expect(released).toHaveLength(1)
    }
  })
})

describe('reportOverlayRotationLockContended', () => {
  beforeEach(() => { __resetOverlayRotationRefusalStreaks() })

  it('names the path, the workspace and the KEY it lost', async () => {
    // One contended rotation stalls the whole static projector's tick, so a
    // refusal must publish a signal; a silent refusal is the same blind spot
    // as the stall.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    reportOverlayRotationLockContended({
      path: 'recover-admitted', landscapeId: 'land', versionId: 'version', kind: 'connection',
    })
    const event = JSON.parse(String(warn.mock.calls.at(-1)?.[0])) as Record<string, unknown>
    expect(event).toMatchObject({
      event: 'read_model.overlay_rotation_lock_contended',
      path: 'recover-admitted',
      landscapeId: 'land',
      versionId: 'version',
      kind: 'connection',
      // The key comes from the SAME function the acquisition used, so the log
      // cannot disagree with the statement about which door was closed.
      lockKey: 'overlay-rotation:land:version:connection',
      state: 'refused',
    })
  })

  it('COUNTS the streak and its age, so refusal #1 and refusal #2000 differ', async () => {
    // The streak count is the difference between a signal and a noise
    // generator: another pod folding a chain for 400 ms and a key
    // nobody will ever release produce byte-identical lines without this.
    // `now` is injected rather than read from the clock — a test that measures
    // elapsed wall time measures the machine.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const detail = {
      path: 'fold', landscapeId: 'land', versionId: 'version', kind: 'object',
    } as const
    reportOverlayRotationLockContended({ ...detail, now: 1_000 })
    reportOverlayRotationLockContended({ ...detail, now: 11_000 })
    reportOverlayRotationLockContended({ ...detail, now: 41_000 })
    const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    expect(events.map((e) => e.consecutiveRefusals)).toEqual([1, 2, 3])
    expect(events.map((e) => e.refusedForMs)).toEqual([0, 10_000, 40_000])
  })

  it('a streak is per KEY, and an ACQUISITION ends it', async () => {
    // The falling edge, and it is the half nobody checks. A counter with no
    // reset reports the whole life of the process and stops meaning "right
    // now"; the reset lives on the acquisition because that is the event that
    // makes the entry obsolete, never on a read of it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const object = { path: 'fold', landscapeId: 'l', versionId: 'v', kind: 'object' } as const
    const connection = { path: 'fold', landscapeId: 'l', versionId: 'v', kind: 'connection' } as const
    reportOverlayRotationLockContended({ ...object, now: 0 })
    reportOverlayRotationLockContended({ ...object, now: 5 })
    // The OTHER collection of the SAME workspace is a different door.
    reportOverlayRotationLockContended({ ...connection, now: 5 })
    const before = warn.mock.calls.map(([l]) => (JSON.parse(String(l)) as { consecutiveRefusals: number }).consecutiveRefusals)
    expect(before).toEqual([1, 2, 1])

    const { client } = fakeClient(() => ({ rows: [{ locked: true }] }))
    await expect(acquireOverlayRotationLock(client, 'overlay-rotation:l:v:object'))
      .resolves.toBe('acquired')
    reportOverlayRotationLockContended({ ...object, now: 9 })
    reportOverlayRotationLockContended({ ...connection, now: 9 })
    const after = warn.mock.calls.slice(3)
      .map(([l]) => (JSON.parse(String(l)) as { consecutiveRefusals: number }).consecutiveRefusals)
    // The object door restarts at 1; the connection door, which nothing
    // acquired, carries on at 2. A reset that cleared the whole map would read
    // `[1, 1]` and would be indistinguishable from the correct one without it.
    expect(after).toEqual([1, 2])
  })

  it('carries `unknown` through instead of calling it a refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    reportOverlayRotationLockContended({
      path: 'rotate', landscapeId: 'l', versionId: 'v', kind: 'object', state: 'unknown',
    })
    const event = JSON.parse(String(warn.mock.calls.at(-1)?.[0])) as Record<string, unknown>
    expect(event.state).toBe('unknown')
  })
})

describe('overlayRotationLockMetricSamples', () => {
  beforeEach(() => {
    __resetOverlayRotationRefusalStreaks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  const sample = (name: string, now?: number) =>
    overlayRotationLockMetricSamples(now).find((entry) => entry.name.endsWith(name))

  it('un état SAIN vaut ZÉRO, jamais NaN — c\'est une réponse, pas une mesure impossible', () => {
    // Zero is TRUE here: "no key is stuck" is an answer to the question. NaN
    // is reserved for a number that could not be taken, and a NaN here would
    // make the panel read `No data` on the healthiest possible fleet.
    expect(sample('contended_keys')?.values[0]?.value).toBe(0)
    expect(sample('longest_refusal_seconds')?.values[0]?.value).toBe(0)
    expect(Number.isNaN(sample('longest_refusal_seconds')?.values[0]?.value)).toBe(false)
  })

  it('l\'ÂGE du plus vieux refus, qui est ce qui sépare un voisin sain d\'un détenteur bloqué', () => {
    // Two keys refusing, started 90 s apart. `refusals_total` cannot tell them
    // apart — both contribute the same slope — and this is the sample that can.
    reportOverlayRotationLockContended({ path: 'fold', landscapeId: 'l', versionId: 'v', kind: 'object', now: 1_000 })
    reportOverlayRotationLockContended({ path: 'rotate', landscapeId: 'l', versionId: 'v', kind: 'connection', now: 91_000 })
    expect(sample('contended_keys', 101_000)?.values[0]?.value).toBe(2)
    // The OLDEST, not the newest and not the mean: one key nobody will ever
    // release is the alarm, and averaging it against healthy churn hides it.
    // MUTANT: `Math.min` — 10 instead of 100, i.e. a wedged key reported as a
    // ten-second blip.
    expect(sample('longest_refusal_seconds', 101_000)?.values[0]?.value).toBe(100)
  })

  it('une ACQUISITION éteint la jauge, parce que la carte est évincée là et pas à la lecture', async () => {
    reportOverlayRotationLockContended({ path: 'rotate', landscapeId: 'l', versionId: 'v', kind: 'object', now: 0 })
    expect(sample('contended_keys', 5_000)?.values[0]?.value).toBe(1)
    const { client } = fakeClient(() => ({ rows: [{ locked: true }] }))
    await expect(acquireOverlayRotationLock(client, 'overlay-rotation:l:v:object'))
      .resolves.toBe('acquired')
    // Back to zero, and the counter below does NOT go back with it: a gauge
    // that says "nothing is stuck now" and a counter that says "this happened"
    // are different facts, and folding them loses the second.
    expect(sample('contended_keys', 5_000)?.values[0]?.value).toBe(0)
    expect(sample('longest_refusal_seconds', 5_000)?.values[0]?.value).toBe(0)
  })

  it('le COMPTEUR est monotone et se lit en DELTA — le reset de test ne le touche pas', () => {
    // Read as a delta across the work, never as an absolute: nothing resets it,
    // so an assertion on its value would pass or fail on test ORDER.
    const before = Number(sample('refusals_total')?.values[0]?.value)
    reportOverlayRotationLockContended({ path: 'fold', landscapeId: 'l', versionId: 'v', kind: 'object' })
    reportOverlayRotationLockContended({ path: 'fold', landscapeId: 'l', versionId: 'v', kind: 'object' })
    expect(Number(sample('refusals_total')?.values[0]?.value) - before).toBe(2)

    // …and the seam that clears the streaks must NOT wind it back. A counter
    // that goes backwards makes every `rate()` over it lie.
    // MUTANT: `refusalsTotal = 0` inside `__resetOverlayRotationRefusalStreaks`.
    const held = Number(sample('refusals_total')?.values[0]?.value)
    __resetOverlayRotationRefusalStreaks()
    expect(Number(sample('refusals_total')?.values[0]?.value)).toBe(held)
  })

  it('l\'HORLOGE PAR DÉFAUT est la vraie, et la seconde garde ses décimales', () => {
    // The path `index.ts` actually calls — `overlayRotationLockMetricSamples()`
    // with no argument. Every other value-bearing assertion in this block
    // passes `now` explicitly, so only this one sees a wrong default (every
    // age reported from the Unix epoch) or a lost `toFixed(3)` precision.
    //
    // Fake timers, so the elapsed value is exact rather than "about 5 seconds":
    // an assertion with slop cannot see a lost decimal.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      reportOverlayRotationLockContended({ path: 'rotate', landscapeId: 'l', versionId: 'v', kind: 'object' })
      vi.setSystemTime(1_005_432)
      // MUTANT: `now: number = 0` — this reads 1005.432 instead of 5.432.
      // MUTANT: `toFixed(0)` — this reads 5.
      expect(sample('longest_refusal_seconds')?.values[0]?.value).toBe(5.432)
      expect(sample('contended_keys')?.values[0]?.value).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('une entrée PÉRIMÉE ne se publie plus — sinon la jauge se verrouille pour la vie du process', () => {
    // `refusalStreaks` is evicted at exactly one production site — the
    // acquisition — which never runs again for a key this pod stopped taking.
    // Without the TTL, one transient refusal on a workspace later demoted or
    // handed over would latch `contended_keys` at 1 and grow
    // `longest_refusal_seconds` for the life of the process.
    // MUTANT: drop the TTL filter in the sample function.
    reportOverlayRotationLockContended({ path: 'fold', landscapeId: 'l', versionId: 'v', kind: 'object', now: 0 })
    // Inside the window it still counts…
    expect(sample('contended_keys', 599_000)?.values[0]?.value).toBe(1)
    // …and past it, the pod is not contending on anything.
    expect(sample('contended_keys', 601_000)?.values[0]?.value).toBe(0)
    expect(sample('longest_refusal_seconds', 601_000)?.values[0]?.value).toBe(0)

    // A LIVE streak beside a stale one is not hidden by it — the filter is per
    // entry, not a global cut-off.
    reportOverlayRotationLockContended({ path: 'fold', landscapeId: 'l2', versionId: 'v', kind: 'object', now: 600_500 })
    expect(sample('contended_keys', 601_000)?.values[0]?.value).toBe(1)
    expect(sample('longest_refusal_seconds', 601_000)?.values[0]?.value).toBe(0.5)
  })

  it('la PURGE est sur le chemin d\'écriture, pas sur la lecture', () => {
    // A map swept only by its reader is swept only while someone is asking.
    // So the stale entry must be GONE from the map after a later refusal, with
    // no sample call in between.
    // MUTANT: delete the prune loop in `reportOverlayRotationLockContended`.
    //
    // The assertion goes through a SEAM and not through the samples, because
    // the samples filter by age: a stale entry and a pruned one publish
    // identically, so an assertion on the gauge cannot tell them apart.
    reportOverlayRotationLockContended({ path: 'fold', landscapeId: 'old', versionId: 'v', kind: 'object', now: 0 })
    expect(__overlayRotationStreakEntryCount()).toBe(1)
    reportOverlayRotationLockContended({ path: 'fold', landscapeId: 'new', versionId: 'v', kind: 'object', now: 700_000 })
    // TWO entries were written and ONE is held: the stale one is gone from the
    // map itself, with no sample call in between to have swept it.
    expect(__overlayRotationStreakEntryCount()).toBe(1)
    expect(sample('contended_keys', 700_000)?.values[0]?.value).toBe(1)
  })

  it('une clé qui refuse ENCORE reste vivante, même bien au-delà du TTL', () => {
    // The other direction: `lastAt` must be stamped on EVERY refusal, not
    // only the first (the TTL cases above use two different keys and cannot
    // see this). Otherwise a genuinely wedged key — the one thing these gauges exist to
    // report — ages out after ten minutes and the fleet goes quiet on it.
    //
    // MUTANT: `lastAt: previous?.lastAt ?? at`.
    const key = { path: 'rotate', landscapeId: 'l', versionId: 'v', kind: 'object' } as const
    reportOverlayRotationLockContended({ ...key, now: 0 })
    // …still refusing, every tick, an hour later.
    for (let at = 10_000; at <= 3_600_000; at += 300_000) {
      reportOverlayRotationLockContended({ ...key, now: at })
    }
    expect(__overlayRotationStreakEntryCount()).toBe(1)
    expect(sample('contended_keys', 3_600_000)?.values[0]?.value).toBe(1)
    // And the AGE is measured from the first refusal, not the last — that is
    // the whole point of keeping `since` and `lastAt` apart.
    expect(sample('longest_refusal_seconds', 3_600_000)?.values[0]?.value).toBe(3600)
  })

  it('les trois échantillons RENDENT, sous les noms que le tableau de bord interroge', () => {
    // A rendering assertion, because the exposition format is where a bad name
    // or an unescaped label becomes a scrape error rather than a type error —
    // and the first symptom of either is a series that quietly stops updating.
    reportOverlayRotationLockContended({ path: 'rotate', landscapeId: 'l', versionId: 'v', kind: 'object' })
    const text = renderPrometheus(overlayRotationLockMetricSamples())
    expect(text).toContain('# TYPE maplespire_overlay_rotation_lock_refusals_total counter')
    expect(text).toContain('# TYPE maplespire_overlay_rotation_lock_contended_keys gauge')
    expect(text).toContain('# TYPE maplespire_overlay_rotation_lock_longest_refusal_seconds gauge')
    // NO WORKSPACE LABELS. The streak map is keyed by lock key, so a label per
    // key puts `(landscape, version, kind)` into the cardinality — unbounded
    // across a fleet, and largest exactly when the fault is widespread. The log
    // line beside it carries which key; these three carry whether and how long.
    expect(text).not.toContain('landscape')
    expect(text).not.toContain('{')
  })
})
