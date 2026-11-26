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
import { createProcessExclusion } from './processExclusion.js'

/** G4-16f: compaction (waits) and the sweep (skips) never overlap. */
describe('the pool-heavy-pass exclusion', () => {
  const deferred = () => {
    let resolve!: () => void
    let reject!: (e: unknown) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it('a TRY while held skips; a RUN while held waits, FIFO; the slot frees on both settle paths', async () => {
    const x = createProcessExclusion()
    const order: string[] = []
    const first = deferred()
    const a = x.run(async () => { order.push('a'); await first.promise })
    expect(x.busy()).toBe(true)
    expect(await x.tryRun(async () => order.push('sweep'))).toEqual({ ran: false })
    const b = x.run(async () => { order.push('b') })
    const c = x.run(async () => { order.push('c'); throw new Error('c fails') })
    first.resolve()
    await a
    await b
    await expect(c).rejects.toThrow('c fails')
    expect(order).toEqual(['a', 'b', 'c'])
    expect(x.busy()).toBe(false)
    expect(await x.tryRun(async () => 'swept')).toEqual({ ran: true, value: 'swept' })
  })

  it('the FIFO HAND-OVER keeps the slot held — a TRY issued while the handed-to waiter runs is refused, never admitted beside it', async () => {
    const x = createProcessExclusion()
    const first = deferred()
    const second = deferred()
    let bStarted = false
    const a = x.run(async () => { await first.promise })
    const b = x.run(async () => { bStarted = true; await second.promise })
    expect(x.waiting()).toBe(1)
    first.resolve()
    await a
    // The very next turn after A's release, and every turn while B runs.
    const atRelease = await x.tryRun(async () => 'beside')
    await new Promise((r) => setTimeout(r, 5))
    expect(bStarted).toBe(true)
    const whileB = await x.tryRun(async () => 'beside')
    expect([atRelease, whileB]).toEqual([{ ran: false }, { ran: false }])
    expect(x.busy()).toBe(true)
    second.resolve()
    await b
    expect(x.busy()).toBe(false)
  })

  it('waiting() counts the queued RUNs; hold() names each hand-over with its own sequence and start', async () => {
    let t = 1_000
    const x = createProcessExclusion(() => t)
    expect(x.hold()).toBeNull()
    const first = deferred()
    const a = x.run(async () => { await first.promise })
    const h1 = x.hold()!
    expect(h1.sinceMs).toBe(1_000)
    const b = x.run(async () => {})
    expect(x.waiting()).toBe(1)
    t = 5_000
    first.resolve()
    await a
    await b
    expect(x.hold()).toBeNull()
    expect(x.waiting()).toBe(0)
    await x.tryRun(async () => { expect(x.hold()!.seq).toBeGreaterThan(h1.seq + 1) })
  })

  it('a running TRY makes a RUN wait for it', async () => {
    const x = createProcessExclusion()
    const sweep = deferred()
    const order: string[] = []
    const s = x.tryRun(async () => { await sweep.promise; order.push('sweep') })
    const c = x.run(async () => { order.push('compaction') })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([])
    sweep.resolve()
    await s
    await c
    expect(order).toEqual(['sweep', 'compaction'])
  })

  it('runWithin WAITS as a waiter (a running try sees it in waiting()) and runs once handed the slot', async () => {
    const x = createProcessExclusion()
    const triggered = deferred()
    let sawWaiter = false
    const t = x.tryRun(async () => {
      await new Promise((r) => setTimeout(r, 5))
      sawWaiter = x.waiting() > 0 // the triggered pass's `shouldYield` reads this
      await triggered.promise
    })
    const periodic = x.runWithin(async () => 'swept', 1_000)
    await new Promise((r) => setTimeout(r, 15))
    expect(sawWaiter).toBe(true)
    triggered.resolve()
    await t
    expect(await periodic).toEqual({ ran: true, value: 'swept' })
    expect(x.hold()).toBeNull()
  })

  it('runWithin SKIPS after its wait, leaving no waiter behind; free, it runs at once', async () => {
    const x = createProcessExclusion()
    const held = deferred()
    const h = x.run(async () => { await held.promise })
    expect(await x.runWithin(async () => 'late', 20)).toEqual({ ran: false })
    expect(x.waiting()).toBe(0)
    held.resolve()
    await h
    // Free: it runs at once AND holds the slot while it works (without the
    // take, a compaction would run beside it).
    let heldInside = false
    let triedInside: unknown
    expect(await x.runWithin(async () => {
      heldInside = x.busy()
      triedInside = await x.tryRun(async () => 'beside')
      return 'now'
    }, 20)).toEqual({ ran: true, value: 'now' })
    expect(heldInside).toBe(true)
    expect(triedInside).toEqual({ ran: false })
    expect(x.busy()).toBe(false)
  })
})
