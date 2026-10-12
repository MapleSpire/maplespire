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
import { runTeardownSteps } from './teardownSteps.js'

/**
 * A sequential teardown blocked on `DROP DATABASE … WITH (FORCE)` (which forces
 * an immediate checkpoint and waits for it — tens of seconds under a loaded
 * cluster) times out the `afterAll` hook: a file is reported failed with no
 * test accused, and the statements AFTER the slow drop never run, leaking a
 * database and a temporary directory.
 *
 * The control at the bottom of this file executes that sequential shape and
 * shows it truncating. Everything above it asserts the property that shape
 * cannot have.
 */
describe('runTeardownSteps', () => {
  it('starts every step even when one of them never settles', async () => {
    const ran: string[] = []
    const forever = new Promise<void>(() => {})

    const failure = await runTeardownSteps(
      [
        { name: 'target database', run: () => forever },
        { name: 'source database', run: async () => { ran.push('source') } },
        { name: 'temporary directory', run: async () => { ran.push('directory') } },
      ],
      { stepTimeoutMs: 50, label: 'backup drill teardown' },
    ).catch((error: unknown) => error as Error)

    // The two obligations a sequential teardown would silently drop.
    expect(ran).toEqual(expect.arrayContaining(['source', 'directory']))
    // And the report names the step, not the hook.
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('backup drill teardown')
    expect((failure as Error).message).toContain('target database: still running after 50 ms')
    expect((failure as Error).message).not.toContain('source database')
  })

  it('runs the remaining steps when one rejects, and aggregates every failure', async () => {
    const ran: string[] = []

    const failure = await runTeardownSteps(
      [
        { name: 'pool', run: () => Promise.reject(new Error('connection terminated')) },
        { name: 'database', run: async () => { ran.push('database'); throw new Error('55006 object_in_use') } },
        { name: 'directory', run: async () => { ran.push('directory') } },
      ],
      { stepTimeoutMs: 1_000 },
    ).catch((error: unknown) => error as Error)

    expect(ran).toEqual(['database', 'directory'])
    const message = (failure as Error).message
    expect(message).toContain('2 of 3 step(s)')
    expect(message).toContain('pool: connection terminated')
    expect(message).toContain('database: 55006 object_in_use')
  })

  it('survives a step that throws before its first await', async () => {
    const ran: string[] = []

    const failure = await runTeardownSteps(
      [
        { name: 'synchronous', run: () => { throw new Error('boom') } },
        { name: 'directory', run: async () => { ran.push('directory') } },
      ],
      { stepTimeoutMs: 1_000 },
    ).catch((error: unknown) => error as Error)

    expect(ran).toEqual(['directory'])
    expect((failure as Error).message).toContain('synchronous: boom')
  })

  it('resolves silently when every step completes', async () => {
    const ran: string[] = []
    await expect(
      runTeardownSteps(
        [
          { name: 'a', run: async () => { ran.push('a') } },
          { name: 'b', run: async () => { ran.push('b') } },
        ],
        { stepTimeoutMs: 1_000 },
      ),
    ).resolves.toBeUndefined()
    expect(ran.sort()).toEqual(['a', 'b'])
  })

  it('CONTROL: the sequential shape it replaced drops every obligation after the slow one', async () => {
    const ran: string[] = []
    const forever = new Promise<void>(() => {})

    // The sequential teardown, with the hook timeout modelled as the race that
    // vitest actually applies to it.
    const preFix = (async () => {
      await forever
      ran.push('source')
      ran.push('directory')
    })()
    const hookTimeout = new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), 50) })

    await expect(Promise.race([preFix, hookTimeout])).resolves.toBe('timeout')
    expect(ran).toEqual([])
  })
})
