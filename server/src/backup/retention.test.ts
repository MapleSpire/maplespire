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

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bundleBudgetBytes,
  drillHistoryBudgetBytes,
  bundleStartedAt,
  parseByteBudget,
  pruneBackupBundles,
  pruneDrillHistory,
} from './retention.js'
import { bootSweepMinimumAgeMs, partialSweepMinimumAgeMs } from './drillRunner.js'
import { bundleName, maxDrillHoldMs } from './drillSchedule.js'
import { bundleOwnerLiveness } from './bundleOwner.js'
import { ensureBackupSchema } from './schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe('byte budgets', () => {
  it('accepts the units an operator writes a disk budget in', () => {
    expect(parseByteBudget('1048576', 1)).toBe(1_048_576)
    expect(parseByteBudget('256MB', 1)).toBe(256 * 1024 ** 2)
    expect(parseByteBudget('2 gb', 1)).toBe(2 * 1024 ** 3)
    expect(parseByteBudget('1.5GB', 1)).toBe(Math.floor(1.5 * 1024 ** 3))
  })

  it('falls back rather than to zero on anything unparseable', () => {
    // A typo must not empty the history.
    for (const value of ['', '   ', 'lots', '0', '-5MB', '10 petabytes', '1e9']) {
      expect(parseByteBudget(value, 4_242)).toBe(4_242)
    }
  })

  it('treats an absurdly small budget as a typo, not as an instruction', () => {
    // `BACKUP_DRILL_HISTORY_MAX_BYTES=1024` reads like a value somebody meant in
    // some other unit. Honouring it literally would prune to the protected rows
    // on every run, which looks exactly like working retention until you need
    // the history.
    expect(parseByteBudget('1024', 7_777)).toBe(7_777)
    expect(parseByteBudget('64KB', 7_777)).toBe(64 * 1024)
  })

  it('reads its own environment variables', () => {
    expect(drillHistoryBudgetBytes({ BACKUP_DRILL_HISTORY_MAX_BYTES: '8MB' })).toBe(8 * 1024 ** 2)
    expect(bundleBudgetBytes({ BACKUP_BUNDLE_MAX_BYTES: '5GB' })).toBe(5 * 1024 ** 3)
    expect(drillHistoryBudgetBytes({})).toBeGreaterThan(0)
    expect(bundleBudgetBytes({})).toBeGreaterThan(drillHistoryBudgetBytes({}))
  })
})

