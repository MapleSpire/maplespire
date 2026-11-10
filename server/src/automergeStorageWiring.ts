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

import type { Pool } from 'pg'
import type { PostgresStorageAdapter } from './automergeStorage.js'
import type { AutomergeResidencyStorageProbe } from './automergeResidency.js'
import type { SyncCellOwnership } from './syncCells/ownership.js'

/**
 * How the sync server wires its storage adapter (G4-16d), apart from
 * `automergeServer.ts` so that what the wiring PASSES is testable: no test
 * boots that function (`automergeStorageWiring.test.ts`).
 */

/** The sync server's adapter options: saves and removals on the tagged,
 * bounded storage WRITE pool (`storageWritePoolConfig`), reads on the
 * primary pool (the adapter's default). */
export function syncServerStorageAdapterOptions(args: {
  writeDb: Pool
  ownership: (Pick<SyncCellOwnership, 'fencingToken'> & { enabled?: boolean }) | undefined
  fencedTransactionIdleTimeoutMs: number
  trackStaticReadModel: boolean
}): ConstructorParameters<typeof PostgresStorageAdapter>[0] {
  return {
    writeDb: args.writeDb,
    ownership: args.ownership?.enabled ? args.ownership : undefined,
    fencedTransactionIdleTimeoutMs: Number.isFinite(args.fencedTransactionIdleTimeoutMs)
      ? args.fencedTransactionIdleTimeoutMs
      : 1_000,
    trackStaticReadModel: args.trackStaticReadModel,
  }
}

/** The residency's view of the adapter: chunk accounting, and the unsaved-
 * write hooks that keep an eviction from dropping the only copy of a delta
 * and clear a mark a resolved flush proves stale. */
export function residencyStorageProbe(
  adapter: Pick<PostgresStorageAdapter,
    'residencySnapshot' | 'forgetResidency' | 'hasUnsavedWrite' | 'saveCursor' | 'flushSettled'>,
): Required<AutomergeResidencyStorageProbe> {
  return {
    snapshot: (documentIds) => adapter.residencySnapshot(documentIds),
    forget: (documentId) => adapter.forgetResidency(documentId),
    hasUnsavedWrite: (documentId) => adapter.hasUnsavedWrite(documentId),
    saveCursor: () => adapter.saveCursor(),
    flushSettled: (documentId, cursor) => adapter.flushSettled(documentId, cursor),
  }
}

/** The Automerge shutdown steps, in order: drain, the Repo's last flush,
 * THEN the adapter's retries stop (`close()`: none may fire against a pool
 * `index.ts` ends right after), then the background-save observer. */
export function automergeShutdownSteps(args: {
  drain: () => Promise<void>
  repoShutdown: () => Promise<void>
  storageAdapter: Pick<PostgresStorageAdapter, 'close'>
  stopBackgroundSaveErrors: () => void
}): Array<{ name: string; run: () => void | Promise<void> }> {
  return [
    { name: 'drain', run: args.drain },
    { name: 'repo shutdown', run: args.repoShutdown },
    { name: 'storage retries', run: () => args.storageAdapter.close() },
    { name: 'background save observer', run: args.stopBackgroundSaveErrors },
  ]
}
