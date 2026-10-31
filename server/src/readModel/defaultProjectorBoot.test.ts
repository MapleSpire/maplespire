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
 * The default projector at boot: a failure that used to abort the read-model
 * bring-up (and leave the pod unready until a restart) is retried instead.
 * The timer is a seam, so each test fires the retries it means to, in order.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureDefaultProjectorAtBoot, type DefaultProjectorBootOptions } from './defaultProjectorBoot.js'

class StaticRefusal extends Error {}
class OwnershipRefusal extends Error {}

function harness(ensure: () => Promise<unknown>, overrides: Partial<DefaultProjectorBootOptions> = {}) {
  const timers: Array<{ run: () => void; delayMs: number }> = []
  const settled: string[] = []
  let stopped = false
  const options: DefaultProjectorBootOptions = {
    ensure: vi.fn(ensure),
    isStaticRefusal: (error) => error instanceof StaticRefusal,
    isOwnershipRefusal: (error) => error instanceof OwnershipRefusal,
    stopped: () => stopped,
    onSettled: (outcome) => { settled.push(outcome) },
    schedule: (run, delayMs) => { timers.push({ run, delayMs }) },
    log: () => {},
    ...overrides,
  }
  /** Fire the oldest pending timer and let its attempt finish. */
  const fire = async () => {
    const next = timers.shift()
    if (!next) throw new Error('no retry is armed')
    next.run()
    await vi.waitFor(() => undefined)
    await new Promise((done) => setImmediate(done))
  }
  return { options, timers, settled, fire, stop: () => { stopped = true } }
}

describe('ensureDefaultProjectorAtBoot', () => {
  it('a resident projector is resident, and arms nothing', async () => {
    const h = harness(async () => true)
    await expect(ensureDefaultProjectorAtBoot(h.options)).resolves.toBe('resident')
    expect(h.timers).toEqual([])
  })

  it('the two expected refusals are answers, not failures — boot carries on past both', async () => {
    const a = harness(async () => { throw new StaticRefusal() })
    await expect(ensureDefaultProjectorAtBoot(a.options)).resolves.toBe('static')
    const b = harness(async () => { throw new OwnershipRefusal() })
    await expect(ensureDefaultProjectorAtBoot(b.options)).resolves.toBe('not-owned')
    expect([...a.timers, ...b.timers]).toEqual([])
  })

  it('any other failure RETURNS instead of throwing, and retries until the projector is resident', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
      if (calls < 3) throw new Error('connection terminated')
      return true
    })
    await expect(ensureDefaultProjectorAtBoot(h.options)).resolves.toBe('retrying')
    expect(h.settled).toEqual([])
    await h.fire()
    expect(h.settled, 'one failed retry settles nothing').toEqual([])
    await h.fire()
    expect(h.settled).toEqual(['resident'])
    expect(calls).toBe(3)
    expect(h.timers, 'nothing is armed after it settled').toEqual([])
  })

  it('backs off exponentially, from 1 s, capped at 30 s', async () => {
    const h = harness(async () => { throw new Error('connection terminated') })
    await ensureDefaultProjectorAtBoot(h.options)
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      delays.push(h.timers[0]!.delayMs)
      await h.fire()
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })

  it('a retry that meets an expected refusal settles with it', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
      if (calls === 1) throw new Error('connection terminated')
      throw new StaticRefusal()
    })
    await ensureDefaultProjectorAtBoot(h.options)
    await h.fire()
    expect(h.settled).toEqual(['static'])
  })

  it('stops for good once the process is stopping: no attempt, no settle, nothing re-armed', async () => {
    const h = harness(async () => { throw new Error('connection terminated') })
    await ensureDefaultProjectorAtBoot(h.options)
    const attempts = vi.mocked(h.options.ensure).mock.calls.length
    h.stop()
    await h.fire()
    expect(vi.mocked(h.options.ensure).mock.calls.length).toBe(attempts)
    expect(h.settled).toEqual([])
    expect(h.timers).toEqual([])
  })

  it('a stop that lands DURING a successful retry settles nothing', async () => {
    // (kept below)
    await stopDuringRetry()
  })
})

/**
 * THE WIRING, asserted on the source, because `index.ts` cannot be loaded by
 * a test and a failure at exactly this boot step cannot be staged on a real
 * server (every table it reads is read earlier in boot too). A source pin
 * cannot say the wiring is right; it makes a revert loud.
 */
describe('index.ts boots the default projector through ensureDefaultProjectorAtBoot', () => {
  const INDEX = path.resolve(import.meta.dirname, '..', 'index.ts')
  const code = async () => (await readFile(INDEX, 'utf8'))
    .split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')

  it('hands it the fleet, the two expected refusals and the shutdown flag', async () => {
    const source = await code()
    expect(source).toContain('const outcome = await ensureDefaultProjectorAtBoot({')
    expect(source).toContain('ensure: () => fleet.ensure(defaultWorkspaceKey),')
    expect(source).toContain('isStaticRefusal: (error) => error instanceof ProjectorStaticWorkspaceError,')
    expect(source).toContain('isOwnershipRefusal: (error) => error instanceof ProjectorOwnershipError,')
    expect(source).toContain('stopped: () => readiness.shuttingDown,')
  })

  it('no longer rethrows out of the read-model bring-up', async () => {
    const source = await code()
    expect(source).not.toMatch(/await readModelFleet\.ensure\(defaultWorkspaceKey\)/)
    expect(source).not.toContain('else if (!(error instanceof ProjectorOwnershipError)) throw error')
  })

  it('keeps the pod unready while a retry is pending, and lets a retry make it ready', async () => {
    const source = await code()
    expect(source).toContain("defaultProjectorPending = outcome === 'retrying'")
    expect(source).toMatch(/onSettled: \(\) => \{\s*defaultProjectorPending = false\s*if \(bringUpComplete && !readiness\.shuttingDown\) readiness\.readModel = true\s*\}/)
    const complete = source.indexOf('bringUpComplete = true')
    const ready = source.indexOf('if (!defaultProjectorPending) readiness.readModel = true')
    expect(complete).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(complete)
    // The only other place the flag is raised is the retry's settle.
    expect(source.split('readiness.readModel = true').length - 1).toBe(2)
  })
})

async function stopDuringRetry(): Promise<void> {
  let calls = 0
  // Read only once `ensure` runs, which is after the assignment.
  const h: ReturnType<typeof harness> = harness(async () => {
    calls += 1
    if (calls === 1) throw new Error('connection terminated')
    h.stop()
    return true
  })
  await ensureDefaultProjectorAtBoot(h.options)
  await h.fire()
  expect(h.settled).toEqual([])
}
