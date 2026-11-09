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

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as A from '@automerge/automerge'
import {
  DEFAULT_ORDINARY_CHAIN_FOLD_BUDGET,
  DEFAULT_ORDINARY_CHAIN_FOLD_MIN,
  DEFAULT_ORDINARY_CHAIN_FOLD_RETAIN_HOURS,
  ORDINARY_CHAIN_FOLD_BUDGET_ENV,
  ORDINARY_CHAIN_FOLD_FLAG,
  ORDINARY_CHAIN_FOLD_MIN_ENV,
  ORDINARY_CHAIN_FOLD_RETAIN_HOURS_ENV,
  DEFAULT_ORDINARY_HEAD_MAX_ACTORS,
  DEFAULT_ORDINARY_HEAD_MAX_CHANGES,
  MAX_REMEMBERED_TRIGGERS,
  ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV,
  ORDINARY_HEAD_ROTATION_FLAG,
  ORDINARY_HEAD_ROTATION_MAX_ACTORS_ENV,
  ORDINARY_HEAD_ROTATION_MAX_CHANGES_ENV,
  ORDINARY_HEAD_ROTATION_OFF,
  OrdinaryHeadRotationObserver,
  ordinaryHeadRotationConfig,
  type OrdinaryHeadRotationConfig,
} from './ordinaryHeadRotation.js'

// `stats` wrapped so a test can tell "looked and stayed quiet" from "never
// looked" — the off and not-allow-listed paths must be the second.
const statsCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('@automerge/automerge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@automerge/automerge')>()
  return {
    ...actual,
    stats: (doc: A.Doc<unknown>) => {
      statsCalls.count += 1
      return actual.stats(doc)
    },
  }
})

type Shard = { objects: Record<string, { id: string }> }
const WORKSPACE = { landscapeId: 'land-a', versionId: 'ver-1' }
const LISTED = `${WORKSPACE.landscapeId}/${WORKSPACE.versionId}`

/** A head written by exactly `actors` actors, one change each. Every branch
 * loads the same empty base, so the base contributes no actor and no change. */
function headWithActors(actors: number): A.Doc<Shard> {
  const base = A.save(A.init<Shard>())
  let doc = A.load<Shard>(base)
  for (let index = 0; index < actors; index += 1) {
    const branch = A.change(A.load<Shard>(base), (d) => {
      if (!d.objects) d.objects = {}
      d.objects[`o${index}`] = { id: `o${index}` }
    })
    doc = A.merge(doc, branch)
  }
  return doc
}

/** A head carrying exactly `changes` changes from ONE actor. */
function headWithChanges(changes: number): A.Doc<Shard> {
  let doc = A.init<Shard>()
  for (let index = 0; index < changes; index += 1) {
    doc = A.change(doc, (d) => {
      if (!d.objects) d.objects = {}
      d.objects[`o${index}`] = { id: `o${index}` }
    })
  }
  return doc
}

const shadow = (overrides: Partial<OrdinaryHeadRotationConfig> = {}): OrdinaryHeadRotationConfig => ({
  mode: 'shadow',
  allowlist: new Set([LISTED]),
  maxActors: DEFAULT_ORDINARY_HEAD_MAX_ACTORS,
  maxChanges: DEFAULT_ORDINARY_HEAD_MAX_CHANGES,
  ...overrides,
})

function observer(config: OrdinaryHeadRotationConfig, key = WORKSPACE) {
  const lines: Array<Record<string, unknown>> = []
  const subject = new OrdinaryHeadRotationObserver(config, key, (line) => { lines.push(JSON.parse(line)) })
  return { subject, lines }
}

beforeEach(() => { statsCalls.count = 0 })

