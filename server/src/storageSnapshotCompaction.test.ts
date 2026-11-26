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

import { describe, expect, it } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo, type Chunk, type StorageAdapterInterface, type StorageKey } from '@automerge/automerge-repo'
import { createHash } from 'node:crypto'
import {
  documentContainsChunk, partitionCoveredRows, snapshotStorageKey, storageCompactionCoverageErrors, wellFormedChunks,
} from './storageSnapshotCompaction.js'

type D = { objects: Record<string, { name: string }> }
const base = () => {
  let doc = A.from<D>({ objects: { a: { name: 'a' }, b: { name: 'b' } } }, { actor: '01'.repeat(16) })
  const h0 = A.getHeads(doc)
  doc = A.change(doc, (d) => { d.objects.a!.name = 'a1' })
  const h1 = A.getHeads(doc)
  doc = A.change(doc, (d) => { d.objects.b!.name = 'b1' })
  return { doc, h0, h1 }
}

describe('documentContainsChunk (the coverage rule)', () => {
  it('a snapshot or an incremental of the document itself, or of an ancestor, is covered', () => {
    const { doc, h0, h1 } = base()
    const heads = A.getHeads(doc)
    expect(documentContainsChunk(doc, heads, A.save(doc))).toBe(true)
    expect(documentContainsChunk(doc, heads, A.save(A.view(doc, h0) as A.Doc<D>))).toBe(true)
    expect(documentContainsChunk(doc, heads, A.saveSince(doc, h1))).toBe(true)
    expect(documentContainsChunk(doc, heads, A.saveSince(doc, h0))).toBe(true)
  })

  it('a chunk holding a change the document lacks is NOT covered, nor one whose dependency is missing', () => {
    const { doc, h1 } = base()
    const heads = A.getHeads(doc)
    const later = A.change(A.clone(doc), (d) => { d.objects.a!.name = 'later' })
    expect(documentContainsChunk(doc, heads, A.saveSince(later, heads))).toBe(false)
    expect(documentContainsChunk(doc, heads, A.save(later))).toBe(false)
    // A change built on a state the document never had: its dependency is
    // missing in `doc`, it is queued, the heads do not move — still refused.
    const other = A.change(A.from<D>({ objects: {} }, { actor: '02'.repeat(16) }), (d) => { d.objects.z = { name: 'z' } })
    const otherNext = A.change(A.clone(other), (d) => { d.objects.z!.name = 'z2' })
    expect(documentContainsChunk(doc, heads, A.saveSince(otherNext, A.getHeads(other)))).toBe(false)
    void h1
  })

  it('bytes that do not parse are not covered, and the document is left untouched', () => {
    const { doc, h1 } = base()
    const heads = A.getHeads(doc)
    // Control: `loadIncremental` alone ignores garbage (heads unchanged), the
    // reason for `wellFormedChunks`.
    const ignored = A.loadIncremental(A.clone(doc), new Uint8Array([1, 2, 3, 4, 5]))
    expect(A.getHeads(ignored)).toEqual(heads)
    expect(documentContainsChunk(doc, heads, new Uint8Array([1, 2, 3, 4, 5]))).toBe(false)
    const good = A.saveSince(doc, h1)
    expect(wellFormedChunks(good)).toBe(true)
    expect(wellFormedChunks(A.save(doc))).toBe(true)
    expect(wellFormedChunks(new Uint8Array([...A.save(doc), ...good]))).toBe(true)
    expect(documentContainsChunk(doc, heads, good.subarray(0, good.length - 1))).toBe(false)
    const flipped = good.slice()
    flipped[flipped.length - 1] ^= 0xff
    expect(documentContainsChunk(doc, heads, flipped)).toBe(false)
    expect(documentContainsChunk(doc, heads, new Uint8Array([...good, 0]))).toBe(false)
    expect(documentContainsChunk(doc, heads, new Uint8Array())).toBe(false)
    expect(A.getHeads(doc)).toEqual(heads)
    expect(A.toJS(doc).objects.a!.name).toBe('a1')
  })
})

