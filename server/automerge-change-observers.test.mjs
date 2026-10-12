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
import { setTimeout as delay } from 'node:timers/promises'
import { Repo, NetworkAdapter } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import { HandleRegistry } from './node_modules/@automerge/automerge-repo/dist/subdoc-handles/handle-registry.js'
import { patchDocumentObservedDiffSource, patchFanoutHeadsSource, patchRegistryChangeObserversSource } from './patch-automerge-change-observers.mjs'
import { readFile } from 'node:fs/promises'

function observeDispatch(t) {
  const original = HandleRegistry.prototype.dispatchChange
  const calls = []
  HandleRegistry.prototype.dispatchChange = function (...args) {
    calls.push({ documentId: this.document.documentId, patches: args[1] })
    return original.apply(this, args)
  }
  t.after(() => { HandleRegistry.prototype.dispatchChange = original })
  return calls
}

class MemoryStorage {
  values = new Map()
  async load(key) { return this.values.get(JSON.stringify(key))?.slice() }
  async save(key, data) { this.values.set(JSON.stringify(key), data.slice()) }
  async remove(key) { this.values.delete(JSON.stringify(key)) }
  async loadRange(prefix) {
    return [...this.values].filter(([key]) => prefix.every((part, index) => JSON.parse(key)[index] === part))
      .map(([key, data]) => ({ key: JSON.parse(key), data: data.slice() }))
  }
  async removeRange(prefix) { for (const { key } of await this.loadRange(prefix)) await this.remove(key) }
}

function makeRepo(t, options = {}) {
  const repo = new Repo({ network: [], saveDebounceRate: 0, ...options })
  t.after(() => repo.shutdown())
  return repo
}

test('installed observer patches are strict, idempotent and reject an unknown dependency', async () => {
  for (const [path, patch] of [
    ['Document.js', patchDocumentObservedDiffSource],
    ['subdoc-handles/handle-registry.js', patchRegistryChangeObserversSource],
    ['synchronizer/DocSynchronizer.js', patchFanoutHeadsSource],
  ]) {
    const source = await readFile(new URL(`./node_modules/@automerge/automerge-repo/dist/${path}`, import.meta.url), 'utf8')
    assert.equal(patch(source).changed, false)
    assert.throws(() => patch(`${source}\n${source}`), /Ambiguous/)
    assert.throws(() => patch('unrecognized source'), /Unsupported/)
  }
})

test('no observer still adopts, announces and persists heads; a cold reader avoids change dispatch', async t => {
  const calls = observeDispatch(t)
  const storage = new MemoryStorage()
  const writer = makeRepo(t, { storage })
  const handle = writer.create({ objects: { one: { id: 'one', value: 1 } } })
  const headsBefore = handle.heads()
  let announced = 0
  handle.on('heads-changed', () => announced++)
  handle.change(doc => { doc.objects.one.value = 2 })
  assert.equal(handle.listenerCount('change'), 0)
  assert.equal(announced, 1)
  assert.notDeepEqual(handle.heads(), headsBefore)
  await writer.flush()
  const reader = makeRepo(t, { storage })
  assert.equal(Object.keys(reader.handles).length, 0)
  const loaded = await reader.find(handle.url)
  assert.deepEqual(loaded.heads(), handle.heads())
  assert.equal(loaded.doc().objects.one.value, 2)
  assert.equal(calls.length, 0, 'neither initial load nor unobserved changes need materialized patches')
  // Positive instrument control: the same installed dispatch must be visible.
  loaded.on('change', () => {})
  loaded.change(doc => { doc.objects.one.value = 3 })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].patches.length > 0)
})

test('a writable sub-handle alone gets changes while a pinned view does not', async t => {
  const calls = observeDispatch(t)
  const handle = makeRepo(t).create({ nested: { count: 0 } })
  const sub = handle.sub('nested')
  const view = handle.view(handle.heads())
  const events = []
  let pinnedEvents = 0
  view.on('change', () => pinnedEvents++)
  handle.change(doc => { doc.nested.count = 1 })
  assert.equal(calls.length, 0, 'readonly-only subscriptions do not consume live patches')
  sub.on('change', event => events.push(event))
  handle.change(doc => { doc.nested.count = 2 })
  assert.equal(handle.listenerCount('change'), 0)
  assert.equal(calls.length, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].doc.count, 2)
  assert.equal(events[0].patchInfo.before.nested.count, 1)
  assert.equal(events[0].patchInfo.after.nested.count, 2)
  assert.equal(pinnedEvents, 0)
  assert.equal(view.doc().nested.count, 0)
})

