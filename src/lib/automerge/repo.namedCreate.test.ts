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
 * The synchronous naming seam (`createHandleNamed` via `repo.import`).
 *
 * The property under test end to end: a browser-created document whose id
 * came from the minted reserve behaves EXACTLY like a `repo.create`d one
 * (value, readiness, storage) while carrying the server-minted 24-byte name
 * the sync gate verifies with a MAC. Every fallback path must produce an
 * ordinary random 16-byte id, never a throw and never a merge.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  Repo,
  documentIdToBinary,
  type Chunk,
  type StorageKey,
  type StorageAdapterInterface,
} from '@automerge/automerge-repo'
import { createDiagramHandle, importDocumentNamed } from './repo'
import { __setMintedIdTakeForTest } from './mintedIdSupply'
import type { DiagramDoc } from './types'

/** Minted-shaped bytes: version byte 1 + 23 random bytes. The nonce is random
 * so ids never collide across tests — `namedThisSession` is module state and
 * deliberately never cleared (a session guard, not a cache). */
function mintedLikeBytes(): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes[0] = 1
  bytes.set(randomBytes(23), 1)
  return bytes
}

/** Feed createHandleNamed's take() a fixed queue; empty queue = empty reserve. */
function injectTakes(queue: (Uint8Array | null)[]): void {
  __setMintedIdTakeForTest(() => (queue.length > 0 ? queue.shift()! : null))
}

function blankDiagram(name: string): DiagramDoc {
  return {
    name,
    type: 'context',
    objectIds: [],
    connectionIds: [],
    groupIds: [],
    comments: {},
    flows: {},
    checkpoints: [],
  }
}

/** The minimal in-memory storage adapter automerge-repo accepts — enough to
 * observe whether the storage listener captured a document's initial data. */
class MemoryStorageAdapter implements StorageAdapterInterface {
  readonly saved = new Map<string, Uint8Array>()
  private key(k: StorageKey): string {
    return k.join('/')
  }
  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.saved.get(this.key(key))
  }
  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.saved.set(this.key(key), data)
  }
  async remove(key: StorageKey): Promise<void> {
    this.saved.delete(this.key(key))
  }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const p = this.key(prefix)
    return [...this.saved.entries()]
      .filter(([k]) => k.startsWith(p))
      .map(([k, data]) => ({ key: k.split('/'), data }))
  }
  async removeRange(prefix: StorageKey): Promise<void> {
    const p = this.key(prefix)
    for (const k of [...this.saved.keys()]) if (k.startsWith(p)) this.saved.delete(k)
  }
}

