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
 * The chunk kinds that carry CONTENT — i.e. the ones whose presence means a
 * document's bytes were actually written.
 *
 * `sync-state` is the whole reason this exists. It is automerge-repo's own peer
 * bookkeeping, 2 bytes, written the first time a peer merely TRIES to sync a
 * document — including one whose content was never durably stored. So any check
 * of the form "does a row exist for this document id" answers YES for a
 * document nobody can open.
 *
 * ONE shared constant so every reader (fsck, backup/restore, retention checks)
 * uses the same positive filter. A negative filter ("not sync-state") would
 * count an unknown future chunk kind as content; a positive presence check puts
 * it on the finding side. Activity clocks have the opposite requirement: unknown
 * writes must not prove that a document is idle.
 *
 * Lives outside automergeStorage.ts so metadata readers can share it without
 * constructing that module's application pools.
 */
export const DOCUMENT_CONTENT_CHUNK_TYPES = ['snapshot', 'incremental'] as const

/** SQL fragment over a trusted column expression and module constants, never
 * request input. The existing automergeStorage tests exercise the re-export. */
export const documentContentChunkFilter = (keyColumn = 'key'): string => (
  `split_part(${keyColumn}, '/', 2) IN (${DOCUMENT_CONTENT_CHUNK_TYPES.map((kind) => `'${kind}'`).join(', ')})`
)
