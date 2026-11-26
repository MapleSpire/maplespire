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
 * T-DIAGDEF — the switch's drain ends when nothing can move:
 * no peer on the outgoing transport, or answers and server-known heads that
 * stop changing. A drain still converging keeps its full bound.
 */

import { describe, expect, it } from 'vitest'

import { drainOutgoingWorkspace } from './workspaceSwitchDrain'

const REF = { landscapeId: 'ls', versionId: 'v' }
const DOC = { documentId: 'doc-1', heads: ['a'.repeat(64)] } as never

describe('T-DIAGDEF — drainOutgoingWorkspace', () => {
  it('no peer: unreachable at once, nothing asked', async () => {
    let asks = 0
    const outcome = await drainOutgoingWorkspace({ ref: REF, documents: [DOC] }, {
      connected: () => false, online: () => true,
      acknowledge: async () => { asks += 1; return [] },
    })
    expect(outcome.outcome).toBe('unreachable')
    expect(asks).toBe(0)
    expect(outcome.elapsedMs).toBeLessThan(50)
  })

  it('nothing moves: stalled at the stall window, well under the bound', async () => {
    const outcome = await drainOutgoingWorkspace({ ref: REF, documents: [DOC] }, {
      connected: () => true, online: () => true, pollMs: 20, stallMs: 200, timeoutMs: 3_000,
      acknowledge: async () => [{ documentId: 'doc-1', durable: false }],
      serverHeads: () => new Map([['doc-1', ['b'.repeat(64)]]]),
    })
    expect(outcome.outcome).toBe('stalled')
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(180)
    expect(outcome.elapsedMs).toBeLessThan(600)
    expect(outcome.asks).toBeGreaterThanOrEqual(2)
  })

  it('server heads still moving: NOT stalled — it waits until durable, past the stall window', async () => {
    let tick = 0
    const outcome = await drainOutgoingWorkspace({ ref: REF, documents: [DOC] }, {
      connected: () => true, online: () => true, pollMs: 20, stallMs: 150, timeoutMs: 3_000,
      acknowledge: async () => [{ documentId: 'doc-1', durable: tick >= 25 }],
      serverHeads: () => new Map([['doc-1', [String(++tick).padStart(64, '0')]]]),
    })
    expect(outcome.outcome).toBe('durable')
    expect(outcome.elapsedMs).toBeGreaterThan(150)
  })

  it('still moving and never durable: the full bound, then timeout', async () => {
    let tick = 0
    const outcome = await drainOutgoingWorkspace({ ref: REF, documents: [DOC] }, {
      connected: () => true, online: () => true, pollMs: 20, stallMs: 100, timeoutMs: 400,
      acknowledge: async () => [{ documentId: 'doc-1', durable: false }],
      serverHeads: () => new Map([['doc-1', [String(++tick).padStart(64, '0')]]]),
    })
    expect(outcome.outcome).toBe('timeout')
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(380)
  })
})
