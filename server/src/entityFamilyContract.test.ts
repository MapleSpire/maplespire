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

import { readFileSync } from 'node:fs'
import { generateAutomergeUrl } from '@automerge/automerge-repo'
import { describe, expect, it } from 'vitest'
import { diffModels } from './draft/merge.js'
import { MODEL_COLLECTIONS } from './draft/changes.js'
import { INLINE_COLLECTIONS, MODEL_KEY } from './draft/applyMerge.js'
import type { FullModel } from './draft/materialize.js'
import { collectReferencedUrls } from './maintenance/workspaceFsck.js'
import { buildModelMeta } from './modelMeta.js'
import {
  DRAFT_INLINE_COLLECTIONS,
  DRAFT_MODEL_COLLECTIONS,
  MODEL_META_INLINE_COLLECTIONS,
  MONOLITH_MODEL_COLLECTIONS,
  emptyMonolithModel,
} from './modelCollections.js'
import { collectCrdtInventory } from './readModel/crdtInventory.js'
import { DIAGRAM_FLOW_INDEX_TABLES } from './readModel/projector.js'
import { extractModelEntities, fullExtractionIntegrity } from './readModel/projectorService.js'

/**
 * The SERVER half of the entity-family contract (V0-10). The registry of
 * record is the client's `src/lib/automerge/entityFamilies.ts`; `server/`
 * cannot import it at build time (`rootDir: ./src`), so it is loaded here AT
 * RUN TIME and every server registration point is compared against it — by
 * behaviour where the point is an exported pure function, by its source text
 * where it is a walk buried in a function that needs a live repo or database.
 * The client half is `src/lib/automerge/entityFamilyContract.test.ts`; the
 * point table and the mutant record are in `docs/entity-family-contract.md`.
 */

interface Family {
  name: string
  collection: string
  home: 'modelShard' | 'modelMeta' | 'diagramDoc' | 'registryShard'
  monolith: boolean
  idField: 'id' | 'tagId'
  shards: null | {
    urlsField: string
    tombstonesField: string
    overlay: null | { headField: string; urlsField: string }
  }
  draftCollection: string | null
  projection: null | {
    table: string
    via: 'modelExtraction' | 'decisionRecordProjection' | 'diagramFlowIndex'
    inventoried: boolean
  }
}

const registryUrl = new URL('../../src/lib/automerge/entityFamilies.ts', import.meta.url).href
const { ENTITY_FAMILY_LIST: FAMILIES } = (await import(/* @vite-ignore */ registryUrl)) as {
  ENTITY_FAMILY_LIST: readonly Family[]
}

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const where = (keep: (family: Family) => boolean): Family[] => FAMILIES.filter(keep)
const isModel = (family: Family): boolean => family.home === 'modelShard' || family.home === 'modelMeta'
const monolith = where((family) => family.monolith)
const inline = where((family) => family.home === 'modelMeta')
const sharded = where((family) => family.shards !== null)
const draftModel = where((family) => family.draftCollection !== null && isModel(family))
const projected = where((family) => family.projection !== null)

/** One entity of `family`, keyed by its registered id field. */
const entity = (family: Family, id: string): Record<string, unknown> => ({ [family.idField]: id, name: id })
const mapOf = (family: Family, id: string): Record<string, unknown> => ({ [id]: entity(family, id) })

describe('entity-family contract — registry sanity', () => {
  it('loads the client registry at run time (the comparison is not vacuous)', () => {
    expect(FAMILIES.length).toBeGreaterThanOrEqual(9)
    expect(FAMILIES.map((family) => family.collection)).toContain('domains')
  })
})