describe('a chunk with valid framing and a body Automerge refuses', () => {
  it('is not covered, and the refusal is counted', () => {
    const { doc } = base()
    const heads = A.getHeads(doc)
    const body = new Uint8Array([7, 7, 7, 7, 7])
    const typed = new Uint8Array([1, body.length, ...body]) // type 1, uLEB length, body
    const checksum = createHash('sha256').update(typed).digest().subarray(0, 4)
    const chunk = new Uint8Array([0x85, 0x6f, 0x4a, 0x83, ...checksum, ...typed])
    expect(wellFormedChunks(chunk)).toBe(true)
    const before = storageCompactionCoverageErrors()
    expect(documentContainsChunk(doc, heads, chunk)).toBe(false)
    expect(storageCompactionCoverageErrors()).toBe(before + 1)
    // Once per ROW: the concatenated try of the partition does not
    // count; its row-by-row fallback counts the one bad row once.
    const good = { key: 'd/snapshot/s', arrivalSeq: '1', octets: 1, scope: '1:2', data: A.save(doc) }
    const bad = { key: 'd/incremental/bad', arrivalSeq: '2', octets: 1, scope: '1:2', data: chunk }
    const mid = storageCompactionCoverageErrors()
    const split = partitionCoveredRows(doc, heads, [good, bad], undefined)
    expect(split.kept.map((r) => r.key)).toEqual(['d/incremental/bad'])
    expect(storageCompactionCoverageErrors()).toBe(mid + 1)
  })
})

describe('partitionCoveredRows', () => {
  it('its OWN snapshot row is covered without bytes iff the document has its heads; any field changed is a different row', () => {
    const { doc, h1 } = base()
    const heads = A.getHeads(doc)
    const own = { key: 'd/snapshot/x', arrivalSeq: '7', octets: 100, digest: 'aa', scope: '1:2', heads: h1 }
    const row = { key: 'd/snapshot/x', arrivalSeq: '7', octets: 100, digest: 'aa', scope: '1:2' }
    expect(partitionCoveredRows(doc, heads, [row], own).covered).toHaveLength(1)
    // Another version of the same key (no bytes to check): kept.
    for (const changed of [{ arrivalSeq: '8' }, { octets: 101 }, { scope: '1:3' }, { key: 'd/snapshot/y' }, { digest: 'bb' }, { digest: undefined }]) {
      expect(partitionCoveredRows(doc, heads, [{ ...row, ...changed }], own).kept).toHaveLength(1)
    }
    // Heads the document does not have: kept.
    const foreign = A.change(A.clone(doc), (d) => { d.objects.a!.name = 'x' })
    expect(partitionCoveredRows(doc, heads, [row], { ...own, heads: A.getHeads(foreign) }).kept).toHaveLength(1)
  })

  it('other rows are checked by their bytes', () => {
    const { doc, h1 } = base()
    const heads = A.getHeads(doc)
    const later = A.change(A.clone(doc), (d) => { d.objects.b!.name = 'later' })
    const { covered, kept } = partitionCoveredRows(doc, heads, [
      { key: 'd/incremental/1', arrivalSeq: '1', octets: 1, scope: '1:2', data: A.saveSince(doc, h1) },
      { key: 'd/incremental/2', arrivalSeq: '2', octets: 1, scope: '1:2', data: A.saveSince(later, heads) },
      { key: 'd/incremental/3', arrivalSeq: '3', octets: 1, scope: '1:2' },
    ], undefined)
    expect(covered.map((r) => r.key)).toEqual(['d/incremental/1'])
    expect(kept.map((r) => r.key).sort()).toEqual(['d/incremental/2', 'd/incremental/3'])
  })

  it('many covered rows pass in one concatenated check; one foreign row among them falls back to row by row', () => {
    let doc = A.from<D>({ objects: { a: { name: 'a' } } }, { actor: '03'.repeat(16) })
    const rows: Array<{ key: string; arrivalSeq: string; octets: number; scope: string; data: Uint8Array }> = [
      { key: 'd/snapshot/s', arrivalSeq: '1', octets: 1, scope: '1:2', data: A.save(doc) },
    ]
    for (let i = 0; i < 40; i += 1) {
      const before = A.getHeads(doc)
      doc = A.change(doc, (d) => { d.objects.a!.name = `v${i}` })
      rows.push({ key: `d/incremental/${i}`, arrivalSeq: String(i + 2), octets: 1, scope: '1:2', data: A.saveSince(doc, before) })
    }
    const heads = A.getHeads(doc)
    expect(partitionCoveredRows(doc, heads, rows, undefined).covered).toHaveLength(41)
    const foreign = A.change(A.clone(doc, { actor: '04'.repeat(16) }), (d) => { d.objects.a!.name = 'foreign' })
    const mixed = [...rows, { key: 'd/incremental/foreign', arrivalSeq: '99', octets: 1, scope: '1:2', data: A.saveSince(foreign, heads) }]
    const split = partitionCoveredRows(doc, heads, mixed, undefined)
    expect(split.covered).toHaveLength(41)
    expect(split.kept.map((r) => r.key)).toEqual(['d/incremental/foreign'])
  })
})

