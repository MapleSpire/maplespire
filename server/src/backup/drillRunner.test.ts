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
 * The drill's TEARDOWN, the part that could otherwise swallow the whole run.
 *
 * Most tests here turn on a step that does not settle. That is deliberate and
 * it is the only faithful fixture: `DROP DATABASE ... WITH (FORCE)` waits on
 * the rest of the cluster, so the failure mode is a wait, never a rejection —
 * and a fixture that fails by REJECTING would stay green over the production
 * path that hangs.
 */

import { link, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./backupRestore.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./backupRestore.js')>(),
  createDatabaseBackup: vi.fn(),
  createTemporaryRestoreDatabase: vi.fn(),
  restoreAndVerifyDatabase: vi.fn(),
  dropOrphanedRestoreDatabases: vi.fn(),
}))
vi.mock('./drillReport.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./drillReport.js')>(),
  recordDrillRun: vi.fn(async () => undefined),
}))
vi.mock('./retention.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./retention.js')>(),
  pruneDrillHistory: vi.fn(async () => ({ deleted: 0, bytesAfter: 0 })),
  // The full shape, not a convenient subset. `drillSummary` reads
  // `bundles.partials.length` and `bundles.deletedPartials.length`, and a mock
  // that omits them throws a TypeError the moment a test combines a bundleRoot
  // with a summary. Server tests are not typechecked, so nothing else would
  // say so.
  pruneBackupBundles: vi.fn(async () => ({
    budgetBytes: 0, bytesBefore: 0, bytesAfter: 0, bundlesBefore: 0,
    deleted: [], skipped: [], partials: [], partialBytes: 0,
    deletedPartials: [], deletedPartialBytes: 0, overBudget: false,
  })),
}))

const backupRestore = await import('./backupRestore.js')
const { restoreDatabaseAgeMs } = backupRestore
const {
  drillSummary, runBackupDrill, sweepStrayReportStaging, writeReportAtomically,
  TEARDOWN_STEP_TIMEOUT_MS,
} = await import('./drillRunner.js')
const { pruneBackupBundles } = vi.mocked(await import('./retention.js'))

const createTemporaryRestoreDatabase = vi.mocked(backupRestore.createTemporaryRestoreDatabase)
const createDatabaseBackup = vi.mocked(backupRestore.createDatabaseBackup)
const restoreAndVerifyDatabase = vi.mocked(backupRestore.restoreAndVerifyDatabase)
const dropOrphanedRestoreDatabases = vi.mocked(backupRestore.dropOrphanedRestoreDatabases)

/** Never resolves, never rejects — the shape a blocked checkpoint actually has. */
const blockedForever = () => new Promise<void>(() => undefined)

function restoreTarget(overrides: Partial<{ drop: () => Promise<void>; retain: () => Promise<string> }> = {}) {
  return {
    database: 'maplespire_restore_probe_0001',
    url: 'postgres://user:pw@127.0.0.1:1/maplespire_restore_probe_0001',
    drop: overrides.drop ?? (async () => undefined),
    retain: overrides.retain ?? (async () => 'maplespire_kept_probe_0001'),
  }
}

/**
 * A private temp root for this file. `os.tmpdir()` re-reads the environment on
 * every call, so pointing it here keeps the set-difference below from seeing
 * another vitest worker's drill directories, which would make it intermittent.
 */
let temporaryRoot: string
const originalTemp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }

async function assetDirectories(): Promise<Set<string>> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[])
  return new Set(entries.filter((entry) => entry.startsWith('maplespire-drill-assets-')))
}

/**
 * A URL nothing answers on. `pg`'s `Pool` is NOT mocked — it is constructed for
 * real; what keeps it inert is that `recordDrillRun` and `pruneDrillHistory` are
 * mocked, so no query is ever issued. This must never become reachable, or these
 * tests would quietly start depending on a database.
 */
const UNREACHABLE = 'postgres://user:pw@127.0.0.1:1/nothing'

function drillOptions(extra: Record<string, unknown> = {}) {
  return {
    databaseUrl: UNREACHABLE,
    bundleDirectory: tmpdir(),
    pgTools: {} as never,
    coldApi: false,
    retention: false as const,
    teardownStepTimeoutMs: 60,
    ...extra,
  }
}

