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

import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { changedDecisionRecords, usesDecisionRecordDelta } from './decisionRecordDelta'
import { overlayRecordsToReseed, type ReseedMeta } from './decisionRecordOverlayReseed'
import { reconcile } from './reconcile'
import type { DecisionRecord } from '../../types'

/**
 * The acceptance test for repairing a dangling ADR link.
 *
 * A platform-admin repair splices the link out of
 * `ModelMeta.decisionRecords[id].related` server-side. That write is durable and
 * merges cleanly — but a CONNECTED CLIENT undoes it, and the mechanism is not a
 * race:
 *
 *   the repair CREATES the overlay entry when the record was baseline-only
 *     -> the id becomes an overlay key
 *     -> `changedDecisionRecords` re-emits it unconditionally
 *        (the `|| overlayIds.has(record.id)` term — reference-identity with the
 *        page baseline no longer protects it)
 *     -> `reconcileDecisionRecordCollection` reconciles the client's STALE
 *        `related` back over the repaired one
 *
 * and the trigger is not an edit to that ADR at all: `writeSmallCollections`
 * guards groups/domains/tags/decisionRecords TOGETHER, so renaming a group
 * flushes every overlayed ADR in the window.
 *
 * The fix is `reseedOverlayDecisionRecords` in `bridge.ts`. This file pins the
 * whole loop against real Automerge, because the failure only appears after the
 * client's write merges BACK to the server — and pins the four refusals, because
 * a re-seed writes the STORE, which is how keystrokes get eaten.
 */

interface Meta extends ReseedMeta {
  [key: string]: unknown
  decisionRecords: Record<string, DecisionRecord>
  deletedDecisionRecordIds: string[]
}

const link = (id: string, targetId: string) => ({ id, type: 'diagram' as const, label: id, targetId })
const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: 'adr-1', number: 1, title: 'T', summary: '', status: 'approved', author: 'a',
  createdAt: '', updatedAt: '', content: 'C',
  related: [link('lnk-live', 'dg-live'), link('lnk-dead', 'dg-gone')],
  ...over,
})
const paged = ['automerge:fake']

/** Verbatim transcription of `bridge.ts` `reconcileDecisionRecordCollection`. */
function flushSmallCollections(
  meta: Meta,
  storeRecords: readonly DecisionRecord[],
  baseline: Map<string, DecisionRecord>,
): void {
  if (!usesDecisionRecordDelta(meta)) {
    reconcile(meta.decisionRecords, Object.fromEntries(storeRecords.map((r) => [r.id, r])))
    return
  }
  const overlayIds = new Set(Object.keys(meta.decisionRecords ?? {}))
  const currentIds = new Set(storeRecords.map((r) => r.id))
  const deletedIds = new Set(meta.deletedDecisionRecordIds ?? [])
  for (const id of baseline.keys()) {
    if (!currentIds.has(id)) { deletedIds.add(id); delete meta.decisionRecords[id] }
  }
  for (const r of changedDecisionRecords(storeRecords, baseline, overlayIds)) {
    deletedIds.delete(r.id)
    if (meta.decisionRecords[r.id]) reconcile(meta.decisionRecords[r.id], r)
    else meta.decisionRecords[r.id] = r
  }
  meta.deletedDecisionRecordIds = [...deletedIds]
}

/** The store/baseline update `bridge.ts` performs around the REAL selection
 *  function — imported, not transcribed, so a mutation to the shipped code fails
 *  these tests. */
function reseed(meta: ReseedMeta, store: DecisionRecord[], baseline: Map<string, DecisionRecord>): DecisionRecord[] {
  const byId = new Map(store.map((r) => [r.id, r]))
  const refreshed = overlayRecordsToReseed(meta, baseline, byId)
  if (refreshed.length === 0) return store
  for (const r of refreshed) { byId.set(r.id, r); baseline.set(r.id, r) }
  return [...byId.values()]
}

const linkIds = (doc: Automerge.Doc<Meta>) => doc.decisionRecords['adr-1'].related.map((l) => l.id)

