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
import { restoreDocToHeads } from './history'

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
