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
import { resolveADRLink, type ADRLinkLookups } from './adrLinkResolution'
import { lookupFromArray } from '../../lib/refs/resolve'
import type { ADRLink, DecisionRecord, Diagram } from '../../types'

/**
 * Every case here is a FAILING link path. Clickability must depend on whether
 * the target resolves, not merely on the presence of an id: otherwise a chip
 * pointing at a deleted diagram lands the user on `diagram-not-found`, and a
 * chip pointing at a deleted record silently swaps the pane they were reading
 * for the empty state.
 */

const diagram = (id: string, name: string): Diagram => ({
  id, name, type: 'container', objectIds: [], connectionIds: [], groupIds: [],
})
const record = (id: string, number: number, title: string): DecisionRecord => ({
  id, number, title, summary: '', status: 'approved', author: 'a',
  createdAt: '', updatedAt: '', content: '', related: [],
})

const lookups = (over: Partial<{ diagrams: Diagram[]; records: DecisionRecord[]; complete: boolean; deleted: Set<string> }> = {}): ADRLinkLookups => {
  const { diagrams = [diagram('d1', 'Payments C2')], records = [record('r1', 7, 'Use Postgres')], complete = true, deleted } = over
  return {
    diagram: lookupFromArray(diagrams, { complete, deleted }),
    record: lookupFromArray(records, { complete, deleted }),
  }
}
const link = (over: Partial<ADRLink> & { type: ADRLink['type'] }): ADRLink =>
  ({ id: 'l1', label: 'stored label', ...over })

describe('resolveADRLink — targets that resolve', () => {
  it('re-derives the label from the live diagram, so a rename is not advertised stale', () => {
    const r = resolveADRLink(link({ type: 'diagram', targetId: 'd1', label: 'Old name' }), lookups())
    expect(r).toMatchObject({ state: 'live', issue: 'none', label: 'Payments C2' })
  })

  it('re-derives the label from the live record', () => {
    const r = resolveADRLink(link({ type: 'adr', targetId: 'r1' }), lookups())
    expect(r).toMatchObject({ state: 'live', label: 'ADR-7 Use Postgres' })
  })

  it('treats a draft link like a record link', () => {
    expect(resolveADRLink(link({ type: 'draft', targetId: 'r1' }), lookups()).state).toBe('live')
  })
})

describe('resolveADRLink — targets that are gone', () => {
  it('reports a deleted diagram as dangling, keeping the stored label to identify it', () => {
    const r = resolveADRLink(link({ type: 'diagram', targetId: 'gone' }), lookups())
    expect(r).toMatchObject({ state: 'dangling', issue: 'deleted', label: 'stored label' })
  })

  it('reports a deleted record as dangling', () => {
    expect(resolveADRLink(link({ type: 'adr', targetId: 'gone' }), lookups()).issue).toBe('deleted')
  })

  it('reports a link whose targetId was never stored as dangling', () => {
    expect(resolveADRLink(link({ type: 'diagram' }), lookups()).state).toBe('dangling')
  })
})

describe('resolveADRLink — targets beyond the window', () => {
  it('reports unknown, NOT dangling, when the collection is a bounded page', () => {
    // The 2 000-row ADR page and the one-entry server registry summary both hit
    // this. Calling it dangling would strike out a perfectly healthy link.
    const windowed = lookups({ complete: false })
    expect(resolveADRLink(link({ type: 'adr', targetId: 'ADR-4000' }), windowed).state).toBe('unknown')
    expect(resolveADRLink(link({ type: 'diagram', targetId: 'far' }), windowed).state).toBe('unknown')
  })

  it('keeps the stored label for an unknown target, since there is nothing to re-derive from', () => {
    const r = resolveADRLink(link({ type: 'adr', targetId: 'far' }), lookups({ complete: false }))
    expect(r).toMatchObject({ issue: 'none', label: 'stored label' })
  })

  it('lets a probe result promote unknown to dangling', () => {
    // A 404 from the server — which sees the whole collection — is the only
    // proof of death available to a windowed client.
    const probed = lookups({ complete: false, deleted: new Set(['far']) })
    expect(resolveADRLink(link({ type: 'diagram', targetId: 'far' }), probed).issue).toBe('deleted')
  })
})

describe('resolveADRLink — url links carry no model reference', () => {
  it('accepts an http(s) address and hands back the sanitised href', () => {
    const r = resolveADRLink(link({ type: 'url', url: 'https://example.com/adr' }), lookups())
    expect(r).toMatchObject({ state: 'live', issue: 'none', href: 'https://example.com/adr' })
  })

  it('rejects a bare host, which used to open a path inside the app', () => {
    const r = resolveADRLink(link({ type: 'url', url: 'example.com' }), lookups())
    expect(r).toMatchObject({ state: 'dangling', issue: 'invalid-url', href: null })
  })

  it('rejects a javascript: url instead of attempting it', () => {
    const r = resolveADRLink(link({ type: 'url', url: 'javascript:alert(1)' }), lookups())
    expect(r).toMatchObject({ issue: 'invalid-url', href: null })
  })

  it('rejects a url link with no url at all — the type allows it', () => {
    // `url` and `targetId` are both optional on ADRLink, so an import or a newer
    // client can produce this. It must not render clickable and do nothing.
    expect(resolveADRLink(link({ type: 'url' }), lookups()).issue).toBe('invalid-url')
  })

  it('never marks a url link as deleted — reachability is out of scope', () => {
    const r = resolveADRLink(link({ type: 'url', url: 'https://example.com/404' }), lookups())
    expect(r.issue).not.toBe('deleted')
  })
})

describe('resolveADRLink — types this build does not know', () => {
  it('degrades to an inert chip instead of throwing', () => {
    // LINK_TYPE_CONFIG[link.type].icon threw here, and there is no ErrorBoundary
    // anywhere in src/ — it blanked the whole decision-record pane.
    const r = resolveADRLink({ id: 'l9', type: 'wiki' as ADRLink['type'], label: 'Wiki page' }, lookups())
    expect(r).toMatchObject({ kind: 'unsupported', state: 'dangling', issue: 'unsupported-type', label: 'Wiki page' })
  })

  it('does NOT report an unknown type as deleted', () => {
    // Broken data, not a dead reference: the strike-through would lie.
    const r = resolveADRLink({ id: 'l9', type: 'wiki' as ADRLink['type'], label: 'x' }, lookups())
    expect(r.issue).not.toBe('deleted')
  })
})

describe('resolveADRLink — invariants', () => {
  const cases: ADRLink[] = [
    link({ type: 'diagram', targetId: 'd1' }),
    link({ type: 'diagram', targetId: 'gone' }),
    link({ type: 'adr', targetId: 'far' }),
    link({ type: 'url', url: 'https://ok.test' }),
    link({ type: 'url', url: 'nope' }),
    { id: 'l9', type: 'wiki' as ADRLink['type'], label: 'x' },
  ]

  it('keeps state and issue in lockstep', () => {
    for (const candidate of cases) {
      const r = resolveADRLink(candidate, lookups({ complete: false }))
      expect(r.state === 'dangling', `${candidate.type}/${candidate.targetId ?? candidate.url}`)
        .toBe(r.issue !== 'none')
    }
  })

  it('only ever produces an href for a url link', () => {
    for (const candidate of cases) {
      const r = resolveADRLink(candidate, lookups())
      if (r.kind !== 'url') expect(r.href).toBeNull()
    }
  })
})
