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
 * T-DIAGDEF-2: the workspace-access probe is BOUNDED, and a store-led
 * switch's two readers of it (`switchWorkspace`, then the route guard once
 * the URL names the workspace) share one probe. Measured on the stack behind
 * a server that accepts and never answers: the switch held for good on the
 * first reader; bounded, the guard's own unbounded request then kept a
 * spinner over the bridge's error screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetWorkspaceAccessProbes,
  checkWorkspaceReadAccess,
  workspaceAccess,
  WORKSPACE_ACCESS_REUSE_MS,
} from './api'

let calls = 0
let answer: (() => Response) | null = null
/** When set, the answer comes this late. */
let answerAfterMs = 0

beforeEach(() => {
  calls = 0
  answer = null
  answerAfterMs = 0
  forgetWorkspaceAccessProbes()
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1
    const respond = answer
    if (respond && answerAfterMs > 0) return new Promise<Response>((resolve) => setTimeout(() => resolve(respond()), answerAfterMs))
    if (respond) return Promise.resolve(respond())
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')))
    })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('T-DIAGDEF-2 — the access probe', () => {
  it('fails open at its bound when nothing answers', async () => {
    const startedAt = Date.now()
    expect(await workspaceAccess('L', 'v', { timeoutMs: 50 })).toEqual({ canRead: true, canWrite: true, enforced: false })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('the route guard, asking just after the switch did, reuses its probe — no second wait', async () => {
    await workspaceAccess('L', 'v', { timeoutMs: 50 })
    const startedAt = Date.now()
    expect(await checkWorkspaceReadAccess('L', 'v', { timeoutMs: 5_000 })).toBe('unknown')
    expect(Date.now() - startedAt).toBeLessThan(100)
    expect(calls).toBe(1)
  })

  it('another workspace, or the same one past the reuse window, is asked afresh', async () => {
    answer = json(200, { access: { canRead: true, canWrite: false, enforced: true } })
    await workspaceAccess('L', 'v')
    await workspaceAccess('L', 'other')
    expect(calls).toBe(2)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + WORKSPACE_ACCESS_REUSE_MS + 1)
    answer = json(403, { error: 'forbidden' })
    expect(await checkWorkspaceReadAccess('L', 'v')).toBe('forbidden')
    expect(calls).toBe(3)
  })

  it('a LATE answer still reaches the caller that asked for it (a viewer is locked, late)', async () => {
    answer = json(200, { access: { canRead: true, canWrite: false, enforced: true } })
    answerAfterMs = 150
    const late = new Promise<unknown>((resolve) => {
      void workspaceAccess('L', 'v', { timeoutMs: 20, onLateAnswer: resolve }).then((now) => {
        // Failed open now…
        expect(now).toEqual({ canRead: true, canWrite: true, enforced: false })
      })
    })
    // …and the answer arrives afterwards.
    expect(await late).toEqual({ canRead: true, canWrite: false, enforced: true })
  })

  it('a 401 is not reused, and a change of identity forgets every probe', async () => {
    answer = json(401, { error: 'session ended' })
    expect(await checkWorkspaceReadAccess('L', 'v')).toBe('forbidden')
    answer = json(200, { access: { canRead: true, canWrite: true, enforced: true } })
    expect(await checkWorkspaceReadAccess('L', 'v')).toBe('granted')
    expect(calls).toBe(2)
    const { useAuthStore } = await import('../../stores/authStore')
    answer = json(403, { error: 'forbidden' })
    useAuthStore.setState({ user: { id: 'someone-else' } as never, orgId: 'org-2' })
    expect(await checkWorkspaceReadAccess('L', 'v')).toBe('forbidden')
    expect(calls).toBe(3)
  })

  it('an answer that does not decide (5xx, network failure) is not reused', async () => {
    answer = json(503, { error: 'unavailable' })
    expect(await workspaceAccess('L', 'v')).toEqual({ canRead: true, canWrite: true, enforced: false })
    answer = json(200, { access: { canRead: true, canWrite: false, enforced: true } })
    expect(await workspaceAccess('L', 'v')).toEqual({ canRead: true, canWrite: false, enforced: true })
    expect(calls).toBe(2)
    answer = () => { throw new TypeError('Failed to fetch') }
    expect(await workspaceAccess('M', 'v')).toEqual({ canRead: true, canWrite: true, enforced: false })
    answer = json(200, { access: { canRead: true, canWrite: false, enforced: true } })
    expect(await workspaceAccess('M', 'v')).toEqual({ canRead: true, canWrite: false, enforced: true })
    expect(calls).toBe(4)
    // …while an answer that decides IS reused (one request, not two).
    await workspaceAccess('M', 'v')
    expect(calls).toBe(4)
  })

  it('control: the answers keep their meaning', async () => {
    answer = json(200, { access: { canRead: true, canWrite: false, enforced: true } })
    expect(await workspaceAccess('A', 'v')).toEqual({ canRead: true, canWrite: false, enforced: true })
    expect(await checkWorkspaceReadAccess('A', 'v')).toBe('granted')
    answer = json(403, { error: 'forbidden' })
    expect(await checkWorkspaceReadAccess('B', 'v')).toBe('forbidden')
    expect(await workspaceAccess('B', 'v')).toEqual({ canRead: true, canWrite: true, enforced: false })
    answer = json(503, { error: 'warming' })
    expect(await checkWorkspaceReadAccess('C', 'v')).toBe('unknown')
  })
})
