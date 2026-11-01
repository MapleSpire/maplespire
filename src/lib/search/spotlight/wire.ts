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
 * Spotlight search core: the server tier's wire contract.
 *
 * THIS FILE EXISTS TWICE, byte for byte: `src/lib/search/spotlight/` (the ruling
 * copy) and `server/src/search/spotlight/` (the server's mirror). Edit the
 * `src/` copy, then run `node scripts/sync-spotlight-core.mjs`;
 * `spotlight.conformance.test.ts` fails on any byte difference. See `fold.ts`.
 *
 * What `POST /api/model/spotlight` answers, and the limits it enforces. The
 * server writes these types (`server/src/readModel/spotlight.ts`) and the
 * client reads them (`src/lib/search/spotlightServer.ts`), so one definition
 * keeps the encoder and the reader from drifting.
 */

import type { DocField, SpotlightDoc } from './evaluate.js'
import type { SpotlightKind } from './grammar.js'

export const SPOTLIGHT_WIRE_VERSION = 1

/** Longest query the server reads. */
export const SPOTLIGHT_QUERY_MAX = 256

/** Most hits a section may return: the scoped view lists 50 rows a group, and
 *  asks for one more because the top hit is taken out of its group. */
export const SPOTLIGHT_PER_KIND_MAX = 51

/** The vocabulary the request carries (`vocab`): domain and tag names, which
 *  the read model does not hold. At most this many pairs of each, and this many
 *  characters in an id or a name. */
export const SPOTLIGHT_VOCAB_DOMAINS_MAX = 1000
export const SPOTLIGHT_VOCAB_TAGS_MAX = 5000
export const SPOTLIGHT_VOCAB_TEXT_MAX = 256

/** What the server's read model can and cannot answer for this workspace. */
export interface SpotlightCoverage {
  /** Kinds this workspace's read model does not hold at all. */
  readonly unavailableKinds: readonly SpotlightKind[]
  /** Fields it does not hold for a kind: a term on them cannot match there. */
  readonly fieldGaps: Readonly<Partial<Record<SpotlightKind, readonly DocField[]>>>
}

/**
 * A hit as the server sends it: the document it ranked, trimmed (descriptions
 * to 600 characters, diagram names to 12), plus what a row or a preview needs
 * to show an entity the client does not hold. A client RENDERS it; it never
 * ranks it again (the trimmed text would score differently).
 */
export interface SpotlightWireDoc extends SpotlightDoc {
  readonly extra: Readonly<Record<string, string | number | null>>
}

export interface SpotlightWireHit {
  readonly score: number
  readonly doc: SpotlightWireDoc
}

export interface SpotlightWireSection {
  readonly kind: SpotlightKind
  /** Every match the server counted in this section. */
  readonly total: number
  /** True when the family hit the candidate cap: `total` is a lower bound. */
  readonly totalCapped: boolean
  readonly hits: readonly SpotlightWireHit[]
}

export interface SpotlightWireResult {
  readonly v: typeof SPOTLIGHT_WIRE_VERSION
  readonly topHit: { readonly kind: SpotlightKind; readonly id: string } | null
  readonly sections: readonly SpotlightWireSection[]
  readonly coverage: SpotlightCoverage
}

/** The request body. `kinds` narrows to a scope; absent means every kind. */
export interface SpotlightWireRequest {
  readonly q: string
  readonly kinds?: readonly SpotlightKind[]
  readonly perKind: number
  readonly vocab: {
    /** [domain id, name] */
    readonly domains: ReadonlyArray<readonly [string, string]>
    /** [tag id, value] */
    readonly tags: ReadonlyArray<readonly [string, string]>
  }
}
