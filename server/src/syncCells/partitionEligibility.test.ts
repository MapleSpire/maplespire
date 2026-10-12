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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { syncCellOwnershipConfig } from './ownership.js'

/**
 * A cell that serves and advertises but never takes a partition.
 *
 * THE FAILURE IT CAN PREVENT. The two planes disagree about what a cell is:
 *
 *   - the WebSocket plane is OWNER-AWARE: the router resolves the partition
 *     owner in Redis and tunnels straight to it;
 *   - the REST plane is PINNED BY HOSTNAME: nginx sends `/api/` to the container
 *     literally named `api`, and `index.ts` answers 503 `workspace owner
 *     changed` for any workspace the cell it reached does not own.
 *
 * Partition ownership is a LEASE. So in a two-cell deployment, one solo restart
 * of the pinned cell — an OOM kill, a host reboot, `docker compose restart api`
 * — releases partition 0, the other cell takes it within
 * `partitionProbeIntervalMs` (100 ms by default) and renews it indefinitely, and
 * from then on EVERY REST call to the pinned host 503s. Permanently. Meanwhile
 * `up` reads 1 on both cells, the WebSocket plane is genuinely fine because the
 * router tunnels to the new owner, and no alert rule names any of it.
 *
 * `depends_on` cannot prevent this: it orders a compose-driven start, not the
 * daemon-driven restarts `restart: always` produces.
 */
describe('a cell can be made ineligible for partition ownership', () => {
  it('defaults to ELIGIBLE, so no existing deployment changes', () => {
    // The asymmetry with `SYNC_CELL_PARTITION_WORKER` (which is opt-IN) is the
    // point: every cell deployed today acquires, and an unset value must keep
    // doing exactly that.
    expect(syncCellOwnershipConfig({}).partitionEligible).toBe(true)
    expect(syncCellOwnershipConfig({ SYNC_CELL_PARTITION_ELIGIBLE: 'on' }).partitionEligible).toBe(true)
  })

  it('only the literal "off" opts out — a typo fails toward acquiring', () => {
    // Fail-safe direction matters here and is the opposite of most flags in this
    // file. A misspelling that silently made a cell ineligible would produce a
    // fleet where NOBODY owns the partition and every workspace is unroutable —
    // strictly worse than the flag being ignored.
    for (const typo of ['false', '0', 'no', 'OFF', 'Off', '', 'disabled']) {
      expect(
        syncCellOwnershipConfig({ SYNC_CELL_PARTITION_ELIGIBLE: typo }).partitionEligible,
        `"${typo}" must not be read as off`,
      ).toBe(true)
    }
    expect(syncCellOwnershipConfig({ SYNC_CELL_PARTITION_ELIGIBLE: 'off' }).partitionEligible).toBe(false)
  })

  it('a manifest may mark SOME cells ineligible, never ALL of them', () => {
    // What must never be true in ANY manifest is that every cell is ineligible:
    // nobody could then acquire the partition, so nothing would be owned,
    // projected or served — strictly worse than not having the flag.
    const compose = readFileSync(
      fileURLToPath(new URL('../../../compose.maplespire.yml', import.meta.url)),
      'utf8',
    )
    // ` {2}` rather than two literal spaces: the indent is the whole point of
    // this split (a service key sits at exactly two spaces), and a count nobody
    // can see is a count that drifts.
    const blocks = compose.split(/^ {2}(?=[a-zA-Z0-9][a-zA-Z0-9_-]*:\s*$)/m)
    const cells = blocks.filter((block) => /^\s+SYNC_CELL_ID:/m.test(block))
    // The control: with no cells found the assertion below is vacuous.
    expect(cells.length, 'the shipped manifest declares no sync cells — the scan is broken').toBeGreaterThan(0)

    // LINE-ANCHORED, so a COMMENT that quotes the flag is not read as setting
    // it: a comment above a service key falls inside the PRECEDING service's
    // block, and a gate that reads prose as configuration is a false red.
    const ineligible = cells.filter((block) => /^[ \t]+SYNC_CELL_PARTITION_ELIGIBLE:[ \t]*"off"/m.test(block))
    expect(
      ineligible.length,
      'every cell is ineligible — no cell can acquire the partition, so nothing is owned or served',
    ).toBeLessThan(cells.length)
    // REST is still pinned by hostname, so whichever cell nginx names must be
    // able to own. An ineligible `api` would be the outage in its purest form.
    expect(compose).toMatch(/BACKEND_HOST:\s*api\s*$/m)
    const apiCell = cells.find((block) => /SYNC_CELL_ID:\s*maplespire-home\s*$/m.test(block))
    expect(apiCell, 'the cell nginx sends REST to is gone').toBeDefined()
    expect(apiCell).not.toMatch(/^[ \t]+SYNC_CELL_PARTITION_ELIGIBLE:[ \t]*"off"/m)
  })

  it('a config that OMITS the field is eligible — the guard reads `=== false`', () => {
    // The factory defaults `partitionEligible` to true, but a config assembled
    // by hand omits it. A `!eligible` guard would read `undefined` as
    // INELIGIBLE and every hand-built cell would silently stop acquiring. A
    // fleet where nobody owns a partition is strictly worse than one where the
    // flag does not exist.
    //
    // Asserted on the SOURCE of the guard rather than on behaviour because
    // driving acquisition needs a live Redis and Postgres; the arms above cover
    // the parsing, and `ownership.test.ts` covers the behaviour by being green.
    const source = readFileSync(
      fileURLToPath(new URL('./ownership.ts', import.meta.url)),
      'utf8',
    )
    expect(
      source,
      'the guard must treat a missing field as ELIGIBLE, or every hand-built config stops acquiring',
    ).toMatch(/if \(this\.config\.partitionEligible === false\) return/)
    expect(source).not.toMatch(/if \(!this\.config\.partitionEligible\) return/)
  })

  it('the acquisition path is guarded once, where every caller passes through', () => {
    // `probePartition`, the boot reconcile and `reconcileNow` all reach
    // acquisition through `acquirePartitionIfMissing`. Guarding the probe TIMER
    // instead would leave the other two able to acquire — a partial guard that
    // holds on a quiet stack and fails during exactly the restart it exists for.
    const source = readFileSync(
      fileURLToPath(new URL('./ownership.ts', import.meta.url)),
      'utf8',
    )
    const guard = source.indexOf('if (this.config.partitionEligible === false) return')
    const method = source.indexOf('private async acquirePartitionIfMissing')
    const probeOrder = source.indexOf('for (const partition of partitionProbeOrder(')
    expect(guard, 'the eligibility guard is gone').toBeGreaterThan(-1)
    expect(method).toBeLessThan(guard)
    expect(guard, 'the guard must precede the probe loop, not sit inside it').toBeLessThan(probeOrder)
  })
})