describe('ordinaryHeadRotationConfig', () => {
  it('is OFF when missing, blank or off — and reads no other knob then', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const value of [undefined, '', '   ', 'off', ' off ']) {
        expect(ordinaryHeadRotationConfig({
          [ORDINARY_HEAD_ROTATION_FLAG]: value,
          // Would log `env.knob_rejected` if it were parsed at all.
          [ORDINARY_HEAD_ROTATION_MAX_ACTORS_ENV]: 'garbage',
          [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: '*',
        })).toBe(ORDINARY_HEAD_ROTATION_OFF)
      }
      expect(warn.mock.calls).toHaveLength(0)
    } finally { warn.mockRestore() }
  })

  it('reads on with an explicit allow-list (phase 3)', () => {
    const config = ordinaryHeadRotationConfig({
      [ORDINARY_HEAD_ROTATION_FLAG]: 'on',
      [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: 'a/1, b/2',
    })
    expect(config.mode).toBe('on')
    expect(config.allowlist).toEqual(new Set(['a/1', 'b/2']))
    // An empty list is accepted and rotates nothing.
    expect(ordinaryHeadRotationConfig({ [ORDINARY_HEAD_ROTATION_FLAG]: 'on' }).allowlist).toEqual(new Set())
  })

  it('refuses on with the * wildcard, padded or not — rotation writes, so each workspace is named', () => {
    for (const wildcard of ['*', ' * ', '\t*\n']) {
      expect(() => ordinaryHeadRotationConfig({
        [ORDINARY_HEAD_ROTATION_FLAG]: 'on',
        [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: wildcard,
      })).toThrow(/AM_ORDINARY_HEAD_ROTATION=on refuses AM_ORDINARY_HEAD_ROTATION_WORKSPACE_ALLOWLIST=\*/)
    }
    // ...while shadow, which writes nothing, still takes it.
    expect(ordinaryHeadRotationConfig({
      [ORDINARY_HEAD_ROTATION_FLAG]: 'shadow',
      [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: '*',
    }).allowlist).toBe('all')
  })

  it('refuses an unknown spelling instead of guessing a mode', () => {
    for (const value of ['true', '1', 'Shadow', 'yes', 'ON', 'On']) {
      expect(() => ordinaryHeadRotationConfig({ [ORDINARY_HEAD_ROTATION_FLAG]: value }))
        .toThrow('invalid-AM_ORDINARY_HEAD_ROTATION')
    }
  })

  it('reads shadow with defaults 128 / 512 and an empty allow-list', () => {
    const config = ordinaryHeadRotationConfig({ [ORDINARY_HEAD_ROTATION_FLAG]: 'shadow' })
    expect(config.mode).toBe('shadow')
    expect(config.maxActors).toBe(128)
    expect(config.maxChanges).toBe(512)
    expect(config.allowlist).toEqual(new Set())
  })

  it('reads the allow-list with the compaction entry rule, and * as every workspace', () => {
    const listed = ordinaryHeadRotationConfig({
      [ORDINARY_HEAD_ROTATION_FLAG]: 'shadow',
      [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: 'a/1, b/2\nbad, /3, c/d/e',
    })
    expect(listed.allowlist).toEqual(new Set(['a/1', 'b/2']))
    expect(ordinaryHeadRotationConfig({
      [ORDINARY_HEAD_ROTATION_FLAG]: 'shadow',
      [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: ' * ',
    }).allowlist).toBe('all')
  })

  it('takes thresholds from the env, and a blank or zero keeps the default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const configured = ordinaryHeadRotationConfig({
        [ORDINARY_HEAD_ROTATION_FLAG]: 'shadow',
        [ORDINARY_HEAD_ROTATION_MAX_ACTORS_ENV]: '64',
        [ORDINARY_HEAD_ROTATION_MAX_CHANGES_ENV]: '2048',
      })
      expect([configured.maxActors, configured.maxChanges]).toEqual([64, 2048])
      const blank = ordinaryHeadRotationConfig({
        [ORDINARY_HEAD_ROTATION_FLAG]: 'shadow',
        [ORDINARY_HEAD_ROTATION_MAX_ACTORS_ENV]: '',
        [ORDINARY_HEAD_ROTATION_MAX_CHANGES_ENV]: '0',
      })
      expect([blank.maxActors, blank.maxChanges]).toEqual([128, 512])
    } finally { warn.mockRestore() }
  })
})

