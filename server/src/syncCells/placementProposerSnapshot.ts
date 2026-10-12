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

import type { Queryable } from '../readModel/types.js'
import type { PlacementAdmissionInput, PlacementWorkspaceFact } from './placementHysteresis.js'
import { formatTopologyContract, parseTopologyContract, type TopologyContract } from './topologyContract.js'
import { captureSignatureSql, COVERAGE_TABLE, PROPOSAL_TABLE, proposerSchemaName } from './placementProposerSchema.js'

export type CensusWorkspace = Omit<PlacementWorkspaceFact, 'activity'>
export interface ProposerSnapshot {
  readonly atUs: bigint
  readonly topology: Readonly<TopologyContract>
  readonly workspaces: readonly CensusWorkspace[]
  readonly history: PlacementAdmissionInput['history']
}
/** Resource refusal bound, not a measured capacity claim or a sampled census. */
export const PROPOSER_MAX_ROWS = 100_000
const us = (sql: string): string => `(EXTRACT(epoch FROM ${sql}) * 1000000)::bigint::text`
export function postgresMicros(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new Error('invalid-pg-microseconds')
  const result = BigInt(value)
  if (result > 8_640_000_000_000_000_000n) throw new Error('invalid-pg-microseconds')
  return result
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-proposal-history')
  return value as Record<string, unknown>
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\u0000')) {
    throw new Error('invalid-proposal-history')
  }
  return value
}

/** One statement snapshot. Histories deliberately have no JOIN to living
 * identities and no target/generation/window filter. Timestamps are TEXT inside
 * JSON too: node-postgres Date and JSON numbers would lose microseconds. */
