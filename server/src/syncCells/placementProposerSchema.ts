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

import type { Queryable } from '../readModel/types.js'

export const PROPOSER_PROTOCOL = 1
export const PROPOSAL_TABLE = 'sync_placement_proposals'
export const COVERAGE_TABLE = 'sync_placement_history_coverage'
export function proposerSchemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('invalid-proposer-schema')
  return `"${schema}"`
}

/** A signature is a present-tense check, not evidence against an administrator
 * disabling and restoring capture between reads. Such maintenance MUST reset
 * coverage. Relation identity detects a drop/recreate even with identical DDL. */
export function captureSignatureSql(schema: string, kind: 'movements' | 'proposals'): string {
  const s = proposerSchemaName(schema)
  const source = kind === 'movements' ? 'sync_workspace_ownership' : PROPOSAL_TABLE
  const history = kind === 'movements' ? 'sync_workspace_placement_moves' : PROPOSAL_TABLE
  return `(SELECT md5(h.oid::text || string_agg(
    t.tgrelid::text || t.tgfoid::text || pg_get_triggerdef(t.oid) || pg_get_functiondef(t.tgfoid), '|' ORDER BY t.tgname))
    FROM pg_catalog.pg_class h
    JOIN pg_catalog.pg_namespace n ON n.oid = h.relnamespace
    JOIN pg_catalog.pg_trigger t ON
      (t.tgrelid = '${s}.${source}'::regclass AND t.tgname = 'trg_sync_placement_move'
       AND '${kind}' = 'movements')
      OR (t.tgrelid = h.oid AND t.tgname = 'trg_placement_history_invalidated')
    WHERE n.nspname = '${schema}' AND h.relname = '${history}'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
    GROUP BY h.oid HAVING count(*) = ${kind === 'movements' ? 2 : 1})`
}

/** Owner-only migration; never imported by the executable. The migration runner
 * supplies a transaction. No role is provisioned and no PUBLIC grant is changed.
 * Rows written before capture existed cannot attest when capture began: start
 * a new interval. */
export async function ensurePlacementProposerSchema(db: Queryable): Promise<void> {
  const result = await db.query<{ schema: string }>('SELECT current_schema() AS schema')
  const schema = result.rows[0]?.schema
  const s = proposerSchemaName(schema)
  const prior = await db.query<{ existed: boolean }>('SELECT to_regclass($1) IS NOT NULL AS existed',
    [`${s}.${PROPOSAL_TABLE}`])
  const bornHere = prior.rows[0]?.existed === false
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}.${PROPOSAL_TABLE} (
      proposal_id UUID PRIMARY KEY,
      landscape_id TEXT NOT NULL,
      proposed_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      CHECK (jsonb_typeof(payload) = 'object'),
      CHECK ((payload->>'protocol' = '1') IS TRUE),
      CHECK ((jsonb_typeof(payload->'members') = 'array') IS TRUE),
      CHECK ((jsonb_array_length(payload->'members') > 0) IS TRUE)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_placement_proposals_landscape_time
      ON ${s}.${PROPOSAL_TABLE}(landscape_id, proposed_at DESC);
    CREATE TABLE IF NOT EXISTS ${s}.${COVERAGE_TABLE} (
      kind TEXT PRIMARY KEY CHECK (kind IN ('movements', 'proposals')),
      origin UUID NOT NULL DEFAULT gen_random_uuid(),
      from_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      from_beginning BOOLEAN NOT NULL,
      protocol INTEGER NOT NULL CHECK (protocol = 1),
      capture_signature TEXT NOT NULL
    );
    CREATE OR REPLACE FUNCTION ${s}.invalidate_placement_history_coverage()
    RETURNS trigger LANGUAGE plpgsql
    SET search_path = pg_catalog, ${s}, pg_temp AS $$
    BEGIN
      UPDATE ${s}.${COVERAGE_TABLE}
        SET origin = gen_random_uuid(), from_at = clock_timestamp(), from_beginning = false
        WHERE kind = TG_ARGV[0];
      RETURN NULL;
    END;
    $$;
    CREATE OR REPLACE TRIGGER trg_placement_history_invalidated
      AFTER UPDATE OR DELETE OR TRUNCATE ON ${s}.sync_workspace_placement_moves
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.invalidate_placement_history_coverage('movements');
    CREATE OR REPLACE TRIGGER trg_placement_history_invalidated
      AFTER UPDATE OR DELETE OR TRUNCATE ON ${s}.${PROPOSAL_TABLE}
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.invalidate_placement_history_coverage('proposals');
  `)
  // Changes to capture objects reset the interval; identical repeat execution
  // keeps its original age. A pre-existing proposal writer has unknown origin.
  for (const kind of ['movements', 'proposals'] as const) {
    await db.query(`INSERT INTO ${s}.${COVERAGE_TABLE}
      (kind, from_beginning, protocol, capture_signature)
      SELECT $1, $2 AND NOT EXISTS (SELECT 1 FROM ${s}.${PROPOSAL_TABLE}),
        $3, ${captureSignatureSql(schema, kind)}
      ON CONFLICT (kind) DO UPDATE SET origin = gen_random_uuid(),
        from_at = clock_timestamp(), from_beginning = false,
        protocol = EXCLUDED.protocol, capture_signature = EXCLUDED.capture_signature
      WHERE ${s}.${COVERAGE_TABLE}.capture_signature IS DISTINCT FROM EXCLUDED.capture_signature
        OR ${s}.${COVERAGE_TABLE}.protocol IS DISTINCT FROM EXCLUDED.protocol`,
    [kind, kind === 'proposals' && bornHere, PROPOSER_PROTOCOL])
  }
}
