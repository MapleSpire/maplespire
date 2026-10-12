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

import { describe, it, expect } from 'vitest'
import { currentProcessBootId } from './processIdentity.js'

describe('currentProcessBootId', () => {
  it('is stable for the life of the process', () => {
    // The property every delta on `/api/platform/automerge-residency` rests on.
    // If this varied, two snapshots from ONE process would read as a restart and
    // every eviction run would void.
    const first = currentProcessBootId()
    for (let i = 0; i < 50; i += 1) expect(currentProcessBootId()).toBe(first)
  })

  it('is minted per module LOAD, not baked in as a constant', async () => {
    // A hardcoded string would satisfy the test above perfectly and would make
    // two different servers claim to be the same process — the exact confusion
    // this value exists to prevent, and invisible to any single-process check.
    //
    // A fresh module instance is the closest a same-process test can get to a
    // second server. Vite resolves a query-suffixed specifier as a DIFFERENT
    // module, so the module body — and therefore the `randomUUID()` at its
    // top — runs again.
    const reloaded = await import('./processIdentity.js?freshModuleInstance=1') as {
      currentProcessBootId: () => string
    }
    expect(reloaded.currentProcessBootId()).not.toBe(currentProcessBootId())
    // A THIRD module instance, distinct from both: a loader ignoring the query
    // would return the same module and the set would collapse.
    const third = await import('./processIdentity.js?freshModuleInstance=2') as {
      currentProcessBootId: () => string
    }
    const ids = new Set([currentProcessBootId(), reloaded.currentProcessBootId(), third.currentProcessBootId()])
    expect(ids.size, 'three module loads must mint three identities').toBe(3)
  })

  it('is not the pid, which the OS recycles', () => {
    // The comment in `processIdentity.ts` gives pid recycling as the reason for
    // a UUID — a supervisor restarting a crashed server into the same pid would
    // publish an identity saying "same process" about a restart.
    const id = currentProcessBootId()
    expect(id).not.toBe(String(process.pid))
    // Do not assert `not.toContain(pid)`: a UUID contains "1" ~86 % of the
    // time, so it would flake whenever node runs as pid 1 in a container. The
    // RFC 4122 shape below already excludes a bare pid.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
