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

import { describe, expect, it } from 'vitest'
import { abandonmentReport, recordAbandonment, settleAbandonment } from './drillAbandonment.js'
import type { DrillAbandonment } from './drillTick.js'

/**
 * The witness an abandonment leaves behind.
 *
 * Tested WITHOUT a database on purpose. The half that decides whether anyone
 * finds out is `outcome: 'failed'` — that is what `BackupDrillFailing` watches
 * — and putting it behind a `TEST_DATABASE_URL` gate would mean a run without
 * Postgres reports 0 failures and 1 skip, exit 0. Over 400 server tests already
 * gate themselves that way; the one asserting that a silent failure is not
 * silent must not be among them.
 */

const ABANDONMENT: DrillAbandonment = {
  reason: 'deadline',
  heldMs: 21_600_000,
  deadlineMs: 21_600_000,
  graceMs: 300_000,
  backendPid: 4242,
  backendStart: '1787454350107573',
  lockKey: 7_243_119_002,
  lockLoss: null,
  // The final sample every abandonment takes, and its answer here is the good
  // one. ONE object rather than three parallel nullable fields: the invariant
  // "an age exists exactly when a verdict does" is structural instead of prose,
  // which is what removed three `??` fallbacks that could never fire.
  lockWatch: { verdict: 'ours', ageMs: 3, checks: 1, fenced: true },
}

const CONTEXT = {
  startedAt: new Date('2026-08-21T02:00:00.000Z'),
  bundleDirectory: '/var/lib/maplespire/backups/2026-08-21T02-00-00Z',
  applicationRevision: 'abc1234',
  now: () => new Date('2026-08-21T08:05:00.000Z'),
}

describe('abandonmentReport', () => {
  it('is a FAILED run, which is the only reason any alert fires', () => {
    // Without this the last-success-age gauge simply keeps rising and the first
    // signal is `BackupDrillStale` at 36 hours — during which `restart: always`
    // turns a deterministic wedge into a quiet crash loop.
    expect(abandonmentReport(ABANDONMENT, CONTEXT).outcome).toBe('failed')
  })

  it('says what happened, in terms an operator can act on', () => {
    const error = abandonmentReport(ABANDONMENT, CONTEXT).error!
    // Every one of these is something the reader needs and cannot get
    // elsewhere: which watchdog fired, how long the key was held, and WHICH
    // backend held it — the last being what they grep `pg_stat_activity` for.
    expect(error).toContain('deadline')
    expect(error).toContain('21600000 ms')
    expect(error).toContain('7243119002')
    expect(error).toContain('4242')
    // And the fact that makes this different from an ordinary failure.
    expect(error).toContain('may still have been running')
  })

  it('claims NOTHING about the bundle or the source census', () => {
    // A report written by code that inspected neither. A zeroed census would
    // be a SIGNED statement that no document is empty — a clean bill of health
    // nobody earned — and `written: true` would confuse "a bundle exists" with
    // "there is no backup at all".
    const report = abandonmentReport(ABANDONMENT, CONTEXT)
    expect(report.bundle.written).toBe(false)
    expect(report.sourceIntegrity?.verdict).toBe('incomplete')
    expect(report.sourceIntegrity?.census).toBeNull()
    expect(report.verification).toBeNull()
    expect(report.coldApi).toBeNull()
  })

  it('reports an RTO measured from the drill, not from the abandonment', () => {
    const report = abandonmentReport(ABANDONMENT, CONTEXT)
    expect(report.rtoMs).toBe(6 * 3_600_000 + 5 * 60_000)
    expect(report.startedAt).toBe('2026-08-21T02:00:00.000Z')
  })

  it('names the caller when the caller is what stopped it', () => {
    const report = abandonmentReport({ ...ABANDONMENT, reason: 'caller' }, CONTEXT)
    expect(report.error).toContain('caller')
    expect(report.error).not.toContain('(deadline:')
  })
})

