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
 * G4-16l test 8: the resident debt driver on a fake clock. Every delay is a
 * LITERAL (a bound derived from the constant under test agrees with any
 * value it is given).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createResidentDebtDriver, type ResidentDebtAttempt } from './residentDebtDriver'

/** A fake lifecycle target counting its listeners. */
function fakeTargets() {
  const listeners = { pagehide: new Set<() => void>(), visibilitychange: new Set<() => void>() }
  const target = (kind: 'pagehide' | 'visibilitychange') => ({
    addEventListener: vi.fn((type: string, fn: () => void) => { if (type === kind) listeners[kind].add(fn) }),
    removeEventListener: vi.fn((type: string, fn: () => void) => { if (type === kind) listeners[kind].delete(fn) }),
  })
  const doc = { ...target('visibilitychange'), visibilityState: 'visible' as DocumentVisibilityState }
  const win = target('pagehide')
  return {
    listeners,
    doc,
    targets: () => ({ window: win as never, document: doc as never }),
    fire: (kind: 'pagehide' | 'visibilitychange') => { for (const fn of [...listeners[kind]]) fn() },
  }
}

function driverWith(over: {
  owed?: () => boolean
  attempt?: () => ResidentDebtAttempt
  token?: () => number
  onLifecycle?: () => void
  targets?: ReturnType<typeof fakeTargets>
} = {}) {
  const at: number[] = []
  const start = Date.now()
  const attempt = vi.fn(() => { at.push(Date.now() - start); return over.attempt ? over.attempt() : 'refused' as const })
  const warn = vi.fn()
  const driver = createResidentDebtDriver({
    owed: over.owed ?? (() => true),
    attempt,
    onLifecycle: over.onLifecycle ?? (() => undefined),
    sessionToken: over.token ?? (() => 1),
    lifecycleTargets: (over.targets ?? fakeTargets()).targets,
    warn,
  })
  return { driver, attempt, at, warn }
}

