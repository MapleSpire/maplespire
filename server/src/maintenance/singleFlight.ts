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
 * The IN-PROCESS half of "two maintenance passes never overlap".
 *
 * The other half is cluster-wide and lives in `MaintenanceCoordinator`: one
 * advisory lock per job name, so a second replica is refused. That one stops at
 * the process boundary — it is taken per job NAME on a connection this replica
 * already holds, so a replica asking itself for a job it is already running is
 * not a second holder and is not refused. Overlap inside one process is excluded
 * here instead: the in-flight promise is handed back, so the second caller joins
 * the first run rather than starting another.
 *
 * Used by `runCompaction` and `runGc` in `index.ts`. Extracted so the exclusion
 * can be tested: with per-workspace due-work in place of the per-job-name lock,
 * this is the ONLY thing between two compactions in one replica — see
 * `compactionExclusionToday.integration.test.ts`.
 *
 * Lifetime walk (every `await` between acquisition and release) — acquisition is setting the latch, release
 * is clearing it, and there is exactly ONE await in between:
 *
 *   - `task()` throwing SYNCHRONOUSLY never assigns, so the latch is never taken
 *     and the throw propagates with nothing to release. (Both call sites pass an
 *     async function, which cannot throw synchronously; the shape is safe anyway,
 *     which is the point of walking it rather than assuming the callers.)
 *   - `await inFlight` is the only await, and `finally` clears on BOTH settle
 *     paths. A rejected pass therefore leaves the latch clear: one failure must
 *     not wedge the job until the process restarts.
 *   - A follower returns at the guard and never reaches the `finally`, so it
 *     cannot clear a latch belonging to a run it did not start.
 */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return async () => {
    if (inFlight) return inFlight
    inFlight = task()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }
}
