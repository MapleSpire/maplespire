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
import {
  deepSearchAdrIndex,
  loadAdrCreatedAt,
  loadAdrId,
  planReadModelLoadSeed,
} from '../../scripts/read-model-load-plan.js'

describe('read-model adversarial load plan', () => {
  it('keeps nominal cardinalities exact and discloses the mathematical 100k hub limit', () => {
    const plan = planReadModelLoadSeed({
      objectCount: 100_000,
      connectionCount: 300_000,
      decisionRecordCount: 100_000,
    })

    expect(plan.denseDiagram).toMatchObject({ first: 1, count: 20_000, objectCount: 500 })
    expect(plan.dependencyHubs.map((hub) => ({
      first: hub.first,
      requested: hub.requestedPeers,
      actual: hub.peerCount,
    }))).toEqual([
      { first: 20_001, requested: 1_000, actual: 1_000 },
      { first: 21_001, requested: 10_000, actual: 10_000 },
      { first: 31_001, requested: 100_000, actual: 99_999 },
    ])
    expect(plan.baselineConnections).toEqual({ first: 131_000, count: 169_001 })
    expect(plan.decisionRecordCount).toBe(100_000)
    expect(plan.limitations).toEqual([
      expect.stringContaining('100,000 limited to 99,999 peers'),
    ])
  })

  it('caps every fixture rather than exceeding a deliberately small scale', () => {
    const plan = planReadModelLoadSeed({ objectCount: 20, connectionCount: 25_100, decisionRecordCount: 37 })

    expect(plan.denseDiagram).toMatchObject({ objectCount: 20, count: 20_000 })
    expect(plan.dependencyHubs.map((hub) => hub.peerCount)).toEqual([19, 19, 19])
    expect(plan.baselineConnections.count).toBe(5_043)
    expect(plan.decisionRecordCount).toBe(37)
    expect(plan.limitations).toHaveLength(4)
    expect(plan.denseDiagram.count
      + plan.dependencyHubs.reduce((total, hub) => total + hub.count, 0)
      + plan.baselineConnections.count).toBe(25_100)
  })

  it('provides deterministic ADR ids, timestamps and a non-edge deep-search target', () => {
    expect(loadAdrId(73_100)).toBe('adr-load-073100')
    expect(loadAdrCreatedAt(1)).toBe('2020-01-01T00:00:01.000Z')
    expect(deepSearchAdrIndex(100_000)).toBe(73_100)
    expect(deepSearchAdrIndex(1)).toBe(1)
  })

  it('rejects a scale that cannot represent three distinct hub foci', () => {
    expect(() => planReadModelLoadSeed({ objectCount: 3, connectionCount: 100 })).toThrow(/at least 4/)
  })
})
