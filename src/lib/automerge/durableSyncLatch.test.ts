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
 * The URL `acknowledgeDurableDocumentHeads` sends — a
 * hopping tab's latch asks carry `latch=1` (the server's priority pass), and
 * only they do; the capability listener is told the workspace parameters
 * without it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentId } from '@automerge/automerge-repo'

const apiFetch = vi.fn()
vi.mock('../api/http', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const { acknowledgeDurableDocumentHeads, setEpochCapabilityListener } = await import('./durableSync')

const documents = [{ documentId: 'abc' as DocumentId, heads: ['0'.repeat(64)] }]
const answer = () => new Response(JSON.stringify({ documents: [{ documentId: 'abc', durable: true }], epochs: true }), { status: 200 })

afterEach(() => {
  apiFetch.mockReset()
  setEpochCapabilityListener(null)
})

describe('acknowledgeDurableDocumentHeads: the latch parameter', () => {
  it('a latch ask sends latch=1, after the workspace parameters of the explicit workspace', async () => {
    apiFetch.mockResolvedValue(answer())
    await acknowledgeDurableDocumentHeads(documents, { latch: true, workspace: { landscapeId: 'l1', versionId: 'v1' } })
    const url = String(apiFetch.mock.calls[0]![0])
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(query.get('latch')).toBe('1')
    expect(query.get('landscapeId')).toBe('l1')
    expect(query.get('versionId')).toBe('v1')
  })

  it('an ordinary ask sends no latch, and the listener is told the workspace parameters without it', async () => {
    const told: string[] = []
    setEpochCapabilityListener((_epochs, params) => { told.push(params) })
    apiFetch.mockResolvedValue(answer())
    await acknowledgeDurableDocumentHeads(documents, { workspace: { landscapeId: 'l1', versionId: 'v1' } })
    expect(String(apiFetch.mock.calls[0]![0])).not.toContain('latch')
    apiFetch.mockResolvedValue(answer())
    await acknowledgeDurableDocumentHeads(documents, { latch: true, workspace: { landscapeId: 'l1', versionId: 'v1' } })
    expect(told).toEqual(['landscapeId=l1&versionId=v1', 'landscapeId=l1&versionId=v1'])
  })
})
