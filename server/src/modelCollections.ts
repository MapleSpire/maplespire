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

/**
 * The server's ONE copy of the entity-family collection lists (V0-10).
 *
 * The registry of record is the client's `src/lib/automerge/entityFamilies.ts`;
 * `server/` cannot import it (`rootDir: ./src`, see `modelMeta.ts`). Before
 * this file the same lists were typed by hand at nine server sites (draft diff,
 * changes, merge apply, five empty-model literals, the legacy-model probe).
 * They now derive from here, and `entityFamilyContract.test.ts` (next to this
 * file) compares this file against the registry at run time, so a family
 * added to the registry and forgotten here fails a test instead of being
 * silently absent from drafts, forks and repairs.
 */

/** Collections of the pre-sharding monolithic ModelDoc, in registry order. */
export const MONOLITH_MODEL_COLLECTIONS = [
  'objects', 'connections', 'groups', 'domains', 'tagSnapshots', 'decisionRecords',
] as const
export type MonolithModelCollection = (typeof MONOLITH_MODEL_COLLECTIONS)[number]

/** Collections carried inline on the ModelMeta. */
export const MODEL_META_INLINE_COLLECTIONS = [
  'groups', 'domains', 'tagSnapshots', 'decisionRecords',
] as const satisfies readonly MonolithModelCollection[]
export type ModelMetaInlineCollection = (typeof MODEL_META_INLINE_COLLECTIONS)[number]

/** Draft-diff collection name -> the model collection it diffs. Key order is
 * the diff's iteration order. */
export const DRAFT_MODEL_COLLECTIONS = {
  object: 'objects',
  connection: 'connections',
  group: 'groups',
  domain: 'domains',
  tag: 'tagSnapshots',
  decisionRecord: 'decisionRecords',
} as const satisfies Record<string, MonolithModelCollection>
export type DraftModelCollection = keyof typeof DRAFT_MODEL_COLLECTIONS

export const DRAFT_MODEL_COLLECTION_NAMES: readonly DraftModelCollection[] = Object.freeze(
  Object.keys(DRAFT_MODEL_COLLECTIONS) as DraftModelCollection[],
)

/** Draft collections whose model collection is inline on the ModelMeta. */
export const DRAFT_INLINE_COLLECTIONS: readonly DraftModelCollection[] = Object.freeze(DRAFT_MODEL_COLLECTION_NAMES.filter(
  (name) => (MODEL_META_INLINE_COLLECTIONS as readonly string[]).includes(DRAFT_MODEL_COLLECTIONS[name]),
))

/** A fresh, empty monolithic model: one NEW empty map per collection. */
export function emptyMonolithModel(): { [K in MonolithModelCollection]: Record<string, never> } {
  return Object.fromEntries(MONOLITH_MODEL_COLLECTIONS.map((key) => [key, {}])) as {
    [K in MonolithModelCollection]: Record<string, never>
  }
}
