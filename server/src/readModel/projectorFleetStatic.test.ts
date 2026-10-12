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
 * The ORDINARY projector refuses a STATIC (summary) workspace.
 *
 * The promotion primitive detaches the resident ordinary projector explicitly.
 * That alone is not enough: any `ensure()` racing the promotion (an HTTP read,
 * the compaction job, a boot) would put it straight back, and then two writers
 * would advance this workspace's `ro_*` generations independently — the
 * ordinary one rebuilding from an Automerge graph the summary contract no
 * longer keeps loaded, erasing exactly the rows the static world serves.
 */

import { describe, it, expect, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import {
  ProjectorFleet,
  ProjectorOwnershipError,
  ProjectorStaticWorkspaceError,
  type startReadModelProjector,
} from './projectorService.js'
import { ReadModelPlaneError } from './projectionAuthority.js'

const WORKSPACE = { landscapeId: 'L', versionId: 'V' }

/** A `Queryable` that answers only the one question the guard asks. */
function fakeDb(isStatic: boolean) {
  const seen: string[] = []
  return {
    seen,
    db: {
      query: async (text: string) => {
        seen.push(text)
        if (/read_model_static_workspaces/.test(text)) {
          return { rows: [{ present: isStatic }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    } as never,
  }
}

describe('ProjectorFleet — the static-workspace refusal', () => {
  it('the ordinary projector refuses to attach a static workspace', async () => {
    const resolveRoot = vi.fn(async () => 'automerge:root')
    const startProjector = vi.fn(async () => vi.fn())
    const { db } = fakeDb(true)
    const fleet = new ProjectorFleet(new Repo({}), resolveRoot, {
      fallbackRootUrl: 'automerge:fallback',
      db,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })

    await expect(fleet.ensure(WORKSPACE)).rejects.toBeInstanceOf(ProjectorStaticWorkspaceError)
    // The DISCRIMINATOR against "remove the guard": with the guard gone, the
    // cold build runs and a second writer becomes resident. Asserting on the
    // rejection alone would not see that.
    expect(startProjector).not.toHaveBeenCalled()
    expect(resolveRoot).not.toHaveBeenCalled()
    expect(fleet.isResident(WORKSPACE)).toBe(false)
    expect(fleet.snapshot().residentProjectors).toBe(0)
    fleet.stopAll()
  })

  it('maps a cold build that loses the PLANE to an ownership rejection, not a raw failure (A8)', async () => {
    // The window this covers is between `ensure()`'s static check and the cold
    // build's first transaction. The plane pre-check is deliberately NOT
    // cold-build-exempt — unlike the write fence, where claiming is the cold
    // build's own job — so a workspace promoted inside that window arrives
    // here. It must be mapped to a lost lease; otherwise it escapes as an
    // unrecognised start failure the fleet's ownership accounting never sees.
    const { db } = fakeDb(false)
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback',
      db,
      startProjector: (async () => {
        throw new ReadModelPlaneError(WORKSPACE, 'ordinary')
      }) as unknown as typeof startReadModelProjector,
    })

    await expect(fleet.ensure(WORKSPACE)).rejects.toBeInstanceOf(ProjectorOwnershipError)
    expect(fleet.snapshot().ownershipRejectedStarts).toBe(1)
    expect(fleet.isResident(WORKSPACE)).toBe(false)
    fleet.stopAll()
  })

  it('does NOT map an ordinary build failure to an ownership rejection', async () => {
    // The anti-void control for the test above: a mapping that swallowed every
    // start failure would pass it just as well, and would hide real faults as
    // routine lease churn.
    const { db } = fakeDb(false)
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback',
      db,
      startProjector: (async () => {
        throw new Error('the cold build genuinely failed')
      }) as unknown as typeof startReadModelProjector,
    })

    await expect(fleet.ensure(WORKSPACE)).rejects.toThrow('the cold build genuinely failed')
    expect(fleet.snapshot().ownershipRejectedStarts).toBe(0)
    fleet.stopAll()
  })

  it('is NOT retryable — waiting never makes a promoted workspace ordinary again', async () => {
    const { db } = fakeDb(true)
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback',
      db,
      startProjector: (async () => vi.fn()) as unknown as typeof startReadModelProjector,
    })
    const error = await fleet.ensure(WORKSPACE).catch((caught) => caught)
    expect((error as ProjectorStaticWorkspaceError).retryable).toBe(false)
    expect((error as ProjectorStaticWorkspaceError).code).toBe('read_model_workspace_is_static')
    fleet.stopAll()
  })

  it('an ORDINARY workspace still attaches (the anti-void control)', async () => {
    // Without this, the refusal test above would pass just as well against a
    // fleet that refuses everything.
    const startProjector = vi.fn(async () => vi.fn())
    const { db, seen } = fakeDb(false)
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback',
      db,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })

    await expect(fleet.ensure(WORKSPACE)).resolves.toBe(true)
    expect(startProjector).toHaveBeenCalledTimes(1)
    expect(fleet.isResident(WORKSPACE)).toBe(true)
    // and it really did consult the table, rather than defaulting to "ordinary".
    expect(seen.some((text) => /read_model_static_workspaces/.test(text))).toBe(true)
    fleet.stopAll()
  })

  it('a `db` with no `query` is a test double, not a static workspace — the documented escape hatch', () => {
    // Pinned deliberately so it cannot widen silently. Several fleet suites
    // construct `db: {} as never` because they never reach SQL; production
    // always passes a real Pool, so this branch is unreachable there. If this
    // test ever has to change, the guard's blast radius changed with it.
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback',
      db: {} as never,
      startProjector: (async () => vi.fn()) as unknown as typeof startReadModelProjector,
    })
    return fleet.ensure(WORKSPACE).then((ok) => {
      expect(ok).toBe(true)
      fleet.stopAll()
    })
  })
})
