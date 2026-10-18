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
import { createSessionWatch, sessionWatchApplies, type SessionWatchDeps } from './sessionWatch'
import type { MeOutcome } from './api'

const stale: MeOutcome = { kind: 'signed-out', reason: 'permissions-changed' }
const valid = { kind: 'signed-in', result: {} } as MeOutcome

function setup(overrides: Partial<SessionWatchDeps> = {}) {
  let clock = 0
  const onEnded = vi.fn()
  const probe = vi.fn(async () => stale)
  const watch = createSessionWatch({
    probe,
    shouldWatch: () => true,
    onEnded,
    now: () => clock,
    minIntervalMs: 10_000,
    ...overrides,
  })
  return { watch, probe, onEnded, advance: (ms: number) => { clock += ms } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('session watch (a live page notices its session ended)', () => {
  it('a 4001 close asks the server, and its stale answer ends the session', async () => {
    const { watch, probe, onEnded } = setup()
    watch({ code: 4001, opened: true })
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(onEnded).toHaveBeenCalledWith('permissions-changed')
  })

  it('a socket that never opened (a refused upgrade reads as a bare 1006) also asks', async () => {
    const { watch, probe, onEnded } = setup()
    watch({ code: 1006, opened: false })
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(onEnded).toHaveBeenCalledWith('permissions-changed')
  })

  it('an ordinary drop of a socket that was open asks nothing', async () => {
    const { watch, probe } = setup()
    watch({ code: 1006, opened: true })
    watch({ code: 1012, opened: true })
    await settle()
    expect(probe).not.toHaveBeenCalled()
  })

  it('an unreachable server is an outage, not a verdict: nothing ends', async () => {
    const { watch, onEnded } = setup({ probe: vi.fn(async () => { throw new Error('offline') }) })
    watch({ code: 1006, opened: false })
    await settle()
    expect(onEnded).not.toHaveBeenCalled()
  })

  it('a valid session ends nothing', async () => {
    const { watch, onEnded } = setup({ probe: vi.fn(async () => valid) })
    watch({ code: 4001, opened: true })
    await settle()
    expect(onEnded).not.toHaveBeenCalled()
  })

  it('an outage does not turn into a probe per reconnect: spaced by the interval, one in flight', async () => {
    let resolveProbe: (o: MeOutcome) => void = () => {}
    const probe = vi.fn(() => new Promise<MeOutcome>((resolve) => { resolveProbe = resolve }))
    const { watch, advance } = setup({ probe })
    watch({ code: 1006, opened: false })
    watch({ code: 4001, opened: true }) // in flight: joins nothing, starts nothing
    expect(probe).toHaveBeenCalledTimes(1)
    resolveProbe(valid)
    await settle()

    advance(5_000)
    watch({ code: 1006, opened: false })
    expect(probe).toHaveBeenCalledTimes(1)
    advance(5_000)
    watch({ code: 1006, opened: false })
    expect(probe).toHaveBeenCalledTimes(2)
    resolveProbe(valid)
    await settle()

    // The server's own revocation close is not held back by the interval.
    watch({ code: 4001, opened: true })
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('the production interval: a second refused upgrade 9 999 ms later does not probe, 10 000 ms later does', async () => {
    let clock = 0
    const probe = vi.fn(async () => valid)
    const watch = createSessionWatch({ probe, shouldWatch: () => true, onEnded: vi.fn(), now: () => clock })
    watch({ code: 1006, opened: false })
    await settle()
    clock += 9_999
    watch({ code: 1006, opened: false })
    expect(probe).toHaveBeenCalledTimes(1)
    clock += 1
    watch({ code: 1006, opened: false })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('the app watches only at stage on, signed in, not yet ended', () => {
    const user = { id: 'u' }
    expect(sessionWatchApplies({ config: { stage: 'on' }, user, sessionEnded: null })).toBe(true)
    // dual and off admit a stale session, so a close there never means "revoked".
    expect(sessionWatchApplies({ config: { stage: 'dual' }, user, sessionEnded: null })).toBe(false)
    expect(sessionWatchApplies({ config: { stage: 'off' }, user, sessionEnded: null })).toBe(false)
    expect(sessionWatchApplies({ config: null, user, sessionEnded: null })).toBe(false)
    expect(sessionWatchApplies({ config: { stage: 'on' }, user: null, sessionEnded: null })).toBe(false)
    expect(sessionWatchApplies({ config: { stage: 'on' }, user, sessionEnded: 'permissions-changed' })).toBe(false)
  })

  it('does not watch when told not to (stage off/dual, signed out, already ended)', async () => {
    let watching = true
    const { watch, probe, onEnded } = setup({ shouldWatch: () => watching })
    watching = false
    watch({ code: 4001, opened: true })
    await settle()
    expect(probe).not.toHaveBeenCalled()

    // And a session signed out WHILE the probe was out is not "ended" twice.
    watching = true
    let resolveProbe: (o: MeOutcome) => void = () => {}
    probe.mockImplementationOnce(() => new Promise<MeOutcome>((resolve) => { resolveProbe = resolve }))
    watch({ code: 4001, opened: true })
    watching = false
    resolveProbe(stale)
    await settle()
    expect(onEnded).not.toHaveBeenCalled()
  })
})
