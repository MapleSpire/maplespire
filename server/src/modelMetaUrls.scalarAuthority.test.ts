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
 * G4-16f — consumer suites of the ModelMeta URL writers, run a SECOND
 * time over SCALAR-ruled ModelMetas, inside the ordinary server run (no second
 * vitest invocation, so `ci:local` and `ci.yml` need no new step).
 *
 * WHAT CHANGED WITH THE EPOCHS. The first
 * version of this file set `AM_META_URL_SCALAR=on`, and every server writer
 * then cut its ModelMeta over IN PLACE on its first write. That path is gone:
 * a scalar-ruled ModelMeta is
 * BORN so, by an epoch roll. So the rerun now sets a test-only flag
 * (`testing/scalarRerun.ts`) that the suites' FIXTURES read to build their
 * ModelMeta scalar-ruled, as an epoch meta is; the code under test reads
 * nothing.
 *
 * Re-run here: the two suites whose fixtures build their ModelMeta through a
 * helper that honours the flag, plus `gc.test.ts` and
 * `workspaceFsck.test.ts` (read-only consumers; their scalar cases are
 * explicit tests). NOT re-run any more: `overlaySegments.test.ts` and
 * `readModel/compaction.test.ts`, whose second run relied on the in-place
 * cut-over by the writer itself — their writers on a scalar-ruled ModelMeta
 * are exercised end to end on a real epoch meta instead
 * (`readModel/modelEpochStep.integration.test.ts`: the rotator after a roll;
 * `readModel/modelEpochForwarder.integration.test.ts`: compaction and
 * rotation on the epoch-1 meta).
 */
import { afterAll, expect, it } from 'vitest'
import { scalarRerun, setScalarRerun } from './testing/scalarRerun.js'

setScalarRerun(true)
afterAll(() => { setScalarRerun(false) })

it('the scalar rerun flag is on for the suites below', () => {
  expect(scalarRerun()).toBe(true)
})

await import('./overlaySegments.history.test.js')
await import('./readModel/staticDeltaProjector.test.js')
await import('./gc.test.js')
await import('./maintenance/workspaceFsck.test.js')
