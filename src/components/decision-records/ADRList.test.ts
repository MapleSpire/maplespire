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
import type { DecisionRecord } from '../../types'
import { filterDecisionRecords, sortDecisionRecordsNewestFirst } from './adrFiltering'

function record(id: string, title: string, status: DecisionRecord['status']): DecisionRecord {
  return {
    id, number: Number(id.slice(1)), title, summary: `${title} summary`, status,
    author: 'Platform', createdAt: '2026-01-01', updatedAt: '2026-01-01', content: '', related: [],
  }
}

describe('ADRList filtering capability', () => {
  const records = [record('a1', 'Ledger', 'approved'), record('a2', 'Gateway', 'rejected')]

  it('preserves query and status filtering for the legacy non-static route', () => {
    expect(filterDecisionRecords(records, 'ledger', 'approved', false).map((item) => item.id)).toEqual(['a1'])
    expect(filterDecisionRecords(records, '', 'rejected', false).map((item) => item.id)).toEqual(['a2'])
  })

  it('does not re-filter authoritative global server results', () => {
    expect(filterDecisionRecords(records, 'not-present-locally', 'rejected', true)).toEqual(records)
  })

  it('orders merged server and offline records by newest creation date first', () => {
    const sameDayA = { ...record('a1', 'Same day A', 'approved'), createdAt: '2026-02-02T12:00:00.000Z' }
    const older = { ...record('a2', 'Older', 'approved'), createdAt: '2025-12-31T23:59:59.000Z' }
    const newest = { ...record('a3', 'Newest', 'approved'), createdAt: '2026-07-30T08:30:00.000Z' }
    const sameDayZ = { ...record('z9', 'Same day Z', 'approved'), createdAt: sameDayA.createdAt }
    const legacy = { ...record('legacy', 'Legacy', 'approved'), createdAt: '' }

    expect(sortDecisionRecordsNewestFirst([sameDayA, legacy, older, newest, sameDayZ]).map((item) => item.id))
      .toEqual(['a3', 'z9', 'a1', 'a2', 'legacy'])
  })
})
