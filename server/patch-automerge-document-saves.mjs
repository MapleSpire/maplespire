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

function replaceOnce(source, before, after, name) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2
      || source.split(before).length !== after.split(before).length) {
      throw new Error(`Ambiguous automerge-repo ${name}; mixed or duplicated document-save patch.`)
    }
    return { source, changed: false }
  }
  if (source.split(before).length !== 2) {
    throw new Error(`Unsupported automerge-repo ${name}; review document-save patch before upgrading.`)
  }
  return { source: source.replace(before, after), changed: true }
}

/** Preserve write admission and SavedHeads ordering; join bodies, never barriers. */
export function patchDocumentSaveBarrierSource(source) {
  const before = `    async saveDoc(documentId, doc) {
        // Don't bother saving if the document hasn't changed`
  const after = `    #pendingDocumentSaves = new Map();
    async saveDoc(documentId, doc) {
        let batch = this.#pendingDocumentSaves.get(documentId);
        if (!batch) {
            batch = { pending: new Set(), failed: false, error: undefined };
            this.#pendingDocumentSaves.set(documentId, batch);
        }
        let resolveWrite, rejectWrite;
        const write = new Promise((resolve, reject) => {
            resolveWrite = resolve;
            rejectWrite = reject;
        });
        // Reserve before starting the body: doc-saved/doc-compacted listeners
        // can reenter saveDoc synchronously. Only raw bodies enter this set.
        batch.pending.add(write);
        const admittedBatch = batch;
        const finish = () => {
            admittedBatch.pending.delete(write);
            if (admittedBatch.pending.size === 0
                && this.#pendingDocumentSaves.get(documentId) === admittedBatch)
                this.#pendingDocumentSaves.delete(documentId);
        };
        void write.then(finish, error => {
            if (!admittedBatch.failed) {
                admittedBatch.failed = true;
                admittedBatch.error = error;
            }
            finish();
        });
        // Observe the first wave before the body can settle or reenter.
        const drained = this.drainDocumentSaves(documentId);
        void this.#saveDocumentBody(documentId, doc).then(resolveWrite, rejectWrite);
        await drained;
    }
    async drainDocumentSaves(documentId) {
        let batch = this.#pendingDocumentSaves.get(documentId);
        let failed = false, failure;
        while (batch) {
            await Promise.allSettled([...batch.pending]);
            if (batch.failed && !failed) {
                failed = true;
                failure = batch.error;
            }
            batch = this.#pendingDocumentSaves.get(documentId);
            // Autosave can start DURING a flush. Waiting only for writes that
            // preceded it lets that later write invalidate a freshness stamp.
            // Continuous writes can prolong this drain; there is no timeout
            // or cancellation claim. Other document IDs remain independent.
        }
        if (failed)
            throw failure;
    }
    async #saveDocumentBody(documentId, doc) {
        // Don't bother saving if the document hasn't changed`
  return replaceOnce(source, before, after, 'StorageSubsystem save barrier')
}

export function patchDocumentSaveBarrierTypesSource(source) {
  const before = '    saveDoc(documentId: DocumentId, doc: A.Doc<unknown>): Promise<void>;'
  return replaceOnce(source, before, `${before}
    /** Wait for active document writes without starting a new write. */
    drainDocumentSaves(documentId: DocumentId): Promise<void>;`, 'StorageSubsystem save barrier types')
}

/** A delayed callback must not re-save an old snapshot after a newer flush. */
export function patchStorageSourceCurrentDocumentSource(source) {
  return replaceOnce(source,
    `asyncThrottle(({ doc, handle }) => this.#storage.saveDoc(handle.documentId, doc).catch(error => {
                this.#onStorageError?.({ documentId: handle.documentId, error, operation: "document" });
            }), this.#saveDebounceRate);`,
    `asyncThrottle(async ({ doc, handle }) => {
                try {
                    // Keep an already armed save after detach. A current
                    // callback reads the latest revision instead of replaying
                    // a captured snapshot after a newer explicit flush.
                    const current = this.#saveFns[documentId] === fn ? handle.fullDoc() : doc;
                    await this.#storage.saveDoc(handle.documentId, current);
                }
                catch (error) {
                    this.#onStorageError?.({ documentId: handle.documentId, error, operation: "document" });
                }
            }, this.#saveDebounceRate);`,
    'StorageSource current document')
}
