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
 * T-DIAGDEF-2 — a workspace switch behind a server that accepts and never
 * answers must END. Measured on the stack (`e2e/boot/workspace-switch-server-
 * down.spec.ts`, shape `unanswered`): still loading 90 s after the click,
 * waiting on `GET /api/me/workspace-access`, a request with no bound of its
 * own, awaited after the outgoing drain and before the bridge starts.
 *
 * The bridge and the network are stubbed (`switchWorkspaceQueue.test.ts`'s
 * pattern); `fetch` never answers anything, honouring only its signal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loads: [] as Array<{ landscapeId: string; readOnly: boolean; at: number }>,
  asked: [] as Array<{ path: string; at: number }>,
  accessAnswer: null as null | { canRead: boolean; canWrite: boolean; enforced: boolean },
  /** The access answer comes this late (0: at once). */
  accessDelayMs: 0,
  /** The new route takes this long (between the active ref moving and the lock). */
  routeDelayMs: 0,
}))

vi.mock('./bridge', () => ({
  startBridge: vi.fn(async (ref: { landscapeId: string }) => {
    const { useModelStore } = await import('../../stores/modelStore')
    mocks.loads.push({ landscapeId: ref.landscapeId, readOnly: useModelStore.getState().workspaceReadOnly, at: Date.now() })
  }),
  stopBridge: vi.fn(() => {}),
  preferInitialDiagram: vi.fn(() => {}),
  // The session left owes one document: the switch drains.
  takeStoppedSessionDurableDebt: vi.fn(() => ({
    ref: { landscapeId: 'A', versionId: 'current' },
    documents: [{ documentId: '4NMNnkMhL8jXrdJ9jamS7Z56vPn7', heads: ['a'.repeat(64)] }],
  })),
}))
vi.mock('./repo', () => ({
  forgetWorkspace: vi.fn(() => {}),
  routeWorkspaceNetwork: vi.fn(async () => {
    if (mocks.routeDelayMs) await new Promise((resolve) => setTimeout(resolve, mocks.routeDelayMs))
  }),
  hasConnectedSyncPeer: vi.fn(() => true),
  serverKnownHeads: vi.fn(() => new Map()),
}))

import { switchWorkspace } from './switchWorkspace'
import { setActiveWorkspaceRef } from './workspace'
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'

const A = { landscapeId: 'A', versionId: 'current' }
const B = { landscapeId: 'B', versionId: 'current' }

/** Resolves with the switch, or with 'still running' after `ms`. */
const within = (job: Promise<void>, ms: number) => Promise.race([
  job.then(() => 'ended' as const),
  new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), ms)),
])

describe('T-DIAGDEF-2 — a switch behind a server that never answers', () => {
  beforeEach(async () => {
    mocks.loads = []
    mocks.asked = []
    mocks.accessAnswer = null
    mocks.accessDelayMs = 0
    mocks.routeDelayMs = 0
    // Each case asks afresh (a settled probe answers for 15 s otherwise). The
    // hook is looked up, not imported: the base this case is measured red on
    // has no such hook, and no probe to forget.
    const api = await import('../auth/api') as { forgetWorkspaceAccessProbes?: () => void }
    api.forgetWorkspaceAccessProbes?.()
    setActiveWorkspaceRef(A)
    useAuthStore.setState({
      config: { stage: 'on' } as never,
      user: { id: 'u1', email: 'paul@example.test' } as never,
    })
    useModelStore.setState({ workspaceReadOnly: false })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      mocks.asked.push({ path: url.pathname, at: Date.now() })
      if (url.pathname.endsWith('/api/me/workspace-access') && mocks.accessAnswer) {
        const response = new Response(JSON.stringify({ access: mocks.accessAnswer }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (!mocks.accessDelayMs) return Promise.resolve(response)
        return new Promise<Response>((resolve) => setTimeout(() => resolve(response), mocks.accessDelayMs))
      }
      // Nothing answers: only the request's own signal ends it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')))
      })
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ends, and starts the destination, within the drain bound (the access probe runs beside it)', async () => {
    const startedAt = Date.now()
    const outcome = await within(switchWorkspace(B), 8_000)
    expect(outcome, 'the switch is still waiting on the server 8 s after it was asked').toBe('ended')
    expect(mocks.loads.map((load) => load.landscapeId)).toEqual(['B'])
    // Drain (3 s) beside the access probe (3 s), not one after the other.
    expect(mocks.loads[0]!.at - startedAt).toBeLessThan(4_500)
    // Failed open: a probe with no answer does not lock the editor.
    expect(mocks.loads[0]!.readOnly).toBe(false)
  }, 15_000)

  it('asks the destination\'s access before the outgoing drain is over', async () => {
    const startedAt = Date.now()
    await within(switchWorkspace(B), 8_000)
    const access = mocks.asked.find((ask) => ask.path.endsWith('/api/me/workspace-access'))
    const drain = mocks.asked.find((ask) => ask.path.endsWith('/api/automerge/durable-heads'))
    expect(drain, 'the drain never asked: the case is VOID').toBeDefined()
    expect(access, 'the access probe never ran').toBeDefined()
    expect(access!.at - startedAt).toBeLessThan(1_000)
  }, 15_000)

  it('control: an access answer that says read-only still locks the editor before the bridge starts', async () => {
    mocks.accessAnswer = { canRead: true, canWrite: false, enforced: true }
    await within(switchWorkspace(B), 8_000)
    expect(mocks.loads).toEqual([expect.objectContaining({ landscapeId: 'B', readOnly: true })])
  }, 15_000)

  // The LATE answer (after the 3 s patience) of a viewer's access.
  const VIEWER = { canRead: true, canWrite: false, enforced: true }

  it('a late answer arriving after the active ref moved and before the lock step is not overwritten by the fail-open value', async () => {
    mocks.accessAnswer = VIEWER
    mocks.accessDelayMs = 3_400 // after the patience, after the drain (3 s)…
    mocks.routeDelayMs = 1_500 // …while the new route is still being set up
    expect(await within(switchWorkspace(B), 10_000)).toBe('ended')
    expect(mocks.loads).toEqual([expect.objectContaining({ landscapeId: 'B', readOnly: true })])
    expect(useModelStore.getState().workspaceReadOnly).toBe(true)
  }, 20_000)

  it('a late answer arriving after the bridge started still locks the editor (the app is still there)', async () => {
    mocks.accessAnswer = VIEWER
    mocks.accessDelayMs = 4_500
    expect(await within(switchWorkspace(B), 10_000)).toBe('ended')
    expect(mocks.loads).toEqual([expect.objectContaining({ landscapeId: 'B', readOnly: false })])
    await expect.poll(() => useModelStore.getState().workspaceReadOnly, { timeout: 5_000 }).toBe(true)
  }, 20_000)

  it('a late answer for an identity that is no longer signed in is not applied', async () => {
    mocks.accessAnswer = VIEWER
    mocks.accessDelayMs = 3_400
    mocks.routeDelayMs = 1_500
    setTimeout(() => useAuthStore.setState({ user: { id: 'u2', email: 'marie@example.test' } as never }), 3_200)
    expect(await within(switchWorkspace(B), 10_000)).toBe('ended')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(mocks.loads).toEqual([expect.objectContaining({ landscapeId: 'B', readOnly: false })])
    expect(useModelStore.getState().workspaceReadOnly).toBe(false)
  }, 20_000)
})
