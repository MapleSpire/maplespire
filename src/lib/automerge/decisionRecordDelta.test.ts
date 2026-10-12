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
import {
  changedDecisionRecords,
  shouldProjectInlineDecisionRecords,
  usesDecisionRecordDelta,
} from './decisionRecordDelta'

const record = { id: 'adr-1', title: 'Baseline' } as DecisionRecord

describe('paged decision-record delta', () => {
  it('uses deltas for a relational static baseline even without ADR shard urls', () => {
    expect(usesDecisionRecordDelta({ staticBaseline: true, decisionRecordShardUrls: [] })).toBe(true)
    expect(usesDecisionRecordDelta({ staticBaseline: false, decisionRecordShardUrls: [] })).toBe(false)
  })

  it('does not replace a server page with the inline edit overlay of a slim static baseline', () => {
    expect(shouldProjectInlineDecisionRecords({
      staticBaseline: true,
      decisionRecordShardUrls: [],
      decisionRecords: { edited: record },
    })).toBe(false)
    expect(shouldProjectInlineDecisionRecords({
      staticBaseline: false,
      decisionRecordShardUrls: [],
      decisionRecords: { edited: record },
    })).toBe(true)
  })

  it('keeps hydrated pages read-only until a record reference changes', () => {
    const baseline = new Map([[record.id, record]])
    expect(changedDecisionRecords([record], baseline, new Set())).toEqual([])
    const edited = { ...record, title: 'Edited' }
    expect(changedDecisionRecords([edited], baseline, new Set())).toEqual([edited])
  })

  it('retains an existing overlay entry during later flushes', () => {
    const baseline = new Map([[record.id, record]])
    expect(changedDecisionRecords([record], baseline, new Set([record.id]))).toEqual([record])
  })

  it('does not rebaseline an edited first page when a second page hydrates', () => {
    const second = { id: 'adr-2', title: 'Second page' } as DecisionRecord
    const baseline = new Map([[record.id, record]])
    const edited = { ...record, title: 'Edited before load more' }
    baseline.set(second.id, second)
    expect(changedDecisionRecords([edited, second], baseline, new Set())).toEqual([edited])
  })
})
