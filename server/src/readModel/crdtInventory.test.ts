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

import { collectCrdtInventory } from './crdtInventory.js'

const docs = (map: Record<string, unknown>) => async (url: string) => {
  if (!(url in map)) throw new Error(`unavailable: ${url}`)
  return map[url]
}

const shardedRoot = { modelMetaUrl: 'meta', shardUrls: ['reg0'] }

describe('collectCrdtInventory', () => {
  it('walks root -> meta -> shards and unions the ids', async () => {
    const inv = await collectCrdtInventory(shardedRoot, docs({
      meta: { objectShardUrls: ['o0', 'o1'], connectionShardUrls: ['c0'] },
      o0: { objects: { a: {}, b: {} } },
      o1: { objects: { c: {} } },
      c0: { connections: { x: {} } },
      reg0: { diagrams: {} },
    }))
    expect(inv.objects.sort()).toEqual(['a', 'b', 'c'])
    expect(inv.connections).toEqual(['x'])
  })

  it('THROWS on an unresolvable shard instead of silently returning fewer ids', async () => {
    // This is the whole point. extractModelEntities does `?? {}` here, so using
    // it would make a missing shard invisible on BOTH sides of the comparison
    // and let the detector report clean while the read model lost rows.
    await expect(collectCrdtInventory(shardedRoot, docs({
      meta: { objectShardUrls: ['o0', 'missing'] },
      o0: { objects: { a: {} } },
      reg0: { diagrams: {} },
    }))).rejects.toThrow(/could not be resolved/)
  })

  it('THROWS when a shard resolves to something that is not a document', async () => {
    await expect(collectCrdtInventory(shardedRoot, docs({
      meta: { objectShardUrls: ['o0'] },
      o0: 'not a document',
      reg0: { diagrams: {} },
    }))).rejects.toThrow(/did not resolve to a document/)
  })

  it('THROWS when a shard carries a non-map objects field', async () => {
    await expect(collectCrdtInventory(shardedRoot, docs({
      meta: { objectShardUrls: ['o0'] },
      o0: { objects: ['a', 'b'] },
      reg0: { diagrams: {} },
    }))).rejects.toThrow(/is not a map/)
  })

  it('applies tombstones after reading the shards', async () => {
    const inv = await collectCrdtInventory(shardedRoot, docs({
      meta: { objectShardUrls: ['o0'], deletedObjectIds: ['b'] },
      o0: { objects: { a: {}, b: {} } },
      reg0: { diagrams: {} },
    }))
    expect(inv.objects).toEqual(['a'])
  })

  it('inventories flows from DIAGRAM documents, which model shards never carry', async () => {
    // Comparing only ro_objects/ro_connections would let the deletion of every
    // flow row go undetected.
    const inv = await collectCrdtInventory(shardedRoot, docs({
      meta: { objectShardUrls: [] },
      reg0: { diagrams: { d1: { docUrl: 'dd1' }, d2: { docUrl: 'dd2' } } },
      dd1: { flows: { f1: {}, f2: {} } },
      dd2: { flows: {} },
    }))
    expect(inv.diagrams.sort()).toEqual(['d1', 'd2'])
    expect(inv.flows.sort()).toEqual(['d1:f1', 'd1:f2'])
  })

  it('THROWS when a diagram document referenced by the registry cannot be read', async () => {
    // An advertised-but-unopenable diagram happens in practice; the inventory
    // must refuse rather than under-report.
    await expect(collectCrdtInventory(shardedRoot, docs({
      meta: { objectShardUrls: [] },
      reg0: { diagrams: { d1: { docUrl: 'gone' } } },
    }))).rejects.toThrow(/could not be resolved/)
  })

  it('supports a pre-sharding monolithic model document', async () => {
    const inv = await collectCrdtInventory({ modelUrl: 'model', shardUrls: [] }, docs({
      model: { model: { objects: { a: {} }, connections: { x: {} }, groups: { g: {} } } },
    }))
    expect(inv.objects).toEqual(['a'])
    expect(inv.connections).toEqual(['x'])
    expect(inv.groups).toEqual(['g'])
  })

  it('skips the diagram walk on a registrySummaryOnly root rather than failing', async () => {
    const inv = await collectCrdtInventory(
      { modelMetaUrl: 'meta', registrySummaryOnly: true, shardUrls: ['unreadable'] },
      docs({ meta: { objectShardUrls: [] } }),
    )
    expect(inv.diagrams).toEqual([])
    expect(inv.flows).toEqual([])
  })

  it('THROWS when the root carries no model reference at all', async () => {
    await expect(collectCrdtInventory({ shardUrls: [] }, docs({}))).rejects.toThrow(/neither modelMetaUrl nor modelUrl/)
  })

  it('THROWS when the root itself is not a document', async () => {
    await expect(collectCrdtInventory(undefined, docs({}))).rejects.toThrow(/root did not resolve/)
  })

  it('shares no import with the projector, so a defect there cannot cancel here', async () => {
    // Independence is the point: building the CRDT operand with the
    // projector's own extractor would compare the writer against itself.
    // Asserted on the CODE, not the prose - this module's comments name
    // extractModelEntities deliberately.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./crdtInventory.ts', import.meta.url), 'utf8'))
    const code = source
      .split(/\r|\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join(' ')
    expect(code).not.toMatch(/import[^;]*projectorService/)
    expect(code).not.toMatch(/extractModelEntities/)
    // No relative import at all: this module must re-walk the graph itself.
    expect(code).not.toMatch(/import[^;]*from '\.\//)
  })
})
