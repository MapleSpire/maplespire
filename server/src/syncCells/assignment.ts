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

import { createHash } from 'node:crypto'
import type { WorkspaceKey } from '../rbac/docScope.js'
import { isTopologyGeneration, MAX_TOPOLOGY_PARTITIONS as MAX_PARTITIONS, normalizeReservedPartitions, type TopologyContract } from './topologyContract.js'

const UINT64_MASK = (1n << 64n) - 1n

/** Identity of the finite workspace mapping corpus in assignment.test.ts:
 * SHA-256 of its versioned UTF-8 JSON, truncated to the first 16 hex characters.
 * This excludes partitionProbeOrder and is not a hash of the executable code.
 * It is part of the effective topology generation, so changing it requires a
 * coordinated rollout/rollback across every cell and router. */
export const MAPPING_FINGERPRINT = 'ce1461953e2b8ac2'

export interface SyncCellPartitionConfig {
  partitionCount: number
  placementMode: TopologyContract['placementMode']
  reservedPartitions: readonly number[]
  configuredGeneration: string
  effectiveGeneration: string
  /** Effective generation retained under the existing consumer-facing name. */
  topologyGeneration: string
}

export type SyncCellRole = 'pool' | `reserved:${number}`

/** A role belongs to one cell; only the reservation set belongs to the fleet. */
export function syncCellRole(raw: string | undefined, reserved: readonly number[]): SyncCellRole {
  const role = raw ?? 'pool'
  if (role === 'pool') return role
  const match = typeof role === 'string' ? /^reserved:(0|[1-9][0-9]*)$/.exec(role) : null
  if (!match || !reserved.includes(Number(match[1]))) {
    throw new Error('SYNC_CELL_ROLE must be pool or reserved:<partition> included in SYNC_CELL_RESERVED_PARTITIONS')
  }
  return role as SyncCellRole
}

export class SyncCellTopologyGenerationError extends Error {
  readonly code = 'sync_cell_topology_generation_invalid'
  constructor(readonly reason: 'configured-invalid' | 'fingerprint-invalid' | 'effective-too-long') {
    super(reason === 'configured-invalid'
      ? 'SYNC_CELL_TOPOLOGY_GENERATION must be a safe 1-64 character identifier'
      : reason === 'fingerprint-invalid'
        ? 'The mapping fingerprint must be exactly 16 lowercase hexadecimal characters'
        : 'The effective topology generation (configured generation plus mapping fingerprint) exceeds 64 characters')
    this.name = 'SyncCellTopologyGenerationError'
  }
}

/** Partition count is a cluster-wide correctness setting, so malformed values
 * fail boot instead of silently falling back to a different topology. */
