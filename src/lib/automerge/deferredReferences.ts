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

import type { DocumentId } from '@automerge/automerge-repo'
import type { KvStore } from '../modelQuery/kvStore'

/**
 * "Content before pointer", one hop further than `publishAfterDurableFlush`.
 *
 * That helper orders a reference after the LOCAL IndexedDB flush. It cannot
 * order it after the SERVER: the browser syncs every document independently,
 * so a tab closed in between can leave the server holding a pointer to a
 * document it never received — every other client then meets
 * "Document … is unavailable" (measured 2026-10-18 for the demo seed, and
 * named at `writeModelShards` as a known gap for model-shard overflow).
 *
 * The fix is to not WRITE the pointer until the server has acknowledged the
 * document it names (`POST /api/automerge/durable-heads`), and to keep the
 * pending pointer in a persisted queue so a reload neither loses it nor hides
 * the author's own content.
 *
 * It must not be done by writing the pointer and refusing to sync it: a
 * client-side deny is cached per (document, peer) by automerge-repo and needs a
 * lift (an explicit share-policy re-evaluation). Not writing it needs none.
 *
 * ONLY FOR MINTED DOCUMENTS. The server acknowledges a document only once it is
 * claimed into the workspace (`automerge_document_workspace`). A minted id is
 * claimed by its MAC on first sync; a random fallback id is claimed only by the
 * walk from the root, i.e. through the very pointer being held back. Holding a
 * fallback document's pointer would wait for ever, so callers publish those at
 * once, as before (`isMintedDocumentId`, repo.ts).
 */

/** Resolves once the server has acknowledged a document as durable. */
export class ServerDurabilityWaiters {
  private readonly waiters = new Map<DocumentId, Array<() => void>>()
  private readonly acknowledged = new Set<DocumentId>()

  /** Resolves when `noteDurable` names the document — at once if it already
   *  has in this session. Never rejects; `clear()` abandons it. */
  wait(documentId: DocumentId): Promise<void> {
    if (this.acknowledged.has(documentId)) return Promise.resolve()
    return new Promise((resolve) => {
      const list = this.waiters.get(documentId) ?? []
      list.push(resolve)
      this.waiters.set(documentId, list)
    })
  }

  /** Called with the documents an acknowledgement round answered `durable`. */
  noteDurable(documentIds: Iterable<DocumentId>): void {
    for (const documentId of documentIds) {
      this.acknowledged.add(documentId)
      const list = this.waiters.get(documentId)
      if (!list) continue
      this.waiters.delete(documentId)
      for (const resolve of list) resolve()
    }
  }

  /** Session end: pending waits never resolve. Their references stay in the
   *  persisted queue and are resumed by the next boot of that workspace. */
  clear(): void {
    this.waiters.clear()
    this.acknowledged.clear()
  }

  get pending(): number {
    return this.waiters.size
  }
}

/** ModelMeta's model-shard lists, or the workspace root's registry-shard list. */
export type DeferredReferenceField = 'objectShardUrls' | 'connectionShardUrls' | 'shardUrls'

export function isModelShardReferenceField(field: DeferredReferenceField): field is 'objectShardUrls' | 'connectionShardUrls' {
  return field === 'objectShardUrls' || field === 'connectionShardUrls'
}

/** A pointer that has not been written yet: `url` belongs in `field` of the
 *  document `holderDocumentId`. */
export interface DeferredReference {
  holderDocumentId: string
  field: DeferredReferenceField
  url: string
  /** `shardUrls` only: the same write also makes `url` the root's
   *  `registryWriteUrl` (a summary workspace's write head). One entry, so the
   *  two root fields are published in one change or not at all. */
  writeHead?: boolean
  /** Boots that could not load the document locally (`noteResumeFailure`). */
  resumeFailures?: number
}

export const DEFERRED_REFERENCES_KEY = 'deferred-references:v1'

function sameReference(a: DeferredReference, b: DeferredReference): boolean {
  return a.holderDocumentId === b.holderDocumentId && a.field === b.field && a.url === b.url
}

function isDeferredReference(value: unknown): value is DeferredReference {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return typeof ref.holderDocumentId === 'string'
    && (ref.field === 'objectShardUrls' || ref.field === 'connectionShardUrls' || ref.field === 'shardUrls')
    && typeof ref.url === 'string'
    && (ref.writeHead === undefined || typeof ref.writeHead === 'boolean')
    && (ref.resumeFailures === undefined || typeof ref.resumeFailures === 'number')
}

/**
 * The persisted set of pointers this browser still owes the workspace. Every
 * mutation is one atomic `KvStore.update`, so two tabs of the same workspace
 * cannot lose each other's entries.
 */
export class DeferredReferenceQueue {
  private readonly store: () => KvStore

  constructor(store: () => KvStore) {
    this.store = store
  }

  async list(): Promise<DeferredReference[]> {
    const stored = await this.store().get<unknown[]>(DEFERRED_REFERENCES_KEY)
    return Array.isArray(stored) ? stored.filter(isDeferredReference) : []
  }

  async add(reference: DeferredReference): Promise<void> {
    await this.store().update<unknown[]>(DEFERRED_REFERENCES_KEY, (old) => {
      const current = Array.isArray(old) ? old.filter(isDeferredReference) : []
      return current.some((entry) => sameReference(entry, reference)) ? current : [...current, reference]
    })
  }

  async remove(reference: DeferredReference): Promise<void> {
    await this.store().update<unknown[]>(DEFERRED_REFERENCES_KEY, (old) => {
      const current = Array.isArray(old) ? old.filter(isDeferredReference) : []
      return current.filter((entry) => !sameReference(entry, reference))
    })
  }

  /**
   * Count one boot that could not load the referenced document from this
   * browser, and drop the entry at `limit`. A document missing from local
   * storage is not coming back, and every boot that retries it pays a
   * resolution timeout. Returns the count after this failure.
   */
  async noteResumeFailure(reference: DeferredReference, limit: number): Promise<number> {
    let failures = 0
    await this.store().update<unknown[]>(DEFERRED_REFERENCES_KEY, (old) => {
      const current = Array.isArray(old) ? old.filter(isDeferredReference) : []
      const next: DeferredReference[] = []
      for (const entry of current) {
        if (!sameReference(entry, reference)) { next.push(entry); continue }
        failures = (entry.resumeFailures ?? 0) + 1
        if (failures < limit) next.push({ ...entry, resumeFailures: failures })
      }
      return next
    })
    return failures
  }
}
