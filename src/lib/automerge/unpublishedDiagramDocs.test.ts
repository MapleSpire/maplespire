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
import { UnpublishedDiagramDocs } from './unpublishedDiagramDocs'

describe('UnpublishedDiagramDocs', () => {
  it('keeps a just-created document resolvable through an index rebuild', () => {
    const docs = new UnpublishedDiagramDocs()
    docs.record('n1', 'automerge:new')
    // The rebuild: clear, refill from the shards (which do not name n1 yet), readmit.
    const index = new Map([['d1', docs.resolve('d1', 'automerge:d1')]])
    docs.readmit(index)
    expect(index.get('n1')).toBe('automerge:new')
    expect(index.get('d1')).toBe('automerge:d1')
  })

  it('falls back to its own document for a meta published with an empty docUrl', () => {
    const docs = new UnpublishedDiagramDocs()
    docs.record('z1', 'automerge:fresh')
    expect(docs.resolve('z1', '')).toBe('automerge:fresh')
    expect(docs.resolve('z1', undefined)).toBe('automerge:fresh')
    expect(docs.size).toBe(1)
  })

  it('lets a meta that names a document win, and retires the record', () => {
    const docs = new UnpublishedDiagramDocs()
    docs.record('n1', 'automerge:mine')
    expect(docs.resolve('n1', 'automerge:published')).toBe('automerge:published')
    expect(docs.size).toBe(0)
    const index = new Map([['n1', 'automerge:published']])
    docs.readmit(index)
    expect(index.get('n1')).toBe('automerge:published')
  })

  it('never overrides a url the rebuilt index already holds', () => {
    const docs = new UnpublishedDiagramDocs()
    docs.record('n1', 'automerge:mine')
    const index = new Map([['n1', 'automerge:other']])
    docs.readmit(index)
    expect(index.get('n1')).toBe('automerge:other')
  })

  it('forgets a deleted diagram and clears with the session', () => {
    const docs = new UnpublishedDiagramDocs()
    docs.record('a', 'automerge:a')
    docs.record('b', 'automerge:b')
    docs.forget('a')
    const index = new Map<string, string>()
    docs.readmit(index)
    expect([...index.keys()]).toEqual(['b'])
    docs.clear()
    expect(docs.size).toBe(0)
  })
})
