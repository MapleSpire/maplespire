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

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { setImmediate as turn } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import { patchDocumentSaveBarrierSource, patchDocumentSaveBarrierTypesSource, patchStorageSourceCurrentDocumentSource } from './patch-automerge-document-saves.mjs'

// Import each installed runtime before registering tests; do not mix documents
// across independent Automerge/WASM instances or skip a missing installation.
const runtimes = await Promise.all(['root', 'server'].map(async prefix => {
  const modules = new URL(prefix === 'root' ? '../node_modules/' : './node_modules/', import.meta.url)
  const importModule = path => import(new URL(path, modules).href)
  const A = await importModule('@automerge/automerge/dist/mjs/entrypoints/fullfat_node.js')
  const { StorageSubsystem } = await importModule('@automerge/automerge-repo/dist/storage/StorageSubsystem.js')
  const { StorageSource } = await importModule('@automerge/automerge-repo/dist/StorageSource.js')
  return { prefix, modules, A, StorageSubsystem, StorageSource }
}))

for (const { prefix, modules, A, StorageSubsystem, StorageSource } of runtimes) {
  test(`${prefix}: document save patches reject partial, mixed and duplicated sources`, async () => {
    for (const [path, patch, oldMarker] of [
      ['storage/StorageSubsystem.js', patchDocumentSaveBarrierSource, "    async saveDoc(documentId, doc) {\n        // Don't bother saving if the document hasn't changed"],
      ['storage/StorageSubsystem.d.ts', patchDocumentSaveBarrierTypesSource, '    saveDoc(documentId: DocumentId, doc: A.Doc<unknown>): Promise<void>;'],
      ['StorageSource.js', patchStorageSourceCurrentDocumentSource, null],
    ]) {
      const source = await readFile(new URL(`@automerge/automerge-repo/dist/${path}`, modules), 'utf8')
      assert.equal(patch(source).changed, false)
      assert.throws(() => patch(`${source}\n${source}`), /Ambiguous/)
      assert.throws(() => patch('unknown dependency'), /Unsupported/)
      if (oldMarker) {
        assert.throws(() => patch(`${source}\n${oldMarker}`), /Ambiguous/)
        const first = patch(oldMarker)
        assert.equal(first.changed, true)
        assert.equal(patch(first.source).changed, false)
      }
    }
  })
  function deferred() {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  function memoryAdapter(hook = async () => {}) {
    const values = new Map(), calls = []
    return {
      calls,
      async save(key, data) {
        const call = { key: [...key], data: data.slice(), complete: false }
        calls.push(call)
        await hook(call, calls.length)
        values.set(JSON.stringify(key), data.slice())
        call.complete = true
      },
      async load(key) { return values.get(JSON.stringify(key)) },
      async remove(key) { values.delete(JSON.stringify(key)) },
      async loadRange(prefix) { return [...values].map(([key, data]) => ({ key: JSON.parse(key), data })).filter(row => prefix.every((p, i) => row.key[i] === p)) },
      async removeRange(prefix) { for (const key of values.keys()) if (prefix.every((p, i) => JSON.parse(key)[i] === p)) values.delete(key) },
    }
  }

  for (const sameHeads of [true, false]) test(`${prefix}: ${sameHeads ? 'same H1' : 'new H1'} save waits for an older write after its own write completed`, async () => {
    const gate = deferred()
    const adapter = memoryAdapter(async (_call, n) => { if (n === 1) await gate.promise })
    const storage = new StorageSubsystem(adapter)
    const h0 = A.from({ n: 0 }), h1 = sameHeads ? h0 : A.change(h0, doc => { doc.n = 1 })
    let laterSettled = false
    const older = storage.saveDoc('document-a', h0)
    const later = storage.saveDoc('document-a', h1)
    void later.then(() => { laterSettled = true }, () => { laterSettled = true })
    try {
      await turn()
      assert.equal(adapter.calls.length, 2, 'writes retain immediate admission; no queue or dedup assumption')
      assert.equal(adapter.calls[0].complete, false)
      assert.equal(adapter.calls[1].complete, true)
      assert.equal(laterSettled, false, 'later save must drain the earlier write before resolving')
    } finally { gate.resolve(); await Promise.allSettled([older, later]) }
    assert.deepEqual(A.getHeads(await storage.loadDoc('document-a')), A.getHeads(h1))
    const writesBeforeNoop = adapter.calls.length
    await storage.saveDoc('document-a', h1)
    assert.equal(adapter.calls.length, writesBeforeNoop, 'older completion must not rewind the admitted saved heads')
  })

  test(`${prefix}: an own noop still drains earlier writes`, async () => {
    const gate = deferred()
    const adapter = memoryAdapter(async (_call, n) => { if (n === 1) await gate.promise })
    const storage = new StorageSubsystem(adapter)
    const h0 = A.from({ n: 0 }), h1 = A.change(h0, doc => { doc.n = 1 })
    const older = storage.saveDoc('document-a', h0)
    const middle = storage.saveDoc('document-a', h1)
    void middle.catch(() => {})
    let noopSettled = false
    let noop
    try {
      await turn()
      assert.equal(adapter.calls[1].complete, true)
      noop = storage.saveDoc('document-a', h1)
      void noop.then(() => { noopSettled = true }, () => { noopSettled = true })
      await turn()
      assert.equal(adapter.calls.length, 2)
      assert.equal(noopSettled, false, 'unchanged heads do not cancel the drain obligation')
    } finally { gate.resolve(); await Promise.allSettled([older, middle, ...(noop ? [noop] : [])]) }
  })

  test(`${prefix}: adapter reentrancy sees the outer write reservation`, async () => {
    const gate = deferred()
    const h0 = A.from({ n: 0 }), h1 = A.change(h0, doc => { doc.n = 1 })
    let storage, nested, nestedSettled = false
    const adapter = memoryAdapter(async (_call, n) => {
      if (n === 1) {
        nested = storage.saveDoc('document-a', h1)
        void nested.then(() => { nestedSettled = true }, () => { nestedSettled = true })
        await gate.promise
      }
    })
    storage = new StorageSubsystem(adapter)
    const outer = storage.saveDoc('document-a', h0)
    try {
      await turn()
      assert.ok(nested)
      assert.equal(adapter.calls[1].complete, true)
      assert.equal(nestedSettled, false, 'reserving only after body admission loses a reentrant observer')
    } finally { gate.resolve(); await Promise.allSettled([outer, ...(nested ? [nested] : [])]) }
  })

  test(`${prefix}: writes admitted during the drain cannot finish after the waiter`, async () => {
    const firstGate = deferred(), lastGate = deferred()
    const adapter = memoryAdapter(async (_call, n) => {
      if (n === 1) await firstGate.promise
      if (n === 3) await lastGate.promise
    })
    const storage = new StorageSubsystem(adapter)
    const h0 = A.from({ n: 0 }), h1 = A.change(h0, doc => { doc.n = 1 }), h2 = A.change(h1, doc => { doc.n = 2 })
    const older = storage.saveDoc('document-a', h0), waiting = storage.saveDoc('document-a', h1)
    let waiterSettled = false
    void waiting.then(() => { waiterSettled = true }, () => { waiterSettled = true })
    await turn()
    const later = storage.saveDoc('document-a', h2)
    try {
      assert.equal(adapter.calls.length, 3)
      firstGate.resolve()
      await turn()
      assert.equal(adapter.calls[0].complete, true)
      assert.equal(adapter.calls[1].complete, true)
      assert.equal(adapter.calls[2].complete, false)
      assert.equal(waiterSettled, false, 'a fixed snapshot of prior writes misses a write admitted during the drain')
    } finally { firstGate.resolve(); lastGate.resolve(); await Promise.allSettled([older, waiting, later]) }
    assert.deepEqual(A.getHeads(await storage.loadDoc('document-a')), A.getHeads(h2))
  })

  test(`${prefix}: prior rejection reaches waiter, while a later retry is not poisoned`, async () => {
    const gate = deferred(), error = new Error('qa prior write refused')
    const adapter = memoryAdapter(async (_call, n) => { if (n === 1) { await gate.promise; throw error } })
    const storage = new StorageSubsystem(adapter)
    const h0 = A.from({ n: 0 }), h1 = A.change(h0, doc => { doc.n = 1 })
    const older = storage.saveDoc('document-a', h0), later = storage.saveDoc('document-a', h1)
    // Observe immediately so the intentionally injected failure is never an
    // unhandled rejection from a detached test callback.
    const results = Promise.allSettled([older, later])
    await turn()
    gate.resolve()
    const outcomes = await results
    assert.equal(outcomes[0].status, 'rejected')
    assert.equal(outcomes[1].status, 'rejected', 'own successful write cannot hide the earlier failure')
    await storage.saveDoc('document-a', h1)
    assert.deepEqual(A.getHeads(await storage.loadDoc('document-a')), A.getHeads(h1))
  })

  test(`${prefix}: another document completes while document-a remains blocked`, async () => {
    const gate = deferred()
    const adapter = memoryAdapter(async call => { if (call.key[0] === 'document-a') await gate.promise })
    const storage = new StorageSubsystem(adapter)
    const doc = A.from({ n: 0 })
    const older = storage.saveDoc('document-a', doc)
    let unrelatedSettled = false
    const unrelated = storage.saveDoc('document-b', doc).then(() => { unrelatedSettled = true })
    try {
      await turn()
      assert.equal(unrelatedSettled, true, 'drain registry is per document, not global')
      assert.equal(adapter.calls.find(call => call.key[0] === 'document-a').complete, false)
    } finally { gate.resolve(); await Promise.allSettled([older, unrelated]) }
  })

  // Only the source's timer scheduling is controlled. Its production throttle,
  // StorageSource, StorageSubsystem and Automerge documents all execute unchanged.
  async function withSourceTimers(body) {
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
    const timers = new Map()
    globalThis.setTimeout = callback => { const token = {}; timers.set(token, callback); return token }
    globalThis.clearTimeout = token => { timers.delete(token) }
    const fire = async () => {
      const ready = [...timers.values()]
      timers.clear()
      for (const callback of ready) await callback()
    }
    try { await body(fire) } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear }
  }
  function controlledHandle(doc) {
    const handle = new EventEmitter()
    handle.documentId = 'document-source'
    handle.current = doc
    handle.fullDoc = () => handle.current
    handle.update = fn => { handle.current = fn(handle.current) }
    return handle
  }
  function attach(source, handle) {
    source.attach({ handle, sourceUnavailable() {}, sourcePending() {}, sourceReady() {} })
  }

  test(`${prefix}: delayed source callback reads the current H2 after an explicit H2 save`, async () => {
    await withSourceTimers(async fire => {
      const adapter = memoryAdapter(), storage = new StorageSubsystem(adapter)
      const h0 = A.from({ n: 0 })
      const handle = controlledHandle(h0), source = new StorageSource(storage, 100)
      attach(source, handle)
      await fire()
      assert.equal((await storage.loadDoc(handle.documentId)).n, 0)
      const h1 = A.change(A.clone(h0), doc => { doc.n = 1 })
      handle.current = h1
      handle.emit('heads-changed', { handle, doc: h1 })
      // The queued event snapshot can age while an explicit caller saves the
      // current fullDoc. It must not become a later historical save.
      const h2 = A.change(A.clone(h1), doc => { doc.n = 2 })
      handle.current = h2
      await storage.saveDoc(handle.documentId, h2)
      const writesAfterH2 = adapter.calls.length
      await fire()
      assert.equal(adapter.calls.length, writesAfterH2, 'old event H1 must not write after H2 was saved')
      assert.deepEqual(A.getHeads(await storage.loadDoc(handle.documentId)), A.getHeads(h2))
    })
  })

  test(`${prefix}: detaching preserves the final scheduled change`, async () => {
    await withSourceTimers(async fire => {
      const adapter = memoryAdapter(), storage = new StorageSubsystem(adapter)
      const h0 = A.from({ n: 0 })
      const handle = controlledHandle(h0), source = new StorageSource(storage, 100)
      attach(source, handle)
      await fire()
      // A.save(oldView) includes later history already resident in its WASM
      // instance. Construct H1 only after H0 is proven durable, on a clone.
      assert.equal((await storage.loadDoc(handle.documentId)).n, 0)
      const h1 = A.change(A.clone(h0), doc => { doc.n = 1 })
      handle.current = h1
      handle.emit('heads-changed', { handle, doc: h1 })
      source.detach(handle.documentId)
      // Hostile lifecycle seam: the installed 2.6 unload is currently a noop.
      // Keep the captured revision even if a detached handle is later replaced.
      handle.current = A.init()
      await fire()
      assert.deepEqual(A.getHeads(await storage.loadDoc(handle.documentId)), A.getHeads(h1), 'detach cannot discard the last admitted save callback')
    })
  })

  test(`${prefix}: a pure drain waits without starting another write`, async () => {
    const gate = deferred()
    const adapter = memoryAdapter(async () => { await gate.promise })
    const storage = new StorageSubsystem(adapter)
    const write = storage.saveDoc('document-pure-drain', A.from({ n: 1 }))
    let drained = false
    const drain = storage.drainDocumentSaves('document-pure-drain').then(() => { drained = true })
    try {
      await turn()
      assert.equal(drained, false)
      assert.equal(adapter.calls.length, 1)
    } finally { gate.resolve(); await Promise.allSettled([write, drain]) }
    assert.equal(drained, true)
    await storage.drainDocumentSaves('document-pure-drain')
    assert.equal(adapter.calls.length, 1)
  })

  test(`${prefix}: an error reading the delayed current document reaches the storage error bridge`, async () => {
    await withSourceTimers(async fire => {
      const adapter = memoryAdapter(), storage = new StorageSubsystem(adapter)
      const errors = [], source = new StorageSource(storage, 100, { onStorageError: event => errors.push(event) })
      const handle = controlledHandle(A.from({ n: 1 }))
      attach(source, handle)
      const error = new Error('current document unavailable')
      handle.fullDoc = () => { throw error }
      await fire()
      assert.equal(adapter.calls.length, 0)
      assert.deepEqual(errors, [{ documentId: handle.documentId, error, operation: 'document' }])
    })
  })
}
