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

import { describe, it, expect } from 'vitest'
import {
  COMPACTION_ALLOWLIST_ENV,
  admitCompaction,
  parseCompactionAllowlist,
} from './compactionAllowlist.js'

/**
 * Which workspace `POST /api/model/compact` may compact. The compaction is
 * hard-wired to the default workspace, so without this gate a request naming
 * workspace B would compact workspace A's overlay and report it as B's.
 */

const DEFAULT = { landscapeId: 'default', versionId: 'v-current' }
const NAMED = { landscapeId: 'land-b', versionId: 'ver-7' }

describe('compaction allow-list (T-28e)', () => {
  it('is EMPTY by default, so an unset deployment cannot reach the path', () => {
    // The whole safety argument rests on this. `compactOverlay` rewrites base
    // shards in place; an allow-list that defaulted to anything would put that
    // path one HTTP call away on every deployment that upgrades.
    expect(parseCompactionAllowlist({}).size).toBe(0)
    expect(parseCompactionAllowlist({ [COMPACTION_ALLOWLIST_ENV]: '' }).size).toBe(0)
    expect(parseCompactionAllowlist({ [COMPACTION_ALLOWLIST_ENV]: '   ' }).size).toBe(0)
  })

  it('parses comma- and whitespace-separated entries', () => {
    const list = parseCompactionAllowlist({ [COMPACTION_ALLOWLIST_ENV]: 'a/1, b/2\nc/3\td/4' })
    expect([...list].sort()).toEqual(['a/1', 'b/2', 'c/3', 'd/4'])
  })

  it('DROPS a malformed entry rather than widening the list', () => {
    // `land-b` with no version cannot name a workspace. Treating it as a
    // landscape id would admit every version of it — more than was written.
    const list = parseCompactionAllowlist({
      [COMPACTION_ALLOWLIST_ENV]: 'land-b, ok/1, a/b/c, /2, 3/',
    })
    expect([...list]).toEqual(['ok/1'])
  })

  it('always admits the DEFAULT workspace', () => {
    // Requiring it to be listed would make an empty list mean "compaction is
    // off" — the scheduled daily pass would stop.
    expect(admitCompaction(DEFAULT, DEFAULT, parseCompactionAllowlist({})))
      .toEqual({ allowed: true, scope: 'default' })
  })

  it('REFUSES a named workspace that is not listed, and says which one', () => {
    // The operator must never be told about a workspace they did not name, so
    // the refusal carries the one they did.
    expect(admitCompaction(NAMED, DEFAULT, parseCompactionAllowlist({})))
      .toEqual({ allowed: false, reason: 'not_allowlisted', requested: 'land-b/ver-7' })
  })

  it('admits a named workspace once it is listed', () => {
    const list = parseCompactionAllowlist({ [COMPACTION_ALLOWLIST_ENV]: 'land-b/ver-7' })
    expect(admitCompaction(NAMED, DEFAULT, list)).toEqual({ allowed: true, scope: 'allowlisted' })
  })

  it('matches on the FULL key — a listed sibling version does not admit another', () => {
    // Without this, `land-b/ver-7` in the list would be satisfied by any request
    // whose landscape matched, which is the widening the malformed-entry rule
    // above exists to prevent, reached from the other side.
    const list = parseCompactionAllowlist({ [COMPACTION_ALLOWLIST_ENV]: 'land-b/ver-7' })
    expect(admitCompaction({ landscapeId: 'land-b', versionId: 'ver-8' }, DEFAULT, list))
      .toMatchObject({ allowed: false, requested: 'land-b/ver-8' })
    expect(admitCompaction({ landscapeId: 'land-c', versionId: 'ver-7' }, DEFAULT, list))
      .toMatchObject({ allowed: false, requested: 'land-c/ver-7' })
  })

  it('the DEFAULT check is on the key, not on the landscape alone', () => {
    // A second version of the default landscape is a different workspace with
    // its own overlay and its own base shards.
    expect(admitCompaction({ landscapeId: 'default', versionId: 'v-old' }, DEFAULT, parseCompactionAllowlist({})))
      .toMatchObject({ allowed: false, requested: 'default/v-old' })
  })
})
