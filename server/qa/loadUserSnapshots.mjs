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

import assert from 'node:assert/strict'
import { loadConvergenceState, objectMap } from './loadUsersCore.mjs'

/** Copy only the fields the existing predicate reads, synchronously from one
 * immutable DocHandle snapshot. No Automerge document crosses a MessagePort. */
export function projectLoadObjects(document, ids, writersOf) {
  const objects = objectMap(document)
  if (!objects) throw new Error('load user lost its object collection')
  return Object.fromEntries(ids.map(id => {
    const object = objects[id]
    const fields = Object.fromEntries(writersOf[id].map(writer => [`u${writer}`, object?.[`u${writer}`]]))
    return [id, { ...fields, hot: object?.hot }]
  }))
}

/** A qualified episode has fresh final values for every expected writer. Each
 * final field was changed atomically with that writer's hot. Once all finals
 * are present, the closed episode has no further hot changes, including shared
 * objects. This is not a global atomic snapshot or a legacy-r3 freshness proof. */
export function aggregateLoadPoll(snapshots, { pollId, episodeId, users, ids, writersOf, expectedRound }) {
  assert.equal(snapshots.length, users.length, 'every client must answer the poll')
  assert.ok(users.length > 0 && new Set(users).size === users.length, 'distinct expected users')
  for (const [index, snapshot] of snapshots.entries()) {
    assert.equal(snapshot.user, users[index], 'poll user/order mismatch')
    assert.equal(snapshot.pollId, pollId, 'mixed or stale poll')
    assert.equal(snapshot.episodeId, episodeId, 'snapshot from another episode')
    assert.ok(Number.isSafeInteger(snapshot.startedAt) && Number.isSafeInteger(snapshot.sampledAt)
      && snapshot.startedAt > 0 && snapshot.sampledAt >= snapshot.startedAt, 'invalid local sample interval')
    assert.deepEqual(Object.keys(snapshot.objects).sort(), [...ids].sort(), 'incomplete object projection')
  }
  const state = loadConvergenceState({
    clients: snapshots.map(snapshot => ({ i: snapshot.user, objects: snapshot.objects })),
    ids, writersOf, expectedRound,
  })
  return {
    state,
    hotValues: ids.map(id => snapshots[0].objects[id]?.hot ?? null),
    window: { pollId, startedAt: Math.min(...snapshots.map(s => s.startedAt)),
      completedAt: Math.max(...snapshots.map(s => s.sampledAt)), clients: snapshots.length,
      freshEpisode: episodeId !== null, fullyConverged: state.fullyConverged },
  }
}
