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
import { readFileSync } from 'node:fs'
import type { Pool } from 'pg'
import { automergeShutdownSteps, residencyStorageProbe, syncServerStorageAdapterOptions } from './automergeStorageWiring.js'

/**
 * G4-16d: the sync server's storage wiring, which no test boots
 * (`automergeServer.ts`): the write pool passed, the residency probe's
 * unsaved-write hooks wired, the adapter's retries stopped before the pools
 * end.
 */
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('sync server storage wiring (G4-16d)', () => {
  it('the adapter options carry the write pool; ownership only when enabled; a bad idle timeout falls back', () => {
    const writeDb = {} as Pool
    const ownership = { enabled: true, fencingToken: () => '1' }
    expect(syncServerStorageAdapterOptions({ writeDb, ownership, fencedTransactionIdleTimeoutMs: 700, trackStaticReadModel: true }))
      .toEqual({ writeDb, ownership, fencedTransactionIdleTimeoutMs: 700, trackStaticReadModel: true })
    expect(syncServerStorageAdapterOptions({
      writeDb, ownership: { ...ownership, enabled: false }, fencedTransactionIdleTimeoutMs: Number.NaN, trackStaticReadModel: false,
    })).toEqual({ writeDb, ownership: undefined, fencedTransactionIdleTimeoutMs: 1_000, trackStaticReadModel: false })
  })

  it('automergeServer.ts passes THE storage write pool, the probe and the shutdown steps', () => {
    const server = source('./automergeServer.ts')
    expect(server).toMatch(/new PostgresStorageAdapter\(syncServerStorageAdapterOptions\(\{\s*writeDb: storageWritePool,/)
    expect(server).toContain('new AutomergeResidencyLeases(repo, residencyStorageProbe(storageAdapter))')
    expect(server).toMatch(/runShutdownSteps\('Automerge shutdown', automergeShutdownSteps\(\{[\s\S]*?storageAdapter,/)
  })

  it('the probe forwards every hook to the adapter', () => {
    const adapter = {
      residencySnapshot: vi.fn(() => ({ trackedDocuments: 1, trackedChunkBytes: 2 })),
      forgetResidency: vi.fn(),
      hasUnsavedWrite: vi.fn(() => true),
      saveCursor: vi.fn(() => 41),
      flushSettled: vi.fn(),
    }
    const probe = residencyStorageProbe(adapter as never)
    expect(probe.snapshot(['d'])).toEqual({ trackedDocuments: 1, trackedChunkBytes: 2 })
    probe.forget('d')
    expect(probe.hasUnsavedWrite('d')).toBe(true)
    expect(probe.saveCursor()).toBe(41)
    probe.flushSettled('d', 41)
    expect(adapter.residencySnapshot).toHaveBeenCalledWith(['d'])
    expect(adapter.forgetResidency).toHaveBeenCalledWith('d')
    expect(adapter.hasUnsavedWrite).toHaveBeenCalledWith('d')
    expect(adapter.flushSettled).toHaveBeenCalledWith('d', 41)
  })

  it('shutdown: the retries stop AFTER the Repo\'s last flush; index.ts ends the write pool after that', async () => {
    const order: string[] = []
    const steps = automergeShutdownSteps({
      drain: async () => { order.push('drain') },
      repoShutdown: async () => { order.push('repo') },
      storageAdapter: { close: () => { order.push('close') } },
      stopBackgroundSaveErrors: () => { order.push('observer') },
    })
    expect(steps.map((step) => step.name)).toEqual(['drain', 'repo shutdown', 'storage retries', 'background save observer'])
    for (const step of steps) await step.run()
    expect(order).toEqual(['drain', 'repo', 'close', 'observer'])
    const index = source('./index.ts')
    const automerge = index.indexOf('await shutdownAutomerge()')
    const writePoolEnd = index.indexOf('await storageWritePool.end()')
    expect(automerge).toBeGreaterThan(0)
    expect(writePoolEnd).toBeGreaterThan(automerge)
  })
})
