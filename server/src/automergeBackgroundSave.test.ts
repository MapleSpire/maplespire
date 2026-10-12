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

import { describe, expect, it, vi } from 'vitest'
import { Repo, type StorageAdapterInterface, type StorageKey } from '@automerge/automerge-repo'
import { StaleSyncCellWriteError, isDocumentStorageKey } from './automergeStorage.js'
import { observeAutomergeBackgroundSaveErrors } from './automergeBackgroundSave.js'
import { SyncStateTracker } from '../node_modules/@automerge/automerge-repo/dist/SyncStateTracker.js'

class RejectingStorageAdapter implements StorageAdapterInterface {
  rejectWrites = true

  async load(): Promise<Uint8Array | undefined> { return undefined }
  async loadRange(): Promise<[]> { return [] }
  async remove(): Promise<void> {}
  async removeRange(): Promise<void> {}

  async save(key: StorageKey): Promise<void> {
    if (!isDocumentStorageKey(key)) return
    if (this.rejectWrites) throw new StaleSyncCellWriteError()
  }
}

describe('Automerge background save rejection handling', () => {
  it('emits and handles a stale fenced save without an unhandled rejection', async () => {
    const storage = new RejectingStorageAdapter()
    const repo = new Repo({ storage, saveDebounceRate: 0 })
    const logger = { warn: vi.fn(), error: vi.fn() }
    const stop = observeAutomergeBackgroundSaveErrors(repo, logger)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      repo.create({ value: 'background save must be fenced' })
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(unhandled).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledTimes(1)
      const event = JSON.parse(logger.warn.mock.calls[0]![0] as string) as Record<string, unknown>
      expect(event).toEqual({
        event: 'automerge.background_save_fenced',
        outcome: 'rejected',
        reason: 'stale_sync_cell',
        operation: 'document',
        mutationKind: 'unknown',
        fenceReason: 'stale-fence',
        // The refused document is NAMED — the id the repo minted.
        documentId: expect.stringMatching(/^[A-Za-z0-9]{20,}$/),
      })
      expect(logger.error).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      stop()
      storage.rejectWrites = false
      await repo.shutdown()
    }
  })

  it('reports a rejected throttled sync-state save without an unhandled rejection', async () => {
    const onStorageError = vi.fn()
    const unhandled = vi.fn()
    const storage = {
      saveSyncState: vi.fn().mockRejectedValue(new StaleSyncCellWriteError()),
      removeSyncState: vi.fn().mockResolvedValue(undefined),
    }
    // The compatibility patch intentionally extends this internal constructor;
    // its installed declaration file remains owned by the upstream package.
    // @ts-expect-error patched runtime accepts the controlled-error callback
    const tracker = new SyncStateTracker(storage, 0, { onStorageError })
    process.on('unhandledRejection', unhandled)

    try {
      tracker.handleSyncState(
        {
          documentId: '11111111-1111-7111-8111-111111111111',
          syncState: { theirHeads: undefined },
        } as never,
        { storageId: 'remote-storage' } as never,
        { emit: vi.fn() } as never,
      )
      await new Promise((resolve) => setTimeout(resolve, 20))

      // @ts-expect-error compatibility patch adds the reset boundary
      await tracker.resetStorage('remote-storage')

      expect(unhandled).not.toHaveBeenCalled()
      expect(onStorageError).toHaveBeenCalledWith(expect.objectContaining({
        documentId: '11111111-1111-7111-8111-111111111111',
        error: expect.any(StaleSyncCellWriteError),
        operation: 'sync-state',
      }))
      expect(storage.removeSyncState).toHaveBeenCalledWith(
        '11111111-1111-7111-8111-111111111111',
        'remote-storage',
      )
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('does not persist protocol progress when the hub requires truthful reconnects', async () => {
    const previous = process.env.AM_PERSIST_SYNC_STATE
    process.env.AM_PERSIST_SYNC_STATE = 'off'
    const storage = { saveSyncState: vi.fn(), removeSyncState: vi.fn() }
    // @ts-expect-error patched runtime accepts the controlled-error callback
    const tracker = new SyncStateTracker(storage, 0, { onStorageError: vi.fn() })
    try {
      tracker.handleSyncState(
        {
          documentId: '22222222-2222-7222-8222-222222222222',
          syncState: { theirHeads: undefined },
        } as never,
        { storageId: 'remote-storage' } as never,
        { emit: vi.fn() } as never,
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(storage.saveSyncState).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.AM_PERSIST_SYNC_STATE
      else process.env.AM_PERSIST_SYNC_STATE = previous
    }
  })

  it('does not reload persisted progress while a disconnect reset is still pending', async () => {
    let releaseRemoval!: () => void
    const removalBlocked = new Promise<void>((resolve) => { releaseRemoval = resolve })
    const storage = {
      saveSyncState: vi.fn().mockResolvedValue(undefined),
      removeSyncState: vi.fn().mockImplementation(() => removalBlocked),
    }
    // @ts-expect-error compatibility patch adds reset/load lifecycle methods
    const tracker = new SyncStateTracker(storage, 0, { onStorageError: vi.fn() })
    tracker.handleSyncState(
      {
        documentId: '33333333-3333-7333-8333-333333333333',
        syncState: { theirHeads: undefined },
      } as never,
      { storageId: 'reconnecting-storage' } as never,
      { emit: vi.fn() } as never,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    // @ts-expect-error compatibility patch adds the reset boundary
    const reset = tracker.resetStorage('reconnecting-storage')
    // @ts-expect-error compatibility patch adds the load barrier
    const loadBarrier = tracker.waitForStorageReset('reconnecting-storage')
    let barrierResolved = false
    void loadBarrier.then(() => { barrierResolved = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(barrierResolved).toBe(false)

    releaseRemoval()
    await Promise.all([reset, loadBarrier])
    expect(storage.removeSyncState).toHaveBeenCalledWith(
      '33333333-3333-7333-8333-333333333333',
      'reconnecting-storage',
    )
  })

  it('does not swallow the same fencing error from an explicit flush', async () => {
    const storage = new RejectingStorageAdapter()
    const repo = new Repo({ storage, saveDebounceRate: 60_000 })
    const handle = repo.create({ value: 'explicit durability boundary' })

    await expect(repo.flush([handle.documentId])).rejects.toBeInstanceOf(StaleSyncCellWriteError)
    storage.rejectWrites = false
    await repo.shutdown()
  })
})
