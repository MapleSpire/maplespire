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
 * T-DIAGDEF — a switch asked DURING the drain of the previous
 * one. A load drains the outgoing transport (up to 3 s) before
 * it moves the active ref; `switchWorkspace` compared the new destination with
 * the active ref, which still named the workspace being left.
 *
 * The bridge and the network are stubbed; the drain is held by a durable-heads
 * route that answers only when the test says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loads: [] as string[],
  debt: null as null | { ref: { landscapeId: string; versionId: string }; documents: Array<{ documentId: string; heads: string[] }> },
}))

vi.mock('./bridge', () => ({
  startBridge: vi.fn(async (ref: { landscapeId: string }) => { mocks.loads.push(ref.landscapeId) }),
  stopBridge: vi.fn(() => {}),
  preferInitialDiagram: vi.fn(() => {}),
  // Every stop leaves one document owed: each load drains.
  takeStoppedSessionDurableDebt: vi.fn(() => mocks.debt),
}))
vi.mock('./repo', () => ({
  forgetWorkspace: vi.fn(() => {}),
  routeWorkspaceNetwork: vi.fn(async () => {}),
  hasConnectedSyncPeer: vi.fn(() => true),
  serverKnownHeads: vi.fn(() => new Map()),
}))

import { switchWorkspace } from './switchWorkspace'
import { currentWorkspaceRef, setActiveWorkspaceRef } from './workspace'

const A = { landscapeId: 'A', versionId: 'current' }
const B = { landscapeId: 'B', versionId: 'current' }
const C = { landscapeId: 'C', versionId: 'current' }
const D = { landscapeId: 'D', versionId: 'current' }

describe('T-DIAGDEF — switches asked during a drain', () => {
  let release: () => void = () => undefined
  let held: Promise<void>

  beforeEach(() => {
    mocks.loads = []
    setActiveWorkspaceRef(A)
    held = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (!url.pathname.endsWith('/api/automerge/durable-heads')) return new Response('{}', { status: 404 })
      await held // the drain of the outgoing workspace waits here
      const body = JSON.parse(String(init?.body ?? '{}')) as { documents: Array<{ documentId: string }> }
      return new Response(JSON.stringify({ documents: body.documents.map((d) => ({ documentId: d.documentId, durable: true })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    mocks.debt = { ref: A, documents: [{ documentId: '4NMNnkMhL8jXrdJ9jamS7Z56vPn7', heads: ['a'.repeat(64)] }] }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })
  afterEach(() => {
    release()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const settle = async (...switches: Promise<void>[]) => {
    await new Promise((resolve) => setTimeout(resolve, 20)) // the first load is in its drain
    release()
    await Promise.all(switches.map((s) => s.catch(() => undefined)))
  }

  it('A→B, then back to A during the drain: the app ends on A', async () => {
    const toB = switchWorkspace(B)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const backToA = switchWorkspace(A) // before: taken for a no-op (the active ref still said A)
    await settle(toB, backToA)
    expect(currentWorkspaceRef()).toEqual(A)
    expect(mocks.loads.at(-1)).toBe('A')
  })

  it('B clicked twice during the drain: ONE load of B', async () => {
    const first = switchWorkspace(B)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = switchWorkspace(B) // before: a second full reload queued
    await settle(first, second)
    expect(currentWorkspaceRef()).toEqual(B)
    expect(mocks.loads).toEqual(['B'])
  })

  it('A→B→C: the app ends on C', async () => {
    const toB = switchWorkspace(B)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const toC = switchWorkspace(C)
    await settle(toB, toC)
    expect(currentWorkspaceRef()).toEqual(C)
    expect(mocks.loads.at(-1)).toBe('C')
  })

  it('A→B, then C and back to B during the drain: C is skipped and B is not loaded a second time', async () => {
    const toB = switchWorkspace(B)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const toC = switchWorkspace(C)
    const backToB = switchWorkspace(B)
    await settle(toB, toC, backToB)
    expect(currentWorkspaceRef()).toEqual(B)
    expect(mocks.loads).toEqual(['B'])
  })

  it('A→B→C→D during the drain: C, never started, is not loaded — only the LAST one queued', async () => {
    const toB = switchWorkspace(B)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const toC = switchWorkspace(C)
    const toD = switchWorkspace(D)
    await settle(toB, toC, toD)
    expect(currentWorkspaceRef()).toEqual(D)
    expect(mocks.loads).toEqual(['B', 'D'])
  })
})
