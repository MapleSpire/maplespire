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

const CELL_IDS = ['failover-cell-a', 'failover-cell-b', 'failover-cell-c']
const requireFact = (condition, message) => {
  if (!condition) throw new Error(`Dedicated gate: ${message}`)
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.length > 0
const sameWorkspace = (left, right) => left.landscapeId === right.landscapeId && left.versionId === right.versionId

function assertWorkspace(workspace) {
  requireFact(record(workspace) && nonempty(workspace.landscapeId) && nonempty(workspace.versionId), 'workspace identity is missing')
}

/** Counts identify the target only while the whole ownable census is that one
 * workspace. Callers must read the production census, not filter it first. */
export function assertDedicatedCensus(rows, workspace) {
  assertWorkspace(workspace)
  requireFact(Array.isArray(rows) && rows.length === 1, 'ownable census must contain exactly one workspace')
  requireFact(record(rows[0]) && rows[0].landscape_id === workspace.landscapeId && rows[0].id === workspace.versionId,
    'ownable census does not identify the target workspace')
  return rows[0]
}

/** This is the dedicated bench topology, not a general fleet validator. API
 * snapshots expose no fencing token; Redis/SQL token evidence belongs to the
 * caller. A standby may legitimately report partitionIndex: null. */
export function assertDedicatedTopology(states, { generation, reservedPartition = 1, partitionCount = 2 } = {}) {
  requireFact(nonempty(generation), 'expected generation is missing')
  requireFact(reservedPartition === 1 && partitionCount === 2, 'expected topology must be two partitions with reserved slot 1')
  requireFact(Array.isArray(states) && states.length === 3, 'all three cell snapshots are required')
  const seen = new Set()
  for (const state of states) {
    requireFact(record(state) && CELL_IDS.includes(state.cellId), 'unknown or missing cell identity')
    requireFact(!seen.has(state.cellId), `duplicate cell identity ${state.cellId}`)
    seen.add(state.cellId)
    const label = state.cellId
    requireFact(state.enabled === true && state.topologyConfirmed === true, `${label} has not confirmed ownership topology`)
    requireFact(state.topologyGeneration === generation, `${label} generation differs from the target`)
    requireFact(state.partitionCount === partitionCount, `${label} partition count differs from the target`)
    requireFact(state.placementMode === 'placed', `${label} is not in placed mode`)
    requireFact(Array.isArray(state.reservedPartitions) && state.reservedPartitions.length === 1
      && state.reservedPartitions[0] === reservedPartition, `${label} reservation set differs from [1]`)
    const dedicated = label === 'failover-cell-c'
    requireFact(state.role === (dedicated ? 'reserved:1' : 'pool'), `${label} role differs from its bench role`)
    requireFact(state.partitionIndex === null || state.partitionIndex === (dedicated ? 1 : 0), `${label} partition is missing or outside its role`)
    requireFact(typeof state.ready === 'boolean' && typeof state.partitionReady === 'boolean', `${label} readiness fields are missing or malformed`)
  }
  return states
}

/** Intermediate samples may contain no owner, or unsettled expected counts.
 * They may never turn an absent count into zero or two positive counts into
 * the first owner found. The three HTTP responses are sampled, not atomic. */
export function classifyDedicatedOwnership(states, options) {
  assertDedicatedTopology(states, options)
  const owners = []
  for (const state of states) {
    for (const field of ['ownedWorkspaceCount', 'expectedWorkspaceCount']) {
      requireFact(Number.isSafeInteger(state[field]) && state[field] >= 0 && state[field] <= 1,
        `${state.cellId} ${field} must be an integer from 0 to 1`)
    }
    if (state.ownedWorkspaceCount === 1) owners.push(state.cellId)
  }
  if (owners.length > 1) {
    const error = new Error('Dedicated gate: multiple cells report ownership of the only workspace')
    error.code = 'DEDICATED_MULTIPLE_OWNERS'
    throw error
  }
  return owners[0] ?? null
}

export function assertDedicatedOwner(states, options, destinationCellId) {
  requireFact(CELL_IDS.includes(destinationCellId), 'destination cell identity is invalid')
  const owner = classifyDedicatedOwnership(states, options)
  requireFact(owner === destinationCellId, `target workspace is not uniquely owned by ${destinationCellId}`)
  for (const state of states) {
    const expected = state.cellId === destinationCellId ? 1 : 0
    requireFact(state.ownedWorkspaceCount === expected && state.expectedWorkspaceCount === expected,
      `${state.cellId} ownership and expected counts have not converged`)
  }
  const destination = states.find(state => state.cellId === destinationCellId)
  requireFact(destination.ready === true && destination.partitionReady === true && destination.partitionIndex !== null,
    `${destinationCellId} is not a ready partition owner`)
  return destination
}

/** Pin the already warm partitions, independently of workspace ownership.
 * Losing/reacquiring a partition or restarting a cell is another experiment. */
export function dedicatedPartitionIdentity(states) {
  requireFact(Array.isArray(states) && states.length === 3, 'three partition identities are required')
  requireFact(new Set(states.map(state => state.cellId)).size === 3
    && states.every(state => CELL_IDS.includes(state.cellId)), 'partition cell identities differ')
  return [...states].sort((a, b) => a.cellId.localeCompare(b.cellId)).map(state => {
    requireFact(nonempty(state.bootObservedAt) && Number.isFinite(Date.parse(state.bootObservedAt)), 'cell boot epoch is missing')
    for (const key of ['partitionAcquisitionCount', 'partitionLossCount']) {
      requireFact(Number.isSafeInteger(state[key]) && state[key] >= 0, 'partition counter is missing or invalid')
    }
    requireFact(state.partitionReady === (state.partitionIndex !== null), 'warm partition readiness changed')
    return Object.fromEntries(['cellId', 'bootObservedAt', 'partitionIndex', 'partitionReady',
      'partitionAcquisitionCount', 'partitionLossCount'].map(key => [key, state[key]]))
  })
}

/** npm prints command preambles before fsck's JSON object. Decode that one
 * complete object; never salvage a clean report from multiple reports or a
 * later JSON fragment. Exit status can also describe unrelated shared roots. */
export function parseDedicatedFsck(stdout, workspace) {
  assertWorkspace(workspace)
  requireFact(typeof stdout === 'string', 'fsck output is not text')
  const start = stdout.search(/^\s*\{/m)
  requireFact(start >= 0, 'fsck JSON object is missing')
  let result
  try { result = JSON.parse(stdout.slice(start)) }
  catch { throw new Error('Dedicated gate: fsck JSON is malformed or contains trailing output') }
  requireFact(record(result) && Array.isArray(result.reports) && result.reports.length === 1,
    'fsck must return exactly one report')
  const report = result.reports[0]
  requireFact(record(report) && record(report.workspace) && sameWorkspace(report.workspace, workspace),
    'fsck report does not identify the target workspace')
  requireFact(report.status === 'clean', 'fsck target workspace is not clean')
  requireFact(Array.isArray(result.sharedRoots), 'fsck shared-root results are missing')
  for (const finding of result.sharedRoots) {
    requireFact(record(finding) && nonempty(finding.rootUrl) && Array.isArray(finding.workspaces) && finding.workspaces.length >= 2,
      'fsck shared-root result is malformed')
    for (const related of finding.workspaces) {
      assertWorkspace(related)
      requireFact(!sameWorkspace(related, workspace), 'fsck shared root includes the target workspace')
    }
  }
  return result
}
