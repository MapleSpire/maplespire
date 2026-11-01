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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSpotlightQuery } from './grammar'
import { prepareSpotlightDoc, rankSpotlight } from './evaluate'
import { parseSpotlightQuery as serverParse } from '../../../../server/src/search/spotlight/grammar.js'
import { prepareSpotlightDoc as serverPrepare, rankSpotlight as serverRank } from '../../../../server/src/search/spotlight/evaluate.js'
import { mergeSpotlightTiers } from './merge'
import { mergeSpotlightTiers as serverMerge } from '../../../../server/src/search/spotlight/merge.js'

/**
 * The Spotlight core exists twice: here (the ruling copy) and in
 * `server/src/search/spotlight/` (the server's mirror), because neither side can
 * import the other's at runtime (`fold.ts` says why). Two copies that "must
 * match" drift the day someone edits one; this test is what notices.
 *
 * It lives on the ROOT side on purpose: `tsconfig.app.json` includes `src`, so
 * `npm run build` typechecks the mirror under the app's stricter flags too,
 * through the imports above. Fix a failure with `node scripts/sync-spotlight-core.mjs`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const mirror = join(here, '..', '..', '..', '..', 'server', 'src', 'search', 'spotlight')
const isCore = (name: string) => name.endsWith('.ts') && !name.endsWith('.test.ts')

describe('Spotlight core: server mirror', () => {
  const core = readdirSync(here).filter(isCore).sort()

  it('finds the core files it guards', () => {
    expect(core).toEqual(['evaluate.ts', 'fold.ts', 'grammar.ts', 'merge.ts', 'wire.ts'])
  })

  it('mirrors every core file byte for byte, and nothing else', () => {
    expect(readdirSync(mirror).filter((n) => n.endsWith('.ts')).sort()).toEqual(core)
    for (const name of core) {
      const ruling = readFileSync(join(here, name))
      const copy = readFileSync(join(mirror, name))
      expect(copy.equals(ruling), `${name} differs; run node scripts/sync-spotlight-core.mjs`).toBe(true)
    }
  })

  it('ranks identically through both copies', () => {
    const docs = [
      { kind: 'system' as const, id: '1', name: 'Énergie', tech: ['Postgres'] },
      { kind: 'app' as const, id: '2', name: 'Energy API', description: 'Serves énergie data' },
      { kind: 'connection' as const, id: '3', name: 'Reads', from: 'Energy API', to: 'Énergie' },
    ]
    for (const q of ['energie', 'tech:post OR from:energy', 'en -kind:app', 'kind:object']) {
      const app = rankSpotlight(parseSpotlightQuery(q), docs.map((d) => prepareSpotlightDoc(d)), 10)
      const server = serverRank(serverParse(q), docs.map((d) => serverPrepare(d)), 10)
      expect(server, q).toEqual(app)
    }
  })

  it('merges tiers identically through both copies', () => {
    const resident = [{ kind: 'app' as const, id: '2', name: 'Energy API' }]
    const server = {
      sections: [{ kind: 'system' as const, total: 3, totalCapped: true, hits: [{ score: 12, doc: { kind: 'system' as const, id: '1', name: 'Énergie', extra: {} } }] }],
      coverage: { unavailableKinds: ['adr' as const], fieldGaps: { diagram: ['desc' as const] } },
    }
    for (const q of ['energ', 'in:"Checkout" energy', 'desc:energy', 'energy -in:x']) {
      const app = mergeSpotlightTiers(parseSpotlightQuery(q), {
        result: rankSpotlight(parseSpotlightQuery(q), resident.map((d) => prepareSpotlightDoc(d)), 5),
        doc: () => undefined,
        deleted: () => false,
      }, server, 5)
      const copy = serverMerge(serverParse(q), {
        result: serverRank(serverParse(q), resident.map((d) => serverPrepare(d)), 5),
        doc: () => undefined,
        deleted: () => false,
      }, server, 5)
      expect(copy, q).toEqual(app)
    }
  })
})