describe('ordinaryHeadRotationConfig — chain fold (phase 4)', () => {
  const rotationOn = {
    [ORDINARY_HEAD_ROTATION_FLAG]: 'on',
    [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: 'l/v',
  }

  it.each([undefined, '', ' ', 'off'])('%j leaves the fold OFF: no chainFold at all', (value) => {
    expect(ordinaryHeadRotationConfig({ ...rotationOn, [ORDINARY_CHAIN_FOLD_FLAG]: value }).chainFold)
      .toBeUndefined()
  })

  it('on, with rotation on: the defaults', () => {
    expect(ordinaryHeadRotationConfig({ ...rotationOn, [ORDINARY_CHAIN_FOLD_FLAG]: 'on' }).chainFold).toEqual({
      minChain: DEFAULT_ORDINARY_CHAIN_FOLD_MIN,
      budget: DEFAULT_ORDINARY_CHAIN_FOLD_BUDGET,
      retainMs: DEFAULT_ORDINARY_CHAIN_FOLD_RETAIN_HOURS * 3_600_000,
    })
  })

  it('reads its knobs', () => {
    expect(ordinaryHeadRotationConfig({
      ...rotationOn, [ORDINARY_CHAIN_FOLD_FLAG]: 'on',
      [ORDINARY_CHAIN_FOLD_MIN_ENV]: '3', [ORDINARY_CHAIN_FOLD_BUDGET_ENV]: '5',
      [ORDINARY_CHAIN_FOLD_RETAIN_HOURS_ENV]: '2',
    }).chainFold).toEqual({ minChain: 3, budget: 5, retainMs: 7_200_000 })
  })

  it('a MIN below two falls back to the default: one segment is no chain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(ordinaryHeadRotationConfig({
        ...rotationOn, [ORDINARY_CHAIN_FOLD_FLAG]: 'on', [ORDINARY_CHAIN_FOLD_MIN_ENV]: '1',
      }).chainFold?.minChain).toBe(DEFAULT_ORDINARY_CHAIN_FOLD_MIN)
    } finally { warn.mockRestore() }
  })

  it.each(['shadow', undefined, 'off'])('on is REFUSED unless rotation is on (rotation %j)', (rotation) => {
    expect(() => ordinaryHeadRotationConfig({
      [ORDINARY_HEAD_ROTATION_FLAG]: rotation, [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: 'l/v',
      [ORDINARY_CHAIN_FOLD_FLAG]: 'on',
    })).toThrow(/needs AM_ORDINARY_HEAD_ROTATION=on/)
  })

  it.each(['yes', 'ON', 'shadow'])('throws on any other value: %j', (value) => {
    expect(() => ordinaryHeadRotationConfig({ ...rotationOn, [ORDINARY_CHAIN_FOLD_FLAG]: value }))
      .toThrow(/invalid-AM_ORDINARY_CHAIN_FOLD/)
  })
})

