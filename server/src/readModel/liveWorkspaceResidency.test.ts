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

import { describe, expect, it } from 'vitest'
import { LiveWorkspaceResidency, type ResidencyFleet } from './liveWorkspaceResidency.js'

/**
 * The rule "residency follows the live workspace", as a unit: what the
 * ownership gate reports, what the fleet is asked, what is counted. The wiring
 * itself (the gate calling `noteOwnedActivity` for an owned frame) is proved
 * over real sockets in `liveWorkspaceResidency.integration.test.ts`.
 */

const WS = { landscapeId: 'ls-live', versionId: 'v1' }
const OTHER = { landscapeId: 'ls-other', versionId: 'v1' }
const THIRD = { landscapeId: 'ls-third', versionId: 'v1' }

class RefusalError extends Error { readonly code = 'read_model_workspace_not_owned'; readonly retryable = true }
class StaticRefusalError extends Error { readonly code = 'read_model_workspace_is_static'; readonly retryable = false }

const keyOf = (key: { landscapeId: string; versionId: string }) => `${key.landscapeId}/${key.versionId}`

function fakeFleet(behaviour: { resident?: Set<string>; ensure?: (key: string) => Promise<boolean>; capacity?: number } = {}) {
  const resident = behaviour.resident ?? new Set<string>()
  const calls: string[] = []
  const touches: string[] = []
  const fleet: ResidencyFleet = {
    isResident: (key) => resident.has(keyOf(key)),
    ensure: async (key) => {
      const k = keyOf(key)
      calls.push(k)
      const ensure = behaviour.ensure ?? (async () => { resident.add(k); return true })
      return ensure(k)
    },
    size: () => resident.size,
    capacity: () => behaviour.capacity ?? 8,
    touch: (key) => { touches.push(keyOf(key)); return resident.has(keyOf(key)) },
  }
  return { fleet, calls, touches, resident }
}

async function settled(residency: LiveWorkspaceResidency, workspace = WS): Promise<void> {
  await residency.pending(workspace)
}

