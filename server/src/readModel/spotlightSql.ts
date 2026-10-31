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
 * Spotlight search: the SQL half of accent folding, and the stored, folded
 * columns (`spot_name`, `spot_text`) candidates are found by.
 *
 * `ms_spotlight_fold_v1` is GENERATED from the shared core's tables
 * (`../search/spotlight/fold.ts`: FOLD_MARK_RANGES, FOLD_LETTERS,
 * FOLD_WHITESPACE), so SQL and JS agree on which marks, letters and spaces fold.
 * NFKD and lowercasing are Postgres's own, so they are PROBED, not assumed
 * (`spotlightReadiness`): the route refuses to answer (503) on a database where
 * the SQL fold and the JS fold disagree, rather than return a silently short
 * list.
 *
 * Lowercasing goes through the ICU root collation when the server has one. A
 * plain `lower()` follows the DATABASE's LC_CTYPE, and under `C` (this repo's
 * embedded dev clusters, `server/scripts/embedded-db.mjs`) it lowercases ASCII
 * only, which would store "Łodz" and "МОСКВА" unfolded. ICU applies the final
 * sigma rule; the fold maps ς to σ so that cannot matter.
 *
 * The SQL only has to FIND candidates: stage 2 (`spotlight.ts`) ranks them with
 * the same JS evaluator the browser runs.
 *
 * THE STORED VALUES DEPEND ON THIS FILE. Every definition they are computed from
 * (fold function, technology helper, column expressions, indexes) goes into one
 * fingerprint, pinned in `spotlightSql.test.ts`, and the fingerprint a database
 * was built with is recorded in it (`read_model_schema_migrations`, name
 * `spotlight:<case>:<sha256>`). A database recorded under another fingerprint
 * is never altered in place — `CREATE OR REPLACE` would leave every stored
 * value computed by the old body — and the route answers 503 until a numbered
 * migration rebuilds the `spot_*` columns under the renamed (`_v2`) function.
 */

import { createHash } from 'node:crypto'
import { FOLD_LETTERS, FOLD_MARK_RANGES, FOLD_WHITESPACE, fold } from '../search/spotlight/fold.js'
import type { Queryable } from './types.js'

export const SPOTLIGHT_FOLD_FN = 'ms_spotlight_fold_v1'
export const SPOTLIGHT_TECH_FN = 'ms_spotlight_tech_names_v1'

/** How the fold lowercases: ICU root collation, or the database's own ctype. */
export type SpotlightCaseMode = 'icu' | 'ctype'

/** sha256 of `spotlightSchemaFingerprintSource('icu')`. Change it only with a
 *  version rename and the migration that rebuilds the stored columns. */
export const SPOTLIGHT_SCHEMA_SHA256 = 'a06dabacf7270e061c3f7cb511f2ab771159a022505a035a8a35c5e8c89ee119'

