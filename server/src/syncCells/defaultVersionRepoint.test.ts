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

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REPOINT_RESIDUAL_DRAIN_DELAY_MS,
  announceDefaultVersionRepoint,
  createDefaultVersionRepointHandler,
  installDefaultVersionRepointHandler,
} from './defaultVersionRepoint.js'
import { MAX_ROUTE_BURST_CACHE_TTL_MS } from './workspaceRoute.js'
import type { WorkspaceKey } from '../rbac/docScope.js'

interface ArmedTimer {
  run: () => void
  delayMs: number
  cancelled: boolean
  /** A one-shot timer fires ONCE. The first draft of this harness re-ran every
   * timer on each `elapse()`, which reported a drain that production cannot
   * perform — an instrument that manufactures the event it is measuring. */
  fired: boolean
}

function harness(options: { invalidated?: number; drained?: number } = {}) {
  const invalidations: string[] = []
  const drains: { workspace: WorkspaceKey; reason: string }[] = []
  const logs: Record<string, unknown>[] = []
  const timers: ArmedTimer[] = []
  const handler = createDefaultVersionRepointHandler({
    invalidateRoutes: (landscapeId) => {
      invalidations.push(landscapeId)
      return options.invalidated ?? 0
    },
    drainSockets: (workspace, reason) => {
      // Recorded in call order WITH the invalidations, so "invalidate, then
      // drain" is an assertable fact rather than a sentence in the header.
      invalidations.push(`drain:${workspace.landscapeId}/${workspace.versionId}`)
      drains.push({ workspace, reason })
      return options.drained ?? 0
    },
    log: (line) => { logs.push(JSON.parse(line) as Record<string, unknown>) },
    schedule: (run, delayMs) => {
      const timer: ArmedTimer = { run, delayMs, cancelled: false, fired: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  /** Fire every armed, uncancelled, not-yet-fired timer — what the event loop
   * would do. */
  const elapse = () => {
    for (const timer of timers) {
      if (timer.cancelled || timer.fired) continue
      timer.fired = true
      timer.run()
    }
  }
  return { handler, invalidations, drains, logs, timers, elapse }
}

describe('the residual delay', () => {
  it('outlasts the longest alias cache any process in the deployment may hold', () => {
    // The RELATION is what the design rests on: a socket that comes back inside
    // another process's burst window is canonicalised straight back onto the old
    // default, and the drain has spent the one reconnect it gets. Asserted as a
    // relation because an inversion is the failure that matters...
    expect(REPOINT_RESIDUAL_DRAIN_DELAY_MS).toBeGreaterThan(MAX_ROUTE_BURST_CACHE_TTL_MS)
  })

  it('is 6 000 ms — a LITERAL, so the ceiling cannot move the bound with it', () => {
    // ...and as a literal because a bound derived from the constant under test
    // agrees with any value that constant is given. This repo has watched a
    // ceiling grow 7.5x under a test that computed its own expectation.
    expect(REPOINT_RESIDUAL_DRAIN_DELAY_MS).toBe(6_000)
  })
})

describe('createDefaultVersionRepointHandler', () => {
  it('invalidates the repointed landscape, and only it', () => {
    const { handler, invalidations } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    expect(invalidations).toEqual(['L1'])
  })

  it('does nothing at all when the named version is already the default', () => {
    const { handler, invalidations, logs, timers } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V1' })
    expect(invalidations).toEqual([])
    expect(logs).toEqual([])
    expect(timers).toEqual([])
  })

  it('still invalidates a landscape that had no default at all', () => {
    // Null answers are never cached, so the ALIAS entry cannot exist — but a
    // concrete entry for this landscape can, and this is the cheapest moment to
    // be sure of it.
    const { handler, invalidations } = harness()
    handler({ landscapeId: 'L1', previousVersionId: null, versionId: 'V1' })
    expect(invalidations).toEqual(['L1'])
  })

  it('separates having invalidated from having had nothing to invalidate', () => {
    const { handler, logs } = harness({ invalidated: 0 })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    expect(logs[0].invalidatedRoutes).toBe(0)
  })
})

describe('the drain', () => {
  it('is ARMED, not run, while the announcement is being handled', () => {
    // Draining inside the burst window is the failure mode this delay exists
    // for, so "it did not happen yet" is the property, not an implementation
    // detail.
    const { handler, drains, timers } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    expect(drains).toEqual([])
    expect(timers).toHaveLength(1)
    expect(timers[0].delayMs).toBe(REPOINT_RESIDUAL_DRAIN_DELAY_MS)
  })

  it('reaches the PREVIOUS default, never the new one', () => {
    // The mutation this kills is a one-word slip that would drain exactly the
    // sockets that have just arrived on the right workspace, and leave the
    // stranded ones where they are.
    const { handler, drains, elapse } = harness({ drained: 4 })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    elapse()
    expect(drains).toHaveLength(1)
    expect(drains[0].workspace).toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })

  it('happens AFTER the invalidation, not before', () => {
    // Order is load-bearing: a socket drained before the resolver forgets the
    // alias reconnects into the stale answer this process still holds.
    const { handler, invalidations, elapse } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    elapse()
    expect(invalidations).toEqual(['L1', 'drain:L1/V1'])
  })

  it('carries a reason a browser console can attribute', () => {
    const { handler, drains, elapse } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    elapse()
    expect(drains[0].reason).toMatch(/repointed/i)
    // `drainWorkspace` slices the close reason at 123 bytes; a reason that
    // arrives truncated is a reason nobody can grep for.
    expect(drains[0].reason.length).toBeLessThanOrEqual(123)
  })

  it('is not armed when there was no previous default to leave', () => {
    const { handler, timers, logs } = harness()
    handler({ landscapeId: 'L1', previousVersionId: null, versionId: 'V1' })
    expect(timers).toEqual([])
    expect(logs[0].drainArmed).toBe(false)
    expect(logs[0].drainDelayMs).toBeNull()
  })

  it('arms once per target, so a repeated announcement cannot stack reconnects', () => {
    const { handler, timers, drains, elapse } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V3' })
    expect(timers).toHaveLength(1)
    elapse()
    expect(drains).toHaveLength(1)
  })

  it('arms again for a target it has already drained', () => {
    // The coalescing above is about a drain still WAITING. A landscape that is
    // repointed back to V1 and away again must be drained again, or the second
    // move is silent.
    const { handler, drains, elapse } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    elapse()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V3' })
    elapse()
    expect(drains).toHaveLength(2)
  })

  it('keeps two landscapes apart', () => {
    const { handler, drains, elapse } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    handler({ landscapeId: 'L2', previousVersionId: 'V1', versionId: 'V2' })
    elapse()
    expect(drains.map((d) => d.workspace.landscapeId)).toEqual(['L1', 'L2'])
  })

  it('reports the count as a fact of its own, on its own line', () => {
    const { handler, logs, elapse } = harness({ invalidated: 3, drained: 5 })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })

    expect(logs).toEqual([{
      event: 'sync.cell.default_version_repointed',
      landscapeId: 'L1',
      previousVersionId: 'V1',
      versionId: 'V2',
      invalidatedRoutes: 3,
      // Deferred: this line reports what was ARMED and must not imply a count
      // it cannot know yet.
      drainArmed: true,
      drainDelayMs: REPOINT_RESIDUAL_DRAIN_DELAY_MS,
    }])

    elapse()
    expect(logs[1]).toEqual({
      event: 'sync.cell.default_version_drained',
      landscapeId: 'L1',
      previousVersionId: 'V1',
      versionId: 'V2',
      drainedSockets: 5,
      error: null,
    })
  })

  it('separates "nobody was connected" from "the drain never ran"', () => {
    // Zero drained sockets after a repoint is an ordinary night. A repoint with
    // NO drained line is a process that went away first, and folding them
    // together would send an operator hunting for a fault that did not occur.
    const { handler, logs, elapse } = harness({ drained: 0 })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    expect(logs).toHaveLength(1)
    elapse()
    expect(logs).toHaveLength(2)
    expect(logs[1].drainedSockets).toBe(0)
  })

  it('logs a throwing drain instead of taking the process down from a timer', () => {
    const logs: Record<string, unknown>[] = []
    let armed: (() => void) | null = null
    const handler = createDefaultVersionRepointHandler({
      invalidateRoutes: () => 0,
      drainSockets: () => { throw new Error('registry is gone') },
      log: (line) => { logs.push(JSON.parse(line) as Record<string, unknown>) },
      schedule: (run) => { armed = run; return () => {} },
    })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })

    expect(() => (armed as unknown as () => void)()).not.toThrow()
    expect(logs[1]).toMatchObject({
      event: 'sync.cell.default_version_drained',
      drainedSockets: 0,
      error: 'registry is gone',
    })
  })
})