describe('backup drill teardown', () => {
  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'drillrunner-test-'))
    process.env.TMPDIR = temporaryRoot
    process.env.TEMP = temporaryRoot
    process.env.TMP = temporaryRoot
  })
  afterAll(async () => {
    Object.assign(process.env, originalTemp)
    for (const [key, value] of Object.entries(originalTemp)) {
      if (value === undefined) delete process.env[key]
    }
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  })
  beforeEach(() => {
    // `restoreAllMocks()` does NOT clear call history on vitest 4.x. Without
    // this, `toHaveBeenCalledOnce()` below is an assertion about the whole file,
    // and reordering a test breaks it.
    vi.clearAllMocks()
    createDatabaseBackup.mockResolvedValue({
      applicationRevision: 'abc123',
      source: { database: 'source', postgresVersion: '16.14', transactionTimestamp: '2026-08-20 00:00:00+00' },
      dump: { bytes: 42, sha256: 'dump-hash' },
      retiredWorkspaces: [],
      // A real `createDatabaseBackup` always writes these three, and the
      // verdict depends on them; the `as never` cast means the compiler will
      // not flag a missing one.
      documentProbes: [],
      documentProbeFailures: [],
      probeCoverage: { cap: 64, candidatesConsidered: 1, selectionExhaustive: true, probed: 1, failed: 0 },
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
    } as never)
    restoreAndVerifyDatabase.mockResolvedValue({ outcome: 'passed' } as never)
    dropOrphanedRestoreDatabases.mockResolvedValue({
      candidates: 2, dropped: ['maplespire_restore_old_a'], failed: [], failedCount: 0,
      remaining: 1, completed: true, stoppedBy: 'drops',
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns an outcome even when the restore database never finishes dropping', async () => {
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget({ drop: blockedForever }))

    const outcome = await runBackupDrill(drillOptions())

    // The whole point: without the teardown ceiling this call never resolves,
    // so the assertion that matters is that we got here at all.
    expect(outcome.signed.report.drillId).toMatch(/^drill_/)
    expect(outcome.teardown.restoreDatabase).toBe('maplespire_restore_probe_0001')
    expect(outcome.teardown.restoreDatabaseDropped).toBe(false)
    expect(outcome.teardown.failure).toContain('maplespire_restore_probe_0001')
    expect(outcome.teardown.failure).toContain('still running after 60 ms')
  })

  it('still removes the restored asset directory while the drop is blocked', async () => {
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget({ drop: blockedForever }))
    const before = await assetDirectories()

    // The tight ceiling is REQUIRED here — the drop never settles, so the drill
    // only returns because the ceiling abandons it — which means the `rm` may
    // still be in flight when it does. The property under test is that the
    // directory does not LEAK, i.e. that the removal was STARTED even though
    // the drop before it is blocked. So wait for the state instead of assuming
    // it has already happened; on an unloaded box the first look succeeds and
    // this costs nothing.
    await runBackupDrill(drillOptions())

    // Set difference, not a count: another suite's leftovers must not decide
    // this verdict.
    const stillLeaking = async () =>
      [...await assetDirectories()].filter((entry) => !before.has(entry))
    const deadline = Date.now() + 20_000
    let leaked = await stillLeaking()
    while (leaked.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      leaked = await stillLeaking()
    }
    expect(leaked).toEqual([])
  })

  it('reports the drop as done only when it actually finished', async () => {
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    // A GENEROUS ceiling, and it is the assertion below that requires it. Every
    // other test here blocks a step on purpose and needs the ceiling to fire;
    // this one asserts that NOTHING failed, while the step list still contains a
    // real recursive `rm`. 60 ms is a bet on the event loop, not on the work:
    //
    //   rm of the drill's asset directory   p50 0.5-3.1 ms, max 4.5 ms (n=180)
    //   the same rm, loop starved 120 ms    still running at the 60 ms ceiling,
    //                                       25 trials out of 25
    //
    // A recursive `rm` needs several poll-phase turns, so a worker that loses
    // the CPU cannot advance it at all. Under a full `vitest run` at the default
    // worker count a 60 ms stall is ordinary, so a 60 ms ceiling here would be
    // flaky.
    const outcome = await runBackupDrill(drillOptions({ teardownStepTimeoutMs: 30_000 }))

    expect(outcome.teardown.restoreDatabaseDropped).toBe(true)
    expect(outcome.teardown.failure).toBeNull()
  })

  it('does not let a failing teardown step escape and destroy the report', async () => {
    // `runTeardownSteps` reports failure by THROWING, and a throw from a
    // `finally` propagates out of `runBackupDrill` — taking the signed report,
    // the recorded run and the retention sweep with it. Same loss as the hang,
    // different door.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget({
      retain: async () => { throw new Error('connection reset by peer') },
    }))

    const outcome = await runBackupDrill(drillOptions({ keepRestoreDatabase: true }))

    expect(outcome.signed.report.drillId).toMatch(/^drill_/)
    expect(outcome.teardown.failure).toContain('connection reset by peer')
  })

  it('sweeps orphaned restore databases only when the run owns the operator\'s leftovers', async () => {
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    const oneShot = await runBackupDrill(drillOptions({ retention: false }))
    expect(dropOrphanedRestoreDatabases).not.toHaveBeenCalled()
    expect(oneShot.teardown.orphans).toBeNull()

    const scheduled = await runBackupDrill(drillOptions({ retention: {} }))
    expect(dropOrphanedRestoreDatabases).toHaveBeenCalledOnce()
    // Six hours: the advisory lock serialises schedulers but not a one-shot CLI
    // run, so age is the only thing keeping the sweep off a drill in flight.
    expect(dropOrphanedRestoreDatabases).toHaveBeenCalledWith(
      UNREACHABLE,
      expect.objectContaining({ minimumAgeMs: 6 * 60 * 60 * 1000 }),
    )
    expect(scheduled.teardown.orphans?.remaining).toBe(1)

    // The NIGHTLY sweep's caps, pinned. This is the pass that does the routine
    // reclamation, and halving it silently would let litter accumulate faster
    // than it is cleared.
    //
    // Absence is the assertion, because defaulting is the decision: a per-
    // cadence sweep needs neither the boot sweep's halved drop cap nor any
    // reduction of the failure cap.
    const [, passed] = vi.mocked(dropOrphanedRestoreDatabases).mock.calls[0]!
    expect(passed.maxDrops).toBeUndefined()
    expect(passed.maxFailures).toBeUndefined()
  })

  it('summarises the failure COUNT and the stop reason, not the failure sample', async () => {
    // `drillSummary` must read `failedCount`, not `failed.length` — a sample
    // reported as a count. Unreachable with the defaults because
    // `FAILURE_SAMPLE_LIMIT (25) > DEFAULT_SWEEP_MAX_FAILURES (20)`, which
    // `backupRestore.test.ts` asserts; this pins the consumer so the two cover
    // each other. (A log line, not a database row: `recordDrillRun` persists
    // `signed.report`, which carries no orphan fields.)
    //
    // The fixture is deliberately TRUNCATED — 40 failures, 25 named — which is
    // what a caller raising `maxFailures` produces, and is the only state in
    // which the two readings differ.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())
    dropOrphanedRestoreDatabases.mockResolvedValue({
      candidates: 41,
      dropped: [],
      failed: Array.from({ length: 25 }, (_, i) => `maplespire_restore_${i}: must be owner`),
      failedCount: 40,
      remaining: 1,
      completed: true,
      stoppedBy: 'failures',
    })

    const outcome = await runBackupDrill(drillOptions({ retention: {} }))
    const summary = JSON.parse(drillSummary(outcome)) as Record<string, unknown>

    expect(summary.orphansFailed).toBe(40)
    // …and the stop reason reaches it at all. `completed: true` covers five
    // opposite outcomes, and `failures` is the one that means a cluster-level
    // fault rather than a healthy converging pass.
    expect(summary.orphanSweepStoppedBy).toBe('failures')
    expect(summary.orphanSweepCompleted).toBe(true)
  })

  it('prints what was observed, not what was intended', async () => {
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget({ drop: blockedForever }))

    const summary = JSON.parse(drillSummary(await runBackupDrill(drillOptions())))

    expect(summary.restoreDatabase).toBe('maplespire_restore_probe_0001')
    expect(summary.restoreDatabaseDropped).toBe(false)
    expect(summary.teardownError).toContain('still running after 60 ms')
  })
})

