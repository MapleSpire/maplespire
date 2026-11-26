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

import { SEALED_WINNERS_SQL, sealedRankCte } from '../readModel/sealedWinners.js'

/**
 * The sealed-winners statement as C5 first shipped it (the original
 * `readSealedWinners`, verbatim): `DISTINCT ON` CTEs joined back to each
 * other and to the entities by entity id. NOT run by the server. It is the
 * RED control of `sealedWinnersPlan.integration.test.ts` (the fixture must
 * reproduce its quadratic plan, or the plan test proves nothing) and the
 * `previous` arm of `qa/g416f-winners-plan-probe.mts`; same parameters as
 * `sealedWinnersParams`.
 */
export const SEALED_WINNERS_C5_SQL = `WITH ${sealedRankCte('$5')},
       candidate AS (
         SELECT given.url, given.product_document_id, given.rows_digest, given.entity_count, rank.last_at, rank.first_at
           FROM unnest($6::text[], $7::text[], $8::text[], $10::int[])
                AS given(url, product_document_id, rows_digest, entity_count)
           JOIN rank ON rank.url = given.url),
       found AS (
         SELECT entity.entity_id, candidate.url, candidate.product_document_id, candidate.last_at, candidate.first_at
           FROM candidate
           JOIN read_model_sealed_product_extracts AS header
             ON header.landscape_id = $1 AND header.version_id = $2 AND header.collection = $3
            AND header.product_document_id = candidate.product_document_id
            AND header.rows_digest = candidate.rows_digest
            AND header.extraction_version = $4 AND header.refused_reason IS NULL
           JOIN read_model_sealed_product_entities AS entity
             ON entity.landscape_id = $1 AND entity.version_id = $2 AND entity.collection = $3
            AND entity.product_document_id = candidate.product_document_id),
       counted AS (
         SELECT found.url, count(*)::int AS n FROM found GROUP BY found.url),
       accepted AS (
         SELECT candidate.url FROM candidate JOIN counted USING (url)
          WHERE counted.n = candidate.entity_count),
       held AS (
         SELECT found.* FROM found JOIN accepted USING (url)),
       win AS (
         SELECT DISTINCT ON (held.entity_id) held.entity_id, held.url, held.product_document_id
           FROM held ORDER BY held.entity_id, held.last_at DESC),
       first_held AS (
         SELECT DISTINCT ON (held.entity_id) held.entity_id, held.url
           FROM held WHERE $9 ORDER BY held.entity_id, held.first_at ASC)
       SELECT 'accepted' AS row_kind, accepted.url, NULL::text AS entity_id,
              NULL::boolean AS plain, NULL::jsonb AS inner_id, NULL::jsonb AS value
         FROM accepted
       UNION ALL
       SELECT 'win', win.url, win.entity_id,
              coalesce(jsonb_typeof(entity.value -> 'id') = 'string' AND entity.value ->> 'id' = win.entity_id, false),
              entity.value -> 'id',
              CASE WHEN $9 THEN entity.value END
         FROM win
         JOIN read_model_sealed_product_entities AS entity
           ON entity.landscape_id = $1 AND entity.version_id = $2 AND entity.collection = $3
          AND entity.product_document_id = win.product_document_id AND entity.entity_id = win.entity_id
       UNION ALL
       SELECT 'first', first_held.url, first_held.entity_id, NULL, NULL, NULL
         FROM first_held JOIN win USING (entity_id)
        WHERE first_held.url <> win.url`

/** The current statement with its lateral's `OFFSET 0` removed: the second
 * RED control (the fence is what keeps the plan linear). Throws if the
 * current text no longer carries the fence, so the control cannot silently
 * become the statement itself. */
export function sealedWinnersWithoutOffsetFence(): string {
  const fenced = 'OFFSET 0) AS winner'
  if (SEALED_WINNERS_SQL.split(fenced).length !== 2) throw new Error('SEALED_WINNERS_SQL no longer has exactly one fenced lateral')
  return SEALED_WINNERS_SQL.replace(fenced, ') AS winner')
}