describe('stopPendingDrains', () => {
  it('cancels a drain that has not fired, so it cannot reach a torn-down server', () => {
    const { handler, drains, timers, elapse } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    handler({ landscapeId: 'L2', previousVersionId: 'W1', versionId: 'W2' })
    handler.stopPendingDrains()
    elapse()
    expect(timers.every((t) => t.cancelled)).toBe(true)
    expect(drains).toEqual([])
  })

  it('lets a later repoint arm again — it is a disposer, not a latch', () => {
    const { handler, drains, elapse } = harness()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    handler.stopPendingDrains()
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V3' })
    elapse()
    expect(drains).toHaveLength(1)
  })
})

describe('the production default schedule', () => {
  it('arms an UNREF\'d timer, so a pending drain never holds the process open', () => {
    // Asked of the HANDLE, not of the source: an adversarial run had deleting
    // `timer.unref?.()` survive every other test here, because a fake clock
    // cannot see the difference and a six-second timer that keeps the event
    // loop alive looks exactly like one that does not until a process refuses
    // to exit.
    const armed: NodeJS.Timeout[] = []
    const realSetTimeout = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      const timer = realSetTimeout(fn, ms)
      armed.push(timer)
      return timer
    }) as unknown as typeof globalThis.setTimeout)

    const handler = createDefaultVersionRepointHandler({
      invalidateRoutes: () => 0,
      drainSockets: () => 0,
      log: () => {},
    })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    spy.mockRestore()

    expect(armed).toHaveLength(1)
    expect(armed[0].hasRef()).toBe(false)
    handler.stopPendingDrains()
  })

  it('fires the real timer at the delay, and not a millisecond before', () => {
    vi.useFakeTimers()
    const drains: WorkspaceKey[] = []
    const handler = createDefaultVersionRepointHandler({
      invalidateRoutes: () => 0,
      drainSockets: (workspace) => { drains.push(workspace); return 0 },
      log: () => {},
    })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })

    // The real `setTimeout` path — the branch every test above injects around,
    // and therefore the one that would otherwise be covered by nothing.
    expect(drains).toEqual([])
    vi.advanceTimersByTime(REPOINT_RESIDUAL_DRAIN_DELAY_MS - 1)
    expect(drains).toEqual([])
    vi.advanceTimersByTime(1)
    expect(drains).toEqual([{ landscapeId: 'L1', versionId: 'V1' }])
    vi.useRealTimers()
  })

  it('clears the real timer on stopPendingDrains', () => {
    vi.useFakeTimers()
    const drains: WorkspaceKey[] = []
    const handler = createDefaultVersionRepointHandler({
      invalidateRoutes: () => 0,
      drainSockets: (workspace) => { drains.push(workspace); return 0 },
      log: () => {},
    })
    handler({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' })
    handler.stopPendingDrains()
    vi.advanceTimersByTime(REPOINT_RESIDUAL_DRAIN_DELAY_MS * 2)
    expect(drains).toEqual([])
    vi.useRealTimers()
  })
})

