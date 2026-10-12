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
import { presentForDisplay } from './changes.js'
import type { DiffResult, DraftChange } from './merge.js'
import type { FullModel } from './materialize.js'

function fm(p: Partial<FullModel> = {}): FullModel {
  return { objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {}, diagrams: {}, missing: [], ...p }
}
const mk = (changes: DraftChange[]): DiffResult => ({ changes, conflicts: [], counts: { model: 0, diagrams: 0, conflicts: 0 } })

describe('presentForDisplay', () => {
  it('drops a layout-created row implied by an object-created row, and recounts', () => {
    const diff = mk([
      { kind: 'created', collection: 'object', id: 'o1', label: 'New system' },
      { kind: 'created', collection: 'layout', id: 'o1', label: 'o1', diagramId: 'D' }, // redundant
    ])
    const theirs = fm({ objects: { o1: { id: 'o1', name: 'New system' } } })
    const r = presentForDisplay(diff, theirs, fm())
    expect(r.changes.map((c) => c.collection)).toEqual(['object']) // layout dropped
    expect(r.counts.model).toBe(1)
    expect(r.counts.diagrams).toBe(0)
  })

  it('keeps a layout MOVE and relabels it to the entity name', () => {
    const diff = mk([
      { kind: 'updated', collection: 'layout', id: 'o1', label: 'o1', diagramId: 'D' }, // a move
    ])
    const theirs = fm({ objects: { o1: { id: 'o1', name: 'Web App' } } })
    const r = presentForDisplay(diff, theirs, fm())
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0].label).toBe('Web App') // friendly, not the id
    expect(r.counts.diagrams).toBe(1)
  })

  it('relabels an unlabelled connection to its endpoint names', () => {
    const diff = mk([{ kind: 'created', collection: 'connection', id: 'c1', label: 'o1 → o2' }])
    const theirs = fm({
      objects: { o1: { id: 'o1', name: 'Web' }, o2: { id: 'o2', name: 'API' } },
      connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2' } },
    })
    const r = presentForDisplay(diff, theirs, fm())
    expect(r.changes[0].label).toBe('Web → API')
  })
})