export function syncCellPartitionConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  mappingFingerprint: string = MAPPING_FINGERPRINT,
): SyncCellPartitionConfig {
  const rawCount = env.SYNC_CELL_PARTITION_COUNT?.trim() || '1'
  const partitionCount = Number(rawCount)
  if (!Number.isSafeInteger(partitionCount) || partitionCount < 1 || partitionCount > MAX_PARTITIONS) {
    throw new Error(`SYNC_CELL_PARTITION_COUNT must be an integer between 1 and ${MAX_PARTITIONS}`)
  }
  // The topology contract signs the effective generation, so it rejects builds
  // declaring different mapping fingerprints (and its durable mirror is
  // compared before Redis creation). The finite test corpus plus review still
  // guards the literal's correspondence to code. Multiple partitions still
  // require explicit opt-in on every cell and router.
  if (partitionCount > 1 && env.SYNC_CELL_MULTI_PARTITION?.trim().toLowerCase() !== 'on') {
    throw new Error(
      `SYNC_CELL_PARTITION_COUNT is ${partitionCount}, which needs SYNC_CELL_MULTI_PARTITION=on. `
      + 'The B3d2 topology contract rejects different mapping fingerprints through the effective '
      + 'generation; B3i compares its durable mirror before Redis creation. Set the flag on every '
      + 'cell and router and use the coordinated topology-change recipe in '
      + 'maplespire-sponsor-kit/docs/operations/sync-cell-ownership.md (T-B3).',
    )
  }
  const configuredGeneration = env.SYNC_CELL_TOPOLOGY_GENERATION?.trim().toLowerCase() || 'v1'
  if (!isTopologyGeneration(configuredGeneration)) throw new SyncCellTopologyGenerationError('configured-invalid')
  // Explicit parameter for testing distinct builds; deliberately no operator env override.
  if (typeof mappingFingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(mappingFingerprint)) {
    throw new SyncCellTopologyGenerationError('fingerprint-invalid')
  }
  const effectiveGeneration = `${configuredGeneration}.${mappingFingerprint}`
  if (!isTopologyGeneration(effectiveGeneration)) throw new SyncCellTopologyGenerationError('effective-too-long')
  const placementMode = env.SYNC_CELL_PLACEMENT_MODE ?? 'shadow'
  if (placementMode !== 'shadow' && placementMode !== 'placed') {
    throw new Error('SYNC_CELL_PLACEMENT_MODE must be shadow or placed')
  }
  const reservedText = env.SYNC_CELL_RESERVED_PARTITIONS?.trim() ?? ''
  const reservedTokens = reservedText === '' ? [] : reservedText.split(',').map(token => token.trim())
  if (reservedTokens.some(token => !/^(0|[1-9][0-9]*)$/.test(token))) {
    throw new Error('SYNC_CELL_RESERVED_PARTITIONS must be a comma-separated set of non-negative decimal partition indices')
  }
  const reservedPartitions = Object.freeze(normalizeReservedPartitions(reservedTokens.map(Number), partitionCount))
  // The mode belongs to the contract VALUE, never the generation used
  // by workspace_placement. Placed mode reads the placement snapshot; shadow
  // mode keeps the hash assignment.
  return { partitionCount, placementMode, reservedPartitions, configuredGeneration, effectiveGeneration, topologyGeneration: effectiveGeneration }
}

function hash64(value: string): bigint {
  const digest = createHash('sha256').update(value).digest()
  return digest.readBigUInt64BE(0)
}

/** Google's Jump Consistent Hash: O(log N), deterministic across runtimes and
 * only ~1/(N+1) of keys move when a planned topology grows from N to N+1. */
export function workspacePartition(workspace: WorkspaceKey, partitionCount: number): number {
  if (!Number.isSafeInteger(partitionCount) || partitionCount < 1 || partitionCount > MAX_PARTITIONS) {
    throw new Error('partitionCount is outside the supported range')
  }
  let key = hash64(`${workspace.landscapeId}\0${workspace.versionId}`)
  let bucket = -1
  let candidate = 0
  while (candidate < partitionCount) {
    bucket = candidate
    key = (key * 2_862_933_555_777_941_757n + 1n) & UINT64_MASK
    candidate = Math.floor((bucket + 1) * 2_147_483_648 / Number((key >> 33n) + 1n))
  }
  return bucket
}

/** Cells probe only their permitted slots in the existing stable order.
 * Reservation changes eligibility, not the workspace-to-partition mapping. */
export function partitionProbeOrder(
  cellId: string,
  partitionCount: number,
  reservedPartitions: readonly number[] = [],
  role: SyncCellRole = 'pool',
): number[] {
  if (!Number.isSafeInteger(partitionCount) || partitionCount < 1 || partitionCount > MAX_PARTITIONS) {
    throw new Error('partitionCount is outside the supported range')
  }
  const reserved = normalizeReservedPartitions(reservedPartitions, partitionCount)
  const validatedRole = syncCellRole(role, reserved)
  if (validatedRole !== 'pool') return [Number(validatedRole.slice('reserved:'.length))]
  const excluded = new Set(reserved)
  return Array.from({ length: partitionCount }, (_, partition) => ({
    partition,
    score: hash64(`${cellId}\0${partition}`),
  }))
    .sort((a, b) => a.score === b.score ? a.partition - b.partition : a.score > b.score ? -1 : 1)
    .map(({ partition }) => partition)
    .filter(partition => !excluded.has(partition))
}