describe('announceDefaultVersionRepoint', () => {
  afterEach(() => { installDefaultVersionRepointHandler(null) })

  it('reports that nobody was listening rather than pretending it invalidated', () => {
    installDefaultVersionRepointHandler(null)
    expect(announceDefaultVersionRepoint({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' }))
      .toBe(false)
  })

  it('delivers to the installed handler and stops on uninstall', () => {
    const seen: string[] = []
    const uninstall = installDefaultVersionRepointHandler((r) => { seen.push(r.versionId) })

    expect(announceDefaultVersionRepoint({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' }))
      .toBe(true)
    uninstall()
    expect(announceDefaultVersionRepoint({ landscapeId: 'L1', previousVersionId: 'V2', versionId: 'V3' }))
      .toBe(false)
    expect(seen).toEqual(['V2'])
  })

  it('logs a throwing handler instead of failing the repoint that already committed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installDefaultVersionRepointHandler(() => { throw new Error('resolver is gone') })

    expect(() => announceDefaultVersionRepoint({ landscapeId: 'L1', previousVersionId: 'V1', versionId: 'V2' }))
      .not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    const line = JSON.parse(warn.mock.calls[0][0] as string) as Record<string, unknown>
    expect(line.event).toBe('sync.cell.default_version_repoint_failed')
    expect(line.error).toBe('resolver is gone')
    warn.mockRestore()
  })
})