/** Server repairs, client merges it in, client flushes, server merges back. */
function roundTrip(options: { reseedOnChange: boolean }) {
  const base = Automerge.from<Meta>({
    decisionRecords: { 'adr-1': record() },
    deletedDecisionRecordIds: [],
    decisionRecordShardUrls: paged,
  })

  // The client is sitting on a page it loaded BEFORE the repair. Store and
  // baseline share the SAME object — that is what "no local edit" means here,
  // and the re-seed's central refusal is spelled on exactly that identity.
  const hydrated = record()
  const baseline = new Map<string, DecisionRecord>([['adr-1', hydrated]])
  let store: DecisionRecord[] = [hydrated]

  // Server: splice the dead link out, in place.
  const server = Automerge.change(Automerge.clone(base, { actor: 'aaaaaa' }), (d) => {
    const rel = d.decisionRecords['adr-1'].related
    for (let i = rel.length - 1; i >= 0; i--) if (rel[i].targetId === 'dg-gone') rel.splice(i, 1)
  })

  // Client receives it. `reseedOverlayDecisionRecords` runs on the meta change.
  let client = Automerge.merge(Automerge.clone(base, { actor: 'bbbbbb' }), server)
  if (options.reseedOnChange) store = reseed(client as unknown as Meta, store, baseline)

  // Any durable edit flushes all four small collections together.
  client = Automerge.change(client, (d) => {
    flushSmallCollections(d as unknown as Meta, store, baseline)
  })

  return { server: Automerge.merge(Automerge.clone(server), client), client }
}

describe('a repaired ADR link survives a connected client', () => {
  it('NEGATIVE CONTROL: without the re-seed the client puts the link back', () => {
    // If this ever stops failing to keep the link, the mechanism changed and
    // the test below is no longer proving anything.
    const { server } = roundTrip({ reseedOnChange: false })
    expect(linkIds(server)).toContain('lnk-dead')
  })

  it('with the re-seed the removal holds, on the client AND back on the server', () => {
    const { server, client } = roundTrip({ reseedOnChange: true })
    expect(linkIds(client)).toEqual(['lnk-live'])
    expect(linkIds(server)).toEqual(['lnk-live'])
  })

  it('re-seeds the baseline too, or the next flush would tombstone the record', () => {
    // `reconcileDecisionRecordCollection` adds any baseline id missing from the
    // store to `deletedDecisionRecordIds`. Updating the store without the
    // baseline would delete the ADR outright.
    const repaired = record({ related: [link('lnk-live', 'dg-live')] })
    const meta: Meta = {
      decisionRecords: { 'adr-1': repaired }, deletedDecisionRecordIds: [], decisionRecordShardUrls: paged,
    }
    const hydrated = record()
    const baseline = new Map<string, DecisionRecord>([['adr-1', hydrated]])
    const store = reseed(meta, [hydrated], baseline)
    expect(baseline.get('adr-1')!.related.map((l) => l.id)).toEqual(['lnk-live'])
    flushSmallCollections(meta, store, baseline)
    expect(meta.deletedDecisionRecordIds).toEqual([])
  })

  it('hands the store a MUTABLE clone, never the frozen document object', () => {
    // The overlay value belongs to the Automerge doc. Passing it straight to the
    // store puts a frozen, doc-lifetime object where Immer expects a plain one —
    // and no plain-object fixture can tell the difference, which is why this
    // test uses a real document.
    const doc = Automerge.from<Meta>({
      decisionRecords: { 'adr-1': record({ related: [link('lnk-live', 'dg-live')] }) },
      deletedDecisionRecordIds: [],
      decisionRecordShardUrls: paged,
    })
    const hydrated = record()
    const [refreshed] = overlayRecordsToReseed(
      doc as unknown as ReseedMeta,
      new Map([['adr-1', hydrated]]),
      new Map([['adr-1', hydrated]]),
    )
    expect(refreshed).not.toBe(doc.decisionRecords['adr-1'])
    expect(Object.isFrozen(refreshed)).toBe(false)
    expect(() => refreshed.related!.push(link('lnk-new', 'dg-new'))).not.toThrow()
  })
})

