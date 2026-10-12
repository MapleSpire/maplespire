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

import { Repo } from '@automerge/automerge-repo'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeWithDurabilityTracking,
  DurableHeadLedger,
  durableConnectionStatus,
  pendingDurabilityDebts,
  setLocalDocumentChangeListener,
} from './durableSync'

afterEach(() => setLocalDocumentChangeListener(null))

describe('durable sync ledger', () => {
  it('does not call a connected document synced while PostgreSQL acknowledgement is pending', () => {
    expect(durableConnectionStatus(true, 1)).toBe('saving')
    expect(durableConnectionStatus(true, 0)).toBe('ready')
    expect(durableConnectionStatus(false, 0)).toBe('offline')
  })

  it('counts EVERY durability debt — journaled entity intents and an unread journal included', () => {
    const clean = {
      durableHeadCount: 0,
      writeSchedulerPending: false,
      entityIntentCount: 0,
      entityIntentsHydrated: true,
      placementIntentCount: 0,
      placementIntentsHydrated: true,
    }
    expect(pendingDurabilityDebts(clean)).toBe(0)
    // The historical lie: heads drained + scheduler idle, but an entity edit
    // sits journaled because its write head is missing. Never 'ready'.
    expect(pendingDurabilityDebts({ ...clean, entityIntentCount: 1 })).toBeGreaterThan(0)
    // A journal not yet read is a debt, not an empty journal.
    expect(pendingDurabilityDebts({ ...clean, entityIntentsHydrated: false })).toBeGreaterThan(0)
    expect(pendingDurabilityDebts({ ...clean, durableHeadCount: 2 })).toBe(2)
    expect(pendingDurabilityDebts({ ...clean, writeSchedulerPending: true })).toBe(1)
    // The placement journal is in the sum — otherwise a hydrated off-active
    // placement (or a flush that bailed on a missing handle) would leave the
    // badge saying 'Synced' over unsaved geometry.
    expect(pendingDurabilityDebts({ ...clean, placementIntentCount: 3 })).toBe(3)
    expect(pendingDurabilityDebts({ ...clean, placementIntentsHydrated: false })).toBeGreaterThan(0)
  })

  it('clears only the exact frontier sent to the server', () => {
    const ledger = new DurableHeadLedger()
    ledger.mark('doc-1' as never, ['a'.repeat(64)])
    const sent = ledger.snapshot()
    ledger.mark('doc-1' as never, ['b'.repeat(64)])

    ledger.acknowledge(sent, [{ documentId: 'doc-1', durable: true }])

    expect(ledger.snapshot()).toEqual([
      { documentId: 'doc-1', heads: ['b'.repeat(64)] },
    ])
  })

  it('keeps rejected documents pending and clears durable documents independently', () => {
    const ledger = new DurableHeadLedger()
    ledger.mark('doc-1' as never, ['a'.repeat(64)])
    ledger.mark('doc-2' as never, ['b'.repeat(64)])
    const sent = ledger.snapshot()

    ledger.acknowledge(sent, [
      { documentId: 'doc-1', durable: true },
      { documentId: 'doc-2', durable: false },
    ])

    expect(ledger.snapshot()).toEqual([
      { documentId: 'doc-2', heads: ['b'.repeat(64)] },
    ])
  })

  it('notifies durability tracking for real writes but not no-op changes', () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ value: 1 })
    const listener = vi.fn()
    setLocalDocumentChangeListener(listener)

    changeWithDurabilityTracking(handle, (doc) => { doc.value = 1 })
    expect(listener).not.toHaveBeenCalled()
    changeWithDurabilityTracking(handle, (doc) => { doc.value = 2 })
    expect(listener).toHaveBeenCalledWith(handle)
  })

  it('restores only valid pending frontiers after a browser restart', () => {
    const ledger = new DurableHeadLedger()
    const documentId = new Repo({ network: [] }).create({ value: 1 }).documentId
    ledger.hydrate([
      { documentId, heads: ['a'.repeat(64)] },
      { documentId: 'doc-2' as never, heads: ['invalid'] },
    ])
    expect(ledger.snapshot()).toEqual([
      { documentId, heads: ['a'.repeat(64)] },
    ])
  })
})
