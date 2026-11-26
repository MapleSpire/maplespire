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
import * as A from '@automerge/automerge'
import {
  addForwardedBatchIdsInPlace,
  pruneForwardedBatchIdsInPlace,
  removeTombstonesInPlace,
} from './staticDeltaProjector.js'
import { appendCompactionSegmentInPlace } from './compaction.js'

/**
 * G4-16f: the call sites that used to assign a whole list into a long-lived
 * document (the static plane's tombstone removal and forwarded batch ids,
 * compaction's segment list) — each yields the list it always wrote, its
 * history does not grow with the list's length, and a concurrent writer's
 * push survives. Pure Automerge, no Repo, no database.
 */

type Doc = {
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
  forwardedBatchIds?: string[]
  editsObjectShardUrls?: string[]
  editsConnectionShardUrls?: string[]
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`)
const ops = (doc: A.Doc<Doc>) => A.stats(doc as A.Doc<unknown>).numOps
/** Ops one call adds on a document whose list has `n` entries. */
function opsOf(initial: Doc, write: (doc: Doc) => void): { doc: A.Doc<Doc>; added: number } {
  let doc = A.from<Doc>(initial)
  const before = ops(doc)
  doc = A.change(doc, (d) => write(d))
  return { doc, added: ops(doc) - before }
}

describe('in-place list writes (G4-16f)', () => {
  it('removeTombstonesInPlace: the remaining tombstones, deduplicated; its cost does not grow with the list', () => {
    const { doc } = opsOf({ deletedObjectIds: ['a', 'b', 'a', 'c', 'd'] }, (d) => removeTombstonesInPlace(d, 'deletedObjectIds', ['b', 'd']))
    expect(doc.deletedObjectIds).toEqual(['a', 'c'])
    const small = opsOf({ deletedObjectIds: [...ids('t', 10), 'gone'] }, (d) => removeTombstonesInPlace(d, 'deletedObjectIds', ['gone'])).added
    const large = opsOf({ deletedObjectIds: [...ids('t', 400), 'gone'] }, (d) => removeTombstonesInPlace(d, 'deletedObjectIds', ['gone'])).added
    // RED on the whole assignment: ~10 x 6 vs ~400 x 6 ops.
    expect(large).toBe(small)
  })

  it('removeTombstonesInPlace: an absent list stays an empty list', () => {
    const { doc } = opsOf({}, (d) => removeTombstonesInPlace(d, 'deletedConnectionIds', ['x']))
    expect(doc.deletedConnectionIds).toEqual([])
  })

  it('a client\'s concurrent tombstone push (bridge.ts) survives a server tombstone removal (RED on the whole assignment)', () => {
    const base = A.from<Doc>({ deletedObjectIds: ['a', 'b', 'c'] })
    let server = A.clone(base, { actor: 'aa'.repeat(16) as A.ActorId })
    let client = A.clone(base, { actor: 'bb'.repeat(16) as A.ActorId })
    server = A.change(server, (d) => removeTombstonesInPlace(d, 'deletedObjectIds', ['b']))
    // As `bridge.ts` records a delete: a push into the document's own list.
    client = A.change(client, (d) => { d.deletedObjectIds!.push('z') })
    for (const merged of [A.merge(A.clone(server), client), A.merge(A.clone(client), server)]) {
      expect([...merged.deletedObjectIds!].sort()).toEqual(['a', 'c', 'z'])
    }
  })

  it('addForwardedBatchIdsInPlace: the ids added once, first kept; cost independent of the list', () => {
    const { doc } = opsOf({ forwardedBatchIds: ['b1', 'b2'] }, (d) => addForwardedBatchIdsInPlace(d, ['b2', 'b3', 'b3']))
    expect(doc.forwardedBatchIds).toEqual(['b1', 'b2', 'b3'])
    const absent = opsOf({}, (d) => addForwardedBatchIdsInPlace(d, ['b1']))
    expect(absent.doc.forwardedBatchIds).toEqual(['b1'])
    const small = opsOf({ forwardedBatchIds: ids('b', 10) }, (d) => addForwardedBatchIdsInPlace(d, ['next'])).added
    const large = opsOf({ forwardedBatchIds: ids('b', 400) }, (d) => addForwardedBatchIdsInPlace(d, ['next'])).added
    expect(large).toBe(small)
  })

  it('pruneForwardedBatchIdsInPlace: the unacknowledged ids stay in place; none left, the key goes', () => {
    const { doc } = opsOf({ forwardedBatchIds: ['b1', 'b2', 'b3'] }, (d) => pruneForwardedBatchIdsInPlace(d, new Set(['b2'])))
    expect(doc.forwardedBatchIds).toEqual(['b1', 'b3'])
    const emptied = opsOf({ forwardedBatchIds: ['b1'] }, (d) => pruneForwardedBatchIdsInPlace(d, new Set(['b1'])))
    expect('forwardedBatchIds' in emptied.doc).toBe(false)
    const small = opsOf({ forwardedBatchIds: [...ids('b', 10), 'ack'] }, (d) => pruneForwardedBatchIdsInPlace(d, new Set(['ack']))).added
    const large = opsOf({ forwardedBatchIds: [...ids('b', 400), 'ack'] }, (d) => pruneForwardedBatchIdsInPlace(d, new Set(['ack']))).added
    expect(large).toBe(small)
  })

  it('appendCompactionSegmentInPlace: the url appended, the list deduplicated; cost independent of the list', () => {
    const { doc } = opsOf({ editsObjectShardUrls: ['u1', 'u2', 'u1'] }, (d) => appendCompactionSegmentInPlace(d, 'editsObjectShardUrls', 'u3'))
    expect(doc.editsObjectShardUrls).toEqual(['u1', 'u2', 'u3'])
    const absent = opsOf({}, (d) => appendCompactionSegmentInPlace(d, 'editsConnectionShardUrls', 'u1'))
    expect(absent.doc.editsConnectionShardUrls).toEqual(['u1'])
    const small = opsOf({ editsObjectShardUrls: ids('automerge:seg', 10) }, (d) => appendCompactionSegmentInPlace(d, 'editsObjectShardUrls', 'next')).added
    const large = opsOf({ editsObjectShardUrls: ids('automerge:seg', 400) }, (d) => appendCompactionSegmentInPlace(d, 'editsObjectShardUrls', 'next')).added
    expect(large).toBe(small)
  })
})