export async function readPlacementProposerSnapshot(db: Queryable, schema: string): Promise<ProposerSnapshot> {
  const s = proposerSchemaName(schema)
  const result = await db.query<{
    at_us: string; topology: string | null; census: CensusWorkspace[]
    coverage: { kind: string; origin: string; from_us: string; from_beginning: boolean; valid: boolean }[]
    proposals: { id: string; landscape_id: string; at_us: string; payload: unknown }[]
    movements: { id: string; landscape_id: string; version_id: string; at_us: string; from_cell_id: string; to_cell_id: string }[]
  }>(`SELECT ${us('statement_timestamp()')} AS at_us,
    (SELECT value FROM ${s}.sync_topology_contract WHERE singleton) AS topology,
    COALESCE((SELECT jsonb_agg(c) FROM (
      SELECT v.landscape_id AS "landscapeId", v.id AS "versionId",
        l.tier, l.org_id AS "orgId", o.status AS "orgStatus",
        CASE WHEN p.landscape_id IS NULL THEN NULL
          ELSE jsonb_build_object('generation', p.topology_generation, 'partition', p.partition) END AS placement
      FROM ${s}.versions v
      LEFT JOIN ${s}.landscapes l ON l.id = v.landscape_id
      LEFT JOIN ${s}.orgs o ON o.id = l.org_id
      LEFT JOIN ${s}.workspace_placement p ON p.landscape_id = v.landscape_id AND p.version_id = v.id
        AND p.topology_generation = split_part(
          (SELECT value FROM ${s}.sync_topology_contract WHERE singleton), '|', 1)
      WHERE v.status = 'active' ORDER BY v.landscape_id COLLATE "C", v.id COLLATE "C"
      LIMIT ${PROPOSER_MAX_ROWS + 1}) c), '[]'::jsonb) AS census,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'origin', origin::text,
      'from_us', ${us('from_at')}, 'from_beginning', from_beginning,
      'valid', protocol = 1 AND capture_signature = CASE kind
        WHEN 'movements' THEN ${captureSignatureSql(schema, 'movements')}
        WHEN 'proposals' THEN ${captureSignatureSql(schema, 'proposals')} END))
      FROM ${s}.${COVERAGE_TABLE}), '[]'::jsonb) AS coverage,
    COALESCE((SELECT jsonb_agg(p) FROM (
      SELECT proposal_id::text AS id, landscape_id, ${us('proposed_at')} AS at_us, payload
      FROM ${s}.${PROPOSAL_TABLE} ORDER BY proposed_at, proposal_id
      LIMIT ${PROPOSER_MAX_ROWS + 1}) p), '[]'::jsonb) AS proposals,
    COALESCE((SELECT jsonb_agg(m) FROM (
      SELECT move_id::text AS id, landscape_id, version_id, ${us('moved_at')} AS at_us,
        from_cell_id, to_cell_id FROM ${s}.sync_workspace_placement_moves
      ORDER BY moved_at, move_id LIMIT ${PROPOSER_MAX_ROWS + 1}) m), '[]'::jsonb) AS movements`)
  const row = result.rows[0]
  if (!row || [row.census, row.proposals, row.movements].some(rows =>
    !Array.isArray(rows) || rows.length > PROPOSER_MAX_ROWS)) throw new Error('proposer-snapshot-overflow')
  const atUs = postgresMicros(row.at_us)
  const topology = parseTopologyContract(row.topology).contract
  const keys = new Set<string>()
  for (const w of row.census) {
    const key = JSON.stringify([identity(w.landscapeId), identity(w.versionId)])
    if (keys.has(key) || !['standard', 'enterprise'].includes(w.tier)
      || (w.orgId !== null && typeof w.orgId !== 'string')
      || (w.orgStatus !== null && typeof w.orgStatus !== 'string')
      || (w.placement !== null && (w.placement.generation !== topology.generation
        || !Number.isSafeInteger(w.placement.partition) || w.placement.partition < 0
        || w.placement.partition >= topology.partitionCount))) throw new Error('invalid-proposer-census')
    keys.add(key)
  }
  function coverage(kind: string) {
    const values = row.coverage.filter(item => item.kind === kind)
    if (values.length !== 1 || values[0].valid !== true) return null
    const item = values[0]
    return { fromUs: postgresMicros(item.from_us), throughUs: atUs,
      origin: identity(item.origin), fromBeginning: item.from_beginning }
  }
  const proposals: PlacementAdmissionInput['history']['proposals'][number][] = []
  for (const p of row.proposals) {
    const payload = object(p.payload)
    if (payload.protocol !== 1 || !Array.isArray(payload.members) || payload.members.length === 0
      || payload.landscapeId !== p.landscape_id || payload.evaluatedAtUs !== p.at_us
      || payload.memberCount !== payload.members.length
      || typeof payload.contract !== 'string' || typeof payload.intent !== 'string'
      || !/^[a-f0-9]{64}$/.test(payload.intent) || !payload.policy || !payload.proof) {
      throw new Error('invalid-proposal-history')
    }
    const proof = object(payload.proof)
    if (!Array.isArray(proof.census) || !Array.isArray(proof.grants)) throw new Error('invalid-proposal-history')
    const censusMembers = proof.census.map(object).filter(w => w.landscapeId === p.landscape_id)
      .map(w => JSON.stringify([identity(w.landscapeId), identity(w.versionId)])).sort()
    const policy = object(payload.policy)
    if (policy.id !== payload.policyId || typeof policy.id !== 'string'
      || ['activeWeight', 'idleWeight', 'activityLookbackMs', 'entryGain', 'returnGain',
        'entryStableMs', 'returnStableMs', 'maxSampleGapMs', 'maxSignalAgeMs'].some(key =>
        !Number.isSafeInteger(policy[key]) || Number(policy[key]) <= 0)) throw new Error('invalid-proposal-history')
    const contract = parseTopologyContract(payload.contract).contract
    const members = new Set<string>()
    for (const raw of payload.members) {
      const member = object(raw)
      const workspace = { landscapeId: identity(member.landscapeId), versionId: identity(member.versionId) }
      const key = JSON.stringify([workspace.landscapeId, workspace.versionId])
      if (workspace.landscapeId !== p.landscape_id || members.has(key)
        || !Number.isSafeInteger(member.fromPartition) || !Number.isSafeInteger(member.toPartition)
        || Number(member.fromPartition) < 0 || Number(member.fromPartition) >= contract.partitionCount
        || Number(member.toPartition) < 0 || Number(member.toPartition) >= contract.partitionCount) {
        throw new Error('invalid-proposal-history')
      }
      members.add(key)
      proposals.push({ id: identity(p.id), workspace, atUs: postgresMicros(p.at_us),
        fromPartition: Number(member.fromPartition), toPartition: Number(member.toPartition), topology: contract })
      if (proposals.length > PROPOSER_MAX_ROWS) throw new Error('proposer-snapshot-overflow')
    }
    if (JSON.stringify(censusMembers) !== JSON.stringify([...members].sort())) throw new Error('incomplete-proposal-history')
  }
  const movements = row.movements.map(m => ({
    id: identity(m.id), workspace: { landscapeId: identity(m.landscape_id), versionId: identity(m.version_id) },
    atUs: postgresMicros(m.at_us), fromCellId: identity(m.from_cell_id), toCellId: identity(m.to_cell_id),
  }))
  if (proposals.some(p => p.atUs > atUs) || movements.some(m => m.atUs > atUs || m.fromCellId === m.toCellId)) {
    throw new Error('invalid-proposer-history-clock')
  }
  return { atUs, topology, workspaces: row.census, history: {
    proposalCoverage: coverage('proposals'), movementCoverage: coverage('movements'), proposals, movements,
  } }
}

export function censusSignature(snapshot: ProposerSnapshot): string {
  return JSON.stringify([formatTopologyContract(snapshot.topology), snapshot.workspaces])
}