describe('residentDebtDriver (G4-16l, test 8)', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }) })
  afterEach(() => { vi.useRealTimers() })

  it('refused again and again: the attempts come at 50, 200, 400, 800, 1600, then every 2000 ms', async () => {
    const { driver, at } = driverWith()
    driver.arm()
    await vi.advanceTimersByTimeAsync(12_000)
    // Cumulative: 50, 250, 650, 1450, 3050, 5050, 7050, 9050, 11050.
    expect(at).toEqual([50, 250, 650, 1450, 3050, 5050, 7050, 9050, 11050])
    driver.stop()
  })

  it('arm() is idempotent: armed twice, or again while armed, one schedule', async () => {
    const { driver, at } = driverWith()
    driver.arm()
    driver.arm()
    await vi.advanceTimersByTimeAsync(40)
    driver.arm()
    await vi.advanceTimersByTimeAsync(20)
    expect(at).toEqual([50])
    driver.arm()
    await vi.advanceTimersByTimeAsync(300)
    expect(at).toEqual([50, 250])
    driver.stop()
  })

  it('disarms as soon as nothing is owed — and re-arms from 50 ms', async () => {
    let owed = true
    const { driver, at } = driverWith({ owed: () => owed })
    driver.arm()
    await vi.advanceTimersByTimeAsync(700)
    expect(at).toEqual([50, 250, 650])
    owed = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(at).toEqual([50, 250, 650])
    expect(driver.state().armed).toBe(false)
    owed = true
    driver.arm()
    await vi.advanceTimersByTimeAsync(60)
    expect(at).toEqual([50, 250, 650, 5_750])
    driver.stop()
  })

  it('paid by the attempt itself: no further attempt', async () => {
    let owed = true
    const { driver, at } = driverWith({ owed: () => owed, attempt: () => { owed = false; return 'written' } })
    driver.arm()
    await vi.advanceTimersByTimeAsync(60)
    expect(at).toEqual([50])
    // Paid: no timer left behind it.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(at).toEqual([50])
    expect(driver.state()).toMatchObject({ armed: false, attempts: 0, totalAttempts: 1, lastOutcome: 'written' })
    driver.stop()
  })

  it('nothing owed: arm() does nothing', async () => {
    const { driver, at } = driverWith({ owed: () => false })
    driver.arm()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(at).toEqual([])
    expect(driver.state().armed).toBe(false)
  })

  it('an attempt that throws counts as refused: the driver never throws and tries again on its backoff', async () => {
    let calls = 0
    const { driver, at, warn } = driverWith({ attempt: () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'refused' } })
    driver.arm()
    // A throw out of the timer would fail the run (vitest reports uncaught errors).
    await vi.advanceTimersByTimeAsync(300)
    expect(at).toEqual([50, 250])
    expect(driver.state().lastOutcome).toBe('refused')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('threw'), expect.any(Error))
    driver.stop()
  })

  it('a warning every 10 attempts still owed', async () => {
    const { driver, warn } = driverWith()
    driver.arm()
    // 50+200+400+800+1600 = 3050, then 2000 each: the 10th attempt at 13050.
    await vi.advanceTimersByTimeAsync(13_049)
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('10 attempts')
    driver.stop()
  })

  it('the session token: once it moves, no attempt — the driver stops itself and drops its listener', async () => {
    let token = 7
    const targets = fakeTargets()
    const { driver, at } = driverWith({ token: () => token, targets })
    driver.installLifecycle()
    driver.arm()
    await vi.advanceTimersByTimeAsync(60)
    expect(at).toEqual([50])
    token = 8
    await vi.advanceTimersByTimeAsync(10_000)
    expect(at).toEqual([50])
    expect(driver.state()).toMatchObject({ stopped: true, armed: false, lifecycleInstalled: false })
    expect(targets.listeners.pagehide.size).toBe(0)
    // And it cannot be armed again.
    driver.arm()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(at).toEqual([50])
  })

  it('a token moved by the attempt itself: no re-arm', async () => {
    let token = 1
    const { driver, at } = driverWith({ token: () => token, attempt: () => { token = 2; return 'refused' } })
    driver.arm()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(at).toEqual([50])
    expect(driver.state().stopped).toBe(true)
  })

  it('one lifecycle listener of each kind, however often it is installed or armed; pagehide and a hidden page run the flush', async () => {
    const targets = fakeTargets()
    const onLifecycle = vi.fn()
    const { driver } = driverWith({ targets, onLifecycle })
    driver.installLifecycle()
    driver.installLifecycle()
    driver.arm()
    driver.arm()
    driver.installLifecycle()
    expect(targets.listeners.pagehide.size).toBe(1)
    expect(targets.listeners.visibilitychange.size).toBe(1)
    targets.fire('pagehide')
    expect(onLifecycle).toHaveBeenCalledTimes(1)
    targets.fire('visibilitychange')
    expect(onLifecycle).toHaveBeenCalledTimes(1)
    targets.doc.visibilityState = 'hidden'
    targets.fire('visibilitychange')
    expect(onLifecycle).toHaveBeenCalledTimes(2)
    driver.uninstallLifecycle()
    expect(targets.listeners.pagehide.size).toBe(0)
    expect(targets.listeners.visibilitychange.size).toBe(0)
    driver.installLifecycle()
    expect(targets.listeners.pagehide.size).toBe(1)
    driver.stop()
    expect(targets.listeners.pagehide.size).toBe(0)
    expect(targets.listeners.visibilitychange.size).toBe(0)
    // Stopped: never installed again.
    driver.installLifecycle()
    expect(targets.listeners.pagehide.size).toBe(0)
  })

  it('a lifecycle flush that throws does not escape the listener', () => {
    const targets = fakeTargets()
    const { driver, warn } = driverWith({ targets, onLifecycle: () => { throw new Error('flush failed') } })
    driver.installLifecycle()
    expect(() => targets.fire('pagehide')).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lifecycle'), expect.any(Error))
    driver.stop()
  })

  it('an attempt that re-arms the driver (its store change) leaves ONE timer chain', async () => {
    let driverRef: { arm(): void } | null = null
    const { driver, at } = driverWith({ attempt: () => { driverRef?.arm(); return 'refused' } })
    driverRef = driver
    driver.arm()
    await vi.advanceTimersByTimeAsync(60)
    expect(at).toEqual([50])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(vi.getTimerCount()).toBe(1)
    driver.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a lifecycle event after the token moved runs no flush (never into the next session)', () => {
    let token = 1
    const targets = fakeTargets()
    const onLifecycle = vi.fn()
    const { driver } = driverWith({ token: () => token, targets, onLifecycle })
    driver.installLifecycle()
    token = 2
    targets.fire('pagehide')
    expect(onLifecycle).not.toHaveBeenCalled()
    driver.stop()
  })

  it('stop() clears the armed attempt', async () => {
    const { driver, at } = driverWith()
    driver.arm()
    expect(vi.getTimerCount()).toBe(1)
    driver.stop()
    // The real timer, not only the driver's own flag.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(at).toEqual([])
    expect(driver.state()).toMatchObject({ armed: false, stopped: true })
  })
})
