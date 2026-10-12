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

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { isMainThread } from 'node:worker_threads'
import { installPlacementShadowObserver } from './placement-shadow-observer.mjs'

// NODE_OPTIONS also reaches lease Workers and Docker's node -e healthchecks.
// Do not import ownership there: its Worker entry has process side effects.
if (isMainThread && typeof process.argv[1] === 'string'
    && resolve(process.argv[1]) === '/app/dist/index.js'
    && process.env.MS_PLACEMENT_SHADOW_RUN) {
  assert.match(process.env.MS_PLACEMENT_SHADOW_RUN, /^t10h2-3176-[a-z0-9-]+$/)
  assert.equal(process.env.SYNC_CELL_PARTITION_COUNT, '2')
  assert.equal(process.env.SYNC_CELL_PLACEMENT_MODE, 'shadow')
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.listenerCount('SIGUSR2'), 0)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const manifestBytes = readFileSync('/app/qa/placement-shadow-manifest.json')
  const manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.runId, process.env.MS_PLACEMENT_SHADOW_RUN)
  for (const path of ['/app/dist/index.js', '/app/dist/syncCells/ownership.js',
    '/app/dist/syncCells/assignment.js', '/app/dist/syncCells/placementDivergence.js',
    '/app/qa/placement-shadow-observer.mjs', '/app/qa/placement-shadow-preload.mjs']) {
    assert.match(manifest.hashes[path], /^[a-f0-9]{64}$/)
    assert.equal(digest(readFileSync(path)), manifest.hashes[path], path)
  }
  const metadata = { runId: manifest.runId, pid: process.pid, hostname: hostname(),
    cellId: process.env.SYNC_CELL_ID, manifestSha256: digest(manifestBytes),
    sourceHashes: manifest.sourceHashes, hashes: manifest.hashes }
  const { SyncCellOwnershipCoordinator, OWNABLE_WORKSPACES_SQL } =
    await import('/app/dist/syncCells/ownership.js')
  const observer = installPlacementShadowObserver({
    Coordinator: SyncCellOwnershipCoordinator, ownableSql: OWNABLE_WORKSPACES_SQL,
    metadata, emit: event => process.stdout.write('[t10h2] ' + JSON.stringify(event) + '\n'),
  })
  process.on('SIGUSR2', () => observer.markPhase())
  // The application can exit without draining stdout/reconcileFlight. This is
  // only a terminal fault witness. The collector must also find every sequence
  // and all qualified pass completions in the final, closed Docker log.
  process.once('exit', () => {
    try {
      const stats = observer.stats()
      const event = { schema: 'maplespire-placement-shadow/v1', ...metadata,
        event: 'closed', sequence: stats.eventSequence + 1, stats,
        observerFault: stats.fault, monotonic: process.hrtime.bigint().toString(),
        utc: new Date().toISOString() }
      const record = '[t10h2] ' + JSON.stringify(event) + '\n'
      assert.ok(Buffer.byteLength(record) <= 65536)
      writeSync(1, record)
    } catch {
      // A missing/partial terminal record fails measurement qualification.
    }
  })
}