describe('entity-family contract — the server mirror (modelCollections.ts)', () => {
  it('MONOLITH_MODEL_COLLECTIONS is the registry monolith, in order', () => {
    expect([...MONOLITH_MODEL_COLLECTIONS]).toEqual(monolith.map((family) => family.collection))
  })

  it('MODEL_META_INLINE_COLLECTIONS is the registry ModelMeta home, in order', () => {
    expect([...MODEL_META_INLINE_COLLECTIONS]).toEqual(inline.map((family) => family.collection))
  })

  it('DRAFT_MODEL_COLLECTIONS maps each model family draft name to its collection, in order', () => {
    expect(Object.entries(DRAFT_MODEL_COLLECTIONS)).toEqual(
      draftModel.map((family) => [family.draftCollection, family.collection]),
    )
    expect(DRAFT_INLINE_COLLECTIONS).toEqual(
      draftModel.filter((family) => family.home === 'modelMeta').map((family) => family.draftCollection),
    )
  })

  it('emptyMonolithModel has one FRESH empty map per monolith family', () => {
    const a = emptyMonolithModel() as Record<string, unknown>
    const b = emptyMonolithModel() as Record<string, unknown>
    expect(Object.keys(a)).toEqual(monolith.map((family) => family.collection))
    for (const family of monolith) {
      expect(a[family.collection]).toEqual({})
      expect(a[family.collection]).not.toBe(b[family.collection])
    }
  })

  it('every hand-written empty-model literal is gone: each site derives from the mirror', () => {
    const sites = [
      './automergeServer.ts', './forkRoot.ts', './maintenance/degenerateRootRepair.ts',
      './draft/materialize.ts', './draft/sparse.ts',
    ]
    for (const site of sites) {
      const text = source(site)
      expect(text, site).toMatch(/emptyMonolithModel\(\)/)
      expect(text, site).not.toMatch(/objects: \{\},\s*connections: \{\}/)
    }
    expect(source('./maintenance/degenerateRootRepair.ts')).toMatch(/MONOLITH_MODEL_COLLECTIONS\.every\(/)
  })
})

describe('entity-family contract — drafts', () => {
  it('changes.ts counts exactly the model draft collections', () => {
    expect([...MODEL_COLLECTIONS].sort()).toEqual(draftModel.map((family) => family.draftCollection).sort())
  })

  it('applyMerge routes each draft collection to its family collection, inline ones to ModelMeta', () => {
    for (const family of draftModel) {
      expect(MODEL_KEY[family.draftCollection as keyof typeof MODEL_KEY], family.collection).toBe(family.collection)
    }
    expect([...INLINE_COLLECTIONS].sort()).toEqual(
      draftModel.filter((family) => family.home === 'modelMeta').map((family) => family.draftCollection).sort(),
    )
  })

  it('diffModels reports a created entity of every model family under its draft collection', () => {
    const empty = (): FullModel => ({ ...emptyMonolithModel(), diagrams: {}, missing: [] })
    const theirs = empty() as unknown as Record<string, Record<string, unknown>>
    for (const family of draftModel) theirs[family.collection] = mapOf(family, `${family.name}-1`)
    const diff = diffModels(empty(), empty(), theirs as unknown as FullModel)
    for (const family of draftModel) {
      expect(diff.changes, family.name).toContainEqual(
        expect.objectContaining({ collection: family.draftCollection, id: `${family.name}-1`, kind: 'created' }),
      )
    }
    expect(diff.counts.model).toBe(draftModel.length)
  })

  it('materialize reads every inline, monolith and sharded family', () => {
    const text = source('./draft/materialize.ts')
    for (const family of inline) {
      expect(text, family.collection).toMatch(
        new RegExp(`Object\\.assign\\(model\\.${family.collection}, meta\\.${family.collection} \\?\\? \\{\\}\\)`),
      )
    }
    for (const family of monolith) {
      expect(text, family.collection).toMatch(
        new RegExp(`Object\\.assign\\(model\\.${family.collection}, m\\.${family.collection} \\?\\? \\{\\}\\)`),
      )
    }
    for (const family of sharded) {
      const shards = family.shards!
      expect(text, shards.urlsField).toMatch(new RegExp(`for \\(const u of meta\\.${shards.urlsField} \\?\\? \\[\\]\\)`))
      expect(text, shards.tombstonesField).toMatch(
        new RegExp(`for \\(const id of meta\\.${shards.tombstonesField} \\?\\? \\[\\]\\) delete model\\.${family.collection}\\[id\\]`),
      )
    }
  })

  it('a sparse draft carries every inline family without a baseline shard through base/ours/theirs', () => {
    const text = source('./draft/sparse.ts')
    for (const family of inline.filter((candidate) => candidate.shards === null)) {
      const c = escape(family.collection)
      expect(text, c).toMatch(new RegExp(`const ${c} = plain\\(parentMeta\\.${c} \\?\\? \\{\\}\\)`))
      expect(text, c).toMatch(new RegExp(`draftBaseInline: \\{[^}]*\\b${c}: plain\\(${c}\\)`))
      expect(text, c).toMatch(new RegExp(`base\\.${c} = plain\\(inlineBase\\.${c}\\)`))
      expect(text, c).toMatch(new RegExp(`ours\\.${c} = plain\\(parentMeta\\?\\.${c} \\?\\? \\{\\}\\)`))
      expect(text, c).toMatch(new RegExp(`theirs\\.${c} = plain\\(meta\\.${c} \\?\\? \\{\\}\\)`))
    }
  })

  it('the draft base manifest captures every shard family', () => {
    const text = source('./draft/manifest.ts')
    for (const family of sharded) {
      expect(text, family.shards!.urlsField).toMatch(
        new RegExp(`for \\(const u of meta\\.${family.shards!.urlsField} \\?\\? \\[\\]\\) await capture\\(`),
      )
    }
  })
})

describe('entity-family contract — ModelMeta birth', () => {
  it('buildModelMeta creates every inline family container and carries its seed', () => {
    const seed: Record<string, unknown> = { objectWriteHead: 'automerge:o', connectionWriteHead: 'automerge:c' }
    const bare = buildModelMeta(seed as never) as unknown as Record<string, unknown>
    for (const family of inline) {
      seed[family.collection] = mapOf(family, `${family.name}-1`)
      expect(bare[family.collection], family.collection).toEqual({})
    }
    const seeded = buildModelMeta(seed as never) as unknown as Record<string, unknown>
    for (const family of inline) expect(seeded[family.collection], family.collection).toEqual(seed[family.collection])
  })
})

describe('entity-family contract — operations walks', () => {
  /** ModelMeta naming one base shard, one overlay shard and one overlay head per family. */
  const metaNamingEveryShard = (): { meta: Record<string, unknown>; urls: string[] } => {
    const meta: Record<string, unknown> = {}
    const urls: string[] = []
    for (const family of sharded) {
      const shards = family.shards!
      const base = generateAutomergeUrl()
      meta[shards.urlsField] = [base]
      urls.push(base)
      if (shards.overlay) {
        const head = generateAutomergeUrl()
        const list = generateAutomergeUrl()
        meta[shards.overlay.headField] = head
        meta[shards.overlay.urlsField] = [list]
        urls.push(head, list)
      }
    }
    return { meta, urls }
  }

  it('fsck collectReferencedUrls reaches every shard family document', () => {
    const { meta, urls } = metaNamingEveryShard()
    const found = collectReferencedUrls({ modelMetaUrl: generateAutomergeUrl(), shardUrls: [] }, meta, [])
    expect(urls.length).toBeGreaterThan(sharded.length)
    for (const url of urls) expect(found, url).toContain(url)
  })

  it('gc census marks every shard family document reachable', () => {
    const text = source('./gc.ts')
    for (const family of sharded) {
      const shards = family.shards!
      expect(text, shards.urlsField).toMatch(new RegExp(`for \\(const u of m\\.${shards.urlsField}( \\?\\? \\[\\])?\\) add\\(u\\)`))
      if (shards.overlay) {
        expect(text, shards.overlay.headField).toMatch(new RegExp(`add\\(m\\.${shards.overlay.headField}\\)`))
        expect(text, shards.overlay.urlsField).toMatch(
          new RegExp(`for \\(const u of m\\.${shards.overlay.urlsField} \\?\\? \\[\\]\\) add\\(u\\)`),
        )
      }
    }
  })

  it('the docScope index walk visits every shard family document', () => {
    const text = source('./rbac/docScope.ts')
    for (const family of sharded) {
      const shards = family.shards!
      expect(text, shards.urlsField).toMatch(
        new RegExp(`for \\(const u of meta\\.${shards.urlsField} \\?\\? \\[\\]\\) \\{\\s*await findLeaf\\(u\\)`),
      )
      if (shards.overlay) {
        expect(text, shards.overlay.headField).toMatch(new RegExp(`await findLeaf\\(meta\\.${shards.overlay.headField}\\)`))
        expect(text, shards.overlay.headField).toMatch(new RegExp(`await reference\\(meta\\.${shards.overlay.headField}\\)`))
        expect(text, shards.overlay.urlsField).toMatch(
          new RegExp(`for \\(const url of meta\\.${shards.overlay.urlsField} \\?\\? \\[\\]\\) \\{\\s*await findLeaf\\(url\\)`),
        )
      }
    }
  })
})

describe('entity-family contract — read model', () => {
  const schemaSql = source('./readModel/schema.ts')
  const readModelSources = ['./readModel/projector.ts', './readModel/derivedStats.ts'].map(source).join('\n')
  const snake = (text: string): string => text.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

  it('every projected family has its ro_* table, a writer, and the backup "derived" prefix', () => {
    for (const family of projected) {
      const table = family.projection!.table
      expect(table.startsWith('ro_'), table).toBe(true)
      expect(schemaSql, table).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`))
      expect(readModelSources, table).toMatch(new RegExp(`(INSERT INTO ${table}\\b|bulkUpsert\\(tx, '${table}')`))
    }
  })

  it('no ro_* table exists for a family the registry declares unprojected', () => {
    for (const family of where((candidate) => candidate.projection === null)) {
      expect(schemaSql, family.collection).not.toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ro_${snake(family.collection)} \\(`))
    }
  })

  it('the per-diagram flow index writes the flow families tables', () => {
    for (const family of where((candidate) => candidate.projection?.via === 'diagramFlowIndex')) {
      expect(DIAGRAM_FLOW_INDEX_TABLES as readonly string[]).toContain(family.projection!.table)
    }
  })

  /** A sharded workspace carrying one entity of every family, and a resolver. */
  const workspace = (): { root: Record<string, unknown>; resolve: (url: string) => Promise<unknown> } => {
    const docs = new Map<string, unknown>()
    const meta: Record<string, unknown> = {}
    for (const family of inline) meta[family.collection] = mapOf(family, `${family.name}-1`)
    for (const family of where((candidate) => candidate.home === 'modelShard')) {
      const shards = family.shards!
      const url = `automerge:shard-${family.collection}`
      docs.set(url, { [family.collection]: { ...mapOf(family, `${family.name}-1`), ...mapOf(family, `${family.name}-gone`) } })
      meta[shards.urlsField] = [url]
      meta[shards.tombstonesField] = [`${family.name}-gone`]
    }
    const diagramDoc: Record<string, unknown> = {}
    for (const family of where((candidate) => candidate.home === 'diagramDoc')) {
      diagramDoc[family.collection] = mapOf(family, `${family.name}-1`)
    }
    docs.set('automerge:diagram-doc', diagramDoc)
    docs.set('automerge:registry', {
      diagrams: { 'diagram-1': { id: 'diagram-1', name: 'd', docUrl: 'automerge:diagram-doc' } },
    })
    docs.set('automerge:meta', meta)
    const root = { modelMetaUrl: 'automerge:meta', shardUrls: ['automerge:registry'] }
    return { root, resolve: async (url) => docs.get(url) }
  }

  it('extractModelEntities projects exactly the modelExtraction families (tombstones honoured)', async () => {
    const { root, resolve } = workspace()
    const extracted = (await extractModelEntities(root, resolve)) as unknown as Record<string, unknown>
    const via = where((family) => family.projection?.via === 'modelExtraction')
    for (const family of via) {
      const ids = (extracted[family.collection] as { id: string }[]).map((item) => item.id)
      expect(ids, family.collection).toEqual([`${family.name}-1`])
    }
    const digests = fullExtractionIntegrity(extracted as never).digests as Record<string, unknown>
    expect(Object.keys(digests).sort()).toEqual(via.map((family) => family.name).sort())
  })

  it('the CRDT inventory (coverage witness) counts exactly the inventoried families', async () => {
    const { root, resolve } = workspace()
    const inventory = (await collectCrdtInventory(root, resolve)) as unknown as Record<string, string[]>
    const counted = where((family) => family.projection?.inventoried === true)
    expect(Object.keys(inventory).sort()).toEqual(counted.map((family) => family.collection).sort())
    for (const family of counted) {
      const expected = family.home === 'diagramDoc' ? `diagram-1:${family.name}-1` : `${family.name}-1`
      expect(inventory[family.collection], family.collection).toEqual([expected])
    }
  })

  it('the CRDT inventory reads every inventoried model family from a monolith too', async () => {
    const model: Record<string, unknown> = {}
    for (const family of monolith) model[family.collection] = mapOf(family, `${family.name}-1`)
    const docs = new Map<string, unknown>([['automerge:model', model]])
    const inventory = (await collectCrdtInventory(
      { modelUrl: 'automerge:model', registrySummaryOnly: true },
      async (url) => docs.get(url),
    )) as unknown as Record<string, string[]>
    for (const family of monolith.filter((candidate) => candidate.projection?.inventoried)) {
      expect(inventory[family.collection], family.collection).toEqual([`${family.name}-1`])
    }
  })
})
