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
import { EventEmitter } from 'node:events'
import {
  assertEmptyRestoreDatabase,
  assertSafeRestoreTarget,
  compareBackupState,
  databaseUrlWithName,
  DockerPgTools,
  parseDatabaseUrl,
  DEFAULT_SWEEP_BUDGET_MS,
  DEFAULT_SWEEP_MAX_DROPS,
  DEFAULT_SWEEP_MAX_FAILURES,
  FAILURE_SAMPLE_LIMIT,
  dropOrphanedRestoreDatabases,
  POOL_CONNECT_TIMEOUT_MS,
  readRestoreDatabaseCensus,
  restoreDatabaseAgeMs,
  restoreDatabaseCensusMetrics,
  type BackupManifest,
  type OrphanedRestoreSweep,
} from './backupRestore.js'
import { renderPrometheus } from '../runtime/metrics.js'

const manifest: BackupManifest = {
  format: 'maplespire-postgres-backup-v2',
  createdAt: '2026-07-30T00:00:00.000Z',
  applicationRevision: 'abc123',
  source: {
    database: 'maplespire',
    postgresVersion: '16.9',
    transactionTimestamp: '2026-07-30 00:00:00+00',
    walLsn: '0/123',
  },
  dump: { file: 'database.dump', bytes: 42, sha256: 'dump-hash' },
  schemaSha256: 'schema-hash',
  automergeStorage: { rows: 3, documents: 2, bytes: 100, sha256: 'storage-hash' },
  tables: {
    automerge_storage: { rowCount: 3, totalBytes: 8192 },
    versions: { rowCount: 1, totalBytes: 8192 },
  },
  authoritativeTables: {
    versions: { rows: 1, sha256: 'versions-hash' },
  },
  documentProbes: [{
    url: 'automerge:4ZzWdQmhBtsB8GfVEW1k7R42pqe',
    kind: 'root:version:active',
    heads: ['head-a'],
    contentSha256: 'content-a',
  }],
}

describe('backup and restore safety', () => {
  it('parses credentials without including them in the returned database identity fields', () => {
    const connection = parseDatabaseUrl('postgres://user:p%40ss@localhost:5455/maplespire?sslmode=require')
    expect(connection).toEqual({
      host: 'localhost',
      port: 5455,
      database: 'maplespire',
      user: 'user',
      password: 'p@ss',
      sslMode: 'require',
    })
  })

  it('refuses an in-place restore and only accepts safe generated database names', () => {
    const source = parseDatabaseUrl('postgres://user:secret@localhost:5455/maplespire')
    expect(() => assertSafeRestoreTarget(source, source)).toThrow('Refusing to restore over the source database')
    expect(databaseUrlWithName('postgres://user:secret@localhost:5455/maplespire', 'maplespire_restore_1'))
      .toContain('/maplespire_restore_1')
    expect(() => databaseUrlWithName('postgres://user:secret@localhost:5455/maplespire', 'bad-name'))
      .toThrow('simple PostgreSQL identifier')
  })

  it('refuses to restore into a target containing public tables', async () => {
    const db = { query: async () => ({ rows: [{ tables: '1' }], rowCount: 1 }) }
    await expect(assertEmptyRestoreDatabase(db as never)).rejects.toThrow('target is not empty')
  })

  it('reports table, Automerge, heads and content drift independently', () => {
    const errors = compareBackupState(manifest, {
      schemaSha256: 'different-schema',
      tables: {
        automerge_storage: { rowCount: 2, totalBytes: 10 },
        unexpected: { rowCount: 1, totalBytes: 10 },
      },
      automergeStorage: { rows: 2, documents: 1, bytes: 90, sha256: 'different-storage' },
      authoritativeTables: {
        versions: { rows: 1, sha256: 'different-versions' },
      },
      documentProbes: [{
        ...manifest.documentProbes[0],
        heads: ['head-b'],
        contentSha256: 'content-b',
      }],
      // This manifest predates the census, so it is compared against a
      // findings-free baseline: absence asserts "nothing was found". A restore
      // that then FINDS something is a real difference, not a tolerated gap --
      // the same rule the asset archive already follows one call site down.
      documentCensus: {
        status: 'complete',
        mapped: 2,
        withChunks: 1,
        syncStateOnly: 1,
        noRows: 0,
        otherChunkKinds: {},
        unretiredViolations: 1,
        violationSample: ['whatever'],
        violationsTruncated: 0,
      },
    })
    expect(errors).toEqual(expect.arrayContaining([
      'schema fingerprint differs',
      'public table set differs',
      'automerge_storage row count differs: expected 3, got 2',
      'automerge storage rows differs',
      'automerge storage documents differs',
      'automerge storage bytes differs',
      'automerge storage sha256 differs',
      'versions authoritative content differs',
      `document heads differ: ${manifest.documentProbes[0].url}`,
      `document content differs: ${manifest.documentProbes[0].url}`,
      'document census syncStateOnly differs: 0 -> 1',
    ]))
  })

  it('passes when only physical relation sizes differ after restore', () => {
    expect(compareBackupState(manifest, {
      schemaSha256: manifest.schemaSha256,
      tables: {
        automerge_storage: { rowCount: 3, totalBytes: 999_999 },
        versions: { rowCount: 1, totalBytes: 999_999 },
      },
      automergeStorage: manifest.automergeStorage,
      authoritativeTables: manifest.authoritativeTables,
      documentProbes: manifest.documentProbes,
      documentCensus: {
        status: 'complete',
        mapped: 1,
        withChunks: 1,
        syncStateOnly: 0,
        noRows: 0,
        otherChunkKinds: {},
        unretiredViolations: 0,
        violationSample: [],
        violationsTruncated: 0,
      },
    })).toEqual([])
  })

  it('rejects unsafe Docker container names before invoking Docker', () => {
    expect(() => new DockerPgTools('postgres;rm')).toThrow('Invalid PostgreSQL Docker container name')
  })
})

