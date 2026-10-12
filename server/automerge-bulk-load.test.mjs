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

// The StorageSubsystem patch (patch-automerge-peer-sync-state.mjs,
// patchStorageSubsystemBulkLoadSource) swaps document loading from
// A.loadIncremental(A.init(), binary) to A.load(binary). That is a behavioural
// claim about the DEPENDENCY, so it is pinned here against the real automerge
// rather than only against the patcher's own output string. If an automerge
// upgrade breaks the equivalence, this fails instead of silently changing how
// every stored document loads.
import assert from 'node:assert/strict'
import test from 'node:test'
import * as A from '@automerge/automerge'

function docOf(n, tag) {
  return A.change(A.init(), (d) => {
    d.objects = {}
    for (let i = 0; i < n; i += 1) {
      d.objects[`${tag}-${i}`] = {
        id: `${tag}-${i}`,
        name: `Object ${tag} ${i}`,
        description: 'a description long enough to carry real string weight',
        type: 'app',
      }
    }
  })
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

/** Every chunk shape StorageSubsystem.loadDocData can hand to loadDoc. */
function shapes() {
  const cases = []
  cases.push(['snapshot only', A.save(docOf(40, 's1'))])

  let doc = docOf(20, 's2')
  const snapshot = A.save(doc)
  const before = doc
  doc = A.change(doc, (d) => { d.objects['s2-0'].name = 'renamed once' })
  const inc1 = A.saveIncremental(doc, { from: before })
  const mid = doc
  doc = A.change(doc, (d) => { d.objects['s2-1'].name = 'renamed twice' })
  const inc2 = A.saveIncremental(doc, { from: mid })
  cases.push(['snapshot + two incrementals', concat([snapshot, inc1, inc2])])
  cases.push(['incrementals out of order', concat([snapshot, inc2, inc1])])

  const dup = A.save(docOf(15, 's3'))
  cases.push(['duplicated snapshot', concat([dup, dup])])

  const base = docOf(15, 's4')
  const branchA = A.change(A.clone(base), (d) => { d.objects['s4-0'].name = 'branch A' })
  const branchB = A.change(A.clone(base), (d) => { d.objects['s4-1'].name = 'branch B' })
  cases.push(['two concurrent branches', concat([A.save(branchA), A.save(branchB)])])

  cases.push(['empty document', A.save(A.init())])
  return cases
}

test('A.load and A.loadIncremental agree on every chunk shape loadDoc can see', () => {
  for (const [name, binary] of shapes()) {
    const bulk = A.load(binary)
    const incremental = A.loadIncremental(A.init(), binary)
    assert.deepEqual(A.getHeads(bulk), A.getHeads(incremental), `heads differ: ${name}`)
    assert.equal(JSON.stringify(bulk), JSON.stringify(incremental), `content differs: ${name}`)
    // loadDoc also feeds these two into headsHandle.update and 'document-loaded'
    assert.deepEqual(
      { ops: A.stats(bulk).numOps, changes: A.stats(bulk).numChanges },
      { ops: A.stats(incremental).numOps, changes: A.stats(incremental).numChanges },
      `stats differ: ${name}`,
    )
  }
})

test('a bulk-loaded document still takes local changes under a fresh actor', () => {
  const binary = A.save(docOf(10, 'w'))
  const doc = A.load(binary)
  const actor = A.getActorId(doc)
  assert.equal(typeof actor, 'string')
  // a second load must not reuse the actor id, or two tabs would collide
  assert.notEqual(actor, A.getActorId(A.load(binary)))
  const edited = A.change(doc, (d) => { d.objects['w-0'].name = 'edited after bulk load' })
  assert.equal(edited.objects['w-0'].name, 'edited after bulk load')
  assert.equal(A.getHistory(edited).length, A.getHistory(A.loadIncremental(A.init(), binary)).length + 1)
})

test('trailing garbage is exactly why the fallback exists', () => {
  // A.load is STRICTER here; loadIncremental accepts. The patch's catch keeps
  // the old, more permissive result for this shape.
  const binary = concat([A.save(docOf(10, 'g')), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])])
  assert.throws(() => A.load(binary))
  assert.doesNotThrow(() => A.loadIncremental(A.init(), binary))
})

test('a truncated chunk still throws BOTH ways — the fallback is not a cure', () => {
  // Pins the honest half of the patch comment: shapes both reject still throw
  // out of loadDoc, exactly as before the patch.
  const good = A.save(docOf(10, 't'))
  const truncated = good.slice(0, Math.floor(good.length * 0.6))
  assert.throws(() => A.load(truncated))
  assert.throws(() => A.loadIncremental(A.init(), truncated))
})