describe('OrdinaryHeadRotationObserver — thresholds', () => {
  it('fixtures carry exactly the counts they claim', () => {
    // Otherwise the boundary tests below are off by the fixture's own error.
    expect(A.stats(headWithActors(5))).toMatchObject({ numActors: 5, numChanges: 5 })
    expect(A.stats(headWithChanges(7))).toMatchObject({ numActors: 1, numChanges: 7 })
  })

  it('stats reads the live document, not the snapshot it is handed', () => {
    // Why the counts in a due line can be ahead of the projected sample: on
    // Automerge 3.2.6 an earlier snapshot shares the live wasm state.
    const snapshot = headWithChanges(3)
    A.change(snapshot, (d) => { d.objects.later = { id: 'later' } })
    expect(A.stats(snapshot).numChanges).toBe(4)
  })

  it('actors: 127 is quiet, 128 reports', () => {
    const below = observer(shadow({ maxChanges: 1_000_000 }))
    below.subject.observe('object', 'automerge:below', headWithActors(DEFAULT_ORDINARY_HEAD_MAX_ACTORS - 1))
    expect(below.lines).toEqual([])
    expect(statsCalls.count, 'the quiet answer came without looking').toBe(1)

    const at = observer(shadow({ maxChanges: 1_000_000 }))
    at.subject.observe('object', 'automerge:at', headWithActors(DEFAULT_ORDINARY_HEAD_MAX_ACTORS))
    expect(at.lines).toEqual([{
      event: 'read_model.ordinary_head_rotation_due',
      mode: 'shadow',
      workspace: LISTED,
      kind: 'object',
      url: 'automerge:at',
      numActors: 128,
      numChanges: 128,
      crossed: ['actors'],
      newlyCrossed: ['actors'],
      thresholds: { maxActors: 128, maxChanges: 1_000_000 },
    }])
  })

  it('changes: 511 is quiet, 512 reports', () => {
    const below = observer(shadow())
    below.subject.observe('connection', 'automerge:below', headWithChanges(DEFAULT_ORDINARY_HEAD_MAX_CHANGES - 1))
    expect(below.lines).toEqual([])

    const at = observer(shadow())
    at.subject.observe('connection', 'automerge:at', headWithChanges(DEFAULT_ORDINARY_HEAD_MAX_CHANGES))
    expect(at.lines).toHaveLength(1)
    expect(at.lines[0]).toMatchObject({
      kind: 'connection', numActors: 1, numChanges: 512, crossed: ['changes'],
      thresholds: { maxActors: 128, maxChanges: 512 },
    })
  })
})

describe('OrdinaryHeadRotationObserver — gates', () => {
  it('off computes no stats and says nothing, on a head far over both thresholds', () => {
    // Every other gate open, so `off` is the only thing that can keep it quiet.
    const { subject, lines } = observer({ ...ORDINARY_HEAD_ROTATION_OFF, allowlist: 'all', maxActors: 1, maxChanges: 1 })
    subject.observe('object', 'automerge:h', headWithActors(200))
    expect(lines).toEqual([])
    expect(statsCalls.count).toBe(0)
  })

  it('a workspace absent from the allow-list computes no stats', () => {
    const { subject, lines } = observer(shadow({ allowlist: new Set(['other/ws']) }))
    subject.observe('object', 'automerge:h', headWithActors(200))
    expect(lines).toEqual([])
    expect(statsCalls.count).toBe(0)
  })

  it('an empty allow-list observes nothing, * observes every workspace', () => {
    const empty = observer(shadow({ allowlist: new Set() }))
    empty.subject.observe('object', 'automerge:h', headWithActors(200))
    expect(empty.lines).toEqual([])
    const all = observer(shadow({ allowlist: 'all' }), { landscapeId: 'any', versionId: 'where' })
    all.subject.observe('object', 'automerge:h', headWithActors(200))
    expect(all.lines).toHaveLength(1)
    expect(all.lines[0].workspace).toBe('any/where')
  })

  it('a document that is not Automerge is skipped, not thrown', () => {
    const { subject, lines } = observer(shadow())
    expect(() => subject.observe('object', 'automerge:fake', { objects: {} })).not.toThrow()
    expect(() => subject.observe('object', 'automerge:none', undefined)).not.toThrow()
    expect(lines).toEqual([])
  })
})

