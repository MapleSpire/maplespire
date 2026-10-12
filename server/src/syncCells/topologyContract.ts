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

export const MAX_TOPOLOGY_PARTITIONS = 1_024
const GENERATION = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const MAX_CONTRACT_LENGTH = 8_192

export function isTopologyGeneration(value: unknown): value is string {
  return typeof value === 'string' && GENERATION.test(value)
}

export type TopologyContractFailureReason =
  | 'input-invalid' | 'input-too-long' | 'generation-invalid' | 'count-invalid'
  | 'arity-invalid' | 'version-unsupported' | 'fields-invalid' | 'mode-invalid'
  | 'reserved-invalid' | 'non-canonical'

export class SyncCellTopologyContractFormatError extends Error {
  readonly code = 'sync_cell_topology_contract_invalid'
  constructor(readonly reason: TopologyContractFailureReason) {
    super(`Invalid sync-cell topology contract (${reason})`)
    this.name = 'SyncCellTopologyContractFormatError'
  }
}

export interface TopologyContract {
  /** Already effective; the codec never adds or removes a mapping fingerprint. */
  generation: string
  partitionCount: number
  placementMode: 'shadow' | 'placed'
  reservedPartitions: readonly number[]
}

export interface TopologyContractInput {
  generation: string
  partitionCount: number
  placementMode?: TopologyContract['placementMode']
  reservedPartitions?: readonly number[]
}

export interface ParsedTopologyContract {
  encoding: 'legacy' | 'v1'
  contract: TopologyContract
}

function refuse(reason: TopologyContractFailureReason): never {
  throw new SyncCellTopologyContractFormatError(reason)
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_TOPOLOGY_PARTITIONS
}

/** The same reservation validation serves the wire codec and local config.
 * Return a canonical copy: callers never sort the operator's array in place. */
export function normalizeReservedPartitions(reserved: readonly number[], partitionCount: number): number[] {
  if (!validCount(partitionCount)) refuse('count-invalid')
  if (!Array.isArray(reserved) || [...reserved].some(index =>
    !Number.isSafeInteger(index) || index < 0 || index >= partitionCount)) refuse('reserved-invalid')
  if (new Set(reserved).size !== reserved.length) refuse('reserved-invalid')
  return [...reserved].sort((a, b) => a - b)
}

/** The short default remains byte-compatible with generation|count.
 * Placement and reservations share the existing v1 contract value; neither
 * changes the effective generation or the workspace mapping fingerprint. */
export function formatTopologyContract(input: TopologyContractInput): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) refuse('input-invalid')
  if (!isTopologyGeneration(input.generation)) refuse('generation-invalid')
  if (!validCount(input.partitionCount)) refuse('count-invalid')
  const mode = input.placementMode === undefined ? 'shadow' : input.placementMode
  if (mode !== 'shadow' && mode !== 'placed') refuse('mode-invalid')
  const reserved = input.reservedPartitions === undefined ? [] : input.reservedPartitions
  const indices = normalizeReservedPartitions(reserved, input.partitionCount)
  const base = `${input.generation}|${input.partitionCount}`
  if (mode === 'shadow' && indices.length === 0) return base
  return `${base}|v1|mode=${mode}|reserved=${indices.join(',')}`
}

/** Parse only canonical values; malformed presence is never Redis absence.
 * Lease values have a different grammar and must not use this parser. */
export function parseTopologyContract(raw: unknown): ParsedTopologyContract {
  if (typeof raw !== 'string' || raw.length === 0) refuse('input-invalid')
  if (raw.length > MAX_CONTRACT_LENGTH) refuse('input-too-long')
  const parts = raw.split('|')
  if (parts.length !== 2 && parts.length !== 5) refuse('arity-invalid')
  const [generation, count] = parts
  if (!isTopologyGeneration(generation)) refuse('generation-invalid')
  if (!/^[1-9][0-9]*$/.test(count)) refuse('count-invalid')
  const partitionCount = Number(count)
  if (!validCount(partitionCount)) refuse('count-invalid')
  if (parts.length === 2) {
    return { encoding: 'legacy', contract: { generation, partitionCount, placementMode: 'shadow', reservedPartitions: [] } }
  }
  if (parts[2] !== 'v1') refuse('version-unsupported')
  if (!parts[3].startsWith('mode=') || !parts[4].startsWith('reserved=')) refuse('fields-invalid')
  const placementMode = parts[3].slice('mode='.length)
  if (placementMode !== 'shadow' && placementMode !== 'placed') refuse('mode-invalid')
  const list = parts[4].slice('reserved='.length)
  const tokens = list === '' ? [] : list.split(',')
  if (tokens.some(token => !/^(0|[1-9][0-9]*)$/.test(token))) refuse('reserved-invalid')
  const reservedPartitions = tokens.map(Number)
  const contract: TopologyContract = { generation, partitionCount, placementMode, reservedPartitions }
  // The formatter checks range/duplicates and sorts a copy. Requiring its exact
  // bytes refuses unsorted input and the extended spelling of the short default.
  if (formatTopologyContract(contract) !== raw) refuse('non-canonical')
  return { encoding: 'v1', contract }
}
