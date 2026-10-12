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

import { describe, expect, it, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import {
  ProjectorFleet,
  ProjectorStaticWorkspaceError,
  type startReadModelProjector,
} from './projectorService.js'
import { ColdBuildAdmission } from './coldBuildAdmission.js'
import { LiveWorkspaceResidency } from './liveWorkspaceResidency.js'

/**
 * The residency against the real fleet and the real admission, on a static
 * (or sparse-draft) workspace with live sync traffic.
 *
 * Without suppression, 60 s of one peer syncing a sparse draft would cost the
 * cold-build admission one `started`, one `failed` and one `SELECT EXISTS` per
 * 5 s throttle window, for a workspace that never had a cold build to fail —
 * and `failed` is the operator's "cold builds that failed" counter on
 * `/api/platform/read-model/projector-fleet`. The residency suppresses a
 * `retryable: false` refusal for ten minutes. The unit test pins that with a
 * stub error class; this pins it end to end: `ProjectorStaticWorkspaceError`
 * really carries `retryable: false` through `ColdBuildAdmission.run` and the
 * fleet, which is what makes the suppression fire in production.
 */

const STATIC_WS = { landscapeId: 'L', versionId: 'draft-1' }

function fakeDb(isStatic: boolean) {
  const seen: string[] = []
  return {
    seen,
    db: {
      query: async (text: string) => {
        seen.push(text)
        if (/read_model_static_workspaces/.test(text)) return { rows: [{ present: isStatic }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    } as never,
  }
}

describe('LiveWorkspaceResidency × ProjectorFleet — a static workspace with live traffic', () => {
  it('costs the admission ONE start, ONE failure and ONE static query, then is suppressed past every throttle window', async () => {
    const resolveRoot = vi.fn(async () => 'automerge:root')
    const startProjector = vi.fn(async () => vi.fn())
    const { db, seen } = fakeDb(true)
    const admission = new ColdBuildAdmission({ maxConcurrent: 2, maxQueued: 32 })
    const fleet = new ProjectorFleet(new Repo({}), resolveRoot, {
      fallbackRootUrl: 'automerge:fallback',
      db,
      coldBuildAdmission: admission,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    let now = 0
    const residency = new LiveWorkspaceResidency({
      fleet: () => fleet,
      isExpectedRefusal: (error) => error instanceof ProjectorStaticWorkspaceError,
      throttleMs: 5_000,
      now: () => now,
      log: () => undefined,
    })
    // 60 s of a peer syncing a sparse draft: one frame every 500 ms.
    for (let i = 0; i < 120; i += 1) {
      residency.noteOwnedActivity(STATIC_WS)
      await residency.pending(STATIC_WS)
      now += 500
    }
    const fleetSnap = fleet.snapshot()
    const staticQueries = seen.filter((q) => /read_model_static_workspaces/.test(q)).length
    expect(startProjector).not.toHaveBeenCalled()
    expect(resolveRoot).not.toHaveBeenCalled()
    expect(residency.snapshot()).toMatchObject({ ensuresRequested: 1, refused: 1, failed: 0, suppressed: 119, throttled: 0 })
    expect(fleetSnap.started).toBe(1)
    expect(fleetSnap.failed).toBe(1)
    expect(staticQueries).toBe(1)
    fleet.stopAll()
  })
})