describe('OrdinaryHeadRotationObserver — dedupe', () => {
  it('reports a crossing once per head, and stops looking once both are reported', () => {
    const { subject, lines } = observer(shadow({ maxActors: 3, maxChanges: 3 }))
    const head = headWithActors(4)
    subject.observe('object', 'automerge:h', head)
    subject.observe('object', 'automerge:h', head)
    subject.observe('object', 'automerge:h', A.change(head, (d) => { d.objects.extra = { id: 'extra' } }))
    expect(lines).toHaveLength(1)
    expect(lines[0].crossed).toEqual(['actors', 'changes'])
    expect(statsCalls.count, 'a fully reported head is still being inspected').toBe(1)
  })

  it('a second dimension crossing later on the same head reports once more, naming only it', () => {
    const { subject, lines } = observer(shadow({ maxActors: 3, maxChanges: 6 }))
    let head = headWithActors(3)
    subject.observe('object', 'automerge:h', head)
    for (let index = 0; index < 3; index += 1) {
      head = A.change(head, (d) => { d.objects[`more${index}`] = { id: `more${index}` } })
      subject.observe('object', 'automerge:h', head)
    }
    expect(lines.map((line) => line.newlyCrossed)).toEqual([['actors'], ['changes']])
    expect(lines[1].crossed).toEqual(['actors', 'changes'])
  })

  it('a different head is a different crossing', () => {
    const { subject, lines } = observer(shadow({ maxActors: 3 }))
    const head = headWithActors(3)
    subject.observe('object', 'automerge:one', head)
    subject.observe('connection', 'automerge:two', head)
    expect(lines.map((line) => line.url)).toEqual(['automerge:one', 'automerge:two'])
  })
})