describe('bundle autoclean', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'maplespire-bundles-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const bundle = async (name: string, bytes: number) => {
    await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, name, 'database.dump'), Buffer.alloc(bytes, 1))
    // The manifest is what marks a directory as ours; the sweep deletes
    // recursively and must never act on anything else.
    await writeFile(join(root, name, 'manifest.json'), '{}')
  }

  it('keeps the newest bundles that fit the budget and deletes the rest', async () => {
    await bundle('2026-08-01T00-00-00Z', 1_000)
    await bundle('2026-08-02T00-00-00Z', 1_000)
    await bundle('2026-08-03T00-00-00Z', 1_000)
    const result = await pruneBackupBundles(root, { budgetBytes: 2_500 })
    expect(result.deleted).toEqual(['2026-08-01T00-00-00Z'])
    expect((await readdir(root)).sort()).toEqual(['2026-08-02T00-00-00Z', '2026-08-03T00-00-00Z'])
  })

  it('never deletes the newest bundle, even when it alone blows the budget', async () => {
    // A sweep that leaves an installation with nothing to restore from has
    // inverted its own purpose.
    await bundle('2026-08-01T00-00-00Z', 1_000)
    await bundle('2026-08-02T00-00-00Z', 9_000)
    const result = await pruneBackupBundles(root, { budgetBytes: 500 })
    expect(result.deleted).toEqual(['2026-08-01T00-00-00Z'])
    expect(result.overBudget).toBe(true)
    expect(await readdir(root)).toEqual(['2026-08-02T00-00-00Z'])
  })

  it('orders by name, not mtime — a restore rehearsal must not reorder history', async () => {
    await bundle('2026-08-01T00-00-00Z', 1_000)
    await bundle('2026-08-09T00-00-00Z', 1_000)
    // Touch the OLD bundle last, as reading or copying it would.
    await writeFile(join(root, '2026-08-01T00-00-00Z', 'database.dump'), Buffer.alloc(1_000, 2))
    const result = await pruneBackupBundles(root, { budgetBytes: 1_500 })
    expect(result.deleted).toEqual(['2026-08-01T00-00-00Z'])
  })

  it('counts the whole bundle, including the icon archive', async () => {
    await bundle('2026-08-01T00-00-00Z', 1_000)
    await mkdir(join(root, '2026-08-01T00-00-00Z', 'assets'), { recursive: true })
    await writeFile(join(root, '2026-08-01T00-00-00Z', 'assets', 'icon.svg'), Buffer.alloc(500, 3))
    const result = await pruneBackupBundles(root, { budgetBytes: 10_000 })
    // 1000 dump + 500 icon + 2 manifest: the whole directory, recursively.
    expect(result.bytesBefore).toBe(1_502)
  })

  it('refuses to delete a directory that is not a bundle', async () => {
    // An operator who points the bundle root at the wrong directory (e.g. the
    // CLI's BACKUP_DIRECTORY, which is ONE bundle) must not lose anything to
    // this recursive delete.
    await bundle('2026-08-03T00-00-00Z', 1_000)
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'assets', 'icon.svg'), Buffer.alloc(9_000, 4))
    await mkdir(join(root, 'pg_wal'), { recursive: true })
    await writeFile(join(root, 'pg_wal', 'segment'), Buffer.alloc(9_000, 5))

    const result = await pruneBackupBundles(root, { budgetBytes: 10 })
    expect(result.deleted).toEqual([])
    expect(result.skipped.sort()).toEqual(['assets', 'pg_wal'])
    expect((await readdir(root)).sort()).toEqual(['2026-08-03T00-00-00Z', 'assets', 'pg_wal'])
  })

  it('is a no-op on a directory that does not exist yet', async () => {
    const result = await pruneBackupBundles(join(root, 'not-created'), { budgetBytes: 10 })
    // Every field, with `toEqual`: a subset match would let a new field carry
    // a wrong value unnoticed.
    expect(result).toEqual({
      budgetBytes: 10, bytesBefore: 0, bytesAfter: 0, bundlesBefore: 0,
      deleted: [], skipped: [], partials: [], partialBytes: 0,
      deletedPartials: [], deletedPartialBytes: 0, heldPartials: [], overBudget: false,
    })
  })

  /**
   * `createDatabaseBackup` writes into `<name>.partial-<pid>-<hex>` and renames
   * only after the manifest lands, so the marker of a finished bundle is the
   * RENAME, not the presence of `manifest.json`.
   */
  describe('unfinished bundles', () => {
    const AT = Date.parse('2026-08-01T00:00:00Z')
    const HOUR = 3_600_000

    /**
     * `writtenAt` is not decoration. The sweep consults TWO clocks — the
     * timestamp in the name and the newest mtime inside — and deletes only when
     * both say the directory is dead. A fixture that leaves mtime at "now" is
     * describing a live run, so a test that expected a deletion without setting
     * it would have been asserting the unsafe behaviour.
     */
    const partial = async (
      name: string, bytes: number, manifest: boolean, writtenAt?: number,
    ) => {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'database.dump'), Buffer.alloc(bytes, 1))
      if (manifest) await writeFile(join(root, name, 'manifest.json'), '{}')
      if (writtenAt === undefined) return
      for (const file of manifest ? ['database.dump', 'manifest.json'] : ['database.dump']) {
        await utimes(join(root, name, file), new Date(writtenAt), new Date(writtenAt))
      }
    }

    it('does not let a crashed partial take the newest slot and delete the real bundle', async () => {
      // SIGKILL between the manifest write and the rename leaves a partial
      // that HAS a manifest. `Z.partial-…` sorts above `Z` descending, so a
      // manifest-based classifier would give it the keepNewest slot and make
      // the finished, restorable bundle a deletion candidate.
      await bundle('2026-08-01T00-00-00Z', 8_000)
      await partial('2026-08-01T00-00-00Z.partial-1234-abcdef', 8_000, true)

      const result = await pruneBackupBundles(root, { budgetBytes: 1_024, keepNewest: 1 })

      expect(result.deleted).toEqual([])
      expect(result.deletedPartials).toEqual([])
      expect(result.partials.map((entry) => entry.name))
        .toEqual(['2026-08-01T00-00-00Z.partial-1234-abcdef'])
      // Conjunctive on purpose: the finding is counted AND the restorable
      // bundle is still there. Either half alone passes on a broken build.
      expect((await readdir(root)).sort())
        .toEqual(['2026-08-01T00-00-00Z', '2026-08-01T00-00-00Z.partial-1234-abcdef'])
    })

    it('reports partial bytes beside the budget, never inside it', async () => {
      // Folding them into bytesBefore would make the sweep delete finished
      // bundles to make room for abandoned partials.
      await bundle('2026-08-02T00-00-00Z', 1_000)
      await partial('2026-08-03T00-00-00Z.partial-77-beefed', 4_000, false)

      const result = await pruneBackupBundles(root, { budgetBytes: 10_000 })

      expect(result.bytesBefore).toBe(1_002)   // the dump plus the 2-byte manifest
      expect(result.partialBytes).toBe(4_000)
      expect(result.bundlesBefore).toBe(1)
      expect(result.deleted).toEqual([])
    })

    it('is never confused with a directory that is not ours', async () => {
      // `skipped` means "this sweep is pointed somewhere unexpected" and fires
      // an operator's attention; a drill that is simply running must not look
      // like that. Two lists, two meanings.
      await partial('2026-08-02T00-00-00Z.partial-5-aaaaaa', 100, false)
      await mkdir(join(root, 'pg_wal'), { recursive: true })

      const result = await pruneBackupBundles(root, { budgetBytes: 10 })

      expect(result.skipped).toEqual(['pg_wal'])
      expect(result.partials.map((entry) => entry.name)).toEqual(['2026-08-02T00-00-00Z.partial-5-aaaaaa'])
    })

    it('sweeps a partial no live run could still own, and counts what it freed', async () => {
      // Nothing else ever removes one: createDatabaseBackup cleans
      // its own from a `catch`, and the abandonment path ENDS THE PROCESS
      // instead of throwing. So without this, every abandoned drill leaves a
      // whole database dump behind for good.
      await partial('2026-08-01T00-00-00Z.partial-1-aaaaaa', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 7 * HOUR,
      })

      expect(result.deletedPartials).toEqual(['2026-08-01T00-00-00Z.partial-1-aaaaaa'])
      expect(result.deleted).toEqual([])
      // Survivors and reclaimed are different facts: without the second, a
      // night that freed 40 GB and a night that freed nothing both print zero.
      expect(result.partialBytes).toBe(0)
      expect(result.deletedPartialBytes).toBe(4_000)
      expect(await readdir(root)).toEqual([])
    })

    /**
     * The owner-liveness veto.
     *
     * Both age clocks are PROXIES for "is someone still writing this". A dump
     * BLOCKED on a lock advances neither while being entirely alive, and the
     * parties that race for this directory hold no advisory lock at all: the
     * one-shot CLI, the boot sweep, and an abandoned run still dumping after
     * its key went back.
     *
     * Liveness is injected for the same reason `now` is: `unknown` is a claim
     * from ANOTHER HOST, which has no local process to spawn, and the other two
     * would need a real child process that the test then has to reap.
     */
    const held = (name: string) => ({
      name, bytes: 4_000,
      owner: { host: 'box-a', pid: 4242, startedAt: AT, kind: 'drill' },
    })

    it('vetoes through the REAL probe, with no seam injected', async () => {
      // The wiring row. Every other row injects `ownerLiveness`, which proves
      // the branching and nothing about whether production reaches the real
      // probe. So: a real claim naming THIS process, a directory old by both
      // clocks, and `pruneBackupBundles` called with no seam at all.
      const name = `2026-08-01T00-00-00Z.partial-${process.pid}-aaaaaa`
      await partial(name, 4_000, false, AT)
      await writeFile(
        join(root, name, '.owner.json'),
        // `startedAt: Date.now()`, NOT the fixture's `AT`. The claim carries our
        // own pid, and the next row asserts that such a claim is DEAD when it
        // predates our start — so an old timestamp here would test that rule
        // instead of the probe.
        JSON.stringify({ host: hostname(), pid: process.pid, startedAt: Date.now(), kind: 'drill' }),
        'utf8',
      )
      // The claim file is a file, so it carries an mtime of NOW and would make
      // the directory young by the second clock. Age it with the rest, or this
      // row would pass on the age gate and prove nothing about the veto.
      await utimes(join(root, name, '.owner.json'), new Date(AT), new Date(AT))

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 7 * HOUR,
      })

      expect(result.heldPartials).toEqual([name])
      expect(result.deletedPartials).toEqual([])
      expect(result.partials[0]?.ownerLiveness).toBe('live')
      expect(result.partials[0]?.owner).toMatchObject({ host: hostname(), pid: process.pid })
    })

    it('a claim naming OUR pid but predating OUR start is dead, not live', async () => {
      // In the drill container node is PID 1 (`exec "$@"` in the entrypoint);
      // abandonment calls `process.exit(1)` and `restart: always` restarts the
      // same container with the same hostname and node as pid 1 again. Without
      // this rule the sweeper probes pid 1 — itself — reads `live`, and vetoes
      // the delete of the abandoned dump forever.
      //
      // `startedAt` decides it without /proc: a claim carrying our own pid that
      // predates our own start was written by a process that is gone.
      const name = `2026-08-01T00-00-00Z.partial-${process.pid}-bbbbbb`
      await partial(name, 4_000, false, AT)
      await writeFile(
        join(root, name, '.owner.json'),
        // AT is 2026; this process started today. The claim predates us.
        JSON.stringify({ host: hostname(), pid: process.pid, startedAt: AT, kind: 'drill' }),
        'utf8',
      )
      await utimes(join(root, name, '.owner.json'), new Date(AT), new Date(AT))

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 7 * HOUR,
        // The real probe would say `live` here — it is our own pid — so the
        // discrimination must come from `startedAt` and not from the probe.
        ownerLiveness: (owner) => bundleOwnerLiveness(owner, hostname(), () => {}),
      })

      // Deleted, so it is NOT in `partials` — the survivor list. Asserting the
      // deletion is the point; asserting `partials[0].ownerLiveness` here would
      // read `undefined` and pass against a checker that kept it.
      expect(result.deletedPartials).toEqual([name])
      expect(result.heldPartials).toEqual([])
      expect(result.partials).toEqual([])
      expect(await readdir(root)).toEqual([])
    })

    it('a LIVE owner vetoes a delete both clocks called for', async () => {
      await partial('2026-08-01T00-00-00Z.partial-4242-aaaaaa', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 7 * HOUR,          // seven hours old by BOTH clocks
        ownerLiveness: () => 'live',
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.heldPartials).toEqual(['2026-08-01T00-00-00Z.partial-4242-aaaaaa'])
      expect(await readdir(root)).toEqual(['2026-08-01T00-00-00Z.partial-4242-aaaaaa'])
      // Nothing was reclaimed: a held partial must not inflate the "freed"
      // figure operators read.
      expect(result.deletedPartialBytes).toBe(0)
      // Held bytes still count against capacity. An immortal claim — a recycled
      // pid reads `live` forever, and nothing portable in Node can tell — must
      // be LOUD, or it fills the volume silently.
      expect(result.partialBytes).toBe(4_000)
      expect(result.overBudget).toBe(false)
      expect((await pruneBackupBundles(root, {
        budgetBytes: 100, partialMaxAgeMs: 6 * HOUR, now: AT + 7 * HOUR,
        ownerLiveness: () => 'live',
      })).overBudget).toBe(true)
    })

    it('a DEAD owner does not save it — the veto is one-directional', async () => {
      await partial('2026-08-01T00-00-00Z.partial-4242-aaaaaa', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 7 * HOUR,
        ownerLiveness: () => 'dead',
      })

      expect(result.deletedPartials).toEqual(['2026-08-01T00-00-00Z.partial-4242-aaaaaa'])
      expect(result.heldPartials).toEqual([])
      expect(await readdir(root)).toEqual([])
    })

    it('an UNKNOWN owner changes nothing — an older build\'s partial behaves as it did', async () => {
      // The row that fails if `unknown` were ever folded into `live`. A partial
      // written by an older build has no claim; one written on another host has
      // a claim this host cannot ask about. Both must age out on the age gate
      // alone, or every foreign partial becomes immortal.
      await partial('2026-08-01T00-00-00Z.partial-4242-aaaaaa', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 7 * HOUR,
        ownerLiveness: () => 'unknown',
      })

      expect(result.deletedPartials).toEqual(['2026-08-01T00-00-00Z.partial-4242-aaaaaa'])
      expect(result.heldPartials).toEqual([])
    })

    it('a DEAD owner cannot make a YOUNG partial deletable', async () => {
      // Liveness may move a directory from delete to keep and never the other
      // way. Without this row an implementation that consulted the claim
      // INSTEAD of the age gate, rather than after it, would pass every row
      // above — and it would delete the directory of a run whose writer has
      // just been replaced by a restart while the dump it spawned still holds
      // the file open.
      await partial('2026-08-01T00-00-00Z.partial-4242-aaaaaa', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 1 * HOUR,
        ownerLiveness: () => 'dead',
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.heldPartials).toEqual([])
      expect(await readdir(root)).toEqual(['2026-08-01T00-00-00Z.partial-4242-aaaaaa'])
    })

    it('reports the claim it read, so a report can name who is holding', async () => {
      await partial('2026-08-01T00-00-00Z.partial-4242-aaaaaa', 4_000, false, AT)
      await writeFile(
        join(root, '2026-08-01T00-00-00Z.partial-4242-aaaaaa', '.owner.json'),
        JSON.stringify(held('x').owner),
        'utf8',
      )

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000, partialMaxAgeMs: 6 * HOUR, now: AT + 1 * HOUR,
        ownerLiveness: () => 'unknown',
      })

      expect(result.partials[0]?.owner).toEqual(held('x').owner)
      expect(result.partials[0]?.ownerLiveness).toBe('unknown')
    })

    it('keeps a partial young enough that a live pg_dump may still be filling it', async () => {
      await partial('2026-08-01T00-00-00Z.partial-1-aaaaaa', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 5 * HOUR,
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.partials).toEqual([{
        name: '2026-08-01T00-00-00Z.partial-1-aaaaaa',
        bytes: 4_000,
        ageMs: 5 * HOUR,
        nameAgeMs: 5 * HOUR,
        mtimeAgeMs: 5 * HOUR,
        owner: null,
        ownerLiveness: 'unknown',
      }])
      expect(await readdir(root)).toEqual(['2026-08-01T00-00-00Z.partial-1-aaaaaa'])
    })

    it('takes the SMALLER of the two clocks, so a live writer outvotes an old name', async () => {
      // The case the name alone gets wrong. The directory was named hours ago
      // — a long dump, or a rival whose deadline is longer than ours — and
      // `pg_dump` is writing into it right now.
      await partial('2026-08-01T00-00-00Z.partial-1-aaaaaa', 4_000, false, AT + 9 * HOUR)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 10 * HOUR,
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.partials[0]).toMatchObject({
        nameAgeMs: 10 * HOUR,   // by the name alone this would have been deleted
        mtimeAgeMs: 1 * HOUR,
        ageMs: 1 * HOUR,
      })
    })

    it('keeps a partial at exactly the gate — the boundary belongs to the live run', async () => {
      // A run abandoned on the very last millisecond of its hold is the case
      // this gate exists for, and at that instant its `pg_dump` is at its most
      // likely to still be writing.
      await partial('2026-08-01T00-00-00Z.partial-1-aaaaaa', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 6 * HOUR,
      })

      expect(result.deletedPartials).toEqual([])
      expect(await readdir(root)).toEqual(['2026-08-01T00-00-00Z.partial-1-aaaaaa'])
    })

    it('deletes nothing when the caller did not say how long a drill may run', async () => {
      // The one-shot CLI's case. It cannot know whether a scheduled drill
      // elsewhere is mid-dump, so omitting the gate must mean NEVER — not a
      // default that guesses.
      await partial('2020-01-01T00-00-00Z.partial-1-aaaaaa', 4_000, false, AT - 400 * 24 * HOUR)

      const result = await pruneBackupBundles(root, { budgetBytes: 10, now: AT })

      expect(result.deletedPartials).toEqual([])
      expect(await readdir(root)).toEqual(['2020-01-01T00-00-00Z.partial-1-aaaaaa'])
    })

    it('ages out an unnameable partial on mtime alone', async () => {
      // The documented one-shot CLI invocation names its own output directory,
      // so every partial a CLI run abandons has no timestamp in its name. A
      // name-only gate would keep it forever.
      await partial('manual-before-upgrade.partial-9-ffffff', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 7 * HOUR,
      })

      expect(result.deletedPartials).toEqual(['manual-before-upgrade.partial-9-ffffff'])
      expect(await readdir(root)).toEqual([])
    })

    it('keeps an unnameable partial whose bytes are still moving', async () => {
      await partial('manual-before-upgrade.partial-9-ffffff', 4_000, false, AT + 7 * HOUR)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000,
        partialMaxAgeMs: 6 * HOUR,
        now: AT + 7 * HOUR,
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.partials[0]).toMatchObject({ nameAgeMs: null, mtimeAgeMs: 0, ageMs: 0 })
    })

    it('refuses to act when NEITHER clock can be read', async () => {
      // An empty directory has no files, so no mtime, and an unparseable prefix
      // has no timestamp. No clock means no verdict, and this is a recursive
      // delete on an operator-configured root.
      await mkdir(join(root, 'mystery.partial-1-aaaaaa'), { recursive: true })

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10, partialMaxAgeMs: 0, now: AT + 400 * 24 * HOUR,
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.partials).toEqual([{
        name: 'mystery.partial-1-aaaaaa', bytes: 0, ageMs: null, nameAgeMs: null, mtimeAgeMs: null,
        owner: null, ownerLiveness: 'unknown',
      }])
    })

    it('counts partial bytes against overBudget even though they are exempt from the sweep', async () => {
      // Candidacy and capacity are different questions: a root full of
      // abandoned partials must not report `overBudget: false`.
      await bundle('2026-08-02T00-00-00Z', 1_000)
      await partial('2026-08-03T00-00-00Z.partial-7-bbbbbb', 9_000, false, AT)

      const result = await pruneBackupBundles(root, { budgetBytes: 5_000, now: AT })

      expect(result.deleted).toEqual([])          // the only bundle is protected
      expect(result.bytesAfter).toBe(1_002)       // under budget on its own
      expect(result.overBudget).toBe(true)        // not once the partial is counted
    })

    it('prunes the finished bundles even when a partial tells it nothing', async () => {
      // A finding about an UNFINISHED bundle may never veto the pruning of the
      // finished ones. An unguarded ENOENT while sizing a partial would throw
      // out of pruneBackupBundles and skip the byte budget entirely.
      //
      // The unreadable partial here is an EMPTY directory, which is the state a
      // vanished one presents to the walk. The throw itself needs an interleave
      // between the root listing and the walk that no portable fixture can
      // schedule — so what this asserts is the consequence, not the syscall.
      await bundle('2026-08-01T00-00-00Z', 9_000)
      await bundle('2026-08-02T00-00-00Z', 9_000)
      await mkdir(join(root, 'unreadable.partial-1-aaaaaa'), { recursive: true })

      const result = await pruneBackupBundles(root, { budgetBytes: 1_000, now: AT })

      expect(result.deleted).toEqual(['2026-08-01T00-00-00Z'])
      expect(result.partials).toEqual([{
        name: 'unreadable.partial-1-aaaaaa',
        bytes: 0, ageMs: null, nameAgeMs: null, mtimeAgeMs: null, owner: null, ownerLiveness: 'unknown',
      }])
    })

    it('takes the OLDEST write inside, not the first one it happens to see', async () => {
      // (The title is inverted: the walk must take the NEWEST mtime.) A partial
      // holding one stale file and one being written RIGHT NOW is the case the
      // mtime clock exists for. If the walk kept the oldest mtime, a live
      // `pg_dump` would be judged by a file it finished with hours ago and
      // recursively deleted underneath itself.
      await mkdir(join(root, '2026-08-01T00-00-00Z.partial-1-aaaaaa'), { recursive: true })
      const dir = join(root, '2026-08-01T00-00-00Z.partial-1-aaaaaa')
      await writeFile(join(dir, 'stale.bin'), Buffer.alloc(10, 1))
      await writeFile(join(dir, 'database.dump'), Buffer.alloc(10, 1))
      await utimes(join(dir, 'stale.bin'), new Date(AT), new Date(AT))
      await utimes(join(dir, 'database.dump'), new Date(AT + 9 * HOUR), new Date(AT + 9 * HOUR))

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000, partialMaxAgeMs: 6 * HOUR, now: AT + 10 * HOUR,
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.partials[0]).toMatchObject({ mtimeAgeMs: 1 * HOUR })
    })

    it('keeps a freshly named directory whose files were copied in with old mtimes', async () => {
      // The mirror image, and the case the NAME clock exists for: `cp -a` and
      // `rsync -a` PRESERVE mtime, so a bundle restored into place minutes ago
      // can be full of hours-old files. mtime alone would delete it.
      await partial('2026-08-01T09-30-00Z.partial-1-aaaaaa', 4_000, false, AT)

      const result = await pruneBackupBundles(root, {
        budgetBytes: 10_000, partialMaxAgeMs: 6 * HOUR, now: AT + 10 * HOUR,
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.partials[0]).toMatchObject({
        nameAgeMs: 30 * 60_000,     // named half an hour ago
        mtimeAgeMs: 10 * HOUR,      // by mtime alone this would have been deleted
        ageMs: 30 * 60_000,
      })
    })

    it('never widens the recursive delete beyond the exact name the writer emits', async () => {
      // Any loosening of PARTIAL_DIRECTORY flips a KEEP into a RECURSIVE
      // DELETE. Each name below is the witness for one such loosening.
      const names = [
        '2026-08-01T00-00-00Z.partial--aaaaaa',            // \d+ -> \d*
        '2026-08-01T00-00-00Z.partial-1-DO-NOT-DELETE',    // [0-9a-f]+ -> .+
        '2026-08-01T00-00-00Z.partial-1-aaaaaa.KEEP',      // the trailing $
        '2026-08-01T00-00-00Zxpartial-1-aaaaaa',           // the escaped dot
      ]
      for (const name of names) {
        await mkdir(join(root, name), { recursive: true })
        await writeFile(join(root, name, 'data.bin'), Buffer.alloc(10, 1))
        await utimes(join(root, name, 'data.bin'), new Date(AT), new Date(AT))
      }

      const result = await pruneBackupBundles(root, {
        budgetBytes: 1, partialMaxAgeMs: 0, now: AT + 400 * 24 * HOUR,
      })

      expect(result.deletedPartials).toEqual([])
      expect(result.deleted).toEqual([])
      // Not ours, so they are `skipped` — the list that says an operator should
      // look — and never silently absorbed into `partials`.
      expect(result.skipped.sort()).toEqual([...names].sort())
      expect((await readdir(root)).sort()).toEqual([...names].sort())
    })

    it('never widens the age gate beyond the exact timestamp the writer emits', async () => {
      // Same argument for BUNDLE_NAME: a loosened parser hands a real age to a
      // directory whose prefix only resembles one, and the mtime clock cannot
      // save a name that was never ours.
      for (const prefix of [
        '2026-08-01T00-00-00Zjunk',   // the trailing $
        '2026-08-01X00-00-00Z',       // the literal T
        'junk2026-08-01T00-00-00Z',   // the leading ^
        '2026-8-1T0-0-0Z',            // the fixed digit counts
      ]) {
        expect(bundleStartedAt(prefix)).toBeNull()
      }
    })

    it('never lets the partial gate fall below the gate its sibling trusts', () => {
      // Asserts the relation between the two gates, not specific values.
      //
      // The floor matters because this gate ends in `rm -rf` on a directory a
      // live pg_dump may be filling, while its sibling only drops a restore
      // rehearsal database. Same exposure, strictly worse consequence — so the
      // partial gate may never be the more eager of the two.
      for (const hold of [0, 1_000, 35 * 60_000, 6 * HOUR, 20 * HOUR]) {
        expect(partialSweepMinimumAgeMs(hold)).toBeGreaterThanOrEqual(bootSweepMinimumAgeMs(hold))
      }
      // An hourly cadence derives a one-hour hold; without the floor that is a
      // one-hour gate, and the one party with no deadline and no advisory lock
      // is the one-shot CLI an operator runs during an incident.
      expect(partialSweepMinimumAgeMs(maxDrillHoldMs({ BACKUP_DRILL_INTERVAL_HOURS: '1' })))
        .toBeGreaterThanOrEqual(6 * HOUR)
    })

    it('refuses a non-finite hold instead of clamping it', () => {
      // `Math.max(0, NaN)` is `NaN`, and `age <= NaN` is false for every age —
      // so the clamp that looks defensive makes a recursive delete fail OPEN
      // and remove a partial one millisecond old.
      expect(() => partialSweepMinimumAgeMs(Number.NaN)).toThrow(/finite/)
      expect(() => partialSweepMinimumAgeMs(Number.POSITIVE_INFINITY)).toThrow(/finite/)
    })

    it('round-trips the name the scheduler actually writes', () => {
      // Links producer and parser: a format drift would make every age null,
      // every partial immortal, and this sweep a no-op that reports success.
      for (const iso of [
        '2026-08-09T02:31:07.123Z', '1970-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z',
      ]) {
        const at = new Date(iso)
        const name = bundleName(at)
        expect(bundleStartedAt(name)).toBe(Math.floor(at.getTime() / 1000) * 1000)
      }
    })

    it('treats a name that only LOOKS like a date as unparseable', () => {
      // The whole "unknown falls on the keep side" argument rests on
      // unparseable meaning unparseable, and `Date.parse` is lenient: it rolls
      // February 30th forward to March 2nd rather than refusing.
      expect(bundleStartedAt('2026-02-30T00-00-00Z')).toBeNull()
      expect(bundleStartedAt('2026-13-01T00-00-00Z')).toBeNull()
      expect(bundleStartedAt('2026-08-09T02-31-07Z')).toBe(Date.parse('2026-08-09T02:31:07Z'))
    })
  })
})

