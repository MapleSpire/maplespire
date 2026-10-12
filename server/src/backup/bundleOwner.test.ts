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

import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUNDLE_OWNER_FILE,
  bundleOwnerLiveness,
  readBundleOwner,
  writeBundleOwner,
  type BundleOwner,
} from './bundleOwner.js'

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })
const OWNER: BundleOwner = { host: 'box-a', pid: 4242, startedAt: 1_700_000_000_000, kind: 'drill' }

describe('bundleOwnerLiveness', () => {
  it('is unknown for no claim at all', () => {
    // An older build's partial has no claim. It must read `unknown`, never
    // `dead`, or the sweep would start deleting directories it should keep.
    expect(bundleOwnerLiveness(null, 'box-a', () => {})).toBe('unknown')
  })

  it('is unknown for another host WITHOUT probing', () => {
    // The load-bearing row. This host's pid table knows nothing about box-b's
    // pid 4242, and asking it returns a confident answer to a question nobody
    // asked — wrong in BOTH directions: a locally-live pid makes a remote corpse
    // immortal, a locally-dead one makes a remote live writer deletable.
    //
    // Asserting the probe was NOT CALLED, not merely that the answer is
    // `unknown`: an implementation that probed and then discarded the result
    // would pass the weaker assertion while still consulting the wrong table.
    let probed = 0
    const verdict = bundleOwnerLiveness(OWNER, 'box-b', () => { probed += 1 })
    expect(verdict).toBe('unknown')
    expect(probed).toBe(0)
  })

  it('is live when the probe returns', () => {
    expect(bundleOwnerLiveness(OWNER, 'box-a', () => {})).toBe('live')
  })

  it('is LIVE on EPERM — the process exists and belongs to someone else', () => {
    // The expensive mistake available here. `signal 0` reports EPERM when the
    // process EXISTS but is owned by another uid; reading that as dead would
    // recursively delete a running drill's directory mid-dump.
    expect(bundleOwnerLiveness(OWNER, 'box-a', () => { throw errno('EPERM') })).toBe('live')
  })

  it('is dead on ESRCH', () => {
    expect(bundleOwnerLiveness(OWNER, 'box-a', () => { throw errno('ESRCH') })).toBe('dead')
  })

  it('is unknown when the probe itself fails', () => {
    // A failure to ASK is not an answer. Anything that is neither EPERM nor
    // ESRCH — EINVAL, a TypeError from a pid that got past validation — must
    // land on the keep side.
    expect(bundleOwnerLiveness(OWNER, 'box-a', () => { throw errno('EINVAL') })).toBe('unknown')
    expect(bundleOwnerLiveness(OWNER, 'box-a', () => { throw new TypeError('bad pid') })).toBe('unknown')
  })

  it('answers about THIS process with the real probe, in both directions', () => {
    // The default probe, not an injected one — otherwise every row above tests
    // only the branching and nothing tests `process.kill(pid, 0)` itself.
    //
    // `startedAt` must be AFTER this process started, or the self-pid rule
    // correctly calls it dead: a claim carrying our own pid that predates our
    // own start was written by a process the pid has since been recycled away
    // from. That rule has its own row below.
    const self: BundleOwner = { ...OWNER, host: hostname(), pid: process.pid, startedAt: Date.now() }
    expect(bundleOwnerLiveness(self)).toBe('live')
    // Counter-control, without which the row above would pass against an
    // implementation that always answers `live`.
    //
    // Not 4_194_303: `/proc/sys/kernel/pid_max` can be 4194304, so that pid is
    // allocatable. `2147483647` is out of range on every platform this ships
    // to (ESRCH on win32 and Linux alike).
    expect(bundleOwnerLiveness({ ...self, pid: 2_147_483_647 })).toBe('dead')
  })

  it('is DEAD for our own pid claimed before we started -- the pid-1 case', () => {
    // In the shipped deployment this is the 100 % case rather than a rare wraparound: `docker-entrypoint-drill
    // .sh` ends in `exec "$@"`, so node is pid 1 in the drill container;
    // abandonment calls `process.exit(1)`; `restart: always` restarts the SAME
    // container with the same hostname and node as pid 1 again. The sweeper then
    // probes pid 1, which is ITSELF, and would read `live` about the corpse
    // whose directory it exists to reclaim.
    //
    // The probe is stubbed to RETURN here, i.e. to say `live`, so this row can
    // only pass if the discrimination comes from `startedAt`.
    const stale: BundleOwner = {
      host: hostname(), pid: process.pid, startedAt: Date.now() - 86_400_000, kind: 'drill',
    }
    expect(bundleOwnerLiveness(stale, hostname(), () => {})).toBe('dead')
    // Counter-control: the same claim dated after our start is live, so the row
    // above is failing on the timestamp and not on the pid.
    expect(bundleOwnerLiveness({ ...stale, startedAt: Date.now() }, hostname(), () => {})).toBe('live')
    // And the rule is scoped to OUR pid. Another pid on this host has no start
    // time anything portable can read, so the probe stays the only authority
    // there -- widening this rule would answer `dead` about live strangers.
    expect(bundleOwnerLiveness({ ...stale, pid: process.pid + 1 }, hostname(), () => {})).toBe('live')
  })
})

