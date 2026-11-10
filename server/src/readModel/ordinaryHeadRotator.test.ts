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

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import type { DocumentId } from '@automerge/automerge-repo'
import { rotateOrdinaryHead, type RotateOrdinaryHeadArgs } from './ordinaryHeadRotator.js'
import type { Queryable } from './types.js'

/**
 * The rotator's ORDER and its refusals, with every dependency a recording
 * fake — the steps a crash can fall between are the steps this file pins.
 * The same sequence against a real Repo, PostgreSQL and projector is
 * `ordinaryHeadRotator.integration.test.ts`.
 */

const WS = { landscapeId: 'ls-rot', versionId: 'v1' }
const RETIRED_URL = 'automerge:retired'
const CHILD_URL = 'automerge:child'

afterEach(() => { vi.restoreAllMocks() })

function headDoc() {
  let doc = A.from<{ objects: Record<string, unknown> }>({ objects: {} })
  doc = A.change(doc, (d) => { d.objects.x = { id: 'x', f: 'f0' } })
  const published = A.getHeads(doc)
  // The live document is AHEAD of what was published.
  doc = A.change(doc, (d) => { (d.objects.x as Record<string, unknown>).f = 'f1' })
  return { doc, published, live: A.getHeads(doc) }
}

type Answer = { locked?: boolean | 'none'; failOn?: RegExp }

function harness(options: {
  lock?: Answer['locked']
  failOn?: RegExp
  published?: () => readonly string[] | null
  onCreateChild?: (state: { owned: boolean; current: string }) => void
  onInsert?: (state: { owned: boolean; current: string }) => void
} = {}) {
  const events: string[] = []
  const { doc, published } = headDoc()
  const state = { owned: true, current: RETIRED_URL }
  const releases: Array<unknown> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (options.failOn?.test(sql)) throw new Error(`injected failure on ${sql.slice(0, 30)}`)
      if (sql.includes('pg_try_advisory_lock')) {
        events.push('lock')
        const locked = options.lock ?? true
        return { rows: locked === 'none' ? [] : [{ locked }], rowCount: 1 }
      }
      if (sql.includes('pg_advisory_unlock')) {
        events.push('unlock')
        return { rows: [{ released: true }], rowCount: 1 }
      }
      if (sql.startsWith('BEGIN')) events.push('BEGIN')
      else if (sql === 'COMMIT') events.push('COMMIT')
      else if (sql === 'ROLLBACK') events.push('ROLLBACK')
      else if (sql.includes('INSERT INTO read_model_ordinary_head_retirements')) {
        events.push(`insert:${(params?.[4] as string[]).join(',')}`)
        options.onInsert?.(state)
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn((error?: unknown) => { releases.push(error); events.push(error ? 'release:destroy' : 'release') }),
  }
  const createChild = vi.fn(async () => {
    events.push('createChild')
    options.onCreateChild?.(state)
    return { url: CHILD_URL, documentId: 'child' as DocumentId }
  })
  const publish = vi.fn((url: string) => {
    events.push(`publish:${url}`)
    state.current = url
  })
  const args: RotateOrdinaryHeadArgs = {
    key: WS,
    collection: 'object',
    retired: { url: RETIRED_URL, documentId: 'retired' as DocumentId, doc: () => doc },
    meta: { documentId: 'meta' as DocumentId, doc: () => ({ editsObjectShardUrl: state.current }) },
    publishedHeads: options.published ?? (() => published),
    mayWrite: () => state.owned,
    assertAuthority: async () => { events.push('assertAuthority') },
    connect: async () => { events.push('connect'); return client },
    createChild,
    flush: async (ids) => { events.push(`flush:${ids.join(',')}`) },
    assertTransactionAuthority: async (_tx: Queryable) => { events.push('assertTx') },
    publish,
    log: (line) => { events.push(`log:${JSON.parse(line).event}`) },
  }
  return { args, events, client, releases, createChild, publish, published, state }
}

describe('rotateOrdinaryHead — the order a crash can fall between', () => {
  it('child durable+claimed → H_r flushed → row committed → ONE meta change → meta flushed → lock released', async () => {
    const h = harness()
    const result = await rotateOrdinaryHead(h.args)
    expect(result).toEqual({ outcome: 'rotated', childUrl: CHILD_URL, retirementHeads: [...h.published].sort() })
    expect(h.events).toEqual([
      'assertAuthority', 'connect', 'lock',
      'createChild',
      'flush:retired',
      // ONE in-transaction authority check, BEFORE the row (see the comment
      // at the COMMIT in `ordinaryHeadRotator.ts` for why not a second).
      'BEGIN', 'assertTx', `insert:${[...h.published].sort().join(',')}`, 'COMMIT',
      `publish:${CHILD_URL}`,
      'flush:meta',
      'log:read_model.ordinary_head_rotated',
      'unlock', 'release',
    ])
    expect(h.publish).toHaveBeenCalledTimes(1)
  })

  it('records the PUBLISHED heads as H_r, never the live document heads', async () => {
    const h = harness()
    const { live } = headDoc()
    await rotateOrdinaryHead(h.args)
    const insert = h.events.find((event) => event.startsWith('insert:'))!
    expect(insert).toBe(`insert:${[...h.published].sort().join(',')}`)
    expect(h.published).not.toEqual(live)
  })
})

