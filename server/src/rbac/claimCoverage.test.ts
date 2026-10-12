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
 * The local half of the cross-process coverage invalidation: what `dropWorkspaceCoverageLocally` (the NOTIFY
 * handler's target) may and may not touch. The channel plumbing has its own
 * suites (workspaceCacheInvalidation.test.ts for the listener, the DB-gated
 * twin for the real triggers); THIS file pins the cache semantics the handler
 * relies on, because they carry two non-obvious rules: the own-constat echo
 * exemption, and the in-flight read epoch.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Queryable } from '../readModel/types.js'
import {
  dropWorkspaceCoverageLocally,
  invalidateWorkspaceCoverage,
  isWorkspaceCoveredCached,
  isWorkspaceCoveredLocally,
  noteCoverageGapLocally,
  noteCoveredLocally,
  _resetWorkspaceClaimCoverageForTests,
} from './claimCoverage.js'
import { CLAIM_PROTOCOL_VERSION } from './documentClaims.js'

const KEY = { landscapeId: 'L-drop', versionId: 'V-drop' }

const coveredRow = { covered: true, protocol: CLAIM_PROTOCOL_VERSION, invalidations: '0' }

describe('claim coverage — the cross-process drop (plis E/F n°4)', () => {
  beforeEach(() => {
    _resetWorkspaceClaimCoverageForTests()
  })

  it('a remote coverage change drops a locally covered entry', () => {
    noteCoveredLocally(KEY)
    expect(isWorkspaceCoveredLocally(KEY)).toBe(true)

    dropWorkspaceCoverageLocally(KEY)

    // Dropped, not overwritten: the next consumer re-reads the durable row
    // rather than trusting anything carried out of band.
    expect(isWorkspaceCoveredLocally(KEY)).toBe(false)
  })

  it("never drops this process's own constat record — the gap licence survives the echo", () => {
    // NOTIFY echoes back to its emitter: our own invalidateWorkspaceCoverage
    // fires the trigger, and the echo arrives at this very handler. Dropping
    // the gap-marked write-through would re-arm the once-per-TTL workspace
    // ceiling of noteCoverageGapLocally — a second unclaimed document inside
    // the window would buy a second durable invalidation + memo purge + full
    // repair walk. Catches: dropping gapMarked entries → the second licence
    // call below returns true.
    expect(noteCoverageGapLocally(KEY, 'doc-first-hole')).toBe(true)

    dropWorkspaceCoverageLocally(KEY) // the echo of our own durable write

    expect(
      noteCoverageGapLocally(KEY, 'doc-second-hole'),
      'a NEW document inside the TTL window must stay under the workspace ceiling',
    ).toBe(false)
  })

  it('a coverage read in flight across a remote drop is not retained (epoch guard)', async () => {
    let releaseFirst!: () => void
    const held = new Promise<void>((resolve) => { releaseFirst = resolve })
    let reads = 0
    const db = {
      query: async () => {
        reads += 1
        if (reads === 1) await held
        return { rows: [coveredRow], rowCount: 1 }
      },
    } as unknown as Queryable

    // The read takes off, the remote change lands while it is in the air.
    const inFlight = isWorkspaceCoveredCached(db, KEY)
    dropWorkspaceCoverageLocally(KEY)
    releaseFirst()

    // The flight's callers get the flight's answer — served, never retained.
    await expect(inFlight).resolves.toBe(true)

    // Catches: an unguarded `remember` caches the raced answer and the
    // next call is served from memory — `reads` stays at 1.
    void isWorkspaceCoveredCached(db, KEY)
    expect(reads, 'the post-drop read must consult the durable row again').toBe(2)
  })

  // ======================================================================
  // The LOCAL constat writers bump the read epoch too. Otherwise a read that
  // took off BEFORE the constat could land AFTER it and `remember` its
  // pre-constat "covered" answer OVER the gap-marked entry: the licence
  // re-armed and "covered" served for up to 30 s — with no LISTEN echo able to
  // help (the echo keeps gapMarked entries by design, and the licence path
  // never writes a durable row at all).
  // ======================================================================

  it('a local constat is not overwritten by a read that was already in flight', async () => {
    let releaseFirst!: () => void
    const held = new Promise<void>((resolve) => { releaseFirst = resolve })
    let reads = 0
    const db = {
      query: async () => {
        reads += 1
        if (reads === 1) await held
        return { rows: [coveredRow], rowCount: 1 }
      },
    } as unknown as Queryable

    // The read takes off against a durably covered row...
    const inFlight = isWorkspaceCoveredCached(db, KEY)
    // ...and the constat lands while it is in the air. This is the
    // licence-only writer: no durable row, hence no NOTIFY echo, ever.
    expect(noteCoverageGapLocally(KEY, 'doc-first-hole')).toBe(true)
    releaseFirst()

    // The flight's callers get the flight's answer — served, never retained.
    await expect(inFlight).resolves.toBe(true)

    // Catches: epoch bump removed → the landing read remembers
    // `covered: true` over the gap entry and BOTH witnesses flip.
    expect(
      isWorkspaceCoveredLocally(KEY),
      'the gap entry must survive the landing read',
    ).toBe(false)
    expect(
      noteCoverageGapLocally(KEY, 'doc-second-hole'),
      'the M2 workspace ceiling must still be armed — re-arming it re-buys an invalidation + walk per document',
    ).toBe(false)
  })

  it('a durable invalidation also fences reads already in flight', async () => {
    let releaseFirst!: () => void
    const held = new Promise<void>((resolve) => { releaseFirst = resolve })
    let selects = 0
    const db = {
      query: async (sql: string) => {
        if (/INSERT INTO workspace_claim_coverage/.test(sql)) return { rows: [], rowCount: 1 }
        selects += 1
        if (selects === 1) await held
        return { rows: [coveredRow], rowCount: 1 }
      },
    } as unknown as Queryable

    const inFlight = isWorkspaceCoveredCached(db, KEY)
    // The durable de-cover lands while the read is in the air. Its own NOTIFY
    // echo would eventually bump the epoch — but only with a live LISTEN
    // client, and only after the durable round trip; the local bump must not
    // wait for either.
    await invalidateWorkspaceCoverage(db, KEY, 'route-gate constat (test)')
    releaseFirst()

    await expect(inFlight).resolves.toBe(true)

    // Catches: bump removed → the raced "covered" overwrites the gap
    // entry and both reads below serve stale truth from memory.
    expect(isWorkspaceCoveredLocally(KEY)).toBe(false)
    await expect(isWorkspaceCoveredCached(db, KEY)).resolves.toBe(false)
  })
})
