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
import { extractModelEntities, fullExtractionIntegrity } from './projectorService.js'
import { lastOccurrenceById } from './projector.js'
import { digestOfIds } from './contentDigest.js'
import { summarizeModelDefects } from './modelDefects.js'

/**
 * G4-16f C7: the merged lists are NOT unique by construction. Shards
 * merge by CRDT map KEY while a row is keyed by the entity's inner `id`, and
 * registry shards are flat-mapped. `extractModelEntities` must drop every
 * duplicate (LAST occurrence in list order kept — the client's by-id views
 * are last-wins, `lastOccurrenceById`), record each as a `duplicate-id`
 * defect, and seal digests over exactly the kept ids. Pure: a fake resolver,
 * no database (`coldBuild.property.integration.test.ts` drives the same
 * extraction into real rows).
 */
const sharded = (docs: Record<string, unknown>) => extractModelEntities(
  { modelMetaUrl: 'meta', modelUrl: '', shardUrls: (docs.registries as string[] | undefined) ?? ['reg0'] },
  async (url) => docs[url],
)

describe('extractModelEntities drops duplicate ids, last occurrence kept', () => {
  it('objects: one inner id under two map keys in two shards', async () => {
    const model = await sharded({
      meta: { objectShardUrls: ['os0', 'os1'], connectionShardUrls: [], groups: {} },
      os0: { objects: { k1: { id: 'x', name: 'first' }, k0: { id: 'y', name: 'y' } } },
      os1: { objects: { k2: { id: 'x', name: 'second' } } },
      reg0: { diagrams: {} },
    })
    expect(model.objects.map((object) => [object.id, object.name])).toEqual([['y', 'y'], ['x', 'second']])
    expect(model.defects).toEqual([
      { kind: 'duplicate-id', source: 'object-shard', url: null, entity: 'object', id: 'x' },
    ])
    expect(fullExtractionIntegrity(model).digests?.object).toEqual(digestOfIds(['x', 'y']))
  })

  it('CONTROL: the same map KEY in a later shard is still the overlay (last shard wins), not a duplicate', async () => {
    const model = await sharded({
      meta: { objectShardUrls: ['os0', 'edits'], connectionShardUrls: [], groups: {} },
      os0: { objects: { x: { id: 'x', name: 'base' } } },
      edits: { objects: { x: { id: 'x', name: 'edited' } } },
      reg0: { diagrams: {} },
    })
    expect(model.objects.map((object) => object.name)).toEqual(['edited'])
    expect(model.defects).toEqual([])
  })

  it('connections, groups and diagrams (two registry shards)', async () => {
    const model = await sharded({
      registries: ['reg0', 'reg1'],
      meta: {
        objectShardUrls: [], connectionShardUrls: ['cs0', 'cs1'],
        groups: { ga: { id: 'g', name: 'first' }, gb: { id: 'g', name: 'second' }, gc: { id: 'h' } },
      },
      cs0: { connections: { a: { id: 'c', label: 'first' } } },
      cs1: { connections: { b: { id: 'c', label: 'second' } } },
      reg0: { diagrams: { d: { id: 'd', name: 'first' } } },
      reg1: { diagrams: { d: { id: 'd', name: 'second' }, e: { id: 'e' } } },
    })
    expect(model.connections.map((connection) => connection.label)).toEqual(['second'])
    expect(model.groups.map((group) => [group.id, group.name])).toEqual([['g', 'second'], ['h', undefined]])
    expect(model.diagrams.map((diagram) => [diagram.id, diagram.name])).toEqual([['d', 'second'], ['e', undefined]])
    expect(model.defects).toEqual([
      { kind: 'duplicate-id', source: 'connection-shard', url: null, entity: 'connection', id: 'c' },
      { kind: 'duplicate-id', source: 'model-meta', url: null, entity: 'group', id: 'g' },
      { kind: 'duplicate-id', source: 'registry-shard', url: null, entity: 'diagram', id: 'd' },
    ])
    const digests = fullExtractionIntegrity(model).digests!
    expect(digests.connection).toEqual(digestOfIds(['c']))
    expect(digests.group).toEqual(digestOfIds(['g', 'h']))
    expect(digests.diagram).toEqual(digestOfIds(['d', 'e']))
    expect(summarizeModelDefects(model.defects)).toContain('registry-shard/duplicate-id=1 [diagram "d"]')
  })

  it('the monolith path, and ids equal only as stored text (5 and "5")', async () => {
    const model = await extractModelEntities(
      { modelUrl: 'model', shardUrls: [] },
      async (url) => (url === 'model'
        ? { objects: { a: { id: 5, name: 'number' }, b: { id: '5', name: 'string' } }, connections: {}, groups: {} }
        : undefined),
    )
    expect(model.objects.map((object) => object.name)).toEqual(['string'])
    expect(model.defects).toEqual([{ kind: 'duplicate-id', source: 'model', url: null, entity: 'object', id: '5' }])
  })

  it('lastOccurrenceById reports positions, in input order, each survivor at its own position', () => {
    const { kept, ids, dropped } = lastOccurrenceById('object', [
      { id: 'a', n: 0 }, { id: 'b', n: 1 }, { id: 'a', n: 2 }, { id: 'c', n: 3 }, { id: 'b', n: 4 }, { id: 'a', n: 5 },
    ])
    expect(kept).toEqual([{ id: 'c', n: 3 }, { id: 'b', n: 4 }, { id: 'a', n: 5 }])
    expect(ids).toEqual(['c', 'b', 'a'])
    expect(dropped).toEqual([
      { kind: 'object', id: 'a', index: 0, keptIndex: 5 },
      { kind: 'object', id: 'b', index: 1, keptIndex: 4 },
      { kind: 'object', id: 'a', index: 2, keptIndex: 5 },
    ])
  })
})
