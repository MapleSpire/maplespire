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

import * as A from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { holdsHeads } from './automergeHeads.js'
import { viewAt } from './modelEpochForward.js'

/**
 * G4-16f: the forward's cheap primitives
 * agree with Automerge's own — `holdsHeads` with `A.hasHeads`, `viewAt` with
 * `A.view` — on every case the forward meets.
 */
describe('holdsHeads (mutants HH1, HH2)', () => {
  const base = A.from<{ n: number }>({ n: 0 })
  const one = A.change(A.clone(base), (d) => { d.n = 1 })
  const two = A.change(A.clone(one), (d) => { d.n = 2 })
  const elsewhere = A.change(A.clone(base, { actor: 'ab'.repeat(16) }), (d) => { d.n = 9 })

  it('agrees with A.hasHeads: present, an ancestor, absent, empty, mixed', () => {
    for (const [doc, heads] of [
      [two, A.getHeads(two)], [two, A.getHeads(one)], [one, A.getHeads(two)], [two, []],
      [two, [...A.getHeads(one), ...A.getHeads(elsewhere)]], [two, A.getHeads(elsewhere)],
    ] as const) {
      expect(holdsHeads(doc, heads)).toBe(A.hasHeads(doc, heads as A.Heads))
    }
  })

  it('a document with changes waiting for absent dependencies is asked the exact way', () => {
    // `two`'s last change applied without its parent: queued, a missing dependency.
    const lastChange = A.getChanges(one, two)
    const [partial] = A.applyChanges(A.clone(base), lastChange)
    expect(A.getMissingDeps(partial, []).length).toBeGreaterThan(0)
    expect(holdsHeads(partial, A.getHeads(base))).toBe(A.hasHeads(partial, A.getHeads(base)))
    expect(holdsHeads(partial, A.getHeads(two))).toBe(A.hasHeads(partial, A.getHeads(two)))
  })
})

describe('viewAt (memoized view)', () => {
  it('the document itself at its own heads, A.view otherwise — and the same view for the same heads', () => {
    let doc = A.from<{ n: number }>({ n: 0 })
    const at0 = A.getHeads(doc)
    doc = A.change(doc, (d) => { d.n = 1 })
    expect(viewAt(doc, A.getHeads(doc))).toBe(doc)
    const old = viewAt(doc, at0)
    expect(old.n).toBe(0)
    expect(viewAt(doc, at0)).toBe(old)
    expect(viewAt(doc, at0).n).toBe(A.view(doc, at0).n)
  })
})