describe('recordAbandonment', () => {
  it('writes the run and reports success', async () => {
    const statements: string[] = []
    const db = {
      query: async (text: string) => {
        statements.push(text)
        return { rows: [] as unknown[] }
      },
    }
    await expect(recordAbandonment(db as never, ABANDONMENT, CONTEXT)).resolves.toBe(true)
    expect(statements.join('\n')).toContain('INSERT INTO backup_drill_runs')
  })

  it('returns FALSE rather than throwing when the write fails', async () => {
    // The caller is on its way to `process.exit`. A rejection here would
    // replace "the drill was abandoned" with "the thing reporting it broke",
    // and the process must end either way — the key is still held.
    const db = { query: async () => { throw new Error('relation does not exist') } }
    await expect(recordAbandonment(db as never, ABANDONMENT, CONTEXT)).resolves.toBe(false)
  })

  it('returns FALSE rather than hanging when the write never answers', async () => {
    // The one that matters most and would never be noticed: this runs on the
    // path that exists to bound a hold, so a write with no ceiling would hold
    // the advisory lock for exactly as long as it hung. The defect one layer up,
    // committed by the code reporting it.
    const db = { query: () => new Promise<never>(() => {}) }
    const started = Date.now()
    await expect(recordAbandonment(db as never, ABANDONMENT, CONTEXT, { timeoutMs: 80 }))
      .resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

/**
 * The abandonment's two obligations, and the order between them.
 *
 * Lifted out of `drillScheduler` so they can be reached at all: that module
 * calls `main()` at module scope, so this sequence was the third non-trivial
 * behaviour in the backup subsystem living where no test could see it. The two
 * seams below exist for exactly this and nothing else — the pair is exercised
 * for real against a cluster in `drillTick.integration.test.ts`.
 */
describe('settleAbandonment — the evidence first, the key LAST', () => {
  const released = {
    signalled: true, released: true, refusedSelf: false, fenced: true, error: null, waitedMs: 3,
  } as const

  function spies(overrides: {
    terminate?: () => Promise<typeof released>
    record?: () => Promise<boolean>
  } = {}): {
      order: string[]
      options: Parameters<typeof settleAbandonment>[3]
      events: Array<[string, Record<string, unknown>]>
    } {
    const order: string[] = []
    const events: Array<[string, Record<string, unknown>]> = []
    return {
      order,
      events,
      options: {
        log: (event, fields = {}) => { events.push([event, fields]) },
        terminate: async (_db, key, pid) => {
          order.push(`terminate:${key}:${pid}`)
          return overrides.terminate ? await overrides.terminate() : released
        },
        record: async () => {
          order.push('record')
          return overrides.record ? await overrides.record() : true
        },
      },
    }
  }

  const db = { query: async () => ({ rows: [] }) } as never

  it('writes the evidence BEFORE returning the key, with the right key and pid', async () => {
    // Not cosmetic ordering, and the reverse of what shipped first. An
    // abandoned drill is STILL RUNNING — that is what abandonment means — so
    // every second between the key coming back and this process dying is a
    // second in which a rival scheduler can dump and run a retention sweep
    // against the same bundle root. Terminating first opens that window for as
    // long as the record takes; terminating last closes it to the exit.
    //
    // The cost is that the key returns ~15 s later, and it is only ever paid in
    // the case where the socket would not have carried a FIN anyway — where the
    // alternative is fifteen MINUTES.
    const spy = spies()
    const outcome = await settleAbandonment(db, ABANDONMENT, CONTEXT, spy.options)

    expect(spy.order).toEqual(['record', `terminate:${ABANDONMENT.lockKey}:${ABANDONMENT.backendPid}`])
    expect(outcome).toEqual({ termination: released, recorded: true })
  })

  it('a log sink that throws does not decide whether the key comes back', async () => {
    // The guarded sink sits BETWEEN the two steps, so an unguarded one would
    // let a logger with a full disk skip the termination entirely — the same
    // exposure `sessionAdvisoryLock` guards for the same reason one layer down.
    const order: string[] = []
    const outcome = await settleAbandonment(db, ABANDONMENT, CONTEXT, {
      log: () => { throw new Error('ENOSPC') },
      record: async () => { order.push('record'); return true },
      terminate: async () => { order.push('terminate'); return released },
    })

    expect(order).toEqual(['record', 'terminate'])
    expect(outcome).toEqual({ termination: released, recorded: true })
  })

  it('a termination that FAILS does not skip the record', async () => {
    // The two answer different questions. Losing the record because the key
    // could not be returned would leave `BackupDrillFailing` silent about the
    // very run that could not clean up after itself.
    const spy = spies({ terminate: () => Promise.reject(new Error('no route to host')) })
    const outcome = await settleAbandonment(db, ABANDONMENT, CONTEXT, spy.options)

    expect(spy.order).toContain('record')
    expect(outcome.recorded).toBe(true)
    // Reported as an UNRELEASED key. The direction that under-claims is the
    // only one that cannot produce a clean bill of health nobody earned.
    // `fenced` too: the synthesised failure reports the guarantee the CALL
    // had. A kill reported as unfenced when it was fenced sends a reader looking for a pid-reuse
    // hazard that this run did not have.
    expect(outcome.termination).toMatchObject({
      released: false, fenced: true, error: 'no route to host',
    })
  })

  it('a record that FAILS does not lose the termination outcome', async () => {
    const spy = spies({ record: () => Promise.reject(new Error('relation does not exist')) })
    const outcome = await settleAbandonment(db, ABANDONMENT, CONTEXT, spy.options)

    expect(outcome).toEqual({ termination: released, recorded: false })
    expect(spy.events.map(([name]) => name)).toContain('backup.drill_abandonment_record_failed')
    expect(spy.events.map(([name]) => name)).toContain('backup.drill_abandonment_recorded')
  })

  it('says out loud when the key may still be held', async () => {
    // The line an operator greps after a wedge. `released: false` in a field is
    // easy to skim past; the sentence is what tells them why every subsequent
    // tick is going to skip.
    const stillHeld = {
      signalled: true, released: false, refusedSelf: false, fenced: true, error: null, waitedMs: 10_000,
    }
    const spy = spies({ terminate: () => Promise.resolve(stillHeld as typeof released) })
    await settleAbandonment(db, ABANDONMENT, CONTEXT, spy.options)

    const line = spy.events.find(([name]) => name === 'backup.drill_lock_return')![1]
    expect(line.detail).toMatch(/may STILL be held/)
    expect(line).toMatchObject({ released: false, lockKey: ABANDONMENT.lockKey, backendPid: 4242 })
  })

  it('and says the opposite when it is confirmed gone', async () => {
    // The other arm, so neither sentence can be deleted without a failure.
    const spy = spies()
    await settleAbandonment(db, ABANDONMENT, CONTEXT, spy.options)

    const line = spy.events.find(([name]) => name === 'backup.drill_lock_return')![1]
    expect(line.detail).toMatch(/confirmed no longer attributed/)
    expect(line.detail).not.toMatch(/may STILL be held/)
  })
})

describe('settleAbandonment — with NO seams, so the production defaults run', () => {
  /** A database that answers both statements and records what it was asked. */
  function recordingDb(): { statements: string[]; db: never } {
    const statements: string[] = []
    const db = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('pg_terminate_backend')) return { rows: [] as unknown[] }
        return { rows: [] as unknown[] }
      },
    }
    return { statements, db: db as never }
  }

  it('takes BOTH production defaults, in order', async () => {
    // Every other case in this file injects both seams, so without this neither
    // default would be executed without a database (the DB-gated integration
    // test is skipped silently when Postgres is absent). Like the
    // alert-deciding half, the key-return half must not sit behind a
    // `TEST_DATABASE_URL` gate.
    const { statements, db } = recordingDb()
    const outcome = await settleAbandonment(db, ABANDONMENT, CONTEXT, { log: () => {} })

    const insert = statements.findIndex((sql) => sql.includes('INSERT INTO backup_drill_runs'))
    const terminate = statements.findIndex((sql) => sql.includes('pg_terminate_backend'))
    expect(insert).toBeGreaterThan(-1)
    expect(terminate).toBeGreaterThan(-1)
    expect(insert).toBeLessThan(terminate)
    // No row from the terminate means that backend does not hold the key, which
    // is the honest "already released".
    expect(outcome).toEqual({
      recorded: true,
      termination: {
        signalled: false, released: true, refusedSelf: false, fenced: true, error: null,
        waitedMs: expect.any(Number),
      },
    })
  })

  it('the terminate really carries the key and the pid from the abandonment', async () => {
    // The values travel through three modules to reach a statement that KILLS a
    // backend. A default that ran with the wrong key would terminate nothing,
    // report `released: true`, and leave the fleet blocked with a clean log.
    const values: unknown[][] = []
    const db = {
      query: async (sql: string, v: unknown[] = []) => {
        if (sql.includes('pg_terminate_backend')) values.push(v)
        return { rows: [] as unknown[] }
      },
    }
    await settleAbandonment(db as never, ABANDONMENT, CONTEXT, { log: () => {} })

    // The fencing token travels WITH the pid. Without it the statement would
    // authorise a kill on a number the OS reissues, and the victim would be the
    // rightful successor drill rather than a random bystander.
    expect(values).toEqual([[ABANDONMENT.lockKey, ABANDONMENT.backendPid, ABANDONMENT.backendStart]])
  })

  it('forwards the ceilings it is given, rather than silently using its own', async () => {
    const seen: Array<Record<string, unknown>> = []
    await settleAbandonment({ query: async () => ({ rows: [] }) } as never, ABANDONMENT, CONTEXT, {
      log: () => {},
      terminationCeilingMs: 4_321,
      recordTimeoutMs: 8_765,
      terminate: async (_db, _key, _pid, options) => {
        seen.push({ step: 'terminate', ...options })
        return { signalled: true, released: true, refusedSelf: false, fenced: true, error: null, waitedMs: 0 }
      },
      record: async (_db, _a, _c, options) => {
        seen.push({ step: 'record', ...options })
        return true
      },
    })

    expect(seen).toEqual([
      { step: 'record', timeoutMs: 8_765 },
      // The fencing token is in the same bag as the ceiling, and asserted here
      // rather than in a case of its own: it is threaded at exactly this call,
      // so dropping it would otherwise only show up as a kill authorised by a
      // recyclable pid — which no fake can notice.
      { step: 'terminate', ceilingMs: 4_321, backendStart: ABANDONMENT.backendStart },
    ])
  })

  it('reports the record outcome AFTER the record, not before it', async () => {
    // `recorded` is read straight out of the log line by whoever is looking at
    // why the container restarted. Emitted before the write it describes, it
    // reports `false` on every run — including the ones that worked.
    const events: Array<[string, Record<string, unknown>]> = []
    await settleAbandonment({ query: async () => ({ rows: [] }) } as never, ABANDONMENT, CONTEXT, {
      log: (event, fields = {}) => { events.push([event, fields]) },
      terminate: async () => ({ signalled: true, released: true, refusedSelf: false, fenced: true, error: null, waitedMs: 0 }),
      record: async () => true,
    })

    expect(events.find(([name]) => name === 'backup.drill_abandonment_recorded')?.[1])
      .toEqual({ recorded: true })
  })

  it('a failed record says WHY, not merely that it failed', async () => {
    // The message is the only thing that distinguishes "the table is missing"
    // from "the write timed out", and the two send an operator to different
    // places at three in the morning.
    const events: Array<[string, Record<string, unknown>]> = []
    await settleAbandonment({ query: async () => ({ rows: [] }) } as never, ABANDONMENT, CONTEXT, {
      log: (event, fields = {}) => { events.push([event, fields]) },
      terminate: async () => ({ signalled: true, released: true, refusedSelf: false, fenced: true, error: null, waitedMs: 0 }),
      record: () => Promise.reject(new Error('relation "backup_drill_runs" does not exist')),
    })

    expect(events.find(([name]) => name === 'backup.drill_abandonment_record_failed')?.[1])
      .toEqual({ error: 'relation "backup_drill_runs" does not exist' })
  })
})

describe('abandonmentReport — the stored sentence ranks its witnesses', () => {
  it('treats not-owner as the CERTAINTY it is, not as the doubt it used to print', () => {
    // `not-owner` comes from the backend asking `pg_locks` about ITSELF
    // (`pid = pg_backend_pid()`) — no pid to recycle, no token to fence, the
    // strongest evidence this system can hold. Because it is conclusive it
    // stops the drill immediately and never starts a watch, so a branch order
    // that checked the watch first would sign the hedge ("may have been running
    // without an exclusion") over a certainty.
    const report = abandonmentReport({
      ...ABANDONMENT,
      reason: 'lock-lost',
      lockLoss: 'not-owner',
      lockWatch: { verdict: 'not-ours', ageMs: 7, checks: 1, fenced: true },
    }, CONTEXT)

    expect(report.error).toMatch(/was CONFIRMED no longer held by backend pid 4242/)
    expect(report.error).toMatch(/asked pg_locks about itself/)
    expect(report.error).toMatch(/WAS running without an exclusion/)
    expect(report.error).not.toMatch(/may have been running/)
    // …and it still reports what the SECOND witness said, which is the clause
    // this change added to the strongest branch and which nothing pinned until
    // an independent battery deleted it silently. Two witnesses that agree and
    // two that disagree are different aftermaths to read at 03:00.
    expect(report.error).toMatch(/A later independent check said not-ours/)
    expect(report.error).toMatch(/7 ms before the abandonment was declared/)
  })

  it('branches on the OBSERVATION, not on the stop reason — a deadline can follow a loss', () => {
    // THE discriminating case, and the one a `reason`-based branch gets wrong.
    // The lock can be lost during the five-minute grace, AFTER the deadline has
    // already decided the stop reason. A sentence derived from `reason` would
    // tell a DR reviewer the key was held by pid 4242 throughout, which is false.
    const report = abandonmentReport({
      ...ABANDONMENT,
      reason: 'deadline',
      lockLoss: 'connection-error',
      lockWatch: { verdict: 'not-ours', ageMs: 12, checks: 4, fenced: true },
    }, CONTEXT)

    expect(report.error).toMatch(/was CONFIRMED no longer held by backend pid 4242/)
    expect(report.error).not.toMatch(/still held by/)
  })

  it('a plain deadline abandonment now carries independent evidence, not a bare assertion', () => {
    // What the fix to the second blocking finding buys. Before it, this case —
    // the COMMON abandonment: six hours elapsed, no loss ever reported — printed
    // "the lock was held by backend pid N and returned by ending that session".
    // A clean bill of health, HMAC-signed, with nothing behind it, on the path
    // where the process is being killed because it would not stop. Now a final
    // independent sample is taken as the abandonment is declared.
    const report = abandonmentReport(ABANDONMENT, CONTEXT)
    expect(report.error).toMatch(/an independent connection confirmed/)
    expect(report.error).toMatch(/still held by backend pid 4242 as of 3 ms/)
    expect(report.error).toMatch(/nothing establishes what happened to the key after that sample/)
    // No claim about a release that has not happened yet.
    expect(report.error).not.toMatch(/returned by ending that session/)
  })

  it('reports a CONFIRMED-held key without claiming it stayed that way', () => {
    // The direction where over-claiming is tempting: the exclusion was verified
    // intact, so a sentence saying the drill "held the lock throughout" reads
    // naturally and is unearned — nothing sampled the interval after.
    const report = abandonmentReport({
      ...ABANDONMENT,
      lockLoss: 'connection-error',
      lockWatch: { verdict: 'ours', ageMs: 4_000, checks: 12, fenced: true },
    }, CONTEXT)

    expect(report.error).toMatch(/still held by backend pid 4242 as of 4000 ms before/)
    expect(report.error).toMatch(/nothing establishes what happened to the key after that sample/)
    expect(report.error).toMatch(/had reported connection-error/)
    expect(report.error).toMatch(/12 independent check\(s\)/)
  })

  it('says how many times it asked when it never got an answer', () => {
    // `unknown` after one attempt and `unknown` after 240 are the same word
    // about different nights — a cluster that hiccuped once, and a cluster that
    // has refused to answer for an hour.
    const report = abandonmentReport({
      ...ABANDONMENT,
      lockLoss: 'heartbeat-failed',
      lockWatch: { verdict: 'unknown', ageMs: 900, checks: 240, fenced: true },
    }, CONTEXT)

    expect(report.error).toMatch(/240 independent check\(s\) from an independent connection could not establish/)
    expect(report.error).toMatch(/may have been running without an exclusion/)
    expect(report.error).not.toMatch(/CONFIRMED/)
    // What the lock's OWN connection had said: the hedge must not sign "had
    // reported nothing wrong" over a connection that reported
    // `heartbeat-failed`.
    expect(report.error).toMatch(/had reported heartbeat-failed/)
    expect(report.error).not.toMatch(/nothing wrong/)
    // NOT `/still held by/`: the `unknown` sentence legitimately contains
    // "could not establish WHETHER … was still held by". The phrase that belongs only to
    // the `ours` branch is the one that disclaims the interval after the sample.
    expect(report.error).not.toMatch(/nothing establishes what happened/)
  })

  it('says when the verdict rests on a pid the OS can reissue', () => {
    // An UNFENCED not-ours is the weaker evidence, and it is the evidence on
    // which a six-hour dump gets killed. Rendering it identically to a fenced
    // one is the two-facts-one-rendering mistake this whole section is about,
    // one level down.
    const fenced = abandonmentReport({
      ...ABANDONMENT,
      lockWatch: { verdict: 'not-ours', ageMs: 5, checks: 2, fenced: true },
    }, CONTEXT)
    const unfenced = abandonmentReport({
      ...ABANDONMENT,
      lockWatch: { verdict: 'not-ours', ageMs: 5, checks: 2, fenced: false },
    }, CONTEXT)

    expect(fenced.error).toMatch(/fenced by the session token/)
    expect(unfenced.error).toMatch(/identified by pid alone, UNFENCED/)
    expect(unfenced.error).not.toEqual(fenced.error)
  })

  it('the verdict OUTRANKS a merely broken connection, which is the weaker witness', () => {
    // Both inputs present and disagreeing in strength — the heartbeat saw a
    // connection die, an independent connection then established the key was
    // gone. A branch that tested `lockLoss` first would print the hedge and
    // discard the finding, which is exactly what shipped.
    const hedged = abandonmentReport({
      ...ABANDONMENT,
      lockLoss: 'connection-error',
      lockWatch: { verdict: 'unknown', ageMs: 5, checks: 3, fenced: true },
    }, CONTEXT)
    const established = abandonmentReport({
      ...ABANDONMENT,
      lockLoss: 'connection-error',
      lockWatch: { verdict: 'not-ours', ageMs: 5, checks: 3, fenced: true },
    }, CONTEXT)

    expect(hedged.error).toMatch(/may have been running without an exclusion/)
    expect(established.error).toMatch(/WAS running without an exclusion/)
    expect(established.error).not.toEqual(hedged.error)
  })
})
