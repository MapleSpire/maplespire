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

// Runs the CRDT-vs-read-model comparison and publishes the verdict.
//
// ⚠️ OFF BY DEFAULT AND NOT A HEALTH SIGNAL (READ_MODEL_DIVERGENCE=on to run it).
//
// The CRDT operand comes from crdtInventory.ts, which re-walks the graph
// independently of the projector's extractor, and five entity kinds are
// compared. Known limitations:
//   1. It ERRORS on many real workspaces. The inventory throws on a
//      registry-advertised diagram document that cannot resolve; the projector
//      deliberately tolerates that state ("metadata stays queryable, only its
//      optional flows are absent"). An erroring run compares nothing at all.
//   2. The `flow` kind compares a REGISTRY against a POSTING TABLE.
//      ro_connection_flows holds one row per (flow, connectionId), and only a
//      MessageStep carries connectionId — so a flow whose steps are all
//      introduction/process/conclusion produces ZERO rows by design, and is a
//      permanent false positive.
//   3. The independence is real at the module boundary but not in the logic: a
//      shard that resolves as a record with no `objects` field still yields an
//      empty set with no error, like the extractor's `?? {}`, and the tombstone
//      rule is the same rule — so those defects are invisible here too.
//
// A better shape would be a writer-side count manifest checked continuously,
// with the id-level walk moved to an on-demand endpoint. Until then: `clean`
// means NOT MEASURED, and `diverged` is record-only.
//
// SCOPE, deliberately narrow: this compares PRESENCE (which ids exist on each
// side), not field content. Comparing fields would mean reproducing the
// projector's normalisation exactly — `normalized_name`, `effective_parent_id`,
// `tree_sort_order` and friends are derived, not copied — and getting that
// wrong yields permanent false positives on every workspace. `comparePass`
// already supports field comparison once that mapping is verified.

import type { Pool } from 'pg'

import {
  comparePass,
  confirmDivergence,
  summarizeDivergence,
  type ComparableEntity,
  type DivergenceItem,
  type DivergencePass,
  type EntityKind,
} from './divergence.js'
import type { CrdtInventory } from './crdtInventory.js'

/** The five kinds and the ro_ table each is compared against. Adding a kind is
 * one row here plus one in the inventory. */
const KINDS: ReadonlyArray<{ kind: EntityKind; field: keyof CrdtInventory; sql: string }> = [
  { kind: 'object', field: 'objects', sql: 'SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2' },
  { kind: 'connection', field: 'connections', sql: 'SELECT id FROM ro_connections WHERE landscape_id = $1 AND version_id = $2' },
  { kind: 'group', field: 'groups', sql: 'SELECT id FROM ro_groups WHERE landscape_id = $1 AND version_id = $2' },
  { kind: 'diagram', field: 'diagrams', sql: 'SELECT id FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2' },
  // Flows are keyed by (diagram, flow) on both sides; a flow id is only unique
  // within its diagram.
  { kind: 'flow', field: 'flows', sql: "SELECT DISTINCT diagram_id || ':' || flow_id AS id FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2" },
]

export interface WorkspaceKey { landscapeId: string; versionId: string }

export interface DivergenceRunResult {
  workspace: WorkspaceKey
  ranAt: string
  outcome: 'clean' | 'diverged' | 'inconclusive' | 'error'
  confirmed: DivergenceItem[]
  healed: number
  reason?: string
  counts: DivergencePass['counts']
  durationMs: number
}

let lastRun: DivergenceRunResult | null = null

export function lastDivergenceRun(): DivergenceRunResult | null {
  return lastRun
}

async function readModelEntities(pool: Pool, workspace: WorkspaceKey): Promise<Record<EntityKind, ComparableEntity[]>> {
  const results = await Promise.all(KINDS.map((k) =>
    pool.query<{ id: string }>(k.sql, [workspace.landscapeId, workspace.versionId])))
  const out = {} as Record<EntityKind, ComparableEntity[]>
  KINDS.forEach((k, index) => {
    out[k.kind] = results[index]!.rows.map((row) => ({ id: row.id, fields: {} }))
  })
  return out
}

async function projectedGeneration(pool: Pool, workspace: WorkspaceKey): Promise<number | null> {
  const { rows } = await pool.query<{ projected_generation: string | null }>(
    'SELECT projected_generation FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
    [workspace.landscapeId, workspace.versionId],
  )
  const raw = rows[0]?.projected_generation
  return raw === undefined || raw === null ? null : Number(raw)
}

export interface DivergenceRunOptions {
  pool: Pool
  workspace: WorkspaceKey
  /** Materialise the CRDT side. Injected so this module needs no Repo of its
   * own and stays unit-testable; the caller binds it to the server's repo. */
  loadCrdtEntities: () => Promise<CrdtInventory>
  /** Gap between the two passes. A difference that survives it, at an unchanged
   * projection generation, is divergence rather than lag. */
  graceMs?: number
  maxItems?: number
  sleep?: (ms: number) => Promise<void>
}

export async function runDivergenceCheck(options: DivergenceRunOptions): Promise<DivergenceRunResult> {
  const { pool, workspace, loadCrdtEntities, graceMs = 5_000, maxItems = 50 } = options
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = Date.now()

  const onePass = async (): Promise<DivergencePass> => {
    const [crdt, ro] = await Promise.all([loadCrdtEntities(), readModelEntities(pool, workspace)])
    const counts = {} as DivergencePass['counts']
    const items: DivergenceItem[] = []
    for (const { kind, field } of KINDS) {
      const left: ComparableEntity[] = (crdt[field] ?? []).map((id) => ({ id, fields: {} }))
      const right = ro[kind] ?? []
      counts[kind] = { crdt: left.length, readModel: right.length }
      items.push(...comparePass(kind, left, right, { maxItems }))
    }
    return { counts, items }
  }

  try {
    const generationBefore = await projectedGeneration(pool, workspace)
    const first = await onePass()
    await sleep(graceMs)
    const second = await onePass()
    const generationAfter = await projectedGeneration(pool, workspace)

    const verdict = confirmDivergence(first, second, { generationBefore, generationAfter })
    lastRun = {
      workspace,
      ranAt: new Date().toISOString(),
      outcome: verdict.outcome,
      confirmed: verdict.confirmed,
      healed: verdict.healed,
      reason: verdict.reason,
      counts: second.counts,
      durationMs: Date.now() - startedAt,
    }
    if (verdict.outcome === 'diverged') {
      console.warn(
        `[divergence] ${workspace.landscapeId}/${workspace.versionId} DIVERGED: ${summarizeDivergence(verdict.confirmed)}`,
      )
    }
    return lastRun
  } catch (error) {
    // An error is NOT a clean run. Recording it as its own outcome keeps a
    // broken checker from reading as a healthy system.
    lastRun = {
      workspace,
      ranAt: new Date().toISOString(),
      outcome: 'error',
      confirmed: [],
      healed: 0,
      reason: error instanceof Error ? error.message : String(error),
      counts: {} as DivergencePass['counts'],
      durationMs: Date.now() - startedAt,
    }
    return lastRun
  }
}
