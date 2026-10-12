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
import { createMemoryKvStore } from '../modelQuery/kvStore'
import {
  createOverlayBatchId,
  hydrateOverlayBatchJournal,
  OverlayBatchJournal,
  overlayBatchJournal,
  persistOverlayBatchJournal,
} from './overlayBatchJournal'

describe('overlay batch journal', () => {
  it('keeps stable batches pending until a terminal server status', () => {
    const journal = new OverlayBatchJournal()
    journal.record({ batchId: 'b2', workspaceKey: 'w', collection: 'object', documentId: 'h1', createdAt: 2 })
    journal.record({ batchId: 'b1', workspaceKey: 'w', collection: 'object', documentId: 'h1', createdAt: 1 })
    expect(journal.pending('w').map((entry) => entry.batchId)).toEqual(['b1', 'b2'])
    expect(journal.hasPendingDocument('w', 'h1')).toBe(true)
    journal.terminal(['b1'])
    expect(journal.pending('w').map((entry) => entry.batchId)).toEqual(['b2'])
  })

  it('persists and restores across a browser restart', async () => {
    const store = createMemoryKvStore()
    const workspaceKey = `restore-${Date.now()}`
    overlayBatchJournal.record({
      batchId: 'durable-batch', workspaceKey, collection: 'connection', documentId: 'h2', createdAt: 1,
    })
    await persistOverlayBatchJournal(store, workspaceKey)
    overlayBatchJournal.terminal(['durable-batch'])
    await hydrateOverlayBatchJournal(store, workspaceKey)
    expect(overlayBatchJournal.pending(workspaceKey).map((entry) => entry.batchId)).toEqual(['durable-batch'])
    overlayBatchJournal.terminal(['durable-batch'])
  })

  it('generates collection-scoped globally stable ids', () => {
    const first = createOverlayBatchId('object')
    const second = createOverlayBatchId('object')
    expect(first).toMatch(/^overlay-object-/)
    expect(second).not.toBe(first)
  })
})
