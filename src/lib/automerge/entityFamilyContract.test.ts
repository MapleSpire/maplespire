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

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChangeCollection } from '../drafts/api'
import { useModelStore } from '../../stores/modelStore'
import {
  DIAGRAM_COLLECTION_INTENT_KINDS,
  SMALL_COLLECTION_INTENT_KINDS,
  isDiagramCollectionKind,
  isEntityPlannerKind,
  isSmallCollectionKind,
  type EntityIntentKind,
} from './entityIntents'
import {
  DIAGRAM_JOURNAL_KINDS,
  ENTITY_FAMILIES,
  ENTITY_FAMILY_BY_NAME,
  ENTITY_FAMILY_LIST,
  ENTITY_STORE_SLICES,
  MODEL_META_INLINE_COLLECTIONS,
  MONOLITH_COLLECTIONS,
  SMALL_JOURNAL_KINDS,
  entityKeyOf,
  type DiagramDocCollection,
  type EntityFamily,
  type ModelMetaInlineCollection,
  type MonolithCollection,
} from './entityFamilies'
import { isModelShardReferenceField, type DeferredReferenceField } from './deferredReferences'
import { COLLECTION_SCHEMAS, DIAGRAM_DOC_SCHEMA, ENTITY_SCHEMAS, ROOT_MODEL_SCHEMA, type EntityCollection } from './knownKeys'
import { persistentSlicesChanged, type PersistentModelSlices } from './persistentSlices'
import {
  modelShardsToRootModel,
  rootModelToSlice,
  sliceToRootModel,
  splitModel,
  type ModelSlice,
} from './projection'
import { smallCollectionKeyOf } from './smallCollectionCapture'
import type { DiagramDoc, ModelMeta, RegistryShard, RootModel } from './types'
import { resetWorkspaceProjection } from './workspaceProjection'

/**
 * The CLIENT half of the entity-family contract (V0-10): every client point a
 * family must be registered at either derives from `entityFamilies.ts` or is
 * compared against it here. Type-level points are compared by `tsc -b` (this
 * file is in `tsconfig.app.json`'s `src`): the `TYPE_CONTRACT` block below does
 * not compile when a declared family is missing from a type. The server half is
 * `server/src/entityFamilyContract.test.ts`; the point table and the mutant
 * record are in `docs/entity-family-contract.md`.
 */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type ShardUrlsField = NonNullable<EntityFamily['shards']>['urlsField']
type OverlaidUrlsField = Extract<
  (typeof ENTITY_FAMILIES)[EntityCollection],
  { readonly shards: { readonly overlay: object } }
>['shards']['urlsField']
type DraftName = Exclude<(typeof ENTITY_FAMILIES)[EntityCollection]['draftCollection'], null>

// Each entry fails `tsc -b` when its equality does not hold.
export const TYPE_CONTRACT: Record<string, true> = {
  rootModel: true satisfies Equals<keyof RootModel, MonolithCollection>,
  modelSlice: true satisfies Equals<keyof ModelSlice, MonolithCollection>,
  modelMetaInline: true satisfies Equals<Extract<keyof ModelMeta, EntityCollection>, ModelMetaInlineCollection>,
  modelMetaShards: true satisfies Equals<Extract<keyof ModelMeta, ShardUrlsField>, ShardUrlsField>,
  diagramDoc: true satisfies Equals<Extract<keyof DiagramDoc, EntityCollection>, DiagramDocCollection>,
  registryShard: true satisfies Equals<Extract<keyof RegistryShard, EntityCollection>, 'diagrams'>,
  persistentSlices: true satisfies Equals<
    Exclude<keyof PersistentModelSlices, 'currentDiagramId'>,
    (typeof ENTITY_STORE_SLICES)[number]
  >,
  draftCollections: true satisfies Equals<Exclude<DraftName, ChangeCollection>, never>,
  deferredReferenceFields: true satisfies Equals<Exclude<OverlaidUrlsField, DeferredReferenceField>, never>,
}

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const families = ENTITY_FAMILY_LIST
const where = (keep: (family: (typeof families)[number]) => boolean) => families.filter(keep)
const entity = (family: { idField: 'id' | 'tagId'; name: string }, id: string) => ({ [family.idField]: id, name: id })