describe('readBundleOwner / writeBundleOwner', () => {
  it('round-trips a claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maplespire-owner-'))
    try {
      const written = await writeBundleOwner(dir, 'drill', Date.now())
      expect(written).toMatchObject({ pid: process.pid, kind: 'drill' })
      const read = await readBundleOwner(dir)
      expect(read).toEqual(written)
      // And the claim the writer made is one this host reads as LIVE, which is
      // the whole point of writing it. Without this the round trip proves only
      // that JSON survives a filesystem.
      expect(bundleOwnerLiveness(read)).toBe('live')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is null for absent, malformed, or implausible claims — never a partial record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maplespire-owner-'))
    try {
      expect(await readBundleOwner(dir)).toBeNull()
      const cases = [
        'not json at all',
        '{}',
        JSON.stringify({ host: '', pid: 1, startedAt: 1 }),
        JSON.stringify({ host: 'box-a', pid: 0, startedAt: 1 }),
        JSON.stringify({ host: 'box-a', pid: -1, startedAt: 1 }),
        // `process.kill(NaN, 0)` throws a TypeError rather than the ESRCH this
        // module reasons about, so a NaN pid must be refused at the door.
        JSON.stringify({ host: 'box-a', pid: null, startedAt: 1 }),
        JSON.stringify({ host: 'box-a', pid: 1.5, startedAt: 1 }),
        JSON.stringify({ host: 'box-a', pid: 1, startedAt: 'yesterday' }),
      ]
      // A WELL-FORMED claim whose `kind` is not a string is the one malformed
      // shape that gets past every check above, so it is asserted separately:
      // it must be READ (the identity fields are sound) with `kind` normalised,
      // never carried through in violation of its own type.
      await writeFile(
        join(dir, BUNDLE_OWNER_FILE),
        JSON.stringify({ host: 'box-a', pid: 7, startedAt: 1, kind: { not: 'a string' } }),
        'utf8',
      )
      expect(await readBundleOwner(dir)).toEqual({ host: 'box-a', pid: 7, startedAt: 1, kind: 'unknown' })
      for (const raw of cases) {
        await writeFile(join(dir, BUNDLE_OWNER_FILE), raw, 'utf8')
        expect(await readBundleOwner(dir), raw).toBeNull()
        // Every one of them must reach `unknown`, not `dead`. A malformed claim
        // that read as `dead` would authorise the delete this file exists to
        // veto.
        expect(bundleOwnerLiveness(await readBundleOwner(dir)), raw).toBe('unknown')
      }
      // Counter-control: a well-formed record on the same path IS read, so the
      // rows above are failing on their content and not on the path.
      await writeFile(join(dir, BUNDLE_OWNER_FILE), JSON.stringify(OWNER), 'utf8')
      expect(await readBundleOwner(dir)).toEqual(OWNER)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null rather than throwing when the claim cannot be written', async () => {
    // Best-effort is the contract: `createDatabaseBackup` calls this before it
    // dumps anything, and a backup must never fail because a lock file could
    // not be created. Without the claim the sweep falls back to the age gate.
    expect(await writeBundleOwner(join(tmpdir(), 'maplespire-absent-dir-xyz'), 'drill')).toBeNull()
  })
})
