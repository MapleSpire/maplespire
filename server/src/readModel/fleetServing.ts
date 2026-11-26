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

import type { WorkspaceKey } from './projector.js'
import { ProjectorOwnershipError, ProjectorStaticWorkspaceError, type ProjectorFleet } from './projectorService.js'
import { ColdBuildAdmissionStoppedError } from './coldBuildAdmission.js'
import type { WorkspaceCompactionDeps } from './workspaceCompaction.js'

/**
 * WHICH QUESTION EACH CALLER OF THE FLEET ASKS (G4-16f C6-2b).
 *
 * With `READ_MODEL_ADOPT=on` a workspace can be SERVING — an adopting start
 * has claimed it and serves the kept rows, under a status that refuses
 * freshness (`idle`), while its attach runs in the background — before it is
 * RESIDENT (attached). The two answers differ in that window, and each caller
 * of `index.ts` needs exactly one of them. They are named here, one function
 * per caller, so the choice is a tested fact rather than a call in a file no
 * test boots (`index.ts` passes the fleet, and nothing else):
 *
 *  - the read route serves rows, so it asks `isServing` (the owner's
 *    decision 1 of 2026-11-07: ready right after the verify and the claim);
 *  - boot readiness turns true at serving, for the same reason;
 *  - compaction (its acknowledgement and instance checks), divergence
 *    detection and the promotion's instance check need the attach done, so
 *    they ask `isResident`.
 *
 * LIMITS, named rather than implied: the call SITES in `index.ts`'s
 * `main()` are booted by no test, so replacing a helper there by the
 * fleet's raw predicate stays green (the helpers themselves are tested,
 * `fleetServing.test.ts`). Three callers take the fleet directly, on
 * purpose: live residency (`liveWorkspaceResidency.ts`, `isResident`; its
 * `ensured` counter also counts a start that resolved at serving), the
 * promotion's `residentProjectorInstanceId` (null while only serving — the
 * promotion is refused by the `idle` freshness then), and the demotion's
 * re-attach (a plain `ensure`, its result unused).
 */

/** The read route's gate (`ensureWorkspace`): true when this cell serves the
 * workspace's rows now — and then the read is a use, for the LRU (`touch`
 * is a no-op while the start is only serving: it is not in the LRU yet). */
export function readRouteServes(fleet: Pick<ProjectorFleet, 'isServing' | 'touch'>, key: WorkspaceKey): boolean {
  if (!fleet.isServing(key)) return false
  fleet.touch(key)
  return true
}

/** Boot readiness's ensure of the default workspace: resolves when it is
 * SERVED (an adopting start: at its claim; a cold build: when attached).
 *
 * The background attach's outcome is then WATCHED: before
 * C6-2b a failed default attach failed the boot; now the pod is already
 * ready when it fails, so `onAttachFailed` is the only trace — called for a
 * failure that is not an ownership loss, a static workspace or a stop (the
 * ordinary ends). Readiness is not withdrawn: the owner's decision makes the
 * pod ready at serving, and the next read re-ensures (a cold build). */
export async function ensureServedForReadiness(
  fleet: Pick<ProjectorFleet, 'ensure'>,
  key: WorkspaceKey,
  onAttachFailed: (error: unknown) => void = (error) => console.error(JSON.stringify({
    event: 'read_model.boot_attach_failed',
    workspace: `${key.landscapeId}/${key.versionId}`,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })),
): Promise<boolean> {
  const served = await fleet.ensure(key, { until: 'serving' })
  // One microtask after the serving resolution: the same start's memo (or
  // the resident entry). Its attach cannot settle in between (each of its
  // remaining steps awaits I/O), so this does not start a second one.
  if (served) fleet.ensure(key, { until: 'attached' }).catch((error: unknown) => {
    if (error instanceof ProjectorOwnershipError || error instanceof ProjectorStaticWorkspaceError
      || error instanceof ColdBuildAdmissionStoppedError) return
    try { onAttachFailed(error) } catch { /* the trace's own failure must not reach the process */ }
  })
  return served
}

/** The divergence scheduler's eligibility: a RESIDENT projector only — the
 * detector compares the rows against the documents, and an attach still
 * catching up would read as divergence. */
export function divergenceEligible(fleet: Pick<ProjectorFleet, 'isResident'>, key: WorkspaceKey): boolean {
  return fleet.isResident(key)
}

/** The fleet as compaction sees it: RESIDENT means attached. Every
 * `ensure` compaction makes is `{ adopt: false }` (`workspaceCompaction.ts`),
 * which resolves at full attach. */
export function compactionFleet(fleet: ProjectorFleet): WorkspaceCompactionDeps['fleet'] {
  return {
    isResident: (key) => fleet.isResident(key),
    ensure: (key, options) => fleet.ensure(key, options),
    release: (key, reason) => fleet.release(key, reason),
    endCompactionWindow: (key) => fleet.endCompactionWindow(key),
    residentProjectorInstanceId: (key) => fleet.residentProjectorInstanceId(key) ?? null,
  }
}
