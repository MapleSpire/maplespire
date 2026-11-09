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

// THE COMPACTION LATCH (G4-16d round 3).
//
// automerge-repo's StorageSubsystem keeps ONE flag for the whole Repo,
// `#compacting`, set at the top of `#saveTotal` and cleared at its END — with
// no try/finally. A snapshot save (or one of the removals after it) that
// throws leaves it true, and `#shouldCompact` then answers false for EVERY
// document of that Repo already saved or loaded — the ones a long-running
// server keeps editing — until some NEW document's first save (a `#saveTotal`
// that does not ask `#shouldCompact`) succeeds and clears it, which a quiet
// workspace may never do: incrementals pile up, loads slow down, storage
// grows (`automerge-compaction-latch.test.mjs`). One storage write stopped by a ceiling
// of the storage write pool (`storageWritePoolConfig`, `dbConfig.ts`) is
// enough. This patch moves the body into `#saveTotalBody` and clears the flag
// in a `finally`; the body itself is unchanged (it still clears the flag on
// success, now redundantly).

const sentinel = 'maplespire: compaction latch released on failure'

const before = `    async #saveTotal(documentId, doc, sourceChunks) {
        this.#compacting = true;`

const after = `    async #saveTotal(documentId, doc, sourceChunks) {
        // ${sentinel}. A throw from the body (a failed snapshot
        // save or removal) would otherwise leave #compacting true for the
        // whole Repo, and no document would ever be compacted again.
        this.#compacting = true;
        try {
            return await this.#saveTotalBody(documentId, doc, sourceChunks);
        }
        finally {
            this.#compacting = false;
        }
    }
    async #saveTotalBody(documentId, doc, sourceChunks) {`

/** Patch StorageSubsystem.js so a failed `#saveTotal` releases the latch. */
export function patchStorageSubsystemCompactionLatchSource(source) {
  if (source.includes(sentinel)) {
    if (source.split(sentinel).length !== 2 || source.split('async #saveTotalBody(').length !== 2) {
      throw new Error('Ambiguous automerge-repo StorageSubsystem; mixed or duplicated compaction-latch patch.')
    }
    return { source, changed: false }
  }
  if (source.split(before).length !== 2) {
    throw new Error(
      'Unsupported automerge-repo StorageSubsystem #saveTotal; review the compaction-latch patch before upgrading.',
    )
  }
  return { source: source.replace(before, after), changed: true }
}

/**
 * The exact inverse, for the test that shows the defect: the patched
 * `#saveTotal` / `#saveTotalBody` pair back to upstream's single method. The
 * install is always patched (postinstall), so this is the only way to run the
 * unpatched code every time. Refuses anything but exactly one patched block.
 */
export function unpatchStorageSubsystemCompactionLatchSource(source) {
  if (!source.includes(sentinel)) return { source, changed: false }
  if (source.split(after).length !== 2) {
    throw new Error('Ambiguous automerge-repo StorageSubsystem; the compaction-latch block is not exactly once as written.')
  }
  return { source: source.replace(after, before), changed: true }
}