describe('OrdinaryHeadRotationObserver — due (phase 3)', () => {
  it('answers due exactly at the threshold, on both dimensions, and stays due on every later pass', () => {
    const { subject: actors } = observer(shadow({ maxActors: 3, maxChanges: 1_000 }))
    expect(actors.observe('object', 'automerge:a', headWithActors(2))).toBe(false)
    expect(actors.observe('object', 'automerge:a', headWithActors(3))).toBe(true)
    // Already reported: still due, every pass, without a new log line.
    expect(actors.observe('object', 'automerge:a', headWithActors(3))).toBe(true)
    const { subject: changes } = observer(shadow({ maxActors: 1_000, maxChanges: 5 }))
    expect(changes.observe('object', 'automerge:c', headWithChanges(4))).toBe(false)
    expect(changes.observe('object', 'automerge:c', headWithChanges(5))).toBe(true)
  })

  it('a head reported on both dimensions is due without another stats call', () => {
    const { subject } = observer(shadow({ maxActors: 3, maxChanges: 3 }))
    const head = headWithActors(4)
    expect(subject.observe('object', 'automerge:h', head)).toBe(true)
    const calls = statsCalls.count
    expect(subject.observe('object', 'automerge:h', head)).toBe(true)
    expect(statsCalls.count).toBe(calls)
  })

  it('is never due when nothing is observed: off, not allow-listed, no document, not Automerge', () => {
    const head = headWithActors(4)
    expect(observer(ORDINARY_HEAD_ROTATION_OFF).subject.observe('object', 'automerge:h', head)).toBe(false)
    expect(observer(shadow({ maxActors: 3 }), { landscapeId: 'other', versionId: 'v' })
      .subject.observe('object', 'automerge:h', head)).toBe(false)
    const { subject } = observer(shadow({ maxActors: 3 }))
    expect(subject.observe('object', 'automerge:h', undefined)).toBe(false)
    expect(subject.observe('object', 'automerge:plain', { objects: {} })).toBe(false)
  })

  it('lastObserved (G4-16e): the counts of the last pass, for that head only', () => {
    const { subject } = observer(shadow({ maxActors: 3, maxChanges: 1_000 }))
    expect(subject.lastObserved('object', 'automerge:h')).toBeNull()
    subject.observe('object', 'automerge:h', headWithActors(2))
    expect(subject.lastObserved('object', 'automerge:h')).toEqual({ actors: 2, changes: 2 })
    // Another url, or the other kind, is not this head.
    expect(subject.lastObserved('object', 'automerge:other')).toBeNull()
    expect(subject.lastObserved('connection', 'automerge:h')).toBeNull()
    expect(subject.lastObserved('object', undefined)).toBeNull()
    // A later pass replaces the counts...
    subject.observe('object', 'automerge:h', headWithActors(4))
    expect(subject.lastObserved('object', 'automerge:h')).toEqual({ actors: 4, changes: 4 })
    // ...and a new head replaces the head.
    subject.observe('object', 'automerge:next', headWithChanges(1))
    expect(subject.lastObserved('object', 'automerge:h')).toBeNull()
    expect(subject.lastObserved('object', 'automerge:next')).toEqual({ actors: 1, changes: 1 })
    // Nothing observed, nothing recorded.
    const off = observer(ORDINARY_HEAD_ROTATION_OFF).subject
    off.observe('object', 'automerge:h', headWithActors(4))
    expect(off.lastObserved('object', 'automerge:h')).toBeNull()
  })

  it('trigger (G4-16e): the threshold the FIRST due pass crossed, kept once set', () => {
    const { subject } = observer(shadow({ maxActors: 3, maxChanges: 6 }))
    subject.observe('object', 'automerge:a', headWithActors(2))
    expect(subject.trigger('automerge:a')).toBeNull()
    // 3 actors, 3 changes: actors first...
    subject.observe('object', 'automerge:a', headWithActors(3))
    expect(subject.trigger('automerge:a')).toBe('actors')
    // ...and still actors once changes crosses too.
    subject.observe('object', 'automerge:a', headWithActors(7))
    expect(subject.trigger('automerge:a')).toBe('actors')
    subject.observe('object', 'automerge:c', headWithChanges(6))
    expect(subject.trigger('automerge:c')).toBe('changes')
    // Both on the same first pass.
    subject.observe('object', 'automerge:b', headWithActors(6))
    expect(subject.trigger('automerge:b')).toBe('both')
    expect(subject.trigger('automerge:never')).toBeNull()
  })

  it('takeTrigger forgets the head, and heads never taken are capped oldest-first', () => {
    const { subject } = observer(shadow({ maxActors: 1_000, maxChanges: 1 }))
    const due = headWithChanges(1)
    subject.observe('object', 'automerge:first', due)
    expect(subject.takeTrigger('automerge:first')).toBe('changes')
    expect(subject.trigger('automerge:first')).toBeNull()
    expect(subject.takeTrigger('automerge:first')).toBeNull()
    for (let index = 0; index <= MAX_REMEMBERED_TRIGGERS; index += 1) subject.observe('object', `automerge:h${index}`, due)
    // One more than the cap: the oldest went, the newest stayed.
    expect(subject.trigger('automerge:h0')).toBeNull()
    expect(subject.trigger('automerge:h1')).toBe('changes')
    expect(subject.trigger(`automerge:h${MAX_REMEMBERED_TRIGGERS}`)).toBe('changes')
  })

  it('rotates only under on, for an allow-listed workspace', () => {
    expect(observer(shadow()).subject.rotates).toBe(false)
    expect(observer(shadow({ mode: 'on' })).subject.rotates).toBe(true)
    expect(observer(shadow({ mode: 'on' }), { landscapeId: 'other', versionId: 'v' }).subject.rotates).toBe(false)
    expect(observer(shadow({ mode: 'on', allowlist: new Set() })).subject.rotates).toBe(false)
    expect(observer(ORDINARY_HEAD_ROTATION_OFF).subject.rotates).toBe(false)
  })
})

describe('OrdinaryHeadRotationObserver — cost', () => {
  it('stats stays cheap on a large history', () => {
    // 2000 actors x 10 changes = 20 000 changes. Scratch timing put one call
    // at ~1.5 µs at this size. The bound (1 ms per call on average) is loose
    // enough that a slow CI box cannot flake it; it catches a gross regression
    // in the per-pass cost, not a constant factor.
    const base = A.save(A.init<Shard>())
    let doc = A.load<Shard>(base)
    for (let actor = 0; actor < 2000; actor += 1) {
      let branch = A.load<Shard>(base)
      for (let change = 0; change < 10; change += 1) {
        branch = A.change(branch, (d) => {
          if (!d.objects) d.objects = {}
          d.objects[`o${actor}_${change}`] = { id: `o${actor}_${change}` }
        })
      }
      doc = A.merge(doc, branch)
    }
    expect(A.stats(doc).numChanges).toBe(20_000)
    const started = performance.now()
    for (let index = 0; index < 1000; index += 1) A.stats(doc)
    expect(performance.now() - started).toBeLessThan(1000)
  }, 120_000)
})
