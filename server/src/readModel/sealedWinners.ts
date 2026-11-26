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
 * SEALED WINNERS FROM SQL (G4-16f C5). The winners of the sealed products a
 * cold build serves from the extract cache, computed by ONE statement over
 * the cached entities, instead of one entity read per product; and the
 * values of chosen winners, read on demand, instead of kept in memory.
 *
 * Why not a persisted winners table: a winner depends on ModelMeta's list
 * ORDER, which fold splices (`spliceFoldedRunInPlace`) and client rewrites
 * change; a table would be a second derived structure going stale with the
 * list. The cache already holds every product's entities, keyed by
 * `(workspace, collection, product, entity id)`, so a statement given the
 * list computes them.
 *
 * THE RANK (`SEALED_RANK_CTE`): the list's positions, per url, through
 * `unnest ... WITH ORDINALITY`; a product's rank is its LAST position, as
 * `sealedRankIn` (`lastIndexOf`) and the merge's last-wins `Object.assign`
 * count a url listed twice; the FIRST position is where the merge inserts
 * a key it has not seen yet. Zero-based, like `lastIndexOf`.
 *
 * WHAT A CANDIDATE IS: a product the C4 hit check accepted
 * (`readSealedProductCacheHits`: its current rows' digest equals its
 * header's, its extraction version is current, no remembered refusal),
 * named by its url, its document id and that digest. Only entities whose
 * header still carries that digest and version, with no refusal, take part:
 * a header rewritten since by another writer takes no part at all (its
 * digest moved), and one whose entity rows number other than its
 * `entity_count` (fewer or more) is refused and returned in `refused` — the
 * caller reads that product from its document. The count is decided inside
 * the statement, before any winner, so the winners never count a product
 * the caller does not serve, and the statement runs once.
 */

import type { Queryable } from './types.js'
import { parameterText, type WorkspaceKey } from './projector.js'
import { SEALED_PRODUCT_EXTRACTION_VERSION, codePointOrder, sortedKeys } from './sealedProductCache.js'

/**
 * The rank of every url of the list bound at `listParam` (a `text[]`):
 * `rank(url, last_at, first_at)`, zero-based. THE ONE rank of this module:
 * `readSealedRanks` (its tests' handle on it) and the winners statement
 * both use this text.
 */
export const sealedRankCte = (listParam: string): string => `rank AS (
  SELECT listed.url, max(listed.ord) - 1 AS last_at, min(listed.ord) - 1 AS first_at
    FROM unnest(${listParam}::text[]) WITH ORDINALITY AS listed(url, ord)
   GROUP BY listed.url)`

/** The rank SQL gives each url of `list`: `last` as `sealedRankIn` does,
 * `first` the first position. */
export async function readSealedRanks(
  db: Queryable,
  list: readonly string[],
): Promise<Map<string, { last: number; first: number }>> {
  const { rows } = await db.query<{ url: string; last_at: string; first_at: string }>(
    `WITH ${sealedRankCte('$1')} SELECT url, last_at::text AS last_at, first_at::text AS first_at FROM rank`,
    [[...list]],
  )
  return new Map(rows.map((row) => [row.url, { last: Number(row.last_at), first: Number(row.first_at) }]))
}

/** A product served from the extract cache: what the hit check decided. */
export interface SealedWinnerCandidate {
  url: string
  documentId: string
  rowsDigest: string
  /** The header's `entity_count`, which the rows found must equal. */
  entityCount: number
}

export interface SealedWinners {
  /** Candidate url -> the ids it wins among the served candidates, in
   * `codePointOrder`. Every served candidate has an entry (maybe empty). */
  wonBy: Map<string, string[]>
  /** entity id -> its winner's value (`values: true` only), keys ordered
   * as a loaded document orders them (`sortedKeys`). */
  values: Map<string, unknown>
  /** Candidate url -> the ids it is the FIRST served candidate in list
   * order to hold, without winning them (`values: true` only): where the
   * merge first inserts those keys. */
  firstHeldBy: Map<string, string[]>
  /** entity id -> its winner's inner-id text (`parameterText` of the value's
   * `id`), only where that differs from the entity id. */
  innerIds: Map<string, string | null>
  /** Candidates refused (their rows do not number `entityCount`, fewer or
   * more): not in `wonBy`, not counted in any winner. */
  refused: Set<string>
  /** Statements run: 1, or 0 without a candidate the list names. */
  statements: number
}

type WinnerRow = {
  row_kind: 'accepted' | 'win' | 'first'
  url: string
  entity_id: string | null
  plain: boolean | null
  inner_id: unknown
  value: unknown
}

/**
 * The winners over `candidates` of one collection, ranked by `list` (the
 * list the caller MERGES: for the cold build, the ModelMeta revision its
 * extraction reads). `values`: also each winner's value and the merge's
 * first-insert slots (the cold build); without it ids only (C6's index
 * built from SQL). Candidates whose url `list` does not name take no part.
 */
export async function readSealedWinners(
  db: Queryable,
  key: WorkspaceKey,
  kind: 'object' | 'connection',
  list: readonly string[],
  candidates: readonly SealedWinnerCandidate[],
  options: { values: boolean },
): Promise<SealedWinners> {
  const byUrl = new Map<string, SealedWinnerCandidate>()
  for (const candidate of candidates) if (list.includes(candidate.url)) byUrl.set(candidate.url, candidate)
  const out: SealedWinners = {
    wonBy: new Map(), values: new Map(), firstHeldBy: new Map(), innerIds: new Map(), refused: new Set(), statements: 0,
  }
  const served = [...byUrl.values()]
  if (!served.length) return out
  out.statements += 1
  const { rows } = await db.query<WinnerRow>(SEALED_WINNERS_SQL, sealedWinnersParams(key, kind, list, served, options))
  for (const row of rows) {
    if (row.row_kind !== 'accepted') continue
    out.wonBy.set(row.url, [])
    if (options.values) out.firstHeldBy.set(row.url, [])
  }
  for (const candidate of served) if (!out.wonBy.has(candidate.url)) out.refused.add(candidate.url)
  for (const row of rows) {
    if (row.row_kind === 'win') {
      out.wonBy.get(row.url)!.push(row.entity_id!)
      // Keys in the loaded document's order: an object id converts
      // through `JSON.stringify`, which follows them.
      if (!row.plain) out.innerIds.set(row.entity_id!, parameterText(sortedKeys(row.inner_id ?? undefined)))
      if (options.values) out.values.set(row.entity_id!, sortedKeys(row.value))
    } else if (row.row_kind === 'first') {
      out.firstHeldBy.get(row.url)!.push(row.entity_id!)
    }
  }
  for (const ids of out.wonBy.values()) ids.sort(codePointOrder)
  for (const ids of out.firstHeldBy.values()) ids.sort(codePointOrder)
  return out
}

/** The parameters of `SEALED_WINNERS_SQL`, in its numbering, for the
 * candidates `served` (each url once, every one named by `list`). */
export function sealedWinnersParams(
  key: WorkspaceKey,
  kind: 'object' | 'connection',
  list: readonly string[],
  served: readonly SealedWinnerCandidate[],
  options: { values: boolean },
): unknown[] {
  return [key.landscapeId, key.versionId, kind, SEALED_PRODUCT_EXTRACTION_VERSION, [...list],
    served.map((candidate) => candidate.url), served.map((candidate) => candidate.documentId),
    served.map((candidate) => candidate.rowsDigest), options.values,
    served.map((candidate) => candidate.entityCount)]
}

/**
 * THE winners statement `readSealedWinners` runs (exported so its PLAN is
 * tested, `sealedWinnersPlan.integration.test.ts`).
 *
 * `found`: every entity row of every candidate whose header still carries
 * the decided digest, the current version and no refusal, with `complete`
 * — its candidate's rows number exactly its entity_count (fewer or more is
 * refused). The count is a window over `found` itself, so it is decided
 * inside the statement, before any winner: a refused candidate takes no
 * part in any winner, the values cross the wire once, nothing runs twice.
 * A candidate with no row at all has no `found` row, so it is refused too.
 *
 * `ranked`: per entity id, over the complete rows, `by_last` (1 = the
 * holder listed LAST, the winner; ties cannot occur, each url has one
 * `last_at`), `by_first` (1 = the holder listed FIRST, where the merge
 * inserts the key) and `winner_url`.
 *
 * WHY WINDOWS AND A LATERAL, not `DISTINCT ON` CTEs joined back by entity
 * id (this query's first version): under statistics that do not know the workspace key
 * (re-keyed, new, or just written and not yet analyzed) every CTE is
 * estimated at ~1 row and those joins became Nested Loops with the ids in
 * a Join Filter — every winner rescanned the workspace's entity rows
 * (measured: an adopted boot's B2 at 504 s on the target-like PC; the
 * first version cancelled at 120 s on a 110 483-row corpus, this one
 * ~0.4 s). Here no
 * entity-sized CTE is joined to another, and each winner's value is ONE
 * primary-key lookup. The `OFFSET 0` keeps the lateral a separate
 * subquery: without it the planner pulls it up into an ordinary join and,
 * under those statistics, plans exactly that filtered Nested Loop — the
 * plan test's second RED control (`sealedWinnersWithoutOffsetFence`).
 */
export const SEALED_WINNERS_SQL = `WITH ${sealedRankCte('$5')},
       candidate AS (
         SELECT given.url, given.product_document_id, given.rows_digest, given.entity_count, rank.last_at, rank.first_at
           FROM unnest($6::text[], $7::text[], $8::text[], $10::int[])
                AS given(url, product_document_id, rows_digest, entity_count)
           JOIN rank ON rank.url = given.url),
       found AS (
         SELECT entity.entity_id, candidate.url, candidate.product_document_id, candidate.last_at, candidate.first_at,
                count(*) OVER (PARTITION BY candidate.url) = candidate.entity_count AS complete
           FROM candidate
           JOIN read_model_sealed_product_extracts AS header
             ON header.landscape_id = $1 AND header.version_id = $2 AND header.collection = $3
            AND header.product_document_id = candidate.product_document_id
            AND header.rows_digest = candidate.rows_digest
            AND header.extraction_version = $4 AND header.refused_reason IS NULL
           JOIN read_model_sealed_product_entities AS entity
             ON entity.landscape_id = $1 AND entity.version_id = $2 AND entity.collection = $3
            AND entity.product_document_id = candidate.product_document_id),
       ranked AS (
         SELECT found.entity_id, found.url, found.product_document_id,
                row_number() OVER (PARTITION BY found.entity_id ORDER BY found.last_at DESC) AS by_last,
                row_number() OVER (PARTITION BY found.entity_id ORDER BY found.first_at ASC) AS by_first,
                first_value(found.url) OVER (PARTITION BY found.entity_id ORDER BY found.last_at DESC) AS winner_url
           FROM found WHERE found.complete)
       SELECT 'accepted' AS row_kind, accepted.url, NULL::text AS entity_id,
              NULL::boolean AS plain, NULL::jsonb AS inner_id, NULL::jsonb AS value
         FROM (SELECT DISTINCT found.url FROM found WHERE found.complete) AS accepted
       UNION ALL
       SELECT 'win', ranked.url, ranked.entity_id,
              coalesce(jsonb_typeof(winner.value -> 'id') = 'string' AND winner.value ->> 'id' = ranked.entity_id, false),
              winner.value -> 'id',
              CASE WHEN $9 THEN winner.value END
         FROM ranked
         CROSS JOIN LATERAL (
           SELECT entity.value FROM read_model_sealed_product_entities AS entity
            WHERE entity.landscape_id = $1 AND entity.version_id = $2 AND entity.collection = $3
              AND entity.product_document_id = ranked.product_document_id AND entity.entity_id = ranked.entity_id
           OFFSET 0) AS winner
        WHERE ranked.by_last = 1
       UNION ALL
       SELECT 'first', ranked.url, ranked.entity_id, NULL, NULL, NULL
         FROM ranked
        WHERE $9 AND ranked.by_first = 1 AND ranked.url <> ranked.winner_url`

/** One parked product's values to read: the ids asked of it, against the
 * digest its extract was served (or written) with. */
export interface SealedValueRequest {
  url: string
  documentId: string
  rowsDigest: string
  ids: readonly string[]
}

/**
 * The values of `requests`, ONE statement: per url, the id -> value of each
 * asked id whose row exists under a header that STILL carries the request's
 * digest, the current extraction version and no refusal. An id absent from
 * the answer is a value the cache no longer has (the extract deleted,
 * pruned or rewritten since, or the row gone): the caller must not read
 * that absence as "the product does not hold it".
 */
export async function readSealedValues(
  db: Queryable,
  key: WorkspaceKey,
  kind: 'object' | 'connection',
  requests: readonly SealedValueRequest[],
): Promise<Map<string, Map<string, unknown>>> {
  const out = new Map<string, Map<string, unknown>>()
  const urls: string[] = []
  const documentIds: string[] = []
  const digests: string[] = []
  const ids: string[] = []
  for (const request of requests) {
    out.set(request.url, new Map())
    for (const id of request.ids) {
      urls.push(request.url)
      documentIds.push(request.documentId)
      digests.push(request.rowsDigest)
      ids.push(id)
    }
  }
  if (!ids.length) return out
  const { rows } = await db.query<{ url: string; entity_id: string; value: unknown }>(
    `SELECT asked.url, entity.entity_id, entity.value
       FROM unnest($4::text[], $5::text[], $6::text[], $7::text[]) AS asked(url, product_document_id, rows_digest, entity_id)
       JOIN read_model_sealed_product_extracts AS header
         ON header.landscape_id = $1 AND header.version_id = $2 AND header.collection = $3
        AND header.product_document_id = asked.product_document_id AND header.rows_digest = asked.rows_digest
        AND header.extraction_version = $8 AND header.refused_reason IS NULL
       JOIN read_model_sealed_product_entities AS entity
         ON entity.landscape_id = $1 AND entity.version_id = $2 AND entity.collection = $3
        AND entity.product_document_id = asked.product_document_id AND entity.entity_id = asked.entity_id`,
    [key.landscapeId, key.versionId, kind, urls, documentIds, digests, ids, SEALED_PRODUCT_EXTRACTION_VERSION],
  )
  for (const row of rows) out.get(row.url)?.set(row.entity_id, sortedKeys(row.value))
  return out
}

/** The inner-id anomalies of an entity map read from a document: each id
 * whose value's `id` (as `parameterText` converts it, the duplicate-id
 * rule's comparison) is not the id itself. */
export function innerIdAnomalies(entities: Readonly<Record<string, unknown>>): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const [id, value] of Object.entries(entities)) {
    const inner = parameterText((value as { id?: unknown } | null | undefined)?.id)
    if (inner !== id) out.set(id, inner)
  }
  return out
}
