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
  hasIntegrityToStamp,
  kindsChangedWithoutStamp,
  readModelDefectMetricSamples,
  withRecordedDeltas,
} from './projectionIntegrity.js'
import { IdSetDeltaRecorder, xorDelta } from './contentDigest.js'

// The /metrics wiring of the defect split: which total goes under which name
// and scope. Every input below is a DISTINCT prime, so a total sent under the
// wrong name or scope (documents vs ids, the two workspace counts swapped,
// the live counter in place of a gauge) cannot read as correct.
describe('readModelDefectMetricSamples', () => {
  const samples = readModelDefectMetricSamples({
    totalDefects: 2,
    workspacesWithDefects: 3,
    totalDuplicateIds: 5,
    workspacesWithDuplicateIds: 7,
    workspacesNeverExamined: 11,
  }, 13)
  const byName = new Map(samples.map((sample) => [sample.name, sample]))

  it('sends each total under its own name and scope', () => {
    expect(samples.map((sample) => [sample.name, sample.type, sample.values])).toEqual([
      ['maplespire_read_model_unreadable_documents', 'gauge', [
        { labels: { scope: 'documents' }, value: 2 },
        { labels: { scope: 'workspaces' }, value: 3 },
      ]],
      ['maplespire_read_model_duplicate_ids', 'gauge', [
        { labels: { scope: 'ids' }, value: 5 },
        { labels: { scope: 'workspaces' }, value: 7 },
      ]],
      ['maplespire_read_model_live_duplicate_ids_dropped_total', 'counter', [{ value: 13 }]],
      ['maplespire_read_model_workspaces_never_examined', 'gauge', [{ value: 11 }]],
    ])
  })

  it('says in the unreadable gauge that duplicates are not in it', () => {
    expect(byName.get('maplespire_read_model_unreadable_documents')?.help)
      .toContain('maplespire_read_model_duplicate_ids')
  })
})

// G4-16f C6a: what a projection that writes rows WITHOUT a stamp (the
// runner's no-health-span path) must un-seal.
describe('kindsChangedWithoutStamp', () => {
  it('is every kind when nothing was declared', () => {
    expect(kindsChangedWithoutStamp(undefined, []).sort()).toEqual(['connection', 'diagram', 'group', 'object'])
  })
  it('spares only the kinds declared unchanged — maintained and re-sealed ones included', () => {
    expect(kindsChangedWithoutStamp(
      { unchanged: ['connection', 'group', 'diagram'], maintained: ['object'], digests: {} }, [],
    )).toEqual(['object'])
  })
  it('un-seals a kind a writer recorded on, even when it was declared unchanged', () => {
    expect(kindsChangedWithoutStamp({ unchanged: ['object', 'connection', 'group', 'diagram'] }, ['connection']))
      .toEqual(['connection'])
  })
})

describe('withRecordedDeltas / hasIntegrityToStamp', () => {
  it('attaches the recorder\'s deltas and keeps undefined undefined', () => {
    const recorder = new IdSetDeltaRecorder()
    recorder.record('object', ['a'], [])
    expect(withRecordedDeltas(undefined, recorder)).toBeUndefined()
    expect(withRecordedDeltas({ maintained: ['object'] }, recorder)?.deltas).toEqual({ object: xorDelta(['a'], []) })
  })
  it('stamps a projection that only declares `maintained`', () => {
    expect(hasIntegrityToStamp({ maintained: ['object'] })).toBe(true)
    expect(hasIntegrityToStamp({})).toBe(false)
  })
})
