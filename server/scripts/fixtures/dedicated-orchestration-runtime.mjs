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

export const fixtureCells = ['failover-cell-a', 'failover-cell-b', 'failover-cell-c']

/** An orchestration fixture, not a Redis, SQL, HTTP or Automerge simulation.
 * Requests and COMMIT have explicit sequential brackets on a synthetic clock.
 * Each move exposes one vacant reading, then stable destination ownership.
 */
export function createOrchestrationRuntime(options) {
  let clock = 0, partition = 0, token = 1, vacant = false
  const trace = { moves: [], events: [], coldReferences: [], counts: {}, samples: [] }
  const record = name => {
    trace.events.push(name)
    trace.counts[name] = (trace.counts[name] ?? 0) + 1
  }
  const owner = () => partition === 0 ? 'failover-cell-a' : 'failover-cell-c'
  const bracket = () => {
    clock += 10
    return { startedAtMs: clock, completedAtMs: clock + 1 }
  }
  const cold = { fixtureOnly: true, rootUrl: 'fixture-root', heads: ['fixture-head'], documents: 7 }
  return {
    trace,
    identity: { fixtureOnly: true, cells: [...fixtureCells] },
    fixture: { kind: 'orchestration-only', syntheticClock: true },
    now: () => clock,
    async census() {
      record('census')
      return [{ landscape_id: options.workspace.landscapeId, id: options.workspace.versionId }]
    },
    async placement() {
      record('placement')
      return { partition, topology_generation: options.generation }
    },
    async readCells() {
      record('readCells')
      const interval = bracket()
      const currentOwner = vacant ? null : owner()
      vacant = false
      const readings = fixtureCells.map((cellId, i) => ({ cellId, ...interval, state: {
        cellId, enabled: true, topologyConfirmed: true, topologyGeneration: options.generation,
        partitionCount: 2, placementMode: 'placed', reservedPartitions: [1],
        role: i === 2 ? 'reserved:1' : 'pool', partitionIndex: [0, null, 1][i],
        ready: i !== 1, partitionReady: i !== 1,
        bootObservedAt: ['2026-09-09T00:00:01.000Z', '2026-09-09T00:00:02.000Z', '2026-09-09T00:00:03.000Z'][i],
        partitionAcquisitionCount: i === 1 ? 0 : 1, partitionLossCount: 0,
        ownedWorkspaceCount: cellId === currentOwner ? 1 : 0,
        expectedWorkspaceCount: cellId === currentOwner ? 1 : 0,
      } }))
      const sample = { readings }
      trace.samples.push(structuredClone(sample))
      return sample
    },
    async move(from, to) {
      record('move')
      assert.equal(partition, from, 'The orchestration must return before its next outbound move')
      assert.equal(to, 1 - from)
      const commit = bracket()
      partition = to
      token++
      vacant = true
      const receipt = { from, to, commit }
      trace.moves.push(structuredClone(receipt))
      return receipt
    },
    async readFence() {
      record('readFence')
      return { cell_id: owner(), token: String(token), released_at: null }
    },
    async readCold(reference) {
      record('readCold')
      trace.coldReferences.push(reference)
      if (reference !== undefined) assert.deepEqual(reference, cold)
      return structuredClone(cold)
    },
    async fsck() {
      record('fsck')
      return {
        native: { fixtureOnly: true, pid: 1234, closed: true, cleanupConfirmed: true, code: 0, signal: null, timedOut: false },
        stdout: JSON.stringify({ reports: [{ workspace: options.workspace, status: 'clean' }], sharedRoots: [] }),
        stderr: '',
      }
    },
    async verifyIdentity() {
      record('verifyIdentity')
      return { unchanged: true, fixtureOnly: true, cells: [...fixtureCells] }
    },
    async close() {
      record('close')
      return { closed: true, operationsJoined: 0, rejectedOperations: 0 }
    },
  }
}

// Only the test preload resolves the production runtime import to this file.
export async function createDedicatedRuntime(options) {
  const runtime = createOrchestrationRuntime(options)
  if (process.env.DEDICATED_TEST_CLOSE_FAILURE === 'yes') {
    runtime.close = async () => { throw new Error('Injected runtime close failure') }
  }
  return runtime
}
