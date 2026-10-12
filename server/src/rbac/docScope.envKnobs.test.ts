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

// The relation between two `docScope` deadlines, and the values of the knobs
// themselves.
//
// `docScope.ts` claims the relation in a comment ("Must stay below the
// whole-walk deadline so one unreachable document fails alone instead of
// consuming the entire budget"); this file is the detector that comment cites.
import { describe, it, expect } from 'vitest'
import {
  STALE_REPAIR_DEADLINE_MS,
  WALK_FIND_TIMEOUT_MS,
  STALE_REPAIR_MIN_INTERVAL_MS,
  WORKSPACE_KEY_SETS_DEADLINE_MS,
} from './docScope.js'

describe('docScope timing knobs', () => {
  it('keeps the per-document deadline BELOW the whole-walk deadline', () => {
    // The relation the comment claims. It catches an INVERSION — someone raising
    // the find timeout past the walk budget — which is the edit that turns "one
    // unreachable document fails alone" into "one unreachable document consumes
    // the entire walk".
    expect(WALK_FIND_TIMEOUT_MS).toBeLessThan(STALE_REPAIR_DEADLINE_MS)
  })

  it('pins each default with a LITERAL, because the relation alone constrains neither', () => {
    // `A < B` between two constants holds for (1, 2) and for (1, 6_000_000)
    // alike, so it constrains neither value. The relation above stays (it
    // catches an inversion) AND the values are pinned with literals.
    expect(STALE_REPAIR_DEADLINE_MS).toBe(15_000)
    expect(WALK_FIND_TIMEOUT_MS).toBe(10_000)
    expect(STALE_REPAIR_MIN_INTERVAL_MS).toBe(5_000)
    expect(WORKSPACE_KEY_SETS_DEADLINE_MS).toBe(5_000)
  })

  // Parsing of blank or garbage env values is not tested here: these are
  // module-level consts read at import, so nothing in this file can vary them.
  // `envNumber.test.ts` covers that axis through an injected env, and its source
  // scanner proves these four sites call the helper at all.
})