describe('the re-seed refuses anything that could be a local edit', () => {
  const overlayed = (over: Partial<Meta> = {}): Meta => ({
    decisionRecords: { 'adr-1': record({ related: [link('lnk-live', 'dg-live')] }) },
    deletedDecisionRecordIds: [],
    decisionRecordShardUrls: paged,
    ...over,
  })

  it('leaves an ADR the user is editing alone, even though the overlay differs', () => {
    // THE dropped-letters hazard. The write path never advances the page
    // baseline, so after one local flush `overlay !== baseline` forever — a
    // value comparison alone would re-seed the flushed copy over every keystroke
    // typed since. Reference-identity with the baseline is the local-edit
    // predicate the write path itself uses.
    const hydrated = record()
    const beingTyped = record({ title: 'Half-typed titl' })
    const store = reseed(overlayed(), [beingTyped], new Map([['adr-1', hydrated]]))
    expect(store[0].title).toBe('Half-typed titl')
    expect(store[0]).toBe(beingTyped)
  })

  it('never re-adds a record the user just deleted', () => {
    // The delete lives in the store first and flushes later. Re-adding it makes
    // `reconcileDecisionRecordCollection` see the id in `currentIds`, so it never
    // tombstones — the delete is lost silently.
    const hydrated = record()
    expect(reseed(overlayed(), [], new Map([['adr-1', hydrated]]))).toEqual([])
  })

  it('never re-seeds a tombstoned record', () => {
    // `deletedDecisionRecordIds` wins over the overlay on every read path; this
    // one must agree, or a deleted ADR reappears in the list.
    const hydrated = record()
    const meta = overlayed({ deletedDecisionRecordIds: ['adr-1'] })
    expect(reseed(meta, [hydrated], new Map([['adr-1', hydrated]]))).toEqual([hydrated])
  })

  it('does nothing in inline mode, where projectAll already re-projects from meta', () => {
    // No shard urls and no staticBaseline: `shouldProjectInlineDecisionRecords`
    // is true, so the change handler refreshes the store for free. Running here
    // would be cost paid on every meta change for no effect.
    const hydrated = record()
    const meta = overlayed({ decisionRecordShardUrls: [] })
    expect(reseed(meta, [hydrated], new Map([['adr-1', hydrated]]))).toEqual([hydrated])
  })

  it('treats staticBaseline as delta even with no shard urls', () => {
    // The static relational baseline publishes `decisionRecordShardUrls: []`
    // deliberately; its ADRs are paged from PostgreSQL, so the hazard is live.
    const hydrated = record()
    const meta = overlayed({ decisionRecordShardUrls: [], staticBaseline: true })
    expect(reseed(meta, [hydrated], new Map([['adr-1', hydrated]]))[0].related)
      .toEqual([link('lnk-live', 'dg-live')])
  })

  it('leaves a record the client has NOT paged alone', () => {
    // An empty baseline means nothing to re-seed; the repair is safe by default
    // for every client that never opened the ADR list.
    const store: DecisionRecord[] = []
    expect(reseed(overlayed(), store, new Map())).toBe(store)
  })

  it('ignores an overlay id that is not on this client’s page', () => {
    // A paged client holds a window. An overlay entry outside it is not ours to
    // put in the store — that would grow the page from a remote event.
    const hydrated = record()
    const meta = overlayed({
      decisionRecords: { 'adr-1': record({ related: [] }), 'adr-99': record({ id: 'adr-99' }) },
    })
    const store = reseed(meta, [hydrated], new Map([['adr-1', hydrated]]))
    expect(store.map((r) => r.id)).toEqual(['adr-1'])
  })

  it('does nothing when the overlay matches what the client already holds', () => {
    // The common case by far: a meta change that has nothing to do with ADRs
    // must not churn the store on every flush.
    const hydrated = record()
    const store = [hydrated]
    expect(reseed(overlayed({ decisionRecords: { 'adr-1': record() } }), store, new Map([['adr-1', hydrated]])))
      .toBe(store)
  })
})