describe('rotateOrdinaryHead — the lock', () => {
  it('refused: nothing is created, and the clean connection goes back bare', async () => {
    const h = harness({ lock: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'lock-refused', state: 'refused' })
    expect(h.createChild).not.toHaveBeenCalled()
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.releases).toEqual([undefined])
    expect(warn.mock.calls.some(([line]) => String(line).includes('overlay_rotation_lock_contended'))).toBe(true)
  })

  it('an answer nobody can read (no row) is NOT permission: nothing is created and the session is destroyed', async () => {
    const h = harness({ lock: 'none' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'lock-refused', state: 'unknown' })
    expect(h.createChild).not.toHaveBeenCalled()
    expect(h.releases).toHaveLength(1)
    expect(h.releases[0]).toBeInstanceOf(Error)
  })

  it('a failure inside the row transaction rolls back, publishes nothing, and still hands the key back', async () => {
    const h = harness({ failOn: /INSERT INTO read_model_ordinary_head_retirements/ })
    await expect(rotateOrdinaryHead(h.args)).rejects.toThrow(/injected failure/)
    expect(h.events).toContain('ROLLBACK')
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.events.slice(-2)).toEqual(['unlock', 'release'])
  })
})

describe('rotateOrdinaryHead — authority and currency, re-checked', () => {
  it('ownership lost while the child is created and flushed: no row, no repoint', async () => {
    const h = harness({ onCreateChild: (state) => { state.owned = false } })
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'superseded', childUrl: CHILD_URL, stage: 'before-row' })
    expect(h.events.some((event) => event.startsWith('insert:'))).toBe(false)
    expect(h.publish).not.toHaveBeenCalled()
  })

  it('ownership lost while the row commits: the row stays (harmless), ModelMeta is NOT repointed', async () => {
    const h = harness({ onInsert: (state) => { state.owned = false } })
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'superseded', childUrl: CHILD_URL, stage: 'after-row' })
    expect(h.events).toContain('COMMIT')
    expect(h.publish).not.toHaveBeenCalled()
  })

  it('the head repointed by someone else while the row commits: NOT repointed again', async () => {
    const h = harness({ onInsert: (state) => { state.current = 'automerge:someone-else' } })
    expect((await rotateOrdinaryHead(h.args)).outcome).toBe('superseded')
    expect(h.publish).not.toHaveBeenCalled()
  })

  it('the head repointed while the child is created: no row', async () => {
    const h = harness({ onCreateChild: (state) => { state.current = 'automerge:someone-else' } })
    expect((await rotateOrdinaryHead(h.args)).outcome).toBe('superseded')
    expect(h.events.some((event) => event.startsWith('insert:'))).toBe(false)
  })

  it('not the owner at entry: no client, no lock', async () => {
    const h = harness()
    h.state.owned = false
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'not-owner' })
    expect(h.events).toEqual([])
  })

  it('no longer current once the lock is held: nothing created', async () => {
    const h = harness()
    h.state.current = 'automerge:other'
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'not-current' })
    expect(h.createChild).not.toHaveBeenCalled()
  })

  it('nothing published yet: nothing created — H_r is never invented', async () => {
    const h = harness({ published: () => null })
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'nothing-published' })
    expect(h.createChild).not.toHaveBeenCalled()
  })

  it('published heads the document does not hold: no row, no repoint', async () => {
    const h = harness({ published: () => ['f'.repeat(64)] })
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'nothing-published' })
    expect(h.events.some((event) => event.startsWith('insert:'))).toBe(false)
    expect(h.events).toContain('log:read_model.ordinary_head_rotation_refused')
  })
})

// Ported from the phase-3 QA lens (mutants R04, R06).
describe('rotateOrdinaryHead — the refusals under the lock', () => {
  it('ownership lost while the lock is taken: no child is minted, and the lock is handed back', async () => {
    const h = harness()
    let calls = 0
    // The entry check answers yes; every later one (under the lock) no.
    h.args.mayWrite = () => { calls += 1; return calls < 2 }
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'not-owner' })
    expect(calls).toBe(2)
    expect(h.createChild).not.toHaveBeenCalled()
    expect(h.events.slice(-2)).toEqual(['unlock', 'release'])
  })

  it('an EMPTY published-heads list is "nothing published": no child, no row with an empty H_r', async () => {
    // An empty H_r would forward the head's whole history.
    const h = harness({ published: () => [] })
    expect(await rotateOrdinaryHead(h.args)).toEqual({ outcome: 'nothing-published' })
    expect(h.createChild).not.toHaveBeenCalled()
    expect(h.events.some((event) => event.startsWith('insert:'))).toBe(false)
  })
})