describe('createHandleNamed — minted naming via repo.import', () => {
  afterEach(() => __setMintedIdTakeForTest(null))

  // Mutant: createHandleNamed falls back to repo.create (or a dead idFactory
  // branch) → a 16-byte random id instead of the injected 24 bytes.
  it('a reserved id names the document', () => {
    const bytes = mintedLikeBytes()
    injectTakes([bytes])
    const handle = createDiagramHandle(blankDiagram('named'))
    expect(handle.url).toMatch(/^automerge:.{37,38}$/)
    const decoded = documentIdToBinary(handle.documentId)
    expect(decoded, 'the documentId must decode via bs58check').toBeTruthy()
    expect(Array.from(decoded!)).toEqual(Array.from(bytes))
  })

  // Mutant: `emptyChange(init())` instead of `from(initial)` — the initial
  // value is lost and every consumer boots an empty diagram.
  it('an import-named document carries the initial value and is immediately ready', () => {
    const bytes = mintedLikeBytes()
    injectTakes([bytes])
    const initial = blankDiagram('carries-initial')
    initial.objectIds = ['o1', 'o2']
    const handle = createDiagramHandle(initial)
    expect(handle.isReady()).toBe(true)
    const doc = handle.doc()
    expect(doc?.name).toBe('carries-initial')
    expect(Array.from(doc?.objectIds ?? [])).toEqual(['o1', 'o2'])
    expect(doc?.comments).toEqual({})
  })

  // Pins the load-bearing sentence of #ensureQuery's doc-comment: an imported
  // document is applied AFTER registration so the storage listener captures
  // the initial data. What it pins is the IMPORT path's persistence — that
  // `import` keeps joining the same storage path as `create` (the exposure at
  // an automerge-repo upgrade). It does NOT catch
  // every conceivable bypass of #ensureQuery: a hand-built DocHandle that fed
  // the storage subsystem some other way would still pass here.
  it('an import-named document is persisted by repo.flush like a created one', async () => {
    const storage = new MemoryStorageAdapter()
    const isolated = new Repo({ network: [], storage })
    const bytes = mintedLikeBytes()
    const handle = importDocumentNamed<{ hello: string }>(isolated, { hello: 'storage' }, bytes)
    expect(handle).not.toBeNull()
    await isolated.flush([handle!.documentId])
    const chunks = [...storage.saved.keys()].filter((k) => k.startsWith(String(handle!.documentId)))
    expect(chunks.length, 'the storage listener must capture an import-named document').toBeGreaterThan(0)
  })

  // Mutant: `from(initial)` without clonePlain in createDiagramHandle — a
  // store-built diagram legitimately carries present-but-undefined optionals
  // (`domainId: undefined` in a domain-less workspace) and Automerge throws
  // on undefined, so the creation would fail instead of naming.
  it('undefined-bearing initial values still name (clonePlain before from)', () => {
    const bytes = mintedLikeBytes()
    injectTakes([bytes])
    const initial: DiagramDoc = { ...blankDiagram('undef-bearing'), domainId: undefined }
    const handle = createDiagramHandle(initial)
    expect(Array.from(documentIdToBinary(handle.documentId)!)).toEqual(Array.from(bytes))
  })

  // THE one corruption this scheme could produce: repo.import with an id the
  // repo already holds silently MERGES histories (Repo.js). Mutant:
  // delete the namedThisSession guard → the second create returns the FIRST
  // document (same documentId) with both histories merged into it.
  it('a session-repeated id falls back to a random id instead of merging histories', () => {
    const bytes = mintedLikeBytes()
    injectTakes([bytes, bytes])
    const first = createDiagramHandle(blankDiagram('first'))
    const second = createDiagramHandle(blankDiagram('second'))
    expect(String(second.documentId)).not.toBe(String(first.documentId))
    expect(documentIdToBinary(second.documentId)!.length, 'the repeat must fall back to a random id').toBe(16)
    expect(first.doc()?.name, 'the first document must not receive the second history').toBe('first')
    expect(Array.from(documentIdToBinary(first.documentId)!)).toEqual(Array.from(bytes))
  })

  // The fallback: no id, no ceremony, an ordinary random-id creation. Never
  // blocks, never throws.
  it('an empty reserve creates with an ordinary random id', () => {
    injectTakes([])
    const handle = createDiagramHandle(blankDiagram('fallback'))
    expect(documentIdToBinary(handle.documentId)!.length).toBe(16)
    expect(handle.doc()?.name).toBe('fallback')
  })

  // Rule 4 of createHandleNamed: nothing swallows the FALLBACK's
  // own failure. A value `repo.create` rejects must THROW out of the factory,
  // with or without a minted id in the reserve. Mutant: a catch wrapped
  // around the final `repo.create` returning some empty document → the
  // invalid create "succeeds" silently and the defect waits for a human.
  // (Chosen over injecting a throwing repo: the module-level `repo` is not
  // injectable from here, and a genuinely rejected value exercises the very
  // failure the rule is about.)
  it("the fallback's own failure surfaces instead of a silent empty document", () => {
    // A Symbol value survives clonePlain (neither array nor plain object →
    // returned as-is) and is rejected by Automerge inside repo.create
    // (`RangeError: invalid import`). Not a function: Automerge silently
    // imports one as `{}` (automerge 3.x).
    const poisoned = (name: string): DiagramDoc =>
      ({ ...blankDiagram(name), poison: Symbol('unsupported') }) as unknown as DiagramDoc

    // Empty reserve: the fallback IS the path, and its throw propagates.
    injectTakes([])
    expect(() => createDiagramHandle(poisoned('fallback-throw'))).toThrow()

    // Minted id available: the minted path's failure falls back (rule 2), and
    // the fallback's own throw still propagates (rule 4) — never swallowed.
    injectTakes([mintedLikeBytes()])
    expect(() => createDiagramHandle(poisoned('minted-then-fallback-throw'))).toThrow()
  })
})