test('a pattern keeps its read cache current without listeners and reports replacement when observed', async t => {
  const calls = observeDispatch(t)
  const handle = makeRepo(t).create({ rows: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }] })
  const selected = handle.sub('rows', { id: 'b' })
  assert.equal(selected.doc().value, 2)
  handle.change(doc => { doc.rows.unshift({ id: 'x', value: 0 }) })
  assert.equal(calls.length, 0)
  assert.equal(selected.doc().id, 'b')
  const events = []
  selected.on('change', event => events.push(event))
  handle.change(doc => { doc.rows.unshift({ id: 'y', value: -1 }) })
  assert.equal(calls.length, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].scopeReplaced, true)
  assert.equal(events[0].doc.id, 'b')
})

test('heads callbacks can install or remove the change subscriber for that same mutation', async t => {
  const calls = observeDispatch(t)
  const handle = makeRepo(t).create({ count: 0 })
  let observed = 0
  const listener = () => observed++
  handle.once('heads-changed', () => handle.on('change', listener))
  handle.change(doc => { doc.count++ })
  assert.equal(observed, 1)
  assert.equal(calls.length, 1)
  handle.once('heads-changed', () => handle.off('change', listener))
  handle.change(doc => { doc.count++ })
  assert.equal(observed, 1)
  assert.equal(calls.length, 1)
  assert.equal(handle.doc().count, 2)
})

test('once change subscriptions expire without suppressing later state changes', async t => {
  const calls = observeDispatch(t)
  const handle = makeRepo(t).create({ count: 0 })
  let observed = 0
  handle.once('change', () => observed++)
  handle.change(doc => { doc.count++ })
  handle.change(doc => { doc.count++ })
  assert.equal(observed, 1)
  assert.equal(calls.length, 1)
  assert.equal(handle.doc().count, 2)
})

class PairedAdapter extends NetworkAdapter {
  other
  active = false
  isReady() { return true }
  whenReady() { return Promise.resolve() }
  connect(peerId, peerMetadata) {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.active = true
    queueMicrotask(() => {
      if (this.other.active) {
        this.emit('peer-candidate', { peerId: this.other.peerId, peerMetadata: this.other.peerMetadata })
        this.other.emit('peer-candidate', { peerId, peerMetadata })
      }
    })
  }
  send(message) {
    const copied = structuredClone(message)
    queueMicrotask(() => { if (this.active && this.other.active) this.other.emit('message', copied) })
  }
  disconnect() {
    if (this.active && this.other.active) this.other.emit('peer-disconnected', { peerId: this.peerId })
    this.active = false
  }
}

test('real repositories synchronize edits in both directions with no application change listener', { timeout: 10_000 }, async t => {
  const left = new PairedAdapter(), right = new PairedAdapter()
  left.other = right; right.other = left
  const first = makeRepo(t, { network: [left] })
  const second = makeRepo(t, { network: [right] })
  const a = first.create({ value: 'initial' })
  const b = await second.find(a.url)
  const waitFor = async predicate => {
    const end = Date.now() + 3000
    while (!predicate() && Date.now() < end) await delay(5)
    assert.ok(predicate(), 'real sync did not converge')
  }
  assert.equal(a.listenerCount('change'), 0)
  assert.equal(b.listenerCount('change'), 0)
  a.change(doc => { doc.value = 'from-first' })
  await waitFor(() => b.doc().value === 'from-first')
  b.change(doc => { doc.value = 'from-second' })
  await waitFor(() => a.doc().value === 'from-second')
  await waitFor(() => JSON.stringify(a.heads()) === JSON.stringify(b.heads()))
  const previousHeads = a.heads()
  a.update(doc => Automerge.emptyChange(doc, { message: 'heads-only sync witness' }))
  assert.notDeepEqual(a.heads(), previousHeads)
  assert.equal(a.doc().value, 'from-second')
  await waitFor(() => JSON.stringify(a.heads()) === JSON.stringify(b.heads()))
})
