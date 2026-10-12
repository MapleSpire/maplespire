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
import { test } from 'node:test'
import * as A from '@automerge/automerge'
import { aggregateLoadPoll, projectLoadObjects } from './loadUserSnapshots.mjs'

const episodeId = '00000000-0000-4000-8000-000000000001'
const expectedRound = `${episodeId}:r3`
const options = { pollId: 2, episodeId, users: [25, 26], ids: ['a'], writersOf: { a: [0, 1] }, expectedRound }
const fixture = () => [25, 26].map(user => ({ user, episodeId, pollId: 2, startedAt: 100 + user,
  sampledAt: 101 + user, objects: { a: { u0: expectedRound, u1: expectedRound, hot: `u1-${expectedRound}` } } }))

test('reader cohorts compare raw shared hot values with their own first user and actual sample end', () => {
  const snapshots = fixture()
  const poll = aggregateLoadPoll(snapshots, options)
  assert.equal(poll.state.fullyConverged, true)
  assert.equal(poll.window.completedAt, 127)
  snapshots[1].objects.a.hot = `u0-${expectedRound}`
  assert.equal(aggregateLoadPoll(snapshots, options).state.fullyConverged, false,
    'two individually valid CRDT winners are not a common winner')
  snapshots[1].objects.a.hot = snapshots[0].objects.a.hot
  snapshots[1].objects.a.u1 = 'r3'
  assert.equal(aggregateLoadPoll(snapshots, options).state.staleFields, 1)
})

test('mixed poll/user/episode and incomplete observations cannot become convergence', () => {
  for (const mutate of [rows => rows.pop(), rows => { rows[1] = rows[0] },
    rows => { rows[1].pollId-- }, rows => { rows[1].episodeId = 'previous' },
    rows => { rows[1].sampledAt = 0 }, rows => { delete rows[1].objects.a }]) {
    const rows = fixture(); mutate(rows)
    assert.throws(() => aggregateLoadPoll(rows, options))
  }
})

test('projection copies expected scalar fields from one immutable real Automerge document', () => {
  const original = A.from({ objects: { a: { u0: expectedRound, u1: expectedRound,
    hot: `u1-${expectedRound}`, ignored: { large: 'not copied' } } } })
  const projected = projectLoadObjects(original, ['a'], { a: [0, 1] })
  const changed = A.change(original, doc => { doc.objects.a.hot = 'later' })
  assert.equal(changed.objects.a.hot, 'later')
  assert.deepEqual(projected, fixture()[0].objects)
  assert.doesNotThrow(() => structuredClone(projected))
  A.free(changed)
})
