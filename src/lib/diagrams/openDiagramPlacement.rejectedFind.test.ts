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
 * Regression, found by the QA lens (round 2). `withTimeout` turns a REJECTED
 * find into `null`, so `read` sets `gaveUp` for a find that did not outlive
 * anything. The next read's find then resolves INSIDE that read and is
 * announced as a late arrival anyway: one redundant placement reload, and a
 * contradiction of "does not announce a document that arrives within the read".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateAutomergeUrl } from '@automerge/automerge-repo'
import type { DiagramDoc } from '../automerge/types'

const findDiagramHandle = vi.fn()
vi.mock('../automerge/repo', () => ({
  findDiagramHandle: (...args: unknown[]) => findDiagramHandle(...args),
  getRegistryShardHandles: async () => [],
  releaseDocumentRequest: () => {},
}))
const VALID_URL = generateAutomergeUrl()
vi.mock('../modelQuery/diagramMeta', () => ({
  fetchDiagramMeta: async () => ({ meta: { id: 'dg1', docUrl: VALID_URL }, diagram: {}, comments: [], flows: [] }),
}))
vi.mock('../../stores/modelStore', () => ({ useModelStore: { getState: () => ({ diagrams: [] }) } }))

const { openDiagramPlacement } = await import('./duplicateSource')

const PLACED = { o1: { position: { x: 10, y: 20 }, size: { width: 160, height: 90 } } }
const handle = () => ({
  doc: () => ({ objectIds: ['o1'], connectionIds: [], groupIds: [], layouts: PLACED } as unknown as DiagramDoc),
  on: () => {},
  off: () => {},
})

beforeEach(() => { vi.clearAllMocks() })

describe('openDiagramPlacement — QA finding', () => {
  it('a find that FAILED is not a read that gave up: the next find landing within its read is not announced', async () => {
    findDiagramHandle.mockRejectedValueOnce(new Error('unavailable'))
    const session = openDiagramPlacement('dg1')
    const onChange = vi.fn()
    session.subscribe(onChange)
    expect(await session.read()).toBeNull()

    findDiagramHandle.mockResolvedValue(handle())
    expect(await session.read()).toEqual(PLACED)
    expect(onChange).not.toHaveBeenCalled()
  })
})
