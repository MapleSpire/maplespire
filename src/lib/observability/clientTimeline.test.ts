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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __setClientTimelineClockForTest,
  __setClientTimelineEnabledForTest,
  markClientTimeline,
  readClientTimeline,
  resetClientTimeline,
  startClientTimelineMeasure,
} from './clientTimeline'

let now = 0

beforeEach(() => {
  now = 0
  resetClientTimeline()
  __setClientTimelineEnabledForTest(true)
  __setClientTimelineClockForTest(() => now)
})
afterEach(() => {
  __setClientTimelineEnabledForTest(null)
  __setClientTimelineClockForTest(null)
})

describe('client performance timeline', () => {
  it('records marks and idempotent measures with aggregates', () => {
    markClientTimeline('diagram.open', { shapes: 500, omitted: undefined })
    const finish = startClientTimelineMeasure('diagram.render.http', { cache: 'hit' })
    now = 42.25
    finish({ status: 200 })
    finish({ failed: true })

    const snapshot = readClientTimeline()
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries[0]).toMatchObject({ name: 'diagram.open', kind: 'mark', details: { shapes: 500 } })
    expect(snapshot.entries[1]).toMatchObject({
      name: 'diagram.render.http', kind: 'measure', durationMs: 42.25,
      details: { cache: 'hit', status: 200 },
    })
    expect(snapshot.measures['diagram.render.http']).toMatchObject({
      calls: 1, failures: 0, averageDurationMs: 42.3, p95DurationMs: 42.3,
    })
  })

  it('keeps a bounded tail and reports dropped entries', () => {
    for (let index = 0; index < 510; index += 1) {
      now = index
      markClientTimeline('heartbeat', { index })
    }
    const snapshot = readClientTimeline()
    expect(snapshot.entries).toHaveLength(500)
    expect(snapshot.droppedEntries).toBe(10)
    expect(snapshot.entries[0].details.index).toBe(10)
    expect(snapshot.entries.at(-1)?.details.index).toBe(509)
  })

  it('records failed measures and resets all state', () => {
    const finish = startClientTimelineMeasure('diagram.doc')
    now = 5
    finish({ failed: true })
    expect(readClientTimeline().measures['diagram.doc'].failures).toBe(1)

    resetClientTimeline()
    expect(readClientTimeline()).toMatchObject({ droppedEntries: 0, entries: [], measures: {} })
  })

  it('is a no-op when diagnostics are disabled', () => {
    __setClientTimelineEnabledForTest(false)
    markClientTimeline('diagram.open')
    const finish = startClientTimelineMeasure('diagram.doc')
    now = 10
    finish()
    expect(readClientTimeline().entries).toEqual([])
  })
})