describe.skipIf(!TEST_DATABASE_URL)('drill history autoclean', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'backup_retention')
    await ensureBackupSchema(db.pool)
  })
  afterAll(async () => {
    await db?.teardown()
  })
  beforeEach(async () => {
    await db.pool.query('DELETE FROM backup_drill_runs')
  })

  /** Padding that does NOT compress. `'x'.repeat(4000)` is ~50 bytes after
   * TOAST, so budgets would never be exceeded and the tests would pass by
   * pruning nothing. Real reports are hashes and URLs — incompressible. */
  const incompressible = (bytes: number, seed: number): string => {
    let value = ''
    let state = seed + 1
    while (value.length < bytes) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      value += state.toString(36)
    }
    return value.slice(0, bytes)
  }

  const insert = async (
    id: string,
    outcome: 'passed' | 'failed',
    minutesAgo: number,
    padding = 4_000,
  ) => {
    await db.pool.query(
      `INSERT INTO backup_drill_runs
         (id, started_at, finished_at, outcome, rto_ms, report_sha256, report)
       VALUES ($1, now() - make_interval(mins => $2), now() - make_interval(mins => $2),
               $3, 1000, $4, $5::jsonb)`,
      [
        id, minutesAgo, outcome, 'a'.repeat(64),
        JSON.stringify({ filler: incompressible(padding, minutesAgo + padding) }),
      ],
    )
  }

  /** Measure, then budget a fraction of it — hard-coded byte counts are a bet on
   * TOAST behaviour. */
  const measure = async (): Promise<number> =>
    (await pruneDrillHistory(db.pool, { budgetBytes: 1024 ** 3, minimumRows: 1 })).bytesBefore

  const ids = async (): Promise<string[]> => {
    const { rows } = await db.pool.query<{ id: string }>(
      'SELECT id FROM backup_drill_runs ORDER BY finished_at DESC',
    )
    return rows.map((row) => row.id)
  }

  it('deletes oldest-first down to the byte budget', async () => {
    for (let index = 0; index < 12; index += 1) {
      await insert(`run-${String(index).padStart(2, '0')}`, 'passed', index * 10)
    }
    const total = await measure()
    const result = await pruneDrillHistory(db.pool, {
      budgetBytes: Math.floor(total / 3),
      minimumRows: 1,
    })
    expect(result.deleted).toBeGreaterThan(0)
    expect(result.bytesAfter).toBeLessThan(total)
    const surviving = await ids()
    // Newest kept, oldest gone.
    expect(surviving).toContain('run-00')
    expect(surviving).not.toContain('run-11')
  })

  it('never deletes the most recent PASSING run, however old', async () => {
    // Deleting it makes last_success_age read NaN, which is the "no drill has
    // ever passed" signal — an alert manufactured by housekeeping.
    await insert('ancient-success', 'passed', 100_000)
    for (let index = 0; index < 8; index += 1) {
      await insert(`fail-${index}`, 'failed', index * 5)
    }
    const total = await measure()
    const result = await pruneDrillHistory(db.pool, {
      budgetBytes: Math.floor(total / 4),
      minimumRows: 1,
    })
    expect(result.deleted).toBeGreaterThan(0)
    expect(await ids()).toContain('ancient-success')
  })

  it('keeps the most recent rows so a failure streak stays countable', async () => {
    for (let index = 0; index < 20; index += 1) {
      await insert(`fail-${String(index).padStart(2, '0')}`, 'failed', index)
    }
    const result = await pruneDrillHistory(db.pool, { budgetBytes: 1, minimumRows: 5 })
    const surviving = await ids()
    expect(surviving).toHaveLength(5)
    expect(surviving[0]).toBe('fail-00')
    expect(result.overBudget).toBe(true)
  })

  it('reports honestly when the protected rows do not fit', async () => {
    await insert('only-run', 'passed', 0, 200_000)
    const result = await pruneDrillHistory(db.pool, { budgetBytes: 1_024, minimumRows: 1 })
    expect(result.deleted).toBe(0)
    expect(result.overBudget).toBe(true)
    expect(await ids()).toEqual(['only-run'])
  })

  it('is a no-op on an empty table', async () => {
    const result = await pruneDrillHistory(db.pool, { budgetBytes: 1_024 })
    expect(result).toMatchObject({ deleted: 0, rowsBefore: 0, bytesBefore: 0, overBudget: false })
  })
})
