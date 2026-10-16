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
 * QA lens battery (round 2) for `openDiagramPlacement`: the session's
 * lifecycle edges. Each case names the mutant it was written to kill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateAutomergeUrl } from '@automerge/automerge-repo'
import type { DiagramDoc } from '../automerge/types'

const findDiagramHandle = vi.fn()
const getRegistryShardHandles = vi.fn()
const fetchDiagramMeta = vi.fn()
const releaseDocumentRequest = vi.fn()

vi.mock('../automerge/repo', () => ({
  findDiagramHandle: (...args: unknown[]) => findDiagramHandle(...args),
  getRegistryShardHandles: () => getRegistryShardHandles(),
  releaseDocumentRequest: (...args: unknown[]) => releaseDocumentRequest(...args),
}))
vi.mock('../modelQuery/diagramMeta', () => ({ fetchDiagramMeta: (id: string) => fetchDiagramMeta(id) }))
vi.mock('../../stores/modelStore', () => ({ useModelStore: { getState: () => ({ diagrams: [] }) } }))

const { openDiagramPlacement } = await import('./duplicateSource')

const PLACED = { o1: { position: { x: 10, y: 20 }, size: { width: 160, height: 90 } } }
const VALID_URL = generateAutomergeUrl()
const doc = (): DiagramDoc => ({
  name: 'Containers', type: 'container', objectIds: ['o1'], connectionIds: [], groupIds: [],
  layouts: PLACED, comments: {}, flows: {}, checkpoints: [],
} as unknown as DiagramDoc)
const metaAnswer = () => ({
  meta: { id: 'dg1', name: 'Containers', type: 'container', docUrl: VALID_URL, objectIds: ['o1'], connectionIds: [], groupIds: [] },
  diagram: {}, comments: [], flows: [],
})
const liveHandle = () => {
  const listeners = new Set<() => void>()
  return {
    listeners,
    doc: () => doc(),
    on: (event: string, fn: () => void) => { if (event === 'change') listeners.add(fn) },
    off: (event: string, fn: () => void) => { if (event === 'change') listeners.delete(fn) },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getRegistryShardHandles.mockResolvedValue([])
  fetchDiagramMeta.mockResolvedValue(metaAnswer())
})
afterEach(() => { vi.useRealTimers() })

describe('openDiagramPlacement — QA round 2', () => {
  // Kills: `if (closed || !url)` → `if (!url)`. A collapse while the URL was
  // being resolved let the read go on to `find` — taking a lease AFTER close,
  // which nothing would ever give back.
  it('a session closed while its URL resolves never asks for the document', async () => {
    let resolveMeta!: (value: unknown) => void
    fetchDiagramMeta.mockReturnValue(new Promise((resolve) => { resolveMeta = resolve }))
    const session = openDiagramPlacement('dg1')
    const read = session.read()
    session.close()
    resolveMeta(metaAnswer())
    expect(await read).toBeNull()
    expect(findDiagramHandle).not.toHaveBeenCalled()
  })

  // Kills: the URL not memoized. Offline, the meta lookup fails; a second read
  // must still wait on the find already running, not give up before it.
  it('a read after the network went away still waits on the find already running', async () => {
    vi.useFakeTimers()
    let arrive!: (handle: ReturnType<typeof liveHandle>) => void
    findDiagramHandle.mockReturnValue(new Promise((resolve) => { arrive = resolve }))
    const session = openDiagramPlacement('dg1', 100)
    const first = session.read()
    await vi.advanceTimersByTimeAsync(150)
    expect(await first).toBeNull()

    fetchDiagramMeta.mockRejectedValue(new Error('offline'))
    const second = session.read()
    await vi.advanceTimersByTimeAsync(10)
    arrive(liveHandle())
    await vi.advanceTimersByTimeAsync(0)
    expect(await second).toEqual(PLACED)
  })

  // Kills: the 4 s default read timeout changed (the hook's real source passes
  // none). Literal times.
  it('a read gives up on an unreachable document after 4 s, not before', async () => {
    vi.useFakeTimers()
    findDiagramHandle.mockReturnValue(new Promise(() => {}))
    const session = openDiagramPlacement('dg1')
    let settled: unknown = 'pending'
    void session.read().then((value) => { settled = value })
    await vi.advanceTimersByTimeAsync(3_900)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toBeNull()
  })

  // Kills: `read` not refusing after close.
  it('reads nothing once closed', async () => {
    findDiagramHandle.mockResolvedValue(liveHandle())
    const session = openDiagramPlacement('dg1')
    expect(await session.read()).toEqual(PLACED)
    session.close()
    expect(await session.read()).toBeNull()
  })
})
