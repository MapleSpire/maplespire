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

// The strict-decode binding patch (patch-automerge-strict-decode.mjs): present
// in BOTH installed runtimes, idempotent, refusing partial/duplicated/unknown
// sources, and — against the real StorageSubsystem — calling the optional
// adapter hook only on a strict, dependency-complete load, with exactly the
// chunk objects the adapter returned. An adapter without the hook is unchanged.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { patchStorageSubsystemStrictDecodeSource } from './patch-automerge-strict-decode.mjs'

const runtimes = await Promise.all(['root', 'server'].map(async prefix => {
  const modules = new URL(prefix === 'root' ? '../node_modules/' : './node_modules/', import.meta.url)
  const importModule = path => import(new URL(path, modules).href)
  const A = await importModule('@automerge/automerge/dist/mjs/entrypoints/fullfat_node.js')
  const { StorageSubsystem } = await importModule('@automerge/automerge-repo/dist/storage/StorageSubsystem.js')
  return { prefix, modules, A, StorageSubsystem }
}))

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

/** Storage that returns the SAME chunk objects on every loadRange, so the
 * hook's arguments can be checked by identity. */
function memoryAdapter(rows, withHook = true) {
  const notes = []
  const adapter = {
    notes,
    async save() {}, async load() { return undefined }, async remove() {}, async removeRange() {},
    async loadRange(prefix) { return rows.filter(row => prefix.every((part, i) => row.key[i] === part)) },
  }
  if (withHook) adapter.noteStrictDecode = (documentId, chunks, heads) => notes.push({ documentId, chunks, heads })
  return adapter
}

function revisions(A) {
  const h0 = A.from({ name: 'H0' })
  const h1 = A.change(A.clone(h0), doc => { doc.name = 'H1' })
  const h2 = A.change(A.clone(h1), doc => { doc.name = 'H2' })
  return {
    h0, h1, h2,
    snapshot: A.save(h0),
    i1: A.saveSince(h1, A.getHeads(h0)),
    i2: A.saveSince(h2, A.getHeads(h1)),
  }
}

for (const { prefix, modules, A, StorageSubsystem } of runtimes) {
  test(`${prefix}: the strict-decode patch is installed, idempotent, and refuses partial, duplicated or unknown sources`, async () => {
    const source = await readFile(new URL('@automerge/automerge-repo/dist/storage/StorageSubsystem.js', modules), 'utf8')
    assert.equal(patchStorageSubsystemStrictDecodeSource(source).changed, false, 'installed source must already be patched')
    assert.match(source, /maplespire: strict decode binding/)
    assert.throws(() => patchStorageSubsystemStrictDecodeSource(`${source}\n${source}`), /Ambiguous/)
    assert.throws(() => patchStorageSubsystemStrictDecodeSource('unknown dependency'), /Unsupported/)
    // Partial: one part reverted.
    const partial = source.replace('            strictDecode = true;\n', '')
    assert.notEqual(partial, source)
    assert.throws(() => patchStorageSubsystemStrictDecodeSource(partial), /Ambiguous/)
  })

  test(`${prefix}: a strict load calls the hook with the adapter's own chunk objects and the loaded heads`, async () => {
    const f = revisions(A)
    const rows = [
      { key: ['doc', 'snapshot', 's'], data: f.snapshot },
      { key: ['doc', 'incremental', 'i1'], data: f.i1 },
    ]
    const adapter = memoryAdapter(rows)
    const doc = await new StorageSubsystem(adapter).loadDoc('doc')
    assert.deepEqual(A.getHeads(doc), A.getHeads(f.h1))
    assert.equal(adapter.notes.length, 1)
    assert.equal(adapter.notes[0].documentId, 'doc')
    assert.deepEqual(adapter.notes[0].heads, A.getHeads(f.h1))
    assert.equal(adapter.notes[0].chunks.length, 2)
    assert.ok(adapter.notes[0].chunks.every((chunk, index) => chunk === rows[index]), 'exact chunk objects, snapshots first')
  })

  test(`${prefix}: the loadIncremental fallback (trailing garbage) never calls the hook`, async () => {
    const f = revisions(A)
    const adapter = memoryAdapter([
      { key: ['doc', 'snapshot', 's'], data: f.snapshot },
      { key: ['doc', 'incremental', 'g'], data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    ])
    assert.throws(() => A.load(concat([f.snapshot, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])])), 'precondition: A.load refuses')
    const warn = console.warn
    let warned = 0
    console.warn = (...args) => { if (args.some(arg => String(arg).includes('falling back to incremental'))) warned++ }
    let doc
    try { doc = await new StorageSubsystem(adapter).loadDoc('doc') } finally { console.warn = warn }
    assert.equal(warned, 1, 'the fallback path was taken')
    assert.ok(doc)
    assert.equal(adapter.notes.length, 0)
  })

  test(`${prefix}: a dependency-less incremental never calls the hook`, async () => {
    const f = revisions(A)
    const adapter = memoryAdapter([
      { key: ['doc', 'snapshot', 's'], data: f.snapshot },
      { key: ['doc', 'incremental', 'i2'], data: f.i2 },
    ])
    const doc = await new StorageSubsystem(adapter).loadDoc('doc')
    assert.equal(A.getMissingDeps(doc, []).length, 1, 'precondition: A.load accepted a readable prefix')
    assert.equal(adapter.notes.length, 0)
  })

  test(`${prefix}: an adapter without the hook loads exactly as before, and a throwing hook never fails the load`, async () => {
    const f = revisions(A)
    const rows = [{ key: ['doc', 'snapshot', 's'], data: f.snapshot }, { key: ['doc', 'incremental', 'i1'], data: f.i1 }]
    const plain = await new StorageSubsystem(memoryAdapter(rows, false)).loadDoc('doc')
    assert.deepEqual(A.getHeads(plain), A.getHeads(f.h1))
    const throwing = memoryAdapter(rows)
    let called = 0
    throwing.noteStrictDecode = () => { called++; throw new Error('hook failed') }
    const warn = console.warn
    console.warn = () => {}
    let doc
    try { doc = await new StorageSubsystem(throwing).loadDoc('doc') } finally { console.warn = warn }
    assert.equal(called, 1)
    assert.deepEqual(A.getHeads(doc), A.getHeads(f.h1))
  })
}