/** A Postgres ARE escape for one BMP code point, as regex source text. */
function areEscape(code: number): string {
  return '\\u' + code.toString(16).padStart(4, '0')
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The fold, in SQL, in the JS order: NFKD, drop diacritic marks, lowercase,
 * map the letters NFKD keeps whole, collapse whitespace, trim.
 */
export function spotlightFoldFunctionSql(caseMode: SpotlightCaseMode): string {
  const marks = `[${FOLD_MARK_RANGES.map(([from, to]) => `${areEscape(from)}-${areEscape(to)}`).join('')}]`
  const spaces = `[${FOLD_WHITESPACE.map(areEscape).join('')}]+`
  const stripped = `regexp_replace(normalize(t, NFKD), ${sqlLiteral(marks)}, '', 'g')`
  let expr = caseMode === 'icu' ? `lower(${stripped} COLLATE "und-x-icu")` : `lower(${stripped})`
  const singlesFrom: string[] = []
  const singlesTo: string[] = []
  for (const [from, to] of Object.entries(FOLD_LETTERS)) {
    if (to.length === 1) { singlesFrom.push(from); singlesTo.push(to) }
    else expr = `replace(${expr}, ${sqlLiteral(from)}, ${sqlLiteral(to)})`
  }
  expr = `translate(${expr}, ${sqlLiteral(singlesFrom.join(''))}, ${sqlLiteral(singlesTo.join(''))})`
  expr = `btrim(regexp_replace(${expr}, ${sqlLiteral(spaces)}, ' ', 'g'), ' ')`
  return `CREATE OR REPLACE FUNCTION ${SPOTLIGHT_FOLD_FN}(t text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $fold$ SELECT ${expr} $fold$`
}

/** Every technology usage's snapshot name in an entity's JSON, space-joined.
 *  Immutable (a function of its argument), so a stored column can use it. */
export const SPOTLIGHT_TECH_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${SPOTLIGHT_TECH_FN}(j jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $tech$ SELECT COALESCE(string_agg(u.value->'snapshot'->>'name', ' '), '')
      FROM jsonb_each(CASE WHEN jsonb_typeof(j->'technologyUsages') = 'object'
                           THEN j->'technologyUsages' ELSE '{}'::jsonb END) u $tech$`

// ── the stored, folded columns ──────────────────────────────────────────────
// STORED generated columns, not expression indexes: with expression indexes
// Postgres re-ran the fold on every recheck and every sort key (measured with
// server/scripts/spotlight-measure.ts). Stored, the fold runs once
// per write, for every writer — the read model's choice for `normalized_name`
// and `search_document` too.

const foldOf = (sql: string) => `${SPOTLIGHT_FOLD_FN}(${sql})`

interface SpotTable {
  readonly table: string
  readonly id: string
  /** Folded title. */
  readonly name: string
  /** Folded "everything an unscoped term can match": a superset per term
   *  (a match across two fields is refused by stage 2). Null: name only. */
  readonly text: string | null
}

/** Diagram descriptions and flow domains are NOT here: the read model holds
 *  the registry's DiagramMeta stub (bridge.ts `buildMeta`), which has neither. */
export const SPOTLIGHT_TABLES: readonly SpotTable[] = [
  {
    table: 'ro_objects', id: 'id', name: foldOf('name'),
    text: foldOf(`name || ' ' || COALESCE(data->>'shortDescription', '') || ' ' || description || ' ' || ${SPOTLIGHT_TECH_FN}(data)`),
  },
  { table: 'ro_groups', id: 'id', name: foldOf('name'), text: foldOf(`name || ' ' || ${SPOTLIGHT_TECH_FN}(data)`) },
  {
    table: 'ro_connections', id: 'id', name: foldOf('label'),
    text: foldOf(`label || ' ' || COALESCE(data->>'description', '') || ' ' || ${SPOTLIGHT_TECH_FN}(data)`),
  },
  { table: 'ro_diagram_summaries', id: 'diagram_id', name: foldOf('name'), text: null },
  { table: 'ro_flows', id: 'flow_id', name: foldOf('name'), text: null },
  {
    table: 'ro_decision_records', id: 'id', name: foldOf('title'),
    text: foldOf(`title || ' ' || COALESCE(data->>'summary', '') || ' ' || COALESCE(data->>'content', '')`),
  },
]

const TRGM = 'public.gin_trgm_ops'

function columnDdl(t: SpotTable): string[] {
  return [
    `spot_name TEXT GENERATED ALWAYS AS (${t.name}) STORED`,
    ...(t.text ? [`spot_text TEXT GENERATED ALWAYS AS (${t.text}) STORED`] : []),
  ]
}

function indexDdl(t: SpotTable): string[] {
  const searchable = t.text ? 'spot_text' : 'spot_name'
  return [
    `CREATE INDEX IF NOT EXISTS idx_${t.table}_spot_trgm ON ${t.table} USING gin (${searchable} ${TRGM})`,
    `CREATE INDEX IF NOT EXISTS idx_${t.table}_spot_name_c
        ON ${t.table} (landscape_id, version_id, spot_name COLLATE "C", ${t.id} COLLATE "C")`,
  ]
}

/** Everything the stored values and their indexes are computed from. */
export function spotlightSchemaFingerprintSource(caseMode: SpotlightCaseMode): string {
  return [
    spotlightFoldFunctionSql(caseMode),
    SPOTLIGHT_TECH_FUNCTION_SQL,
    ...SPOTLIGHT_TABLES.flatMap((t) => [t.table, ...columnDdl(t), ...indexDdl(t)]),
  ].join('\n')
}

export function spotlightSchemaFingerprint(caseMode: SpotlightCaseMode): string {
  return createHash('sha256').update(spotlightSchemaFingerprintSource(caseMode)).digest('hex')
}

/** The ledger row a database built by this code carries. */
export function spotlightLedgerName(caseMode: SpotlightCaseMode): string {
  return `spotlight:${caseMode}:${spotlightSchemaFingerprint(caseMode)}`
}

interface Environment {
  readonly utf8: boolean
  readonly caseMode: SpotlightCaseMode
}

async function environment(db: Queryable): Promise<Environment> {
  const { rows } = await db.query<{ encoding: string; icu: boolean }>(
    `SELECT current_setting('server_encoding') AS encoding,
            EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu') AS icu`,
  )
  return {
    utf8: String(rows[0]?.encoding ?? '').toUpperCase() === 'UTF8',
    caseMode: rows[0]?.icu ? 'icu' : 'ctype',
  }
}

