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
import { FOLD_LETTERS, FOLD_MARK_RANGES, FOLD_WHITESPACE } from '../search/spotlight/fold.js'
import {
  SPOTLIGHT_FOLD_FN,
  SPOTLIGHT_SCHEMA_SHA256,
  SPOTLIGHT_TABLES,
  SPOTLIGHT_TECH_FN,
  SPOTLIGHT_TECH_FUNCTION_SQL,
  spotlightFoldFunctionSql,
  spotlightLedgerName,
  spotlightSchemaFingerprint,
  spotlightSchemaFingerprintSource,
} from './spotlightSql.js'

const hex = (n: number) => n.toString(16).padStart(4, '0')

describe('Spotlight schema fingerprint', () => {
  it('is pinned: the stored spot_* values were computed by exactly this schema', () => {
    // If this fails, you changed what the STORED columns are computed from: the
    // fold tables, the fold or technology SQL, a column expression or an index.
    // Existing databases still hold values computed by the OLD definitions, and
    // `ADD COLUMN IF NOT EXISTS` would never recompute them. Do not just re-pin:
    //   1. rename the functions to the next _vN (SPOTLIGHT_FOLD_FN / SPOTLIGHT_TECH_FN);
    //   2. add a numbered migration (server/src/db/schemaMigrations.ts) that drops
    //      the spot_* columns and the old ledger row (`spotlight:%`), so
    //      ensureSpotlightSchema rebuilds them under the new functions;
    //   3. then re-pin. Until 2 ships, a database recorded under the old
    //      fingerprint is left untouched and /api/model/spotlight answers 503.
    expect(spotlightSchemaFingerprint('icu')).toBe(SPOTLIGHT_SCHEMA_SHA256)
    expect(SPOTLIGHT_FOLD_FN).toMatch(/_v\d+$/)
    expect(SPOTLIGHT_TECH_FN).toMatch(/_v\d+$/)
  })

  it('covers every definition the stored values come from', () => {
    const source = spotlightSchemaFingerprintSource('icu')
    expect(source).toContain(spotlightFoldFunctionSql('icu'))
    expect(source).toContain(SPOTLIGHT_TECH_FUNCTION_SQL)
    for (const t of SPOTLIGHT_TABLES) {
      expect(source).toContain(`spot_name TEXT GENERATED ALWAYS AS (${t.name}) STORED`)
      if (t.text) expect(source).toContain(`spot_text TEXT GENERATED ALWAYS AS (${t.text}) STORED`)
      expect(source).toContain(`ON ${t.table} USING gin`)
    }
  })

  it('records which lowercasing a database was built with', () => {
    expect(spotlightSchemaFingerprint('icu')).not.toBe(spotlightSchemaFingerprint('ctype'))
    expect(spotlightLedgerName('icu')).toBe(`spotlight:icu:${SPOTLIGHT_SCHEMA_SHA256}`)
    expect(spotlightLedgerName('ctype')).toMatch(/^spotlight:ctype:[0-9a-f]{64}$/)
  })
})

describe('ms_spotlight_fold SQL', () => {
  it('is generated from the shared fold tables, every entry of them', () => {
    const sql = spotlightFoldFunctionSql('icu')
    for (const [from, to] of FOLD_MARK_RANGES) expect(sql).toContain(`\\u${hex(from)}-\\u${hex(to)}`)
    for (const code of FOLD_WHITESPACE) expect(sql).toContain(`\\u${hex(code)}`)
    for (const [letter, folded] of Object.entries(FOLD_LETTERS)) {
      expect(sql).toContain(letter)
      if (folded.length > 1) expect(sql).toContain(`'${folded}'`)
    }
    expect(sql).toContain('normalize(t, NFKD)')
    expect(sql).toMatch(/IMMUTABLE/)
  })

  it('lowercases through ICU when it can, not through the database ctype', () => {
    // Under LC_CTYPE C, lower() folds ASCII only (embedded dev clusters).
    expect(spotlightFoldFunctionSql('icu')).toContain('COLLATE "und-x-icu")')
    expect(spotlightFoldFunctionSql('ctype')).not.toContain('COLLATE')
    // Marks come off BEFORE lowercasing, letter folds AFTER, as in the JS.
    const sql = spotlightFoldFunctionSql('icu')
    expect(sql.indexOf('normalize(')).toBeGreaterThan(sql.indexOf('lower('))
    expect(sql.indexOf('translate(')).toBeLessThan(sql.indexOf('lower('))
  })

  it('stores names only for diagrams and flows: the read model has no description for them', () => {
    expect(SPOTLIGHT_TABLES.find((t) => t.table === 'ro_diagram_summaries')!.text).toBeNull()
    expect(SPOTLIGHT_TABLES.find((t) => t.table === 'ro_flows')!.text).toBeNull()
  })
})