describe('backup drill bookkeeping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createDatabaseBackup.mockResolvedValue({
      applicationRevision: 'abc123',
      source: { database: 'source', postgresVersion: '16.14', transactionTimestamp: '2026-08-20 00:00:00+00' },
      dump: { bytes: 42, sha256: 'dump-hash' },
      retiredWorkspaces: [],
      // A real `createDatabaseBackup` always writes these three, and the
      // verdict depends on them; the `as never` cast means the compiler will
      // not flag a missing one.
      documentProbes: [],
      documentProbeFailures: [],
      probeCoverage: { cap: 64, candidatesConsidered: 1, selectionExhaustive: true, probed: 1, failed: 0 },
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
    } as never)
    restoreAndVerifyDatabase.mockResolvedValue({ outcome: 'passed' } as never)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('a drill that cold-load tested NOTHING is not a pass', async () => {
    // `--document-probes 0` is accepted by scripts/backup-database.ts and
    // produces `documentProbes: []` and an empty comparison loop. Probing
    // nothing while the database holds loadable documents must be a finding,
    // not a clean report.
    createDatabaseBackup.mockResolvedValue({
      applicationRevision: 'abc123',
      source: { database: 'source', postgresVersion: '16.14', transactionTimestamp: '2026-08-20 00:00:00+00' },
      dump: { bytes: 42, sha256: 'dump-hash' },
      retiredWorkspaces: [],
      documentProbes: [],
      documentProbeFailures: [],
      probeCoverage: { cap: 0, candidatesConsidered: 0, selectionExhaustive: true, probed: 0, failed: 0 },
      documentCensus: {
        status: 'complete',
        mapped: 5,
        withChunks: 5,
        syncStateOnly: 0,
        noRows: 0,
        otherChunkKinds: {},
        unretiredViolations: 0,
        violationSample: [],
        violationsTruncated: 0,
      },
    } as never)
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    const outcome = await runBackupDrill(drillOptions())

    expect(outcome.signed.report.outcome).toBe('failed')
    expect(outcome.signed.report.error).toContain('no document was cold-load tested')
  })

  it('reports bundle.written FALSE when the copy itself never happened', async () => {
    // The other half of `bundle.written`, without which the field could be
    // hardcoded true and every test above would still pass: `directory`
    // populated, `dumpBytes` 0, and only this field saying no backup exists.
    createDatabaseBackup.mockRejectedValue(new Error('pg_dump exited 1'))
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    const outcome = await runBackupDrill(drillOptions())

    expect(outcome.signed.report.bundle.written).toBe(false)
    expect(outcome.signed.report.outcome).toBe('failed')
    // A source-health verdict cannot be drawn from a backup that never ran, and
    // must not read as clean.
    expect(outcome.signed.report.sourceIntegrity?.verdict).toBe('incomplete')
  })

  it('fails the drill on a source-integrity finding — and still keeps the bundle', async () => {
    // The source-integrity contract, in one test, and CONJUNCTIVE on purpose.
    //
    // Fail-OPEN on the copy: `createDatabaseBackup` resolves, so a bundle
    // exists. A source finding that threw ahead of `pgTools.dump` would leave
    // `bundle.written` false — a few bad mapping rows costing the whole
    // database its backup.
    //
    // Fail-CLOSED on the verdict: narrowing the probe predicate alone would make
    // this drill report `passed` with 2 unopenable documents still in the
    // database. That is the silent failure, and it is the half a green test
    // suite is least likely to notice.
    createDatabaseBackup.mockResolvedValue({
      applicationRevision: 'abc123',
      source: { database: 'source', postgresVersion: '16.14', transactionTimestamp: '2026-08-20 00:00:00+00' },
      dump: { bytes: 42, sha256: 'dump-hash' },
      retiredWorkspaces: [],
      documentProbes: [],
      documentProbeFailures: [],
      probeCoverage: { cap: 64, candidatesConsidered: 1, selectionExhaustive: true, probed: 1, failed: 0 },
      documentCensus: {
        status: 'complete',
        mapped: 3,
        withChunks: 1,
        syncStateOnly: 1,
        noRows: 1,
        otherChunkKinds: {},
        unretiredViolations: 2,
        violationSample: ['docSyncStateOnly', 'docNoRows'],
        violationsTruncated: 0,
      },
    } as never)
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    const outcome = await runBackupDrill(drillOptions())

    // No exception was thrown: the copy path ran to completion.
    expect(outcome.failure).toBeNull()
    expect(outcome.signed.report.bundle.written).toBe(true)
    expect(outcome.signed.report.bundle.dumpBytes).toBe(42)
    // And the drill still refuses to call it a pass, by name and by count.
    expect(outcome.signed.report.outcome).toBe('failed')
    expect(outcome.signed.report.sourceIntegrity?.verdict).toBe('violations')
    expect(outcome.signed.report.error).toContain('2 mapped document(s)')
    expect(outcome.signed.report.error).toContain('docSyncStateOnly')
  })

  it('an incomplete census is not a pass — "we could not check" is not "it checks out"', async () => {
    createDatabaseBackup.mockResolvedValue({
      applicationRevision: 'abc123',
      source: { database: 'source', postgresVersion: '16.14', transactionTimestamp: '2026-08-20 00:00:00+00' },
      dump: { bytes: 42, sha256: 'dump-hash' },
      retiredWorkspaces: [],
      documentProbes: [],
      documentProbeFailures: [],
      probeCoverage: { cap: 64, candidatesConsidered: 0, selectionExhaustive: true, probed: 0, failed: 0 },
      documentCensus: {
        status: 'incomplete',
        mapped: null,
        withChunks: null,
        syncStateOnly: null,
        noRows: null,
        otherChunkKinds: { 'some-future-chunk': 3 },
        unretiredViolations: null,
        violationSample: [],
        violationsTruncated: 0,
      },
    } as never)
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    const outcome = await runBackupDrill(drillOptions())

    expect(outcome.signed.report.outcome).toBe('failed')
    expect(outcome.signed.report.sourceIntegrity?.verdict).toBe('incomplete')
    expect(outcome.signed.report.bundle.written).toBe(true)
  })

  it('keeps teardown OUT of the recovery time objective', async () => {
    // `rtoMs` is signed, stored and exported as a gauge; it is the number a DR
    // review quotes. A real recovery does not drop a throwaway database, so a
    // teardown that blocks for the full ceiling must not inflate it.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget({ drop: blockedForever }))

    const CEILING_MS = 250
    const outcome = await runBackupDrill(drillOptions({ teardownStepTimeoutMs: CEILING_MS }))

    // NOT `>= CEILING_MS`: `teardownMs` is a `Date.now()` DELTA, and a
    // `setTimeout(250)` is permitted to fire fractionally early against that
    // clock (e.g. 249 ms) — Windows' clock granularity does so routinely.
    //
    // The tolerance does not weaken what this anchors. Its job is to prove the
    // teardown BLOCKED for the ceiling rather than returning immediately, and
    // the gap between "blocked ~250 ms" and "returned at once" is three orders
    // of magnitude — 10 ms of slack cannot swallow it. The real proposition is
    // the line below, and this one exists so that line cannot pass vacuously.
    expect(outcome.teardown.teardownMs).toBeGreaterThanOrEqual(CEILING_MS - 10)
    expect(outcome.signed.report.rtoMs).toBeLessThan(outcome.teardown.teardownMs)
  })

  it('does not turn a slow teardown into a failed drill', async () => {
    // The restore was verified; only the cleanup was slow. Marking the drill
    // failed would flip `outcome` in the signed report and page somebody at
    // 03:00 for a throwaway database that PostgreSQL finished dropping anyway.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget({ drop: blockedForever }))

    const outcome = await runBackupDrill(drillOptions())

    expect(outcome.failure).toBeNull()
    expect(outcome.signed.report.outcome).toBe('passed')
    expect(outcome.signed.report.error).toBeNull()
    expect(outcome.teardown.failure).toContain('still running')
  })

  it('ships a ceiling larger than the worst drop this repo has measured', () => {
    // 73 s is a `DROP DATABASE ... WITH (FORCE)` measured under a full
    // `vitest run`. Every other test overrides the ceiling,
    // so without this the SHIPPED default could be anything, including 0 — and a
    // ceiling that fires on drops which are merely slow trains whoever reads the
    // log to ignore it.
    expect(TEARDOWN_STEP_TIMEOUT_MS).toBeGreaterThan(73_000)
  })

  it('does not let a caller overrule the witness', () => {
    // A caller passing `restoreDatabaseDropped: !argv.includes('--keep-target')`
    // must be inert, not merely discouraged.
    const summary = JSON.parse(drillSummary(
      { teardown: { restoreDatabase: 'db', restoreDatabaseDropped: false, restoreDropMs: null, teardownMs: 1, orphans: null, failure: null },
        signed: { report: { drillId: 'drill_x', outcome: 'passed', error: null, retiredWorkspaces: [], source: { snapshotAt: '' }, bundle: { directory: '' }, rtoMs: 1 }, reportSha256: 'x', signature: null },
        verification: null, coldApi: null, history: null, bundles: null, failure: null } as never,
      { restoreDatabaseDropped: true },
    ))

    expect(summary.restoreDatabaseDropped).toBe(false)
  })

  it('renames a retained database out of the namespace the sweep claims', async () => {
    // Retaining it under `maplespire_restore_` would let the nightly scheduler
    // delete, six hours later, the exact database an operator kept in order to
    // look at it.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    const outcome = await runBackupDrill(drillOptions({ keepRestoreDatabase: true }))

    expect(outcome.teardown.restoreDatabase).toBe('maplespire_kept_probe_0001')
    expect(restoreDatabaseAgeMs(outcome.teardown.restoreDatabase!, Date.now())).toBeNull()
    // The database is certainly still there — it was kept on purpose — so it
    // must not be reported as dropped.
    expect(outcome.teardown.restoreDatabaseDropped).toBe(false)
    expect(outcome.teardown.restoreDropMs).toBeNull()
  })

  it('keeps a partial sweep result when the sweep is abandoned mid-flight', async () => {
    // The caller is what gets abandoned, so the sweep must have handed over its
    // progress BEFORE it blocked — otherwise reclaimed databases are reported
    // as `null` and read as "there was nothing to do".
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())
    dropOrphanedRestoreDatabases.mockImplementation(async (_url, options) => {
      options.onProgress?.({
        candidates: 3, dropped: ['maplespire_restore_a'], failed: [], failedCount: 0,
        remaining: 2, completed: false, stoppedBy: null,
      })
      return blockedForever() as never
    })

    const outcome = await runBackupDrill(drillOptions({ retention: {} }))

    expect(outcome.teardown.orphans?.dropped).toEqual(['maplespire_restore_a'])
    expect(outcome.teardown.orphans?.completed).toBe(false)
    expect(outcome.teardown.orphans?.remaining).toBe(2)
  })
})