describe('LiveWorkspaceResidency — residency follows the live workspace', () => {
  it('an owned frame on a NON-resident workspace asks the fleet exactly once, and the next frame finds it resident and touches it', async () => {
    const { fleet, calls, touches } = fakeFleet()
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false })
    residency.noteOwnedActivity(WS)
    await settled(residency)
    residency.noteOwnedActivity(WS)
    expect(calls).toEqual(['ls-live/v1'])
    expect(touches).toEqual(['ls-live/v1'])
    expect(residency.snapshot()).toMatchObject({ activity: 2, ensuresRequested: 1, ensured: 1, alreadyResident: 1, throttled: 0 })
  })

  it('a workspace already resident is never asked for — the steady state is one Map lookup, one key string and a touch', () => {
    const { fleet, calls, touches, resident } = fakeFleet()
    resident.add('ls-live/v1')
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false })
    for (let i = 0; i < 5; i += 1) residency.noteOwnedActivity(WS)
    expect(calls).toEqual([])
    expect(touches).toHaveLength(5)
    expect(residency.snapshot()).toMatchObject({ activity: 5, alreadyResident: 5, ensuresRequested: 0 })
  })

  it('frames inside the throttle window do not re-ask while the first ensure is still PENDING; the window is per workspace', async () => {
    let now = 1_000
    let release: (value: boolean) => void = () => undefined
    const { fleet, calls } = fakeFleet({ ensure: () => new Promise<boolean>((resolve) => { release = resolve }) })
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false, throttleMs: 5_000, now: () => now })
    residency.noteOwnedActivity(WS)
    now += 1_000
    residency.noteOwnedActivity(WS)
    residency.noteOwnedActivity(OTHER)
    expect(calls).toEqual(['ls-live/v1', 'ls-other/v1'])
    expect(residency.snapshot()).toMatchObject({ throttled: 1, ensuresRequested: 2 })
    // Past the window, a still non-resident workspace is asked again.
    now += 5_000
    residency.noteOwnedActivity(WS)
    expect(calls).toEqual(['ls-live/v1', 'ls-other/v1', 'ls-live/v1'])
    release(true)
  })

  it('a retryable refusal INSIDE the window is throttled too, and re-asked once the window has passed', async () => {
    let now = 0
    const { fleet, calls } = fakeFleet({ ensure: async () => { throw new RefusalError('not owned') } })
    const residency = new LiveWorkspaceResidency({
      fleet: () => fleet, isExpectedRefusal: (error) => error instanceof RefusalError, throttleMs: 5_000, now: () => now,
    })
    residency.noteOwnedActivity(WS)
    await settled(residency)
    now += 500
    residency.noteOwnedActivity(WS)
    expect(calls).toEqual(['ls-live/v1'])
    now += 5_000
    residency.noteOwnedActivity(WS)
    await settled(residency)
    expect(calls).toEqual(['ls-live/v1', 'ls-live/v1'])
    expect(residency.snapshot()).toMatchObject({ refused: 2, throttled: 1, suppressed: 0 })
  })

  it('a `retryable: false` refusal (a static workspace) suppresses the workspace for ten minutes, past every throttle window', async () => {
    let now = 0
    const { fleet, calls } = fakeFleet({ ensure: async () => { throw new StaticRefusalError('static') } })
    const residency = new LiveWorkspaceResidency({
      fleet: () => fleet, isExpectedRefusal: (error) => error instanceof StaticRefusalError, throttleMs: 5_000, now: () => now,
    })
    residency.noteOwnedActivity(WS)
    await settled(residency)
    for (let i = 0; i < 20; i += 1) {
      now += 6_000 // each step past the throttle window
      residency.noteOwnedActivity(WS)
    }
    expect(calls).toEqual(['ls-live/v1'])
    expect(residency.snapshot()).toMatchObject({ refused: 1, suppressed: 20, throttled: 0 })
    // Another workspace is not suppressed by this one's answer.
    residency.noteOwnedActivity(OTHER)
    expect(calls).toEqual(['ls-live/v1', 'ls-other/v1'])
    // Ten minutes later it is asked again.
    now += 10 * 60_000
    residency.noteOwnedActivity(WS)
    expect(calls).toEqual(['ls-live/v1', 'ls-other/v1', 'ls-live/v1'])
  })

  it('a FULL fleet is a budget: no ensure while size >= capacity, counted, and the next frame after a slot frees up ensures at once', async () => {
    const { fleet, calls, resident } = fakeFleet({ capacity: 2 })
    resident.add('ls-live/v1')
    resident.add('ls-other/v1')
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false })
    for (let i = 0; i < 3; i += 1) residency.noteOwnedActivity(THIRD)
    expect(calls).toEqual([])
    expect(residency.snapshot()).toMatchObject({ capSaturated: 3, ensuresRequested: 0, throttled: 0 })
    // A projector was evicted or released: room again, no window was stamped.
    resident.delete('ls-other/v1')
    residency.noteOwnedActivity(THIRD)
    await settled(residency, THIRD)
    expect(calls).toEqual(['ls-third/v1'])
    expect(residency.snapshot()).toMatchObject({ capSaturated: 3, ensuresRequested: 1, ensured: 1 })
  })

  it('an expected refusal is counted, never logged; anything else is counted AND logged once', async () => {
    const logged: unknown[] = []
    let attempt = 0
    const { fleet } = fakeFleet({
      ensure: async () => {
        attempt += 1
        if (attempt === 1) throw new RefusalError('not owned')
        throw new TypeError('pool is gone')
      },
    })
    let now = 0
    const residency = new LiveWorkspaceResidency({
      fleet: () => fleet,
      isExpectedRefusal: (error) => error instanceof RefusalError,
      throttleMs: 1_000,
      now: () => now,
      log: (message, error) => logged.push([message, error]),
    })
    residency.noteOwnedActivity(WS)
    await settled(residency)
    now += 2_000
    residency.noteOwnedActivity(WS)
    await settled(residency)
    expect(residency.snapshot()).toMatchObject({ ensuresRequested: 2, refused: 1, failed: 1 })
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[0])).toContain('ls-live/v1')
  })

  it('`ensure` resolving false (no root for the workspace) is counted as unresolved, not as resident', async () => {
    const { fleet } = fakeFleet({ ensure: async () => false })
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false })
    residency.noteOwnedActivity(WS)
    await settled(residency)
    expect(residency.snapshot()).toMatchObject({ ensured: 0, unresolved: 1 })
  })

  it('before the fleet exists, frames are counted and nothing is asked — the fleet accessor is read per call', () => {
    let fleet: ResidencyFleet | null = null
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false })
    residency.noteOwnedActivity(WS)
    expect(residency.snapshot()).toMatchObject({ fleetUnavailable: 1, ensuresRequested: 0 })
    const made = fakeFleet()
    fleet = made.fleet
    residency.noteOwnedActivity(WS)
    expect(made.calls).toEqual(['ls-live/v1'])
  })

  it('two VERSIONS of one landscape are two workspaces: each is ensured, each has its own window and its own pending seam', async () => {
    const { fleet, calls } = fakeFleet({ ensure: () => new Promise<boolean>(() => undefined) })
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false })
    const v1 = { landscapeId: 'ls-live', versionId: 'v1' }
    const v2 = { landscapeId: 'ls-live', versionId: 'v2' }
    residency.noteOwnedActivity(v1)
    residency.noteOwnedActivity(v2)
    residency.noteOwnedActivity(v1)
    expect(calls).toEqual(['ls-live/v1', 'ls-live/v2'])
    expect(residency.snapshot()).toMatchObject({ ensuresRequested: 2, throttled: 1 })
    expect(residency.pending(v1)).toBeDefined()
    expect(residency.pending(v2)).toBeDefined()
    expect(residency.pending(v1)).not.toBe(residency.pending(v2))
  })

  it('the window boundary is exact: one millisecond short is throttled, the literal window re-asks', () => {
    let now = 10_000
    const { fleet, calls } = fakeFleet({ ensure: () => new Promise<boolean>(() => undefined) })
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false, throttleMs: 5_000, now: () => now })
    residency.noteOwnedActivity(WS)
    now += 4_999
    residency.noteOwnedActivity(WS)
    expect(calls).toEqual(['ls-live/v1'])
    now += 1
    residency.noteOwnedActivity(WS)
    expect(calls).toEqual(['ls-live/v1', 'ls-live/v1'])
    expect(residency.snapshot()).toMatchObject({ throttled: 1, ensuresRequested: 2 })
  })

  it('never throws into the gate: a rejecting ensure, a THROWING isResident and a throwing fleet accessor are all absorbed and counted', () => {
    const logged: unknown[] = []
    const rejecting = fakeFleet({ ensure: () => Promise.reject(new Error('boom')) })
    const residency = new LiveWorkspaceResidency({ fleet: () => rejecting.fleet, isExpectedRefusal: () => false, log: (m, e) => logged.push([m, e]) })
    expect(() => residency.noteOwnedActivity(WS)).not.toThrow()

    const throwing: ResidencyFleet = {
      ...rejecting.fleet,
      isResident: () => { throw new TypeError('fleet is torn down') },
    }
    const residency2 = new LiveWorkspaceResidency({ fleet: () => throwing, isExpectedRefusal: () => false, log: (m, e) => logged.push([m, e]) })
    expect(() => residency2.noteOwnedActivity(WS)).not.toThrow()
    expect(() => residency2.noteOwnedActivity(WS)).not.toThrow()
    expect(residency2.snapshot()).toMatchObject({ noteFailed: 2, ensuresRequested: 0 })

    const residency3 = new LiveWorkspaceResidency({ fleet: () => { throw new Error('accessor broke') }, isExpectedRefusal: () => false, log: (m, e) => logged.push([m, e]) })
    expect(() => residency3.noteOwnedActivity(WS)).not.toThrow()
    expect(residency3.snapshot()).toMatchObject({ noteFailed: 1 })
    // Logged once per window per instance, not per frame.
    expect(logged.filter(([message]) => String(message).includes('could not consult the fleet'))).toHaveLength(2)
  })
})
