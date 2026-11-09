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
import { renderPrometheus } from '../runtime/metrics.js'
import {
  countDocumentLoad,
  DOCUMENT_LOAD_CALLERS,
  DOCUMENT_LOAD_LOG_MS,
  DOCUMENT_LOAD_PHASES,
  documentLoadCount,
  documentLoadMetricSamples,
} from './documentLoadTelemetry.js'

describe('documentLoadTelemetry (G4-16 M3)', () => {
  it('counts by phase and caller, zero-fills every series, and renders as one counter', () => {
    const before = documentLoadCount('steady', 'folded-arrival')
    const other = documentLoadCount('attach', 'folded-arrival')
    countDocumentLoad('steady', 'folded-arrival')
    countDocumentLoad('steady', 'folded-arrival')
    expect(documentLoadCount('steady', 'folded-arrival')).toBe(before + 2)
    expect(documentLoadCount('attach', 'folded-arrival')).toBe(other)
    const [metric] = documentLoadMetricSamples()
    expect(metric!.name).toBe('maplespire_read_model_document_loads_total')
    expect(metric!.type).toBe('counter')
    expect(metric!.values).toHaveLength(DOCUMENT_LOAD_PHASES.length * DOCUMENT_LOAD_CALLERS.length)
    expect(metric!.values.find((v) => v.labels?.phase === 'steady' && v.labels?.caller === 'folded-arrival')?.value)
      .toBe(before + 2)
    expect(renderPrometheus([metric!]))
      .toContain(`maplespire_read_model_document_loads_total{phase="steady",caller="folded-arrival"} ${before + 2}`)
    expect(DOCUMENT_LOAD_LOG_MS).toBe(20)
  })
})
