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

import type { DocumentId, Repo } from '@automerge/automerge-repo'
import { StaleSyncCellWriteError } from './automergeStorage.js'

interface StorageErrorEvent {
  documentId: DocumentId
  error: unknown
  operation?: 'document' | 'sync-state' | 'sync-state-reset'
}

interface StorageErrorEmitter {
  on(event: 'storage-error', listener: (event: StorageErrorEvent) => void): void
  off(event: 'storage-error', listener: (event: StorageErrorEvent) => void): void
}

export interface BackgroundSaveLogger {
  warn(message: string): void
  error(message: string, error: unknown): void
}

/**
 * Observe rejected debounced saves emitted by the patched Automerge Repo.
 *
 * A stale-fence rejection is an expected fail-closed result after ownership is
 * retired or transferred. Other storage errors remain high-severity. Explicit
 * `repo.flush()` calls are untouched and still reject their caller.
 */
export function observeAutomergeBackgroundSaveErrors(
  repo: Repo,
  logger: BackgroundSaveLogger = console,
): () => void {
  const emitter = repo as unknown as StorageErrorEmitter
  const listener = ({ documentId, error, operation = 'document' }: StorageErrorEvent): void => {
    if (error instanceof StaleSyncCellWriteError) {
      logger.warn(JSON.stringify({
        event: 'automerge.background_save_fenced',
        outcome: 'rejected',
        reason: 'stale_sync_cell',
        operation,
        mutationKind: error.mutationKind,
        fenceReason: error.reason,
        // WHICH document. Without it a refusal on a healthy cell cannot be
        // attributed (a released draft lease, a snapshot lease not yet
        // acquired, or a real hole).
        documentId,
      }))
      return
    }
    logger.error('[automerge] background storage save failed:', error)
  }
  emitter.on('storage-error', listener)
  return () => emitter.off('storage-error', listener)
}