describe('recognising our own restore databases', () => {
  const NOW = 1_800_000_000_000
  /** Exactly the format `createTemporaryRestoreDatabase` mints. */
  const minted = (at: number) => `maplespire_restore_${at.toString(36)}_deadbeef`

  it('dates a database this codebase minted', () => {
    expect(restoreDatabaseAgeMs(minted(NOW - 90_000), NOW)).toBe(90_000)
  })

  it('REFUSES anything it cannot date, rather than calling it old', () => {
    // Each of these is a database the sweep must never touch, and the difference
    // between `null` and `0` here is the difference between skipping it and
    // dropping it. Returning 0 for an unrecognised name would pass every
    // "the orphan was removed" assertion and destroy production.
    for (const name of [
      'maplespire',
      'postgres',
      'maplespire_restore_',
      'maplespire_restore_zzz',              // no random suffix
      'maplespire_restore_abc_deadbeefff',   // suffix too long
      'maplespire_restore_ABC_deadbeef',     // base36 is lowercase here
      'maplespire_restore_!!_deadbeef',
      'prefix_maplespire_restore_abc_deadbeef',
      // Where `retain()` moves a database an operator asked to keep. It must be
      // unclaimable BY CONSTRUCTION, not by an age gate that expires.
      'maplespire_kept_mt1r8xcd_deadbeef',
      // A stamp of 0 parses fine as base 36 and dates as "56 years old". It is
      // only refused by the `mintedAt <= 0` guard, so without this name that
      // guard can be deleted with every test still green.
      'maplespire_restore_0_deadbeef',
      // Beyond Number.MAX_SAFE_INTEGER: the same guard, the other end.
      'maplespire_restore_zzzzzzzzzzzzz_deadbeef',
    ]) {
      expect(restoreDatabaseAgeMs(name, NOW), name).toBeNull()
    }
  })

  it('is not fooled by the LIKE pattern that would have been the obvious query', () => {
    // `_` is a LIKE wildcard, so `datname LIKE 'maplespire_restore_%'` also
    // matches this. The sweep therefore does no LIKE matching at all and asks
    // this function instead.
    expect(restoreDatabaseAgeMs('maplespireXrestoreY1234_deadbeef', NOW)).toBeNull()
  })

  it('requires the prefix at the START, not merely somewhere in the name', () => {
    // This function is "the only thing standing between the sweep and somebody's
    // production database", so `startsWith` must not weaken to `includes`.
    //
    // The exploitable set under `includes` is NARROW: `slice()` cuts at a FIXED
    // offset of 19, so a stray prefix only produces a datable name when it sits
    // at exactly offset 2, leaving `e_<8 hex>` behind — which would be dated
    // ~56.7 YEARS old, past any age gate, in the code path that authorises
    // `DROP DATABASE`. This case is that shape.
    expect(restoreDatabaseAgeMs('zzmaplespire_restore_deadbeef', NOW)).toBeNull()
  })

  it('treats a stamp from the future as brand new, never as ancient', () => {
    // A clock that moved backwards must not authorise a drop.
    expect(restoreDatabaseAgeMs(minted(NOW + 3_600_000), NOW)).toBe(0)
  })
})

