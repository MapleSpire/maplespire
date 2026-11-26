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

// THE STRICT DECODE BINDING (G4-16f).
//
// StorageSubsystem.loadDoc strictly loads (A.load, the bulk-load patch) the
// very chunks the read model's durable proof later re-reads and re-decodes in
// full. This patch lets the storage adapter remember that decode: after a
// load that took the A.load path — NEVER the loadIncremental fallback — and
// whose document has no missing dependencies, loadDoc calls the OPTIONAL
// adapter hook `noteStrictDecode(documentId, chunks, heads)` with exactly the
// chunk objects loadDocData merged (its two loadRange calls: snapshots, then
// incrementals). An adapter without the hook sees no behaviour change; a hook
// that throws is logged and never fails the load. SavedHeads and chunkInfos
// are untouched.
//
// Applies AFTER the bulk-load patch (patch-automerge-peer-sync-state.mjs):
// its A.load block is one of the anchors.

const sentinel = 'maplespire: strict decode binding'

const parts = [
  {
    name: 'chunk map field',
    before: `    /**
     * Loads and combines document chunks from storage, with snapshots first.
     */
    async loadDocData(documentId) {`,
    after: `    // ${sentinel}: merged binary -> the chunks it was merged from.
    #strictDecodeChunks = new WeakMap();
    /**
     * Loads and combines document chunks from storage, with snapshots first.
     */
    async loadDocData(documentId) {`,
  },
  {
    name: 'merged chunk record',
    before: `        // Merge the chunks into a single binary
        return mergeArrays(binaries);`,
    after: `        // Merge the chunks into a single binary
        const merged = mergeArrays(binaries);
        this.#strictDecodeChunks.set(merged, [...snapshotChunks, ...incrementalChunks]
            .filter(chunk => chunk.data !== undefined));
        return merged;`,
  },
  {
    name: 'strict path flag',
    before: `        try {
            newDoc = A.load(binary);
        }`,
    after: `        let strictDecode = false;
        try {
            newDoc = A.load(binary);
            strictDecode = true;
        }`,
  },
  {
    name: 'adapter hook',
    before: `        headsHandle.update(A.getHeads(newDoc));
        return newDoc;`,
    after: `        headsHandle.update(A.getHeads(newDoc));
        // ${sentinel}: only a strict, dependency-complete load binds.
        const strictChunks = this.#strictDecodeChunks.get(binary);
        this.#strictDecodeChunks.delete(binary);
        if (strictDecode && strictChunks
            && typeof this.#storageAdapter.noteStrictDecode === "function") {
            try {
                if (A.getMissingDeps(newDoc, []).length === 0)
                    this.#storageAdapter.noteStrictDecode(documentId, strictChunks, A.getHeads(newDoc));
            }
            catch (error) {
                this.#log.warn(\`strict decode binding failed for \${documentId}\`, error);
            }
        }
        return newDoc;`,
  },
]

/** Patch StorageSubsystem.js (already bulk-load patched). All four parts are
 * applied together or the source is refused. */
export function patchStorageSubsystemStrictDecodeSource(source) {
  if (parts.some(part => source.includes(part.after))) {
    // Every part exactly once, and no unpatched anchor left beside it.
    if (source.split(sentinel).length !== 3
      || parts.some(part => source.split(part.after).length !== 2
        || source.split(part.before).length !== part.after.split(part.before).length)) {
      throw new Error('Ambiguous automerge-repo StorageSubsystem; mixed, partial or duplicated strict-decode patch.')
    }
    return { source, changed: false }
  }
  if (source.includes(sentinel) || parts.some(part => source.split(part.before).length !== 2)) {
    throw new Error(
      'Unsupported automerge-repo StorageSubsystem loadDoc; review the strict-decode patch before upgrading.',
    )
  }
  let patched = source
  for (const part of parts) patched = patched.replace(part.before, () => part.after)
  return { source: patched, changed: true }
}
