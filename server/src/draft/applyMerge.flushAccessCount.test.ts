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

import { describe, it, expect } from 'vitest'
import {
  Repo,
  type Chunk,
  type DocumentId,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { syncedHandle } from '../automergeRepoCompat.js'
import { flushTouchedDocuments } from './applyMerge.js'

/**
 * The merge's flush loop must not read `repo.handles`.
 *
 * `Repo.get handles()` is NOT a table: it allocates a fresh `Record` and copies
 * every entry of `#queries` on EACH access (~0.2 ms at n=1000, ~3.4 ms at
 * n=10000). Reading it once per touched document makes a merge of m documents
 * on a repo of n resident documents O(n*m) — a cost, not a wrong answer.
 *
 * A test observing only the RESULT (documents are durable) would pass the
 * O(n*m) version too, so the assertion is on the NUMBER OF ACCESSES — never on
 * a duration.
 *
 * No database: `flushTouchedDocuments` is extracted from
 * `applyChangesetDurably` so it can run against a real
 * `new Repo({ network: [] })` without Postgres or Redis.
 */

/** In-memory `StorageAdapterInterface`, same shape as `automergeServer.test.ts`. */
class MemoryStorage implements StorageAdapterInterface {
  private readonly entries = new Map<string, { key: StorageKey; data: Uint8Array }>()

  private keyText(key: StorageKey): string {
    return key.join('/')
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.entries.get(this.keyText(key))?.data.slice()
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.entries.set(this.keyText(key), { key: [...key], data: data.slice() })
  }

  async remove(key: StorageKey): Promise<void> {
    this.entries.delete(this.keyText(key))
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    return [...this.entries.values()]
      .filter(({ key }) => keyPrefix.every((part, index) => key[index] === part))
      .map(({ key, data }) => ({ key: [...key], data: data.slice() }))
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    for (const [text, { key }] of this.entries) {
      if (keyPrefix.every((part, index) => key[index] === part)) this.entries.delete(text)
    }
  }
}

/**
 * Counts reads of `repo.handles`. Deliberately duplicated from
 * `automergeServer.residentHeads.test.ts`: a `*.test.ts` must not import
 * another, and server code must never be able to import a shared test folder.
 */
function countHandlesReads(repo: Repo): () => number {
  let handlesReads = 0
  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(repo), 'handles')
  expect(original?.get, 'repo.handles must still be a getter').toBeTypeOf('function')
  Object.defineProperty(repo, 'handles', {
    configurable: true,
    get() { handlesReads += 1; return original!.get!.call(repo) },
  })
  return () => handlesReads
}

/**
 * Records each `repo.flush` call as its flattened id list (`'a|b'`). A global
 * flush with no argument records as `''`.
 */
function recordFlushCalls(repo: Repo): string[] {
  const calls: string[] = []
  const original = repo.flush.bind(repo)
  Object.defineProperty(repo, 'flush', {
    configurable: true,
    value: async (documents?: DocumentId[]): Promise<void> => {
      calls.push((documents ?? []).join('|'))
      await original(documents)
    },
  })
  return calls
}

/** `count` resident documents, changed and then flushed. */
async function seedDocuments(repo: Repo, count: number): Promise<DocumentId[]> {
  const ids: DocumentId[] = []
  for (let index = 0; index < count; index += 1) {
    const handle = repo.create<{ marker: string }>({ marker: `initial-${index}` })
    handle.change((doc) => { doc.marker = `merged-${index}` })
    ids.push(handle.documentId)
  }
  await repo.flush(ids)
  return ids
}

describe('T11.3bis site C — flushTouchedDocuments ne touche jamais repo.handles', () => {
  it('flushe 50 documents résidents avec ZÉRO lecture de repo.handles', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ storage, network: [] })
    const ids = await seedDocuments(repo, 50)

    // Guard (before instrumenting): the 50 documents are REALLY resident.
    // Without it, a loop that did nothing at all would pass.
    expect(
      Object.keys(repo.handles).sort(),
      'les 50 documents doivent être résidents avant le flush',
    ).toEqual([...ids].sort())

    const flushed = recordFlushCalls(repo)
    const reads = countHandlesReads(repo)
    const before = reads()

    await flushTouchedDocuments(repo, ids)

    // Guard: the work happened — one scoped flush per touched document.
    expect(
      flushed.sort(),
      'un flush scopé par document touché',
    ).toEqual([...ids].sort())

    // The gate. Any reintroduction of the getter in the loop (including a local
    // alias inside the `map`) makes the same documents durable and passes every
    // other assertion; only this counter, m instead of 0, tells it apart.
    // Not "small": ZERO.
    expect(reads() - before, 'la boucle de flush ne doit pas lire repo.handles').toBe(0)
  })

  it('le repli `find` est une voie de DURABILITÉ : un document évincé est quand même flushé', async () => {
    const storage = new MemoryStorage()
    const repo = new Repo({ storage, network: [] })
    const ids = await seedDocuments(repo, 4)
    const evicted = ids[1]

    // Guard: all 4 documents are resident BEFORE the eviction, otherwise
    // "it was evicted" means nothing.
    expect(
      Object.keys(repo.handles).sort(),
      'les 4 documents doivent être résidents avant l\'éviction',
    ).toEqual([...ids].sort())

    await repo.removeFromCache(evicted)
    expect(syncedHandle(repo, evicted), 'évincé : plus de synchronizer').toBeUndefined()
    expect(repo.handles[evicted], 'évincé : plus de query').toBeUndefined()

    // Premise (a property of automerge-repo, and the reason for the `find`
    // fallback): `flush` reads `#queries[id]?.peek()` and does nothing when the
    // entry is missing. It does not throw — it SKIPS SILENTLY.
    await expect(repo.flush([evicted])).resolves.toBeUndefined()
    expect(syncedHandle(repo, evicted), 'un flush ne réadmet rien').toBeUndefined()

    const flushed = recordFlushCalls(repo)
    await flushTouchedDocuments(repo, ids)

    // Catches collapsing the body into a single
    // `await repo.flush(touchedDocumentIds)`: that passes on the three resident
    // documents and on the access gate above, but silently drops the evicted
    // one — one `'a|b|c|d'` call instead of m scoped calls.
    expect(
      flushed.sort(),
      'un flush scopé par document, y compris pour l\'évincé',
    ).toEqual([...ids].sort())

    // The fallback READMITTED the document, so when `repo.flush([id])` runs for
    // it `#queries` holds a `ready` entry and the flush is real, not the no-op
    // above.
    const readmitted = syncedHandle(repo, evicted)
    expect(readmitted, 'le repli find doit réadmettre le document évincé').toBeDefined()
    expect(readmitted!.state).toBe('ready')

    // Durability witness INDEPENDENT of the subject repo's cache: a cold repo on
    // the same storage must read the evicted document back.
    const cold = new Repo({ storage, network: [] })
    const coldHandle = await cold.find<{ marker: string }>(evicted)
    expect(coldHandle.state).toBe('ready')
    expect(coldHandle.doc()).toEqual({ marker: 'merged-1' })
  })
})
