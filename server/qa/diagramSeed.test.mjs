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

import { assignTargets, buildDiagramMeta, buildGoalDiagramDoc } from './diagramSeed.mjs'

test('buildGoalDiagramDoc produces the requested goal shape', () => {
  const doc = buildGoalDiagramDoc({ shapes: 500, connections: 800 })
  assert.equal(doc.objectIds.length, 500)
  assert.equal(doc.connectionIds.length, 800)
  assert.equal(Object.keys(doc.layouts).length, 500)
})

test('buildGoalDiagramDoc carries the fields that share the hot document', () => {
  // comments/flows/checkpoints live in the SAME document (types.ts); a
  // fixture without them would under-state the document under test.
  const doc = buildGoalDiagramDoc({ shapes: 4, connections: 2 })
  assert.deepEqual(doc.comments, {})
  assert.deepEqual(doc.flows, {})
  assert.deepEqual(doc.checkpoints, [])
})

test('buildGoalDiagramDoc lays shapes on a real grid, not all at the origin', () => {
  const doc = buildGoalDiagramDoc({ shapes: 9, connections: 0 })
  const positions = new Set(Object.values(doc.layouts).map((l) => `${l.position.x},${l.position.y}`))
  assert.equal(positions.size, 9, 'every shape needs a distinct starting position')
})

test('buildDiagramMeta mirrors the composition the registry denormalises', () => {
  const doc = buildGoalDiagramDoc({ shapes: 3, connections: 5 })
  const meta = buildDiagramMeta('t1-bench', 'automerge:abc', doc)
  assert.equal(meta.id, 't1-bench')
  assert.equal(meta.docUrl, 'automerge:abc')
  assert.equal(meta.objectIds.length, 3)
  assert.equal(meta.connectionIds.length, 5)
})

test('buildDiagramMeta copies the arrays so later doc edits cannot mutate the stub', () => {
  const doc = buildGoalDiagramDoc({ shapes: 2, connections: 0 })
  const meta = buildDiagramMeta('t1-bench', 'automerge:abc', doc)
  doc.objectIds.push('late')
  assert.equal(meta.objectIds.length, 2)
})

test('assignTargets shared mode puts every peer on the same objects', () => {
  const targets = assignTargets(['a', 'b', 'c', 'd'], 3, { mode: 'shared', sharedWidth: 2 })
  assert.equal(targets.length, 3)
  for (const t of targets) assert.deepEqual(t, ['a', 'b'])
})

test('assignTargets disjoint mode gives each peer its own slice', () => {
  const targets = assignTargets(['a', 'b', 'c', 'd'], 2, { mode: 'disjoint' })
  assert.deepEqual(targets[0], ['a', 'b'])
  assert.deepEqual(targets[1], ['c', 'd'])
})

test('assignTargets disjoint mode still gives every peer work when peers outnumber objects', () => {
  const targets = assignTargets(['a', 'b'], 5, { mode: 'disjoint' })
  assert.equal(targets.length, 5)
  for (const t of targets) assert.ok(t.length >= 1)
})

test('assignTargets shared mode clamps sharedWidth to the objects available', () => {
  const targets = assignTargets(['a'], 2, { mode: 'shared', sharedWidth: 50 })
  assert.deepEqual(targets[0], ['a'])
})

test('assignTargets rejects an unknown contention mode instead of silently sharing', () => {
  assert.throws(() => assignTargets(['a'], 1, { mode: 'whatever' }), /unknown contention mode/)
})

test('assignTargets returns nothing when there is nothing to move', () => {
  assert.deepEqual(assignTargets([], 3), [])
  assert.deepEqual(assignTargets(['a'], 0), [])
})