describe('counting the litter by asking the cluster, not the janitor', () => {
  const NOW = 1_800_000_000_000
  const SIX_HOURS = 6 * 60 * 60 * 1000
  const minted = (at: number) => `maplespire_restore_${at.toString(36)}_deadbeef`
  const census = (names: string[], now: () => number = () => NOW) => readRestoreDatabaseCensus(
    { query: async () => ({ rows: names.map((datname) => ({ datname })) }) as never },
    SIX_HOURS,
    now,
  )

  it('puts every database in exactly one class, so the counts can be trusted', async () => {
    // Classify with `GROUP BY`, never with `WHERE ... IN`. A positive list silently exempts whatever it does not
    // recognise, and the whole reason this metric exists is that the sweep's own
    // numbers were reassuring while litter piled up. If the classes do not sum
    // to the rows examined, some class of database is invisible here too.
    const names = [
      'maplespire', 'postgres', 'template_gone',
      minted(NOW - SIX_HOURS - 1), minted(NOW - 1000),
      'maplespire_restore_nonsense', 'maplespire_kept_mt1r8xcd_deadbeef',
    ]
    const { counts } = await census(names)
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    expect(total).toBe(names.length)
    expect(counts).toEqual({
      foreign: 3, reclaimable: 1, live: 1, unrecognised: 1, retained: 1,
    })
  })

  it('counts the foreign databases too, so an EMPTY scan cannot read as a clean one', async () => {
    // The `runs_considered` lesson from the overlap check, one subsystem over: a
    // query that returned nothing gives four zeros for our own classes, which is
    // byte-identical to a cluster with no litter at all. The foreign count is
    // what separates "I looked and found nothing" from "I did not look".
    const looked = await census(['maplespire', 'postgres'])
    const didNotLook = await census([])
    expect(looked.counts.reclaimable).toBe(0)
    expect(didNotLook.counts.reclaimable).toBe(0)
    // Same verdict on our classes; only the examined total tells them apart.
    expect(looked.counts.foreign).toBe(2)
    expect(didNotLook.counts.foreign).toBe(0)
  })

  it('separates litter no sweep CAN take from litter a sweep has not taken YET', async () => {
    // These two need different alerts and the difference is not one of degree.
    // A `reclaimable` database ages into a sweep's selection and leaves on the
    // next pass. An `unrecognised` one is refused by `restoreDatabaseAgeMs`
    // forever, so it never ages into anything and no amount of convergence
    // removes it.
    const { counts } = await census([
      minted(NOW - SIX_HOURS - 1),
      'maplespire_restore_zzz',            // no random suffix — refused for good
      'maplespire_restore_0_deadbeef',     // stamp of 0 — refused by the guard
    ])
    expect(counts.reclaimable).toBe(1)
    expect(counts.unrecognised).toBe(2)
  })

  it('never counts a database an operator asked to KEEP as litter to reclaim', async () => {
    // `retain()` renames into `maplespire_kept_` precisely so no sweep touches
    // it. Counting one as reclaimable would put a page-worthy number on a
    // deliberate act, and — worse — an operator acting on this alert would
    // delete the one thing they kept in order to look at it.
    const { counts, oldestReclaimableAgeMs } = await census([
      // Far older than anything else here, so it would dominate the age gauge
      // if it were ever admitted.
      `maplespire_kept_${(NOW - 400 * 24 * 3600_000).toString(36)}_deadbeef`,
      minted(NOW - SIX_HOURS - 5000),
    ])
    expect(counts.retained).toBe(1)
    expect(counts.reclaimable).toBe(1)
    expect(oldestReclaimableAgeMs).toBe(SIX_HOURS + 5000)
  })

  it('reports NULL, never zero, when there is nothing to reclaim', async () => {
    // Nulls, never zeros, when a value cannot be established. A zero here
    // renders as `0` rather than NaN, and the
    // rule reads `> 604800`, so a zero is merely silent — but it is silent for
    // the WRONG reason, and a dashboard shows a flat line at zero that an
    // operator reads as "the oldest leftover is brand new".
    const { oldestReclaimableAgeMs } = await census(['maplespire', minted(NOW - 1000)])
    expect(oldestReclaimableAgeMs).toBeNull()
  })

  it('takes the age of the OLDEST reclaimable one, not the first or the newest', async () => {
    const { oldestReclaimableAgeMs } = await census([
      minted(NOW - SIX_HOURS - 1000),
      minted(NOW - SIX_HOURS - 90_000),
      minted(NOW - SIX_HOURS - 4000),
    ])
    expect(oldestReclaimableAgeMs).toBe(SIX_HOURS + 90_000)
  })

  it('admits a database exactly AT the age gate, matching the sweep it reports on', async () => {
    // `>=`, because `dropOrphanedRestoreDatabases` selects with `>=` too. An
    // off-by-one here would make the census disagree with the sweep for one
    // millisecond per database, which is invisible in a test written with round
    // numbers and is exactly how a census drifts from its subject.
    expect((await census([minted(NOW - SIX_HOURS)])).counts.reclaimable).toBe(1)
    expect((await census([minted(NOW - SIX_HOURS + 1)])).counts.live).toBe(1)
  })

  it('reads the clock ONCE, so a long list cannot classify its own head and tail differently', async () => {
    // Two databases minted at the same instant must land in the same class. A
    // clock sampled per row lets the second one cross the age gate mid-walk, so
    // an identical pair splits — a 1-in-N flake on a real cluster, and one that
    // would be blamed on the cluster rather than on the census.
    const stamp = NOW - SIX_HOURS + 5
    let ticks = 0
    // Advances past the gate between the first row and the second.
    const drifting = () => { ticks += 1; return NOW + (ticks > 1 ? 10 : 0) }
    const { counts } = await census([minted(stamp), minted(stamp)], drifting)
    expect(counts.live).toBe(2)
    expect(counts.reclaimable).toBe(0)
  })

  describe('as Prometheus samples', () => {
    const samples = (census: Awaited<ReturnType<typeof readRestoreDatabaseCensus>>) =>
      renderPrometheus(restoreDatabaseCensusMetrics(census))
    const empty = { live: 0, reclaimable: 0, unrecognised: 0, retained: 0, foreign: 0 }

    it('renders NaN, not 0, when nothing is reclaimable', () => {
      // The rule reads `> 604800`, and NaN fails every comparison — so a zero
      // here is silent too, and the difference only shows on a dashboard, where
      // a flat line at zero reads as "the oldest leftover is brand new". The
      // sample is asserted through the real renderer rather than as a JS value
      // because `Number.NaN` and `0` are both "a number" until it is printed.
      const text = samples({ counts: empty, oldestReclaimableAgeMs: null })
      expect(text).toContain('maplespire_backup_restore_oldest_reclaimable_age_seconds NaN\n')
    })

    it('reports the age in SECONDS, which is what the rule threshold is written in', () => {
      // A millisecond value against `> 604800` fires at ten minutes instead of
      // at a week — a rule that looks correct, is never silent, and gets
      // silenced. Nothing else in the pipeline converts, so this line is the
      // whole unit contract.
      //
      // Asserted to the END OF THE LINE: `toContain('… 604800')` is a SUBSTRING
      // match, and `604800000` contains `604800`, so a missing division would
      // pass. An assertion whose subject is a number needs a boundary.
      const text = samples({ counts: empty, oldestReclaimableAgeMs: 7 * 24 * 3600_000 })
      expect(text).toContain('maplespire_backup_restore_oldest_reclaimable_age_seconds 604800\n')
    })

    it('emits every class even at zero, so a clean cluster is not an absent series', () => {
      // A label that appears only when non-zero makes the healthy case
      // indistinguishable from a collector that stopped: `absent()` fires, the
      // dashboard renders "No data", and `sum by (state)` silently loses a
      // dimension. Emitting the zeros is what makes silence mean "measured, and
      // it was zero".
      const text = samples({ counts: empty, oldestReclaimableAgeMs: null })
      for (const state of ['reclaimable', 'live', 'unrecognised', 'retained', 'foreign']) {
        expect(text, state).toContain(`maplespire_backup_restore_databases{state="${state}"} 0\n`)
      }
    })

    it('carries the counts through to the right labels', () => {
      // Ordering of the five is not asserted anywhere else, and a transposition
      // — `unrecognised` and `retained` swapped, say — would alert on the
      // deliberate class and stay silent on the permanently-unreclaimable one.
      const text = samples({
        counts: { live: 1, reclaimable: 2, unrecognised: 3, retained: 4, foreign: 5 },
        oldestReclaimableAgeMs: 0,
      })
      expect(text).toContain('maplespire_backup_restore_databases{state="reclaimable"} 2\n')
      expect(text).toContain('maplespire_backup_restore_databases{state="unrecognised"} 3\n')
      expect(text).toContain('maplespire_backup_restore_databases{state="retained"} 4\n')
      // Zero is a legitimate age — a database minted this instant, at a gate of
      // zero — and must render as 0, never as NaN. The two mean opposite things.
      expect(text).toContain('maplespire_backup_restore_oldest_reclaimable_age_seconds 0\n')
    })
  })
})