describe('entity-family registry', () => {
  it('declares each collection under its own key, with its known-keys schema', () => {
    for (const [key, family] of Object.entries(ENTITY_FAMILIES)) {
      expect(family.collection).toBe(key)
      expect(family.schema, key).toBe(ENTITY_SCHEMAS[key as EntityCollection])
    }
    expect(new Set(families.map((family) => family.name)).size).toBe(families.length)
  })

  it('keeps home, journal and shards consistent', () => {
    const journalOfHome = { modelShard: 'entity', modelMeta: 'small', diagramDoc: 'diagram', registryShard: 'stub' }
    for (const family of families) {
      expect(family.journal, family.name).toBe(journalOfHome[family.home])
      if (family.home === 'modelShard') expect(family.shards?.overlay, family.name).toBeTruthy()
      else if (family.shards) {
        expect(family.home, family.name).toBe('modelMeta')
        expect(family.shards.overlay, family.name).toBeNull()
      }
      if (family.monolith) expect(['modelShard', 'modelMeta'], family.name).toContain(family.home)
    }
  })

  it('reproduces the literals the derived lists replaced, element for element', () => {
    expect(MONOLITH_COLLECTIONS).toEqual(['objects', 'connections', 'groups', 'domains', 'tagSnapshots', 'decisionRecords'])
    expect(MODEL_META_INLINE_COLLECTIONS).toEqual(['groups', 'domains', 'tagSnapshots', 'decisionRecords'])
    expect(SMALL_JOURNAL_KINDS).toEqual(['group', 'domain', 'tagSnapshot', 'decisionRecord'])
    expect(DIAGRAM_JOURNAL_KINDS).toEqual(['comment', 'flow'])
  })
})

describe('entity-family contract — known keys (V0-08)', () => {
  it('ENTITY_SCHEMAS and COLLECTION_SCHEMAS carry exactly the registered families', () => {
    expect(Object.keys(ENTITY_SCHEMAS)).toEqual(Object.keys(ENTITY_FAMILIES))
    expect(Object.keys(COLLECTION_SCHEMAS)).toEqual(Object.keys(ENTITY_FAMILIES))
    for (const family of families) expect(COLLECTION_SCHEMAS[family.collection].value, family.name).toBe(family.schema)
  })

  it('ROOT_MODEL_SCHEMA is the monolith, DIAGRAM_DOC_SCHEMA carries the DiagramDoc families', () => {
    expect(Object.keys(ROOT_MODEL_SCHEMA.fields)).toEqual([...MONOLITH_COLLECTIONS])
    for (const family of where((candidate) => candidate.home === 'diagramDoc')) {
      const field = DIAGRAM_DOC_SCHEMA.fields[family.collection]
      expect(field?.kind === 'map' && field.value, family.name).toBe(family.schema)
    }
  })
})

describe('entity-family contract — crash journal (entityIntents.ts)', () => {
  it('derives its kind lists from the registry', () => {
    expect(SMALL_COLLECTION_INTENT_KINDS).toBe(SMALL_JOURNAL_KINDS)
    expect(DIAGRAM_COLLECTION_INTENT_KINDS).toBe(DIAGRAM_JOURNAL_KINDS)
  })

  it('classifies every family into the carrier its declaration names', () => {
    for (const family of families) {
      const kind = family.name as EntityIntentKind
      expect(isSmallCollectionKind(kind), family.name).toBe(family.journal === 'small')
      expect(isDiagramCollectionKind(kind), family.name).toBe(family.journal === 'diagram')
      expect(isEntityPlannerKind(kind), family.name).toBe(family.journal === 'entity')
    }
  })

  it('keys a small-collection intent by the registered id field', () => {
    for (const kind of SMALL_JOURNAL_KINDS) {
      const family = ENTITY_FAMILY_BY_NAME[kind]
      const value = entity(family, `${kind}-1`) as never
      expect(smallCollectionKeyOf[kind](value), kind).toBe(`${kind}-1`)
      expect(entityKeyOf(family, value), kind).toBe(`${kind}-1`)
    }
  })
})

