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

import { getHeads } from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { describe, expect, it, vi } from 'vitest'
import {
  acknowledgeDurableHeads,
  parseDurableHeadRequests,
} from './durableHeads.js'

describe('durable Automerge head acknowledgements', () => {
  it('validates a bounded, unique set of document heads', () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ value: 1 })
    const heads = getHeads(handle.doc()!)
    expect(parseDurableHeadRequests([{ documentId: handle.documentId, heads }])).toEqual([
      { documentId: handle.documentId, heads },
    ])
    expect(parseDurableHeadRequests([])).toBeNull()
    expect(parseDurableHeadRequests([
      { documentId: handle.documentId, heads },
      { documentId: handle.documentId, heads },
    ])).toBeNull()
    expect(parseDurableHeadRequests([{ documentId: handle.documentId, heads: ['not-a-hash'] }])).toBeNull()
  })

  it('flushes only workspace-owned documents whose requested heads reached the server', async () => {
    const repo = new Repo({ network: [] })
    const owned = repo.create({ value: 1 })
    const crossWorkspace = repo.create({ value: 2 })
    const notArrived = repo.create({ value: 3 })
    const missingHead = '0'.repeat(64)
    const flush = vi.spyOn(repo, 'flush').mockResolvedValue()
    const query = vi.fn().mockResolvedValue({ rows: [
      { document_id: owned.documentId },
      { document_id: notArrived.documentId },
    ] })

    const result = await acknowledgeDurableHeads(
      repo,
      { query },
      { landscapeId: 'landscape-1', versionId: 'version-1' },
      [
        { documentId: owned.documentId, heads: getHeads(owned.doc()!) },
        { documentId: crossWorkspace.documentId, heads: getHeads(crossWorkspace.doc()!) },
        { documentId: notArrived.documentId, heads: [missingHead] },
      ],
    )

    expect(query).toHaveBeenCalledWith(expect.stringContaining('automerge_document_workspace'), [
      'landscape-1',
      'version-1',
      [owned.documentId, crossWorkspace.documentId, notArrived.documentId],
    ])
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith([owned.documentId])
    expect(result).toEqual([
      { documentId: owned.documentId, durable: true },
      { documentId: crossWorkspace.documentId, durable: false },
      { documentId: notArrived.documentId, durable: false },
    ])
  })

  it('does not acknowledge before the PostgreSQL-backed Repo flush resolves', async () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ value: 1 })
    let release!: () => void
    let markFlushStarted!: () => void
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve })
    vi.spyOn(repo, 'flush').mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve
      markFlushStarted()
    }))
    const pending = acknowledgeDurableHeads(
      repo,
      { query: vi.fn().mockResolvedValue({ rows: [{ document_id: handle.documentId }] }) },
      { landscapeId: 'landscape-1', versionId: 'version-1' },
      [{ documentId: handle.documentId, heads: getHeads(handle.doc()!) }],
    )
    let settled = false
    void pending.then(() => { settled = true })
    await flushStarted
    expect(settled).toBe(false)
    release()
    await expect(pending).resolves.toEqual([{ documentId: handle.documentId, durable: true }])
  })
})
