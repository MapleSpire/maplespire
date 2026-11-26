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

import { beforeEach, describe, expect, it } from 'vitest'
import { ABSENCE_STUCK_AFTER_MS, absenceProofMetricSamples, noteAbsenceProof, resetAbsenceProofForTest, staleGraceMs } from './health.js'

describe('noteAbsenceProof (T-SUM-2c: a refused proof says what it waits on)', () => {
  const key = { landscapeId: 'l', versionId: 'v' }
  const refused = (fallback: number, sample: string[]) => ({
    caughtUp: true, absenceProvable: false, arrivalRefusals: { zero: 0, exact: 0, fallback, sample },
  })
  const counter = (name: string, branch?: string) => absenceProofMetricSamples()
    .find((metric) => metric.name === name)!.values
    .find((value) => branch === undefined || value.labels?.branch === branch)!.value
  beforeEach(() => resetAbsenceProofForTest())

  it('counts a caught-up refusal by branch, and nothing for a provable or a not-caught-up answer', () => {
    noteAbsenceProof(key, refused(1, ['m:fallback:9']), 0, () => {})
    noteAbsenceProof(key, { caughtUp: true, absenceProvable: true, arrivalRefusals: { zero: 0, exact: 0, fallback: 0, sample: [] } }, 1, () => {})
    noteAbsenceProof(key, { caughtUp: false, absenceProvable: false, arrivalRefusals: { zero: 0, exact: 2, fallback: 0, sample: ['s:exact:3'] } }, 2, () => {})
    expect(counter('maplespire_read_model_absence_unprovable_total', 'fallback')).toBe(1)
    expect(counter('maplespire_read_model_absence_unprovable_total', 'exact')).toBe(0)
    expect(counter('maplespire_read_model_absence_unprovable_total', 'zero')).toBe(0)
  })

  it('logs ONCE, naming the documents, when the same refusal is still answered after the threshold', () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    noteAbsenceProof(key, refused(1, ['m:fallback:9']), 1_000, log)
    noteAbsenceProof(key, refused(1, ['m:fallback:9']), 1_000 + ABSENCE_STUCK_AFTER_MS - 1, log)
    expect(lines).toEqual([])
    noteAbsenceProof(key, refused(1, ['m:fallback:9']), 1_000 + ABSENCE_STUCK_AFTER_MS, log)
    noteAbsenceProof(key, refused(1, ['m:fallback:9']), 1_000 + 2 * ABSENCE_STUCK_AFTER_MS, log)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({
      event: 'read_model.absence_unprovable_stuck', workspace: 'l/v', sinceMs: ABSENCE_STUCK_AFTER_MS,
      refused: { zero: 0, exact: 0, fallback: 1 }, documents: ['m:fallback:9'],
    })
    expect(counter('maplespire_read_model_absence_unprovable_stuck_total')).toBe(1)
  })

  it('a refusal that CHANGES (a new arrival) or a provable answer starts the clock again', () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    noteAbsenceProof(key, refused(1, ['m:fallback:9']), 0, log)
    noteAbsenceProof(key, refused(1, ['m:fallback:10']), ABSENCE_STUCK_AFTER_MS, log)
    expect(lines).toEqual([])
    noteAbsenceProof(key, { caughtUp: true, absenceProvable: true }, ABSENCE_STUCK_AFTER_MS + 1, log)
    noteAbsenceProof(key, refused(1, ['m:fallback:10']), 2 * ABSENCE_STUCK_AFTER_MS, log)
    expect(lines).toEqual([])
    noteAbsenceProof(key, refused(1, ['m:fallback:10']), 3 * ABSENCE_STUCK_AFTER_MS, log)
    expect(lines).toHaveLength(1)
  })
})

describe('staleGraceMs', () => {
  it('defaults when unset', () => {
    expect(staleGraceMs({})).toBe(60_000)
  })

  it('takes an explicit override', () => {
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '5000' })).toBe(5_000)
  })

  it('refuses zero, and everything that arrives as zero', () => {
    // `Number('') === 0`, so a dangling `VAR=` must not parse as zero. A zero
    // grace would not disable the detector — it would fire on every write that
    // lands between a projection and the next generation bump, and a detector
    // that cries wolf ends up muted.
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '' })).toBe(60_000)
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '   ' })).toBe(60_000)
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '0' })).toBe(60_000)
  })

  it('refuses negative and non-numeric values rather than propagating them into SQL', () => {
    // The value is interpolated into `now() - ($2 || ' milliseconds')::interval`.
    // A negative grace would move the threshold into the future and report every
    // workspace stale; a non-numeric one would make the query throw and take the
    // whole health endpoint down with it.
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: '-1' })).toBe(60_000)
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: 'soon' })).toBe(60_000)
    expect(staleGraceMs({ READ_MODEL_STALE_GRACE_MS: 'Infinity' })).toBe(60_000)
  })
})