describe('sweeping orphaned restore databases', () => {
  const aged = (agoMs: number) => `maplespire_restore_${(Date.now() - agoMs).toString(36)}_deadbeef`
  const DAY = 24 * 60 * 60 * 1000
  const SIX_HOURS = 6 * 60 * 60 * 1000

  /**
   * A pool that answers the catalogue query and can be told which drops fail.
   *
   * A real cluster offers no deterministic way to make `DROP DATABASE` fail —
   * this project runs its tests as superuser and with
   * `max_prepared_transactions = 0` — so the integration suite can only ever
   * exercise the happy path. That is precisely the assumption under which a
   * swallowed error ships.
   */
  function fakePool(catalogue: string[], failOn: string[] = [], failWith?: () => Error) {
    const attempted: string[] = []
    let closed = false
    let connects = 0
    let released = 0
    const clients: EventEmitter[] = []
    const query = async (text: string) => {
      if (text.includes('FROM pg_database')) {
        return { rows: catalogue.map((datname) => ({ datname })) }
      }
      const name = /"([^"]+)"/.exec(text)?.[1] ?? ''
      attempted.push(name)
      if (failOn.includes(name)) {
        // A real per-database refusal carries a SQLSTATE, and the sweep now
        // classifies on it. A bare `Error` here would be read as the connection
        // dying and would abandon the pass — so the DEFAULT failure has to be
        // as specific as production's, or every multi-failure case below would
        // measure the cluster-fault path by accident.
        throw Object.assign(
          new Error(`database "${name}" is being accessed by other users`),
          { code: '55006' },
        )
      }
      if (failWith) throw failWith()
      return { rows: [] }
    }
    const pool = {
      on: () => pool,
      end: async () => { closed = true },
      query,
      // The sweep checks out ONE client for the whole pass. Without `connect`
      // the fake would be more forgiving than the real pool, which destroys and
      // re-dials the client on every failed query — hiding a
      // reconnect-per-failure from a 20-failure test.
      connect: async () => {
        connects += 1
        // A real EventEmitter, not a plain object. `pg`'s Client emits 'error'
        // UNCONDITIONALLY on a socket death, and Node throws an unhandled
        // 'error' emit — which, from a standalone entrypoint with no
        // `uncaughtException` handler, is the whole container. A fake whose
        // client cannot emit makes that defect invisible to every test, which
        // is exactly how it got in.
        //
        // `query` delegates through `pool.query` rather than capturing the
        // closure, so a case that overrides `pool.query` to simulate a fault
        // still reaches the client. Capturing it directly made one such case
        // silently stop testing anything the moment the sweep checked out a
        // client.
        const client = Object.assign(new EventEmitter(), {
          query: (text: string) => pool.query(text),
          release: () => { released += 1 },
        })
        clients.push(client)
        return client
      },
    }
    return {
      pool, attempted, closed: () => closed,
      connects: () => connects, released: () => released, clients,
    }
  }
  const sweep = (fake: ReturnType<typeof fakePool>, options: Record<string, unknown> = {}) =>
    dropOrphanedRestoreDatabases('postgres://u:p@127.0.0.1:1/source', {
      minimumAgeMs: SIX_HOURS,
      createPool: () => fake.pool as never,
      ...options,
    })

  it('reports a drop that failed, and does NOT count it as dropped', async () => {
    const doomed = aged(DAY)
    const stubborn = aged(2 * DAY)
    const fake = fakePool([doomed, stubborn], [stubborn])

    const swept = await sweep(fake)

    expect(swept.dropped).toEqual([doomed])
    // Both halves matter. A witness written before the `await` would list
    // `stubborn` here too; a swallowed `catch` would leave `failed` empty.
    expect(swept.dropped).not.toContain(stubborn)
    expect(swept.failed).toHaveLength(1)
    expect(swept.failed[0]).toContain(stubborn)
    expect(swept.completed).toBe(true)
  })

  it('hands the caller a progress snapshot per drop, and only the RETURN says completed', async () => {
    // `drillRunner.ts` passes `onProgress` so an abandoned teardown keeps the
    // progress its sweep already made, and `drillRunner.test.ts` covers that
    // path — with a MOCKED sweep that calls `onProgress` itself. This drives
    // the real function's callback, including the `completed: false` labelling
    // of intermediate snapshots.
    //
    // Operator cost if it broke: a teardown abandoned by
    // `TEARDOWN_STEP_TIMEOUT_MS` reports `orphans: null` — "there was nothing
    // to do" — on the one night there was.
    const first = aged(2 * DAY)
    const second = aged(DAY)
    const fake = fakePool([second, first])
    const progress: OrphanedRestoreSweep[] = []

    const swept = await sweep(fake, { onProgress: (snapshot) => progress.push(snapshot) })

    // One per drop, in order, and each one a COPY: a callback handed the live
    // array would show the finished list in every entry, so the growing
    // lengths are what prove the snapshot is a snapshot.
    expect(progress.map((p) => p.dropped)).toEqual([[first], [first, second]])
    // `false` on every progress snapshot. This is the field the abandoned
    // caller reads to tell partial state from a finished pass; a snapshot that
    // claimed `true` would make an interrupted sweep indistinguishable from a
    // complete one.
    expect(progress.map((p) => p.completed)).toEqual([false, false])
    expect(progress.map((p) => p.remaining)).toEqual([1, 0])
    // …and ONLY the return value says otherwise.
    expect(swept.completed).toBe(true)
  })

  it('steps OVER the litter it cannot drop and reaches the litter it can', async () => {
    // The starvation this file previously ASSERTED as correct, in a test called
    // "counts a FAILED drop against the cap". Its justification was that each
    // attempt is a cluster-wide CHECKPOINT_IMMEDIATE the cap exists to bound —
    // which is false for a FAILED drop, and being false is the whole defect: a
    // failure performs no checkpoint, so charging it to an I/O cap bounded
    // nothing and starved everything behind it.
    //
    // Why "behind it" is permanent rather than unlucky: `candidates` is sorted
    // oldest-first, and a database that cannot be dropped is never reclaimed,
    // so it drifts to the HEAD of the list and stays there for every future
    // pass. Measured with the production function against a real cluster, the
    // failure an ownership error and `maxDrops: 2` being what the BOOT sweep
    // passes — leading failures 0/1/2/3 reclaimed 1/1/0/0 healthy databases.
    // Two undroppable databases were a permanent, silent, `completed: true`
    // stop on every boot.
    const stubborn = [aged(9 * DAY), aged(8 * DAY)]
    const reclaimable = aged(2 * DAY)
    const fake = fakePool([...stubborn, reclaimable], stubborn)

    const swept = await sweep(fake, { maxDrops: 2 })

    // The oldest-first order is what puts the failures in front, so this also
    // pins that the healthy one is reached LAST rather than by luck of order.
    expect(fake.attempted).toEqual([...stubborn, reclaimable])
    expect(swept.dropped).toEqual([reclaimable])
    expect(swept.failed).toHaveLength(2)
    expect(swept.remaining).toBe(0)
  })

  it('spends the drop cap on SUCCESSES only, so failures cannot consume it', async () => {
    // The same claim one level up from the case above: with more reclaimable
    // databases than the cap allows, the cap must still deliver its full
    // quota — a failure in front must cost the sweep nothing at all.
    const stubborn = aged(9 * DAY)
    const reclaimable = [aged(4 * DAY), aged(3 * DAY), aged(2 * DAY)]
    const fake = fakePool([stubborn, ...reclaimable], [stubborn])

    const swept = await sweep(fake, { maxDrops: 2 })

    expect(swept.dropped).toEqual([reclaimable[0], reclaimable[1]])
    expect(swept.failed).toHaveLength(1)
    // One candidate was never attempted, and `remaining` has to say so.
    expect(swept.remaining).toBe(1)
  })

  it('subtracts a FAILED drop from remaining, not only a successful one', async () => {
    // `remaining` was asserted in four places, all with `failed` empty, so
    // dropping the `- failed.length` term changed nothing anywhere. Here the
    // sweep is stopped by the FAILURE cap with candidates still unattempted, so
    // the term is load-bearing: without it this reads 4 instead of 2, claiming
    // twice as much left to do as there is.
    const doomed = [aged(4 * DAY), aged(3 * DAY), aged(2 * DAY), aged(DAY)]
    const fake = fakePool(doomed, doomed)

    const swept = await sweep(fake, { maxFailures: 2 })

    expect(fake.attempted).toHaveLength(2)
    expect(swept.dropped).toEqual([])
    expect(swept.failed).toHaveLength(2)
    expect(swept.remaining).toBe(2)
  })

  it('gives up after maxFailures, so a cluster-wide fault cannot walk the catalogue', async () => {
    // The circuit breaker. Without it, "keep going past a failure" means one
    // doomed drop per database in the catalogue — measured at 0.85 ms apiece,
    // so `budgetMs` would not trip for thousands of them, and every one of them
    // writes an `ERROR` line into the log of the cluster being backed up.
    //
    // Note what this case does NOT model: a cluster already answering `the database system
    // is shutting down` fails the CATALOGUE query first and never enters the
    // loop. That fault is the `cluster` stop two cases up. This cap is for a
    // population of individually-undroppable databases, and for a shutdown that
    // begins mid-pass.
    //
    // The literal is the point: deriving the bound from the constant under test
    // would agree with any value that constant is ever given.
    const doomed = Array.from({ length: 30 }, (_, i) => aged((30 - i) * DAY))
    const fake = fakePool(doomed, doomed)

    const swept = await sweep(fake)

    expect(fake.attempted).toHaveLength(20)
    expect(swept.failed).toHaveLength(20)
    expect(swept.remaining).toBe(10)
    expect(swept.dropped).toEqual([])
  })

  it('takes ONE connection for the whole pass, however many drops fail', async () => {
    // Why this matters, and why it is easy to miss: `pg-pool` calls
    // `client.release(err)` on a QUERY error and `_release` with a truthy err
    // goes to `_remove`, so every failed drop destroys the pooled client and
    // the next statement re-dials — bounded by `POOL_CONNECT_TIMEOUT_MS` each
    // time. Measured on the real pool: eight failing drops cost EIGHT connects,
    // eight succeeding ones cost one.
    //
    // That breaks `bootSweepBudgetMs`, which derives the boot budget from a
    // model of exactly one connect — and the failure path may run to
    // `maxFailures` attempts.
    const doomed = Array.from({ length: 12 }, (_, i) => aged((20 - i) * DAY))
    const fake = fakePool(doomed, doomed)

    const swept = await sweep(fake, { maxFailures: 12 })

    expect(swept.failedCount).toBe(12)
    expect(fake.connects()).toBe(1)
    // And it is handed back. This is rule-3 territory: the guard tracks "do I
    // hold a client", so a resolved connect must always be followed by a
    // release, on the failure path as much as the happy one.
    expect(fake.released()).toBe(1)
  })

  it('listens for errors on the CLIENT, not only on the pool', async () => {
    // Fatal rather than untidy if missed. `admin.on('error')` is on the POOL; the pool detaches its idle
    // listener on checkout. Measured on the real pool: a checked-out client has
    // `listenerCount('error') === 0`, and `Client._handleErrorEvent` emits
    // UNCONDITIONALLY on a socket death — so Node throws the unhandled emit.
    // `drillScheduler` is a standalone entrypoint with no `uncaughtException`
    // handler, and the boot sweep runs before the first tick: the container
    // dies under `restart: always` with no backups, through a door the
    // `.catch()` at its call site cannot cover.
    const fake = fakePool([aged(2 * DAY)])

    await sweep(fake)

    expect(fake.clients).toHaveLength(1)
    const client = fake.clients[0]!
    expect(client.listenerCount('error')).toBeGreaterThan(0)
    // The property that actually matters, asserted as behaviour rather than as
    // a listener count: emitting must not throw.
    expect(() => client.emit('error', new Error('socket died'))).not.toThrow()
  })

  it('closes the pool even if releasing the client throws', async () => {
    // A throwing release must not skip the close: a pool with a checked-out
    // client does not close (measured: `pool.end()` STILL PENDING at 2005 ms
    // against 0 ms released) — a silent wedge.
    const fake = fakePool([aged(2 * DAY)])
    const original = fake.pool.connect
    fake.pool.connect = (async () => {
      const client = await original()
      client.release = () => { throw new Error('release failed') }
      return client
    }) as never

    await sweep(fake)

    expect(fake.closed()).toBe(true)
  })

  it('lets a rejecting connect out, without releasing a client it never held', async () => {
    // The one arm of the rule-3 guard nothing pinned. `client` is assigned only
    // by a RESOLVED connect, so a rejecting one must leave it `undefined` —
    // calling `release()` on that would throw from the `finally` and mask the
    // real error, and skipping `admin.end()` would leak the pool.
    const fake = fakePool([])
    fake.pool.connect = (async () => { throw new Error('too many clients already') }) as never

    await expect(sweep(fake)).rejects.toThrow('too many clients already')

    expect(fake.released()).toBe(0)
    expect(fake.closed()).toBe(true)
  })

  it('keeps the failure SAMPLE above the failure CAP, so the report cannot truncate', async () => {
    // A relation stated in two literals is a relation nothing keeps — this
    // file's own rule. The persisted `orphansFailed` reads `failedCount`, so a
    // truncated sample under-reports nothing today; but only because the sample
    // limit exceeds the cap. Raise `maxFailures` past it and the sample starts
    // truncating, which is legitimate for the log and never for a count.
    expect(FAILURE_SAMPLE_LIMIT).toBeGreaterThan(DEFAULT_SWEEP_MAX_FAILURES)
  })

  it('releases the client even when the catalogue query throws', async () => {
    // A throw between acquiring and returning. The connect RESOLVED here, so
    // the client must come back: the guard must track "do we hold the thing we
    // must hand back", not "did the operation start".
    const fake = fakePool([])
    fake.pool.query = async () => { throw new Error('connection terminated') }

    await expect(sweep(fake)).rejects.toThrow('connection terminated')

    expect(fake.connects()).toBe(1)
    expect(fake.released()).toBe(1)
    expect(fake.closed()).toBe(true)
  })

  it('stops on a CLUSTER fault instead of blaming every database behind it', async () => {
    // `pool.query` surfaces a dead connection through the same rejection as a
    // per-database refusal. Without classifying, a cluster that is shutting
    // down produces `maxFailures` entries naming databases NOBODY ATTEMPTED,
    // and `describeSweep` prints them as undroppable litter — a confident wrong
    // answer on the one channel reporting this fault at all.
    const doomed = Array.from({ length: 10 }, (_, i) => aged((20 - i) * DAY))
    const fake = fakePool(doomed, [], () =>
      Object.assign(new Error('the database system is shutting down'), { code: '57P03' }))

    const swept = await sweep(fake)

    expect(fake.attempted).toHaveLength(1)
    expect(swept.failedCount).toBe(1)
    expect(swept.stoppedBy).toBe('cluster')
    // The nine it never looked at are reported as unattempted, not as failures.
    expect(swept.remaining).toBe(9)
  })

  it('treats an unknown SQLSTATE as this database\'s problem, not the cluster\'s', async () => {
    // The default has to fall on the side that keeps working. If an unrecognised
    // code abandoned the pass, one new object-level refusal would starve the
    // sweep exactly the way the old drop cap did — the defect, re-entering
    // through the guard added to fix it.
    const doomed = [aged(4 * DAY), aged(3 * DAY)]
    const fake = fakePool(doomed, [], () =>
      Object.assign(new Error('something new'), { code: '2BP01' }))

    const swept = await sweep(fake)

    expect(fake.attempted).toHaveLength(2)
    expect(swept.stoppedBy).toBe('exhausted')
  })

  it('names which exit ended the pass, because completed cannot', async () => {
    // Five outcomes print `completed: true` and they are operationally
    // opposite. `drops` is healthy and converging; `failures` is a tripped
    // circuit breaker. Nothing else in the result separates them.
    const many = Array.from({ length: 6 }, (_, i) => aged((10 - i) * DAY))

    const clean = await sweep(fakePool([aged(2 * DAY)]))
    expect(clean.stoppedBy).toBe('exhausted')

    const capped = await sweep(fakePool(many), { maxDrops: 2 })
    expect(capped.stoppedBy).toBe('drops')

    const broken = await sweep(fakePool(many, many), { maxFailures: 3 })
    expect(broken.stoppedBy).toBe('failures')

    const spent = await sweep(fakePool(many), { budgetMs: -1 })
    expect(spent.stoppedBy).toBe('budget')

    // All four said `completed: true`, which is the point.
    for (const s of [clean, capped, broken, spent]) expect(s.completed).toBe(true)
  })

  it('bounds the failure SAMPLE without bounding the failure COUNT', async () => {
    // `describeSweep` logs the `failed` ARRAY, and that log line is the only
    // channel this fault has. A sample keeps the event small; `failedCount`
    // keeps it honest. Reading `failed.length` as the count is the same "a
    // sample is not a count" error `remaining` made about unreclaimed
    // databases.
    const doomed = Array.from({ length: 40 }, (_, i) => aged((60 - i) * DAY))
    const fake = fakePool(doomed, doomed)

    const swept = await sweep(fake, { maxFailures: 40 })

    expect(swept.failedCount).toBe(40)
    expect(swept.failed).toHaveLength(FAILURE_SAMPLE_LIMIT)
    expect(swept.failed.length).toBeLessThan(swept.failedCount)
  })

  it('charges a failure to the FAILURE cap only, with successes in the same pass', async () => {
    // `dropped.length + failed.length >= maxFailures` would starve again at
    // `maxFailures - dropped.length`. A cap test with no successes (every
    // candidate failing) cannot tell a cap on failures from a cap on attempts.
    //
    // So: successes on BOTH sides of the failures, oldest-first.
    const oldest = [aged(60 * DAY), aged(59 * DAY)]
    const doomed = Array.from({ length: 19 }, (_, i) => aged((58 - i) * DAY))
    // Four, not three: with three the fifth drop is the LAST candidate, the
    // loop falls off its own end, and `stoppedBy` reads `exhausted` — so the
    // assertion that the pass stopped ON the drop cap would be asserting the
    // wrong exit. One spare candidate makes the cap actually bite.
    const newest = [aged(39 * DAY), aged(38 * DAY), aged(37 * DAY), aged(36 * DAY)]
    const fake = fakePool([...oldest, ...doomed, ...newest], doomed)

    // Shipped caps, deliberately: the defect is only visible at the real ones.
    const swept = await sweep(fake)

    // 19 failures is under the cap of 20, so the pass reaches the newer healthy
    // litter and spends its full drop quota. A cap on attempts would stop at
    // 2 + 18 and reclaim two.
    expect(swept.dropped).toHaveLength(DEFAULT_SWEEP_MAX_DROPS)
    expect(swept.dropped).toEqual([...oldest, ...newest.slice(0, 3)])
    expect(swept.failedCount).toBe(19)
    expect(swept.stoppedBy).toBe('drops')
    expect(swept.remaining).toBe(1)
  })

  it('fires progress after a FAILED drop, not only after a successful one', async () => {
    // The other progress cases use a catalogue where nothing fails, so they
    // would not notice `onProgress` moving inside the `try`.
    //
    // The cost is paid on exactly the night it matters. `drillRunner` keeps the
    // last snapshot so a sweep abandoned by `BOOT_SWEEP_CEILING_MS` still
    // reports what it managed; with progress suppressed on failures, a pass
    // that failed on everything and was then stepped over logs
    // `describeSweep(null)` — `candidates: null, dropped: null` — which reads
    // as "there was nothing to do" — and the loop absorbs up to `maxFailures`.
    const doomed = [aged(9 * DAY), aged(8 * DAY)]
    const seen: Array<{ failed: number; completed: boolean }> = []
    const fake = fakePool(doomed, doomed)

    await sweep(fake, {
      onProgress: (p: OrphanedRestoreSweep) =>
        seen.push({ failed: p.failedCount, completed: p.completed }),
    })

    expect(seen).toEqual([{ failed: 1, completed: false }, { failed: 2, completed: false }])
  })

  it('takes maxDrops: 0 literally — drop nothing, attempt nothing', async () => {
    // Pins `??` against `||` on the drop cap. Unlike `maxFailures: 0`, which is
    // incoherent (attempt nothing, learn nothing) and is floored, a caller
    // asking for zero DROPS is asking a coherent question — how much is there —
    // and must not silently get five.
    const fake = fakePool([aged(3 * DAY), aged(2 * DAY)])

    const swept = await sweep(fake, { maxDrops: 0 })

    expect(fake.attempted).toEqual([])
    expect(swept.candidates).toBe(2)
    expect(swept.remaining).toBe(2)
    expect(swept.stoppedBy).toBe('drops')
  })

  it('floors the failure cap at one, so a zero never means "attempt nothing"', async () => {
    // The guard runs BEFORE the first attempt, so an unfloored `maxFailures: 0`
    // returns `dropped: [], completed: true` over a full candidate list — a
    // silent no-op. One attempt, then stop, is the honest reading of zero.
    const doomed = [aged(3 * DAY), aged(2 * DAY)]
    const fake = fakePool(doomed, doomed)

    const swept = await sweep(fake, { maxFailures: 0 })

    expect(fake.attempted).toHaveLength(1)
    expect(swept.failed).toHaveLength(1)
    expect(swept.remaining).toBe(1)
  })

  it('bounds failures far enough above the drop cap to survive a real fault', async () => {
    // Two constants, two jobs, and the relation between them is the thing a
    // later "consistency" edit would break: halving the failure cap alongside
    // the drop cap would re-introduce the starvation at half the threshold.
    // Asserting `A > B` constrains neither, so the value is pinned with a
    // literal as well — measured, the sweep still reclaims past 19 leading
    // failures and starves at 20.
    expect(DEFAULT_SWEEP_MAX_FAILURES).toBe(20)
    expect(DEFAULT_SWEEP_MAX_DROPS).toBe(5)
    expect(DEFAULT_SWEEP_MAX_FAILURES).toBeGreaterThan(DEFAULT_SWEEP_MAX_DROPS)
  })

  it('never drops the source database, nor one the caller is still using', async () => {
    const mine = aged(DAY)
    const fake = fakePool(['source', mine, aged(3 * DAY)])

    const swept = await sweep(fake, { exclude: [mine] })

    expect(fake.attempted).not.toContain('source')
    expect(fake.attempted).not.toContain(mine)
    expect(swept.candidates).toBe(1)
  })

  it('reclaims the OLDEST litter first, which is what makes a capped pass converge', async () => {
    // The order (`.sort()`, not `.sort().reverse()`) is not cosmetic, in two
    // separate ways.
    //
    // In PRODUCTION it decides what a capped pass converges on: `maxDrops`
    // stops a sweep at five, so newest-first would reclaim databases the next
    // pass would have got anyway while the oldest garbage — the abandoned run
    // nobody will ever come back for — survives every pass forever.
    //
    // In the INTEGRATION suite it is the whole mechanism of the flake this
    // change fixes: leftovers from an interrupted earlier run are older than
    // that suite's own fixture, so they are walked first and spend the budget.
    // An analysis resting on an unasserted property is folklore.
    //
    // Lexicographic `.sort()` equals chronological only while the base-36
    // stamps are the same LENGTH, which they are from 1972 to 2059. Stated
    // rather than assumed; nothing here depends on it beyond ordering, since
    // selection is a numeric age comparison.
    const oldest = aged(3 * DAY)
    const middle = aged(2 * DAY)
    const newest = aged(DAY)
    // Catalogue order deliberately is NOT age order: `pg_database` returns
    // whatever the heap gives, so a test seeded in age order would pass against
    // an implementation that does not sort at all.
    const fake = fakePool([newest, oldest, middle])

    await sweep(fake)

    expect(fake.attempted).toEqual([oldest, middle, newest])
  })

  it('stops at maxDrops, says how many it left, and spends the cap on the OLDEST', async () => {
    const day1 = aged(DAY)
    const day2 = aged(2 * DAY)
    const day3 = aged(3 * DAY)
    const day4 = aged(4 * DAY)
    const fake = fakePool([day1, day2, day3, day4])

    const swept = await sweep(fake, { maxDrops: 2 })

    expect(swept.dropped).toHaveLength(2)
    expect(swept.remaining).toBe(2)
    // WHICH two, not merely how many. Lengths alone are satisfied by a capped
    // pass that reclaims the two NEWEST — which converges on nothing, because
    // the next pass finds the same two ancient databases and spends the same
    // cap on whatever is newest again. The oldest litter is the litter no run
    // will ever come back for, so it is what a cap must be spent on. The order
    // test above pins the walk; this pins the CONSEQUENCE, which is the half a
    // reader actually cares about.
    expect(swept.dropped).toEqual([day4, day3])
  })

  it('ships the budget and the cap at the magnitudes production is sized for', async () => {
    // Every other assertion on these constants is a RELATION, and a relation is
    // satisfied by any magnitude (the budget test below agrees with a budget of
    // 0; `drillBootSweep.test.ts` agrees with a cap of 50). The relations catch
    // an inversion; these literals pin the magnitude.
    //
    // These are not arbitrary numbers to protect. Each drop is a cluster-wide
    // CHECKPOINT_IMMEDIATE on the PRODUCTION cluster; measured on the CI
    // container, one takes 40 ms on an idle cluster and 35 s median (301 s
    // worst) with eight concurrent writers. A cap of 50 turns a nightly
    // teardown into an I/O event of its own, and a budget of 0 turns the sweep
    // into a permanent no-op. Change either deliberately and this is the line
    // that asks you to say so.
    expect(DEFAULT_SWEEP_BUDGET_MS).toBe(30_000)
    expect(DEFAULT_SWEEP_MAX_DROPS).toBe(5)
  })

  it('the default budget is wired in, and is big enough to actually START drops', async () => {
    // The line above pins the CONSTANT and the case below pins that a default
    // EXISTS. Between them sits the thing neither covers: the `??` that wires
    // one to the other (`?? 0` would pass both). A seam proves the branching;
    // only a run through it proves the wiring.
    //
    // The clock advances by a LITERAL, which is the whole trick. The case below
    // steps by `DEFAULT_SWEEP_BUDGET_MS + 1`, so it agrees with a default of
    // zero exactly as it agrees with 30 000 — the rule that a test
    // deriving its bound from the constant under test agrees with any value
    // that constant is given. One second per reading, against a default that
    // has to be worth seconds for the sweep to reclaim anything at all.
    const older = aged(2 * DAY)
    const newer = aged(DAY)
    const fake = fakePool([newer, older])
    const base = Date.now()
    let elapsed = 0

    const swept = await sweep(fake, { now: () => { const at = base + elapsed; elapsed += 1_000; return at } })

    expect(swept.dropped).toEqual([older, newer])
    expect(swept.remaining).toBe(0)
  })

  it('applies a default wall-clock budget when the caller names none', async () => {
    // The shipped default is what production runs, and every other test here
    // overrides it. A clock past the deadline from the second reading on leaves
    // nothing dropped — unless the default is unbounded.
    const fake = fakePool([aged(DAY), aged(2 * DAY)])
    let first = true
    const base = Date.now()
    const swept = await sweep(fake, {
      now: () => { const at = first ? base : base + DEFAULT_SWEEP_BUDGET_MS + 1; first = false; return at },
    })

    expect(swept.dropped).toEqual([])
    expect(swept.remaining).toBe(2)
  })

  it('spends its budget on DROPS, not on the connect that precedes them', async () => {
    // `databasePool` gives the admin pool `connectionTimeoutMillis:
    // POOL_CONNECT_TIMEOUT_MS`, which is NOT SMALLER than
    // `DEFAULT_SWEEP_BUDGET_MS` — both 30 000 today. `>=` is the relation the
    // argument needs, so it is what the assertion below pins AND what this
    // sentence says: claiming "equal" in prose while asserting `>=` is the
    // `documentResolution` header shape, a sentence that goes stale on an edit
    // no test notices.
    //
    // With the deadline taken at entry — where it was — the whole budget was
    // spendable before one drop could START, and the sweep returned
    // `dropped: []` over a full candidate list with `completed: true`. Two
    // corrections to the obvious phrasing, both of which make the case
    // narrower and the fix no less right:
    //
    //   - at its FULL legal time the pool acquire REJECTS, and the function
    //     leaves through `finally`. What produces the silent no-op is a connect
    //     NEAR that limit plus a catalogue query, which is bounded by nothing.
    //   - it is not invisible, only quiet: `describeSweep` prints
    //     `candidates: N, dropped: 0, remaining: N, completed: true`, which
    //     reads like a clean cluster.
    //
    // How OFTEN it would happen is not established and is not claimed: the
    // connect measured 8 ms on a cluster with eight concurrent writers. This is
    // a relation between two constants, not a diagnosis.
    //
    // Charged through the injected clock rather than a real delay, so the case
    // is deterministic and costs nothing. Deriving that advance from
    // `DEFAULT_SWEEP_BUDGET_MS` is normally a trap — here it
    // is deliberate and correct, because the property ("the budget is armed
    // after the catalogue query") must hold for EVERY value of that budget.
    expect(POOL_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_SWEEP_BUDGET_MS)
    const doomed = aged(DAY)
    const fake = fakePool([doomed])
    const inner = fake.pool.query
    const base = Date.now()
    let elapsed = 0
    fake.pool.query = (async (text: string) => {
      if (text.includes('FROM pg_database')) elapsed += DEFAULT_SWEEP_BUDGET_MS + 1
      return inner(text)
    }) as never

    const swept = await sweep(fake, { now: () => base + elapsed })

    expect(swept.dropped).toEqual([doomed])
    expect(swept.remaining).toBe(0)
  })

  it('closes the pool even when the catalogue query throws', async () => {
    const fake = fakePool([])
    fake.pool.query = async () => { throw new Error('connection terminated') }

    await expect(sweep(fake)).rejects.toThrow('connection terminated')
    expect(fake.closed()).toBe(true)
  })

  it('registers an error handler on the pool it opens', async () => {
    // Narrow on purpose, and worth saying what it does and does not prove: it
    // pins that a listener IS attached, not that the process survives a real
    // idle-client failure. `WITH (FORCE)` terminates connections, and an
    // unhandled 'error' on a pg Pool takes the whole process down -- for the
    // scheduler, a dead drill loop. There is no deterministic way to make a
    // live pool emit that event from a test, so the alternative to this
    // assertion is no cover at all.
    const listeners: string[] = []
    const fake = fakePool([])
    fake.pool.on = ((event: string) => { listeners.push(event); return fake.pool }) as never

    await sweep(fake)

    expect(listeners).toContain('error')
  })

  it('refuses an age gate below the floor', async () => {
    await expect(sweep(fakePool([]), { minimumAgeMs: 0 })).rejects.toThrow(/Refusing to sweep/)
  })
})