async function recordedLedgerNames(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM read_model_schema_migrations WHERE name LIKE 'spotlight:%' ORDER BY name`,
  )
  return rows.map((r) => r.name)
}

async function hasColumn(db: Queryable, table: string, column: string): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2) AS present`,
    [table, column],
  )
  return rows[0]?.present === true
}

/**
 * Create the fold functions, the folded columns and their indexes, once.
 * Called by `ensureReadModelSchema` (every boot) after the tables and the
 * ledger exist. On a database already built with THIS fingerprint it takes no
 * ACCESS EXCLUSIVE lock: each ALTER runs only when its column is missing. On a
 * database built with another fingerprint it changes nothing and says so.
 */
export async function ensureSpotlightSchema(db: Queryable): Promise<void> {
  const env = await environment(db)
  if (!env.utf8) {
    console.warn('[spotlight] server_encoding is not UTF8: no Spotlight schema; /api/model/spotlight answers 503')
    return
  }
  const expected = spotlightLedgerName(env.caseMode)
  const recorded = await recordedLedgerNames(db)
  if (recorded.some((name) => name !== expected)) {
    console.error(`[spotlight] schema drift: database built as ${recorded.join(', ')}, this build is ${expected}. `
      + 'Left untouched; /api/model/spotlight answers 503 until a migration rebuilds the spot_* columns.')
    return
  }
  await db.query(spotlightFoldFunctionSql(env.caseMode))
  await db.query(SPOTLIGHT_TECH_FUNCTION_SQL)
  for (const t of SPOTLIGHT_TABLES) {
    const missing: string[] = []
    if (!(await hasColumn(db, t.table, 'spot_name'))) missing.push(columnDdl(t)[0])
    if (t.text && !(await hasColumn(db, t.table, 'spot_text'))) missing.push(columnDdl(t)[1])
    // ONE statement per table: each ADD COLUMN ... STORED rewrites the table.
    if (missing.length) await db.query(`ALTER TABLE ${t.table} ${missing.map((c) => `ADD COLUMN ${c}`).join(', ')}`)
    for (const ddl of indexDdl(t)) await db.query(ddl)
  }
  await db.query(`INSERT INTO read_model_schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [expected])
}

// ── readiness ───────────────────────────────────────────────────────────────

export type SpotlightReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: 'encoding' | 'not-built' | 'drift' | 'fold-mismatch'; readonly detail?: string }

/** Inputs the SQL and JS folds must agree on: every letter of Latin-1 and
 *  Latin Extended-A/B, the letter folds, Greek and Cyrillic in both cases with
 *  a final sigma, wide forms, ligatures and every folded space. */
export function spotlightFoldProbeCorpus(): string[] {
  const corpus: string[] = []
  let latin = ''
  for (let c = 0x00c0; c <= 0x024f; c++) latin += String.fromCharCode(c)
  corpus.push(latin, latin.toLowerCase())
  corpus.push(
    'ΑΘΗΝΑ ΟΔΟΣ αθηνα',
    'МОСКВА москва ЁЖ',
    'ŁÓDŹ ÆØŒ ÞÐ ẞ',
    'ﬁ ＡＰＩ İstanbul Café',
    ` a${FOLD_WHITESPACE.map((c) => String.fromCharCode(c)).join('b')}c `,
  )
  return corpus
}

/**
 * Whether this database can answer Spotlight correctly: UTF8, built with this
 * build's fingerprint, and its SQL fold equal to the JS fold on the probe
 * corpus. Read-only, so a runtime role without DDL rights can run it.
 */
export async function spotlightReadiness(db: Queryable): Promise<SpotlightReadiness> {
  const env = await environment(db)
  if (!env.utf8) return { ready: false, reason: 'encoding' }
  const expected = spotlightLedgerName(env.caseMode)
  const recorded = await recordedLedgerNames(db)
  if (recorded.length === 0) return { ready: false, reason: 'not-built' }
  if (recorded.some((name) => name !== expected)) return { ready: false, reason: 'drift', detail: recorded.join(', ') }
  const corpus = spotlightFoldProbeCorpus()
  const { rows } = await db.query<{ i: number; folded: string }>(
    `SELECT i::int, ${SPOTLIGHT_FOLD_FN}(t) AS folded FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i)`,
    [corpus],
  )
  for (const r of rows) {
    const input = corpus[r.i - 1]
    if (r.folded !== fold(input)) {
      return { ready: false, reason: 'fold-mismatch', detail: `${JSON.stringify(input)}: sql=${JSON.stringify(r.folded)} js=${JSON.stringify(fold(input))}` }
    }
  }
  return { ready: true }
}
