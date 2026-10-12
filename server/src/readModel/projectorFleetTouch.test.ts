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
import { ProjectorFleet, type startReadModelProjector } from './projectorService.js'

/**
 * `ProjectorFleet.touch()` is what turns the eviction from FIFO into LRU:
 * `ensure()` bumps `lastUsed` only on an entry it finds already resident, and
 * every production caller guards `ensure()` behind `!isResident()`, so without
 * `touch()` the victim is always the oldest attached projector. The residency's
 * unit suite drives a stub fleet, so this is the only place the real method's
 * effect on the real eviction is pinned (a `touch` that returns true without
 * bumping `lastUsed` would pass every other suite).
 */

const A = { landscapeId: 'L', versionId: 'a' }
const B = { landscapeId: 'L', versionId: 'b' }
const C = { landscapeId: 'L', versionId: 'c' }

function fakeDb() {
  return {
    query: async (text: string) => {
      if (/read_model_static_workspaces/.test(text)) return { rows: [{ present: false }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
  } as never
}

describe('ProjectorFleet — touch() makes the eviction least-recently-USED, not first-attached', () => {
  it('a touched older projector survives the cap; the untouched one is evicted', async () => {
    const startProjector = vi.fn(async () => vi.fn())
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback',
      db: fakeDb(),
      maxProjectors: 2,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    expect(fleet.capacity()).toBe(2)
    expect(await fleet.ensure(A)).toBe(true)
    expect(await fleet.ensure(B)).toBe(true)
    expect(fleet.size()).toBe(2)
    // Not resident: touch reports it and changes nothing.
    expect(fleet.touch(C)).toBe(false)
    // A is older than B by attach order; a use makes it the most recent.
    expect(fleet.touch(A)).toBe(true)
    expect(await fleet.ensure(C)).toBe(true)
    expect(fleet.size()).toBe(2)
    expect(fleet.isResident(A)).toBe(true)
    expect(fleet.isResident(B)).toBe(false)
    expect(fleet.isResident(C)).toBe(true)
    fleet.stopAll()
  })

  it('CONTROL — without a touch the eviction is by attach order (the first attached goes)', async () => {
    const startProjector = vi.fn(async () => vi.fn())
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback',
      db: fakeDb(),
      maxProjectors: 2,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    await fleet.ensure(A)
    await fleet.ensure(B)
    await fleet.ensure(C)
    expect(fleet.isResident(A)).toBe(false)
    expect(fleet.isResident(B)).toBe(true)
    expect(fleet.isResident(C)).toBe(true)
    fleet.stopAll()
  })
})
