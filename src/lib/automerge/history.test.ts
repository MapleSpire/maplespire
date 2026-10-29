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
import * as Automerge from '@automerge/automerge'
import type { DocHandle } from '@automerge/automerge-repo'
import { restoreDocToHeads, restoreTo } from './history'
import type { DiagramDoc } from './types'

/**
 * `restoreDocToHeads` is the primitive behind LANDSCAPE-wide version restore: view
 * a doc at captured heads and write that past state back as a NEW change. Tested
 * here with in-memory Automerge docs + a minimal fake handle (the same approach
 * automerge.test.ts uses), so no Repo/network is needed.
 */

interface Model {
  objects: Record<string, { id: string; name: string }>
}

/** A minimal DocHandle over an in-memory Automerge doc (doc() + change()). */
function fakeHandle<T extends object>(initial: T) {
  let doc = Automerge.from(initial as T & Record<string, unknown>)
  return {
    doc: () => doc,
    change: (fn: (d: T) => void) => {
      doc = Automerge.change(doc, fn as (d: typeof doc) => void)
    },
  } as unknown as DocHandle<T>
}

describe('restoreDocToHeads', () => {
  it('rolls a doc back to captured heads (content matches the past)', () => {
    const handle = fakeHandle<Model>({ objects: { a: { id: 'a', name: 'A' } } })
    const past = Automerge.getHeads(handle.doc()!)

    handle.change((d) => {
      d.objects.a.name = 'A-edited'
      d.objects.c = { id: 'c', name: 'C' }
    })
    expect(handle.doc()!.objects.a.name).toBe('A-edited')
    expect(handle.doc()!.objects.c).toBeDefined()

    const ok = restoreDocToHeads(handle, past)
    expect(ok).toBe(true)
    // Content is back to the captured state…
    expect(handle.doc()!.objects.a.name).toBe('A')
    expect(handle.doc()!.objects.c).toBeUndefined()
    // …but written as a NEW change (so the restore is itself undoable).
    expect(Automerge.getHeads(handle.doc()!)).not.toEqual(past)
  })

  it('is idempotent — restoring to current heads is a no-op in content', () => {
    const handle = fakeHandle<Model>({ objects: { a: { id: 'a', name: 'A' } } })
    const now = Automerge.getHeads(handle.doc()!)
    const ok = restoreDocToHeads(handle, now)
    expect(ok).toBe(true)
    expect(handle.doc()!.objects.a.name).toBe('A')
  })

  it('returns false and leaves the doc untouched on unknown heads', () => {
    const handle = fakeHandle<Model>({ objects: { a: { id: 'a', name: 'A' } } })
    handle.change((d) => {
      d.objects.a.name = 'A2'
    })
    const before = Automerge.getHeads(handle.doc()!)
    const ok = restoreDocToHeads(handle, ['0000000000000000000000000000000000000000000000000000000000000000'])
    expect(ok).toBe(false)
    expect(handle.doc()!.objects.a.name).toBe('A2')
    expect(Automerge.getHeads(handle.doc()!)).toEqual(before)
  })
})

describe('restoreTo', () => {
  // The DiagramDoc's name is not what the canvas shows: the registry meta wins
  // (resolveDiagramProjection). The history panel can only carry the restored
  // name there if restoreTo hands it back — e2e/sync.spec.ts "History & revert"
  // is the end-to-end regression for that defect.
  it('returns the restored state, name included, and keeps the checkpoint list', () => {
    const handle = fakeHandle<DiagramDoc>({
      name: 'BASE',
      type: 'system-context',
      checkpoints: [],
    } as unknown as DiagramDoc)
    const base = Automerge.getHeads(handle.doc()!)
    handle.change((d) => {
      d.name = 'CHANGED'
      d.checkpoints!.push({ id: 'cp', label: 'cp', heads: base, createdAt: 'now' })
    })

    const past = restoreTo(handle, base)

    expect(past?.name).toBe('BASE')
    expect(handle.doc()!.name).toBe('BASE')
    expect(handle.doc()!.checkpoints?.map((c) => c.id)).toEqual(['cp'])
  })

  it('returns undefined and writes nothing on unknown heads', () => {
    const handle = fakeHandle<DiagramDoc>({ name: 'X', type: 'system-context' } as unknown as DiagramDoc)
    const before = Automerge.getHeads(handle.doc()!)
    expect(restoreTo(handle, ['0000000000000000000000000000000000000000000000000000000000000000'])).toBeUndefined()
    expect(Automerge.getHeads(handle.doc()!)).toEqual(before)
  })
})

// Re-review 2026-10-29, F1: a restore point older than a diagram's first scope
// override has no `objectScopes`; reconcile would DELETE the map, taking a
// peer's concurrent override with it. Both restore paths empty it instead.
describe('restore keeps the per-diagram scope map (emptied, never deleted)', () => {
  const legacyDiagram = (): DiagramDoc => ({
    name: 'D', type: 'context', objectIds: ['X', 'Y'], connectionIds: [], groupIds: [],
    layouts: {}, comments: {}, flows: {}, checkpoints: [],
  } as unknown as DiagramDoc)

  for (const [label, restore] of [
    ['restoreTo', (h: DocHandle<DiagramDoc>, heads: string[]) => { restoreTo(h, heads) }],
    ['restoreDocToHeads', (h: DocHandle<DiagramDoc>, heads: string[]) => { restoreDocToHeads(h, heads) }],
  ] as const) {
    it(`${label}: to a point before the first override, a peer's concurrent override survives`, () => {
      const handle = fakeHandle<DiagramDoc>(legacyDiagram())
      const before = Automerge.getHeads(handle.doc()!)
      handle.change((d) => {
        if (!d.objectScopes) d.objectScopes = {}
        d.objectScopes.X = 'external'
      })
      // A peer, concurrently, overrides Y in the same map.
      const peer = Automerge.change(Automerge.clone(handle.doc()!), (d) => {
        d.objectScopes!.Y = 'internal'
      })
      restore(handle, before)
      expect(handle.doc()!.objectScopes).toEqual({})
      const converged = Automerge.merge(Automerge.clone(handle.doc()!), peer)
      expect(converged.objectScopes).toEqual({ Y: 'internal' })
    })
  }
})