describe('entity-family contract — store and projection', () => {
  const slices = (): PersistentModelSlices => ({
    ...(Object.fromEntries(ENTITY_STORE_SLICES.map((slice) => [slice, []])) as unknown as Omit<PersistentModelSlices, 'currentDiagramId'>),
    currentDiagramId: null,
  })

  it('a change to any family store slice schedules a persist', () => {
    for (const family of families) {
      const previous = slices()
      expect(persistentSlicesChanged({ ...previous, [family.storeSlice]: [] }, previous), family.name).toBe(true)
    }
    const previous = slices()
    expect(persistentSlicesChanged({ ...previous }, previous)).toBe(false)
  })

  it('a workspace reset clears every family store slice', () => {
    const seeded = Object.fromEntries(families.map((family) => [
      family.storeSlice,
      [{ ...entity(family, 'x'), objectIds: [], connectionIds: [], groupIds: [] }],
    ]))
    useModelStore.setState(seeded as never)
    resetWorkspaceProjection()
    const state = useModelStore.getState() as unknown as Record<string, unknown[]>
    for (const family of families) expect(state[family.storeSlice], family.name).toEqual([])
  })

  it('the monolith <-> store <-> ModelMeta converters carry every monolith family, keyed by its id field', () => {
    const model = Object.fromEntries(
      where((family) => family.monolith).map((family) => [family.collection, { [`${family.name}-1`]: entity(family, `${family.name}-1`) }]),
    ) as unknown as RootModel
    expect(sliceToRootModel(rootModelToSlice(model))).toEqual(model)
    const split = splitModel(model, 10)
    for (const collection of MODEL_META_INLINE_COLLECTIONS) {
      expect(Object.keys((split.meta as unknown as Record<string, object>)[collection] ?? {}), collection).toHaveLength(1)
    }
    const meta = { ...split.meta, objectShardUrls: [], connectionShardUrls: [] } as ModelMeta
    expect(modelShardsToRootModel(meta, split.objectShards, split.connectionShards)).toEqual(model)
  })
})

describe('entity-family contract — client documents and references', () => {
  it('a client-created shard pointer is held back until durable (deferredReferences)', () => {
    for (const family of where((candidate) => candidate.shards !== null)) {
      const field = family.shards!.urlsField as DeferredReferenceField
      expect(isModelShardReferenceField(field), field).toBe(family.shards!.overlay !== null)
    }
  })

  it('a version snapshot captures every shard family document (landscapeVersions)', () => {
    const text = source('./landscapeVersions.ts')
    for (const family of where((candidate) => candidate.shards !== null)) {
      expect(text, family.shards!.urlsField).toMatch(
        new RegExp(`for \\(const u of meta\\?\\.${family.shards!.urlsField} \\?\\? \\[\\]\\) refs\\.push\\(`),
      )
    }
  })

  it('the bridge derives its collection lists and store slices from the registry', () => {
    const text = source('./bridge.ts')
    expect(text).toMatch(/const MODEL_KEYS = MONOLITH_COLLECTIONS\n/)
    expect(text).toMatch(/const MODEL_SMALL_KEYS = MODEL_META_INLINE_COLLECTIONS\n/)
    expect(text.match(/patch\[ENTITY_FAMILIES\[key\]\.storeSlice\] = Object\.values\(coll\)/g)).toHaveLength(2)
    expect(text).not.toMatch(/key === 'tagSnapshots' \? 'tags'/)
    expect(text.match(/ENTITY_FAMILY_BY_NAME\[kind\]\.collection/g)).toHaveLength(2)
  })

  it('both bridge ModelMeta writers reconcile every inline family', () => {
    const text = source('./bridge.ts')
    for (const collection of MODEL_META_INLINE_COLLECTIONS) {
      const writer = collection === 'decisionRecords'
        ? /reconcileDecisionRecordCollection\(m, (small|state)\.decisionRecords\)/g
        : new RegExp(`reconcileMapField\\(m, '${collection}', `, 'g')
      expect(text.match(writer), collection).toHaveLength(2)
    }
  })

  it('the server half exists where the server vitest suite collects it', () => {
    expect(existsSync(new URL('../../../server/src/entityFamilyContract.test.ts', import.meta.url))).toBe(true)
  })
})
