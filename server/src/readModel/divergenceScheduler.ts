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

// Schedules the divergence check.
//
// ONE workspace per tick, round-robin. Checking every workspace on a timer
// would materialise every model on the same event loop the sync fan-out and the
// projector share. A slow sweep that never hurts anyone beats a thorough one
// that gets disabled.
//
// Only RESIDENT, OWNED workspaces are eligible:
//   - materialising a non-resident workspace would start an O(workspace) cold
//     build as a side effect of monitoring;
//   - a workspace this cell does not own is another cell's business, and its
//     projection state row is not ours to interpret.
// Both are skips, not failures — a skipped tick leaves the previous verdict.

import type { Pool } from 'pg'

import { runDivergenceCheck, type DivergenceRunResult, type WorkspaceKey } from './divergenceRunner.js'
import type { CrdtInventory } from './crdtInventory.js'

export interface DivergenceSchedulerOptions {
  pool: Pool
  /** Materialise the CRDT side for one workspace. Injected so this module holds
   * no Repo and stays testable. */
  loadCrdtEntities: (workspace: WorkspaceKey) => Promise<CrdtInventory>
  isEligible: (workspace: WorkspaceKey) => boolean
  intervalMs?: number
  graceMs?: number
  now?: () => number
}

/** Workspaces that have ever been projected. The check has nothing to compare
 * against for a workspace with no projection state, and calling it "clean"
 * would be the false PASS this detector exists to prevent. */
export async function eligibleWorkspaces(pool: Pool): Promise<WorkspaceKey[]> {
  const { rows } = await pool.query<{ landscape_id: string; version_id: string }>(
    `SELECT landscape_id, version_id FROM read_model_projection_state
     WHERE projected_generation IS NOT NULL
     ORDER BY landscape_id, version_id`,
  )
  return rows.map((row) => ({ landscapeId: row.landscape_id, versionId: row.version_id }))
}

/** Pick the next workspace after `cursor`, wrapping. Returns null when none is
 * eligible, so the caller can distinguish "nothing to do" from "checked". */
export function nextWorkspace(
  candidates: readonly WorkspaceKey[],
  cursor: string | null,
): WorkspaceKey | null {
  if (candidates.length === 0) return null
  if (cursor === null) return candidates[0]!
  const keyOf = (key: WorkspaceKey) => `${key.landscapeId}/${key.versionId}`
  const index = candidates.findIndex((key) => keyOf(key) === cursor)
  // A cursor whose workspace disappeared restarts the sweep rather than
  // stalling on it forever.
  return candidates[(index + 1) % candidates.length]!
}

/** What the last tick could even attempt. Without this, "no workspace was
 * eligible" is indistinguishable from "the scheduler never ran" — both leave the
 * verdict at never-run, and a detector that silently checks NOTHING is the exact
 * false-clean this module exists to prevent (e.g. several projected workspaces,
 * none of them resident and owned, so no tick ever produces a verdict). */
export interface DivergenceSweepState {
  lastTickAt: string | null
  candidates: number
  eligible: number
  checked: string | null
}

let sweep: DivergenceSweepState = { lastTickAt: null, candidates: 0, eligible: 0, checked: null }

export function divergenceSweepState(): DivergenceSweepState {
  return sweep
}

export function startDivergenceScheduler(options: DivergenceSchedulerOptions): () => void {
  const intervalMs = Math.max(60_000, options.intervalMs ?? 15 * 60_000)
  let cursor: string | null = null
  let stopped = false
  let running = false

  const tick = async (): Promise<DivergenceRunResult | null> => {
    if (stopped || running) return null
    running = true
    try {
      const all = await eligibleWorkspaces(options.pool)
      const eligible = all.filter(options.isEligible)
      const workspace = nextWorkspace(eligible, cursor)
      sweep = {
        lastTickAt: new Date().toISOString(),
        candidates: all.length,
        eligible: eligible.length,
        checked: workspace ? `${workspace.landscapeId}/${workspace.versionId}` : null,
      }
      if (!workspace) return null
      cursor = sweep.checked
      return await runDivergenceCheck({
        pool: options.pool,
        workspace,
        loadCrdtEntities: () => options.loadCrdtEntities(workspace),
        graceMs: options.graceMs,
      })
    } catch (error) {
      // The sweep failing is not the same as a workspace diverging, and it must
      // not overwrite a real verdict. runDivergenceCheck records its own
      // per-workspace errors; this catch covers only the enumeration.
      console.warn('[divergence] scheduler tick failed:', error)
      return null
    } finally {
      running = false
    }
  }

  // Run once at startup. Waiting a full interval for the first answer means a
  // freshly booted cell reports never-run for 15 minutes, which is the window an
  // operator is most likely to be looking.
  void tick()
  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