describe('snapshotStorageKey', () => {
  it('is the key automerge-repo gives a snapshot at the same heads', async () => {
    const saved: string[] = []
    const store = new Map<string, Uint8Array>()
    const adapter: StorageAdapterInterface = {
      load: async (key: StorageKey) => store.get(key.join('/')),
      save: async (key: StorageKey, data: Uint8Array) => { saved.push(key.join('/')); store.set(key.join('/'), data) },
      remove: async (key: StorageKey) => { store.delete(key.join('/')) },
      loadRange: async (prefix: StorageKey): Promise<Chunk[]> => [...store].filter(([k]) => k.startsWith(prefix.join('/')))
        .map(([k, data]) => ({ key: k.split('/'), data })),
      removeRange: async (prefix: StorageKey) => { for (const k of [...store.keys()]) if (k.startsWith(prefix.join('/'))) store.delete(k) },
    }
    const repo = new Repo({ storage: adapter, network: [] })
    const handle = repo.create<D>({ objects: { a: { name: 'a' }, b: { name: 'b' } } })
    handle.change((d) => { d.objects.a!.name = 'two heads? no, one' })
    await repo.flush()
    const expected = snapshotStorageKey(String(handle.documentId), A.getHeads(handle.doc()!)).join('/')
    expect(saved.filter((k) => k.split('/')[1] === 'snapshot')).toContain(expected)
    await repo.shutdown()
  })

  it('on a document with TWO concurrent heads, the key is automerge-repo\'s headsHash of them', async () => {
    const saved: string[] = []
    const store = new Map<string, Uint8Array>()
    const adapter: StorageAdapterInterface = {
      load: async (key: StorageKey) => store.get(key.join('/')),
      save: async (key: StorageKey, data: Uint8Array) => { saved.push(key.join('/')); store.set(key.join('/'), data) },
      remove: async (key: StorageKey) => { store.delete(key.join('/')) },
      loadRange: async (prefix: StorageKey): Promise<Chunk[]> => [...store].filter(([k]) => k.startsWith(prefix.join('/')))
        .map(([k, data]) => ({ key: k.split('/'), data })),
      removeRange: async (prefix: StorageKey) => { for (const k of [...store.keys()]) if (k.startsWith(prefix.join('/'))) store.delete(k) },
    }
    const repo = new Repo({ storage: adapter, network: [] })
    const handle = repo.create<D>({ objects: { a: { name: 'a' } } })
    await repo.flush()
    // A fork merged back: two heads. The document stays under 1 kB, so
    // automerge-repo writes a SNAPSHOT at every save (its small-document rule).
    const fork = A.change(A.clone(handle.doc()!, { actor: '05'.repeat(16) }), (d) => { d.objects.b = { name: 'b' } })
    handle.change((d) => { d.objects.a!.name = 'a2' })
    handle.update((doc) => A.merge(doc, fork))
    await repo.flush()
    const heads = A.getHeads(handle.doc()!)
    expect(heads).toHaveLength(2)
    const expected = snapshotStorageKey(String(handle.documentId), heads).join('/')
    expect(saved.filter((k) => k.split('/')[1] === 'snapshot')).toContain(expected)
    // Order matters to the hash: the reversed heads name another key.
    expect(snapshotStorageKey(String(handle.documentId), [...heads].reverse()).join('/')).not.toBe(expected)
    await repo.shutdown()
  })
})