/**
 * `latest-report.json` is the operator's most readable account of recent runs.
 * `writeFile` truncates before it writes, so replacing it in place leaves a
 * window in which it is zero bytes — not a bad report, an unparseable one.
 *
 * The discriminator here is the original INODE (pinned by a hard link),
 * because the alternative needs an observer inside a window microseconds wide.
 */
describe('the drill report is replaced, never truncated in place', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'drill-report-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('swaps the file rather than overwriting it, and leaves no staging sibling', async () => {
    // The witness is a HARD LINK. Comparing `ino` or `birthtimeMs` is unsound
    // on NTFS: it reuses MFT record numbers, and tunnelling restores the
    // creation time of a same-named file recreated within 15 s.
    //
    // A link needs no uniqueness assumption at all. It pins the ORIGINAL inode
    // by a second name, and asks about CONTENT: an in-place write mutates that
    // inode so the link sees the new bytes; a rename swaps the directory entry
    // and leaves the old inode alone, so the link still sees the old ones.
    const target = join(root, 'latest-report.json')
    const witness = join(root, 'witness')
    await writeFile(target, '{"outcome":"passed"}\n', 'utf8')
    await link(target, witness)

    await writeReportAtomically(target, '{"outcome":"failed"}\n')

    expect(await readFile(target, 'utf8')).toBe('{"outcome":"failed"}\n')
    // The whole assertion: the bytes the old directory entry pointed at were
    // never touched. An in-place write reads '{"outcome":"failed"}' here.
    expect(await readFile(witness, 'utf8')).toBe('{"outcome":"passed"}\n')
    // Conjunctive on purpose: a rename that happened AND nothing left behind.
    expect((await readdir(root)).sort()).toEqual(['latest-report.json', 'witness'])
  })

  it('reclaims a staging file no writer can still own, and spares a fresh one', async () => {
    // A SIGKILL between the write and the rename raises no rejection, so the
    // `catch` never runs — and
    // the orphan is invisible to every other sweep in the tree, because
    // `pruneBackupBundles` filters `isDirectory` and a staging file is a FILE.
    const target = join(root, 'latest-report.json')
    const stale = join(root, 'latest-report.json.tmp-999-deadbeefcafe')
    const fresh = join(root, 'latest-report.json.tmp-1000-abcdefabcdef')
    // A file belonging to a DIFFERENT report must not be touched.
    const other = join(root, 'other-report.json.tmp-999-deadbeefcafe')
    for (const path of [stale, fresh, other]) await writeFile(path, 'x', 'utf8')
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(stale, hourAgo, hourAgo)
    await utimes(other, hourAgo, hourAgo)

    const removed = await sweepStrayReportStaging(target)

    expect(removed).toEqual(['latest-report.json.tmp-999-deadbeefcafe'])
    expect((await readdir(root)).sort())
      .toEqual(['latest-report.json.tmp-1000-abcdefabcdef', 'other-report.json.tmp-999-deadbeefcafe'])
  })

  it('reclaims an old orphan as a side effect of the next successful write', async () => {
    // The sweep has to be WIRED, not merely written: a stale staging file left
    // by a killed process is invisible to every other sweep in the tree, so if
    // nothing calls this one the leak is permanent.
    // Conjunctive on purpose — the new report landed AND the orphan is gone AND
    // a fresh sibling survived, because an over-eager sweep would cost a
    // concurrent writer its report, which is worse than the leak.
    const target = join(root, 'latest-report.json')
    const orphan = join(root, 'latest-report.json.tmp-4242-c0ffeec0ffee')
    const fresh = join(root, 'latest-report.json.tmp-4243-c0ffeec0ffee')
    await writeFile(orphan, 'abandoned', 'utf8')
    await writeFile(fresh, 'in flight', 'utf8')
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    await utimes(orphan, longAgo, longAgo)

    await writeReportAtomically(target, '{"a":1}\n')

    expect(await readFile(target, 'utf8')).toBe('{"a":1}\n')
    expect((await readdir(root)).sort())
      .toEqual(['latest-report.json', 'latest-report.json.tmp-4243-c0ffeec0ffee'])
  })

  it('never removes a DIRECTORY that happens to sit under the staging prefix', async () => {
    // This is an unlinking sweep in a root an operator configures, and the
    // whole tree's convention is that anything not identifiably ours is left
    // alone. A directory is not a staging file however it is named.
    const target = join(root, 'latest-report.json')
    const decoy = join(root, 'latest-report.json.tmp-1-aaaaaaaaaaaa')
    await mkdir(decoy, { recursive: true })
    await writeFile(join(decoy, 'something-precious'), 'x', 'utf8')
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    await utimes(decoy, longAgo, longAgo)

    const removed = await sweepStrayReportStaging(target)

    expect(removed).toEqual([])
    expect(await readdir(decoy)).toEqual(['something-precious'])
  })

  it('removes the staging file and rethrows when the replacement cannot land', async () => {
    // A staging file nobody deletes would accumulate once per failed run
    // forever.
    const target = join(root, 'occupied')
    await mkdir(join(target, 'child'), { recursive: true })

    await expect(writeReportAtomically(target, 'x')).rejects.toThrow()

    expect((await readdir(root)).sort()).toEqual(['occupied'])
    expect(await readdir(target)).toEqual(['child'])
  })

  it('does not let a failed report write take the drill down', async () => {
    // The report is written for a FAILED drill too — "no report" and "no drill
    // ran" are indistinguishable — so this path must warn and continue.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    const outcome = await runBackupDrill(drillOptions({ reportPath: join(root, 'nope', 'r.json') }))

    expect(outcome.signed.report.drillId).toMatch(/^drill_/)
    expect(warn.mock.calls.flat().join(' ')).toContain('could not write the report file')
    warn.mockRestore()
  })

  it('gives the bundle sweep an age gate the one-shot CLI never gets', async () => {
    // The runner must pass the caller's gate through verbatim. Omitted means
    // NEVER, because a caller that does not know how long a drill may run must
    // not be able to delete a directory a live pg_dump is filling.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    await runBackupDrill(drillOptions({
      retention: { bundleRoot: root, partialMaxAgeMs: 21_600_000 },
    }))
    expect(pruneBackupBundles).toHaveBeenLastCalledWith(root, expect.objectContaining({
      partialMaxAgeMs: 21_600_000,
    }))

    await runBackupDrill(drillOptions({ retention: { bundleRoot: root } }))
    expect(pruneBackupBundles).toHaveBeenLastCalledWith(root, expect.objectContaining({
      partialMaxAgeMs: undefined,
    }))
  })

  it('prints the partial figures beside the budget, and never folded into it', async () => {
    // Without this the leak is invisible from the one line operations reads.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())
    pruneBackupBundles.mockResolvedValueOnce({
      budgetBytes: 100, bytesBefore: 40, bytesAfter: 40, bundlesBefore: 1,
      deleted: ['old'], skipped: [], deletedPartials: ['a', 'b'],
      partials: [
        {
          name: 'c', bytes: 4_000, ageMs: 10, nameAgeMs: 10, mtimeAgeMs: 20,
          owner: null, ownerLiveness: 'unknown' as const,
        },
        {
          name: 'held', bytes: 1_000, ageMs: 99_999, nameAgeMs: 99_999, mtimeAgeMs: 99_999,
          owner: { host: 'box-a', pid: 4242, startedAt: 5, kind: 'drill' },
          ownerLiveness: 'live' as const,
        },
      ],
      heldPartials: ['held'],
      partialBytes: 4_000, deletedPartialBytes: 9_000, overBudget: true,
    })

    const summary = JSON.parse(drillSummary(
      await runBackupDrill(drillOptions({ retention: { bundleRoot: root } })),
    ))

    expect(summary.bundleBytes).toBe(40)
    expect(summary.bundlesDeleted).toBe(1)
    expect(summary.partialBundleBytes).toBe(4_000)
    // TWO survivors, one of them held by a live claim — and `partialBundles`
    // cannot tell them apart, which is exactly why `partialBundlesHeld` exists
    // below.
    expect(summary.partialBundles).toBe(2)
    // Separate from bundlesDeleted: one is the byte budget doing its job, the
    // other is a run that ended without cleaning up after itself.
    expect(summary.partialBundlesDeleted).toBe(2)
    // And separate again from partialBundleBytes, which counts SURVIVORS: a
    // night that freed 9 kB and a night that freed nothing print the same
    // figure there, and only this one tells them apart.
    expect(summary.partialBundleBytesReclaimed).toBe(9_000)
    // The held count and the claim behind it. The retention code keeps such a
    // directory indefinitely on the grounds that an operator has the pid and
    // host to check; these fields are what make that true. `partialBundles`
    // alone cannot say it: a young in-flight partial and one held forever by a
    // recycled pid both print a count.
    expect(summary.partialBundlesHeld).toBe(1)
    expect(summary.partialBundleOwners).toEqual([
      { name: 'held', liveness: 'live', host: 'box-a', pid: 4242, kind: 'drill', startedAt: 5 },
    ])
  })

  it('omits a partial nothing is known about, rather than printing a row of nulls', async () => {
    // The claim-less partial above is filtered out of `partialBundleOwners`: a
    // row of nulls tells an operator nothing and buries the one row that does.
    // Asserted separately from the row above, because a filter that dropped
    // EVERYTHING would satisfy this and a filter that dropped NOTHING would
    // satisfy neither.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())
    pruneBackupBundles.mockResolvedValueOnce({
      budgetBytes: 100, bytesBefore: 40, bytesAfter: 40, bundlesBefore: 1,
      deleted: [], skipped: [], deletedPartials: [],
      partials: [{
        name: 'c', bytes: 4_000, ageMs: 10, nameAgeMs: 10, mtimeAgeMs: 20,
        owner: null, ownerLiveness: 'unknown' as const,
      }],
      heldPartials: [], partialBytes: 4_000, deletedPartialBytes: 0, overBudget: false,
    })

    const summary = JSON.parse(drillSummary(
      await runBackupDrill(drillOptions({ retention: { bundleRoot: root } })),
    ))

    expect(summary.partialBundles).toBe(1)
    expect(summary.partialBundlesHeld).toBe(0)
    expect(summary.partialBundleOwners).toEqual([])
  })

  it('declares itself as the DRILL when claiming its partial directory', async () => {
    // The call site, not the plumbing. `backupRestore.integration.test.ts`
    // passes `ownerKind: 'drill'` itself, so it pins `createDatabaseBackup` and
    // says nothing about whether the drill asks for it.
    //
    // It matters because `'cli'` is the DEFAULT, and the default is deliberately
    // the party with no advisory lock: a drill silently reporting itself as a
    // one-shot CLI sends an operator looking for a human who never ran anything.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    await runBackupDrill(drillOptions())

    expect(createDatabaseBackup).toHaveBeenCalledWith(
      expect.objectContaining({ ownerKind: 'drill' }),
    )
  })

  it('prints NULL, never zero, for a sweep that did not run', async () => {
    // Nulls, never zeros, when a count could not be taken. Zero here reads as
    // "no leftovers on the volume", and this line is the one operations sees.
    createTemporaryRestoreDatabase.mockResolvedValue(restoreTarget())

    const summary = JSON.parse(drillSummary(await runBackupDrill(drillOptions({ retention: false }))))

    expect(summary.partialBundleBytes).toBeNull()
    expect(summary.partialBundles).toBeNull()
    expect(summary.partialBundlesDeleted).toBeNull()
    expect(summary.partialBundleBytesReclaimed).toBeNull()
    expect(summary.bundleBytes).toBeNull()
  })
})
