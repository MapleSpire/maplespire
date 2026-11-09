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

import { describe, it, expect, vi } from 'vitest'
import * as A from '@automerge/automerge'
import type { DocumentId } from '@automerge/automerge-repo'
import {
  applyRetiredHeadForward,
  forwardRetiredHead,
  hasAllHeads,
  headsPrecede,
  planRetiredHeadForward,
  type RetiredHeadForwardPlanOutcome,
  type ForwardRetiredHeadArgs,
  type RetiredHeadForwardPlan,
} from './ordinaryHeadForwarding.js'
import type { Queryable } from './types.js'
import { envNumber } from '../envNumber.js'

/**
 * The forwarder's pure halves and its driver, on real Automerge documents and
 * a fake `Queryable`. The projector wiring and PostgreSQL are pinned by
 * `ordinaryHeadForwarding.integration.test.ts`.
 */

type Entity = { id: string; [field: string]: unknown }
type Head = { objects: Record<string, Entity>; writeBatchIds: string[]; forwardedBatchIds?: string[] }

const born = (objects: Record<string, Entity> = {}): A.Doc<Head> =>
  A.from<Head>({ objects, writeBatchIds: [] })

/** The retired head R at retirement (H_r) and after one late write. */
function lateWrite(
  initial: Record<string, Entity>,
  write: (doc: Head) => void,
): { retired: A.Doc<Head>; hr: string[] } {
  const atRetirement = born(initial)
  const hr = A.getHeads(atRetirement)
  return { retired: A.change(A.clone(atRetirement), write), hr }
}

const planOf = async (retired: A.Doc<Head>, hr: string[], tombstones: string[] = []): Promise<RetiredHeadForwardPlan> => {
  const outcome = await planRetiredHeadForward(retired, 'object', hr, new Set(tombstones))
  if (outcome.kind !== 'plan') throw new Error(`expected a plan, got ${outcome.kind}`)
  return outcome.plan
}

describe('planRetiredHeadForward', () => {
  it('is nothing when the retired head has not moved since the forwarding point', async () => {
    const doc = born({ x: { id: 'x', f: 'f0' } })
    await expect(planRetiredHeadForward(doc, 'object', A.getHeads(doc), new Set())).resolves.toEqual({ kind: 'nothing' })
  })

  it('REFUSES heads the document does not have — `A.diff` would return no patches, silently', async () => {
    const doc = A.change(born({ x: { id: 'x', f: 'f0' } }), (d) => { d.objects.x.f = 'fA' })
    const foreign = A.getHeads(A.change(born(), (d) => { d.objects.y = { id: 'y' } }))
    await expect(planRetiredHeadForward(doc, 'object', foreign, new Set()))
      .resolves.toEqual({ kind: 'unknown-heads', fromHeads: [...foreign].sort() })
  })

  it('carries each touched entity with its value at the forwarding point and now, and only the new batch ids', async () => {
    const { retired, hr } = lateWrite(
      { x: { id: 'x', f: 'f0', g: 'g0' }, quiet: { id: 'quiet', f: 'q' } },
      (d) => {
        d.writeBatchIds.push('a1')
        d.objects.x.f = 'fA'
        d.objects.born = { id: 'born', f: 'new' }
      },
    )
    const plan = await planOf(retired, hr)
    expect([...plan.entities.keys()].sort()).toEqual(['born', 'x'])
    expect(plan.entities.get('x')).toEqual({
      base: { id: 'x', f: 'f0', g: 'g0' },
      historical: { id: 'x', f: 'fA', g: 'g0' },
    })
    expect(plan.entities.get('born')).toEqual({ base: undefined, historical: { id: 'born', f: 'new' } })
    expect(plan.batchIds).toEqual(['a1'])
    expect(plan.fromHeads).toEqual([...hr].sort())
    expect(plan.toHeads).toEqual([...A.getHeads(retired)].sort())
  })

  it('does not forward a removed key or a tombstoned entity, but still plans past them', async () => {
    const { retired, hr } = lateWrite(
      { gone: { id: 'gone', f: 'f0' }, dead: { id: 'dead', f: 'f0' } },
      (d) => {
        delete d.objects.gone
        d.objects.dead.f = 'resurrect?'
      },
    )
    const plan = await planOf(retired, hr, ['dead'])
    expect(plan.entities.size).toBe(0)
    expect(plan.ignored.sort()).toEqual(['dead', 'gone'])
    expect(plan.toHeads).toEqual([...A.getHeads(retired)].sort())
  })

  it('counts forwarded batch ids of the retired head too (it may itself have been a forward target)', async () => {
    const { retired, hr } = lateWrite({}, (d) => { d.forwardedBatchIds = ['older-1'] })
    expect((await planOf(retired, hr)).batchIds).toEqual(['older-1'])
  })
})

/**
 * G4-16: the plan is sliced across macrotasks and reads the delta narrowly.
 * The reference below is the plan as it was — synchronous, `A.hasHeads`, the
 * whole `view(doc, from)` and the whole `A.diff` — and the new one must equal
 * it on every shape, including the ones that take the whole-document path.
 */
type Doc = Record<string, unknown>
function referencePlan(
  retiredDoc: unknown, collection: 'object' | 'connection', fromHeads: readonly string[], tombstones: ReadonlySet<string>,
): RetiredHeadForwardPlanOutcome {
  const isRecord = (value: unknown): value is Doc => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const batchIdsOf = (d: Doc | undefined): string[] => [
    ...((d?.writeBatchIds as string[] | undefined) ?? []), ...((d?.forwardedBatchIds as string[] | undefined) ?? []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0)
  const doc = retiredDoc as Doc
  const from = [...fromHeads].sort()
  const to = [...A.getHeads(doc as never)].sort()
  if (JSON.stringify(from) === JSON.stringify(to)) return { kind: 'nothing' }
  if (!A.hasHeads(doc as never, from)) return { kind: 'unknown-heads', fromHeads: from }
  const field = collection === 'object' ? 'objects' : 'connections'
  const before = A.view(doc as never, from) as Doc
  const touched = new Set<string>()
  let wholeCollection = false
  for (const patch of A.diff(doc as never, from, to)) {
    if (patch.path[0] !== field) continue
    if (patch.path.length >= 2) touched.add(String(patch.path[1]))
    else wholeCollection = true
  }
  const map = (d: Doc) => d[field] as Record<string, unknown> | undefined
  if (wholeCollection) {
    for (const id of Object.keys(map(before) ?? {})) touched.add(id)
    for (const id of Object.keys(map(doc) ?? {})) touched.add(id)
  }
  const entities = new Map<string, { base: Doc | undefined; historical: Doc }>()
  const ignored: string[] = []
  for (const id of touched) {
    const now = map(doc)?.[id]
    const then = map(before)?.[id]
    if (!isRecord(now) || tombstones.has(id)) { ignored.push(id); continue }
    const historical = copy(now)
    const base = isRecord(then) ? copy(then) : undefined
    if (base !== undefined && JSON.stringify(base) === JSON.stringify(historical)) { ignored.push(id); continue }
    entities.set(id, { base, historical })
  }
  const seen = new Set(batchIdsOf(before))
  const batchIds: string[] = []
  for (const id of batchIdsOf(doc)) {
    if (seen.has(id)) continue
    seen.add(id)
    batchIds.push(id)
  }
  return { kind: 'plan', plan: { fromHeads: from, toHeads: to, entities, batchIds, ignored } }
}

/** Order included: the entity map's insertion order is the write order. */
const serialized = (outcome: RetiredHeadForwardPlanOutcome) => outcome.kind === 'plan'
  ? { ...outcome, plan: { ...outcome.plan, entities: [...outcome.plan.entities.entries()] } }
  : outcome

/** The fleet bench's shape, small: fresh actors every cycle, the writes of a
 * round concurrent, one entity per writer, a batch id per write; then one
 * late round after H_r. */
function fleetLike(cycles = 3, writers = 4, rounds = 2): { retired: A.Doc<Head>; hr: string[] } {
  const ids = ['o0', 'o1', 'o2', 'o3']
  let hub = A.from<Head>({
    objects: Object.fromEntries(ids.map((id) => [id, { id, name: id, position: { x: 1, y: 2 }, tags: [], properties: {} }])),
    writeBatchIds: ['seed'],
  })
  const cycle = (c: number, roundsThis: number) => {
    const replicas = Array.from({ length: writers }, () => A.clone(hub))
    for (let r = 0; r < roundsThis; r++) {
      for (let w = 0; w < writers; w++) {
        replicas[w] = A.change(A.merge(replicas[w], hub), (d) => {
          const object = d.objects[ids[w % ids.length]]
          object[`u${w}`] = `c${c}r${r}`
          object.hot = `u${w}-c${c}r${r}`
          d.writeBatchIds.push(`b-c${c}-u${w}-r${r}`)
        })
      }
      for (const replica of replicas) hub = A.merge(hub, replica)
    }
  }
  for (let c = 0; c < cycles; c++) cycle(c, rounds)
  const hr = A.getHeads(hub)
  cycle(cycles, 1)
  return { retired: hub, hr }
}

/** Record the backend calls the plan makes on `doc` (the handle the
 * `A.*` functions call into), tagged. */
function spyBackend(doc: unknown, log: string[], tag = '') {
  const backend = A.getBackend(doc as never) as unknown as Record<string, (...args: unknown[]) => unknown>
  const names = ['getChangeByHash', 'getChangeMetaByHash', 'getWithType', 'diff', 'diffPath', 'materialize'] as const
  for (const name of names) {
    const original = backend[name].bind(backend)
    backend[name] = (...args: unknown[]) => {
      log.push(`${tag}${name}${name === 'materialize' || name === 'diffPath' || name === 'getWithType' ? `:${String(args[0])}` : ''}`)
      return original(...args)
    }
  }
  return () => { for (const name of names) delete backend[name] }
}

describe('planRetiredHeadForward — sliced and narrow (G4-16), exactly the whole-document plan', () => {
  const scenarios: Record<string, () => { retired: unknown; hr: string[]; collection?: 'object' | 'connection'; tombstones?: string[] }> = {
    'the fleet shape: concurrent writers, fresh actors': () => fleetLike(),
    'edits, a removed field, a removed key, a created entity, a tombstone': () => lateWrite(
      { x: { id: 'x', f: 'f0', meta: { a: 1 } }, gone: { id: 'gone' }, dead: { id: 'dead', f: 'f0' } },
      (d) => {
        d.objects.x.f = 'fA'
        delete (d.objects.x.meta as Record<string, unknown>).a
        delete d.objects.gone
        d.objects.dead.f = 'f1'
        d.objects.born = { id: 'born' }
        d.writeBatchIds.push('a1')
      },
    ),
    'field edits, a removed field, ONE removed key, a tombstone': () => lateWrite(
      { x: { id: 'x', f: 'f0', meta: { a: 1 } }, gone: { id: 'gone' }, dead: { id: 'dead', f: 'f0' } },
      (d) => {
        d.objects.x.f = 'fA'
        delete (d.objects.x.meta as Record<string, unknown>).a
        delete d.objects.gone
        d.objects.dead.f = 'f1'
      },
    ),
    'ONE created entity next to a field edit': () => lateWrite({ x: { id: 'x', f: 'f0' } }, (d) => {
      d.objects.x.f = 'fA'
      d.objects.born = { id: 'born', meta: { a: 1 } }
    }),
    'an entity edited and set back to its value at H_r': () => lateWrite({ x: { id: 'x', f: 'f0' } }, (d) => {
      d.objects.x.f = 'f1'
      d.objects.x.f = 'f0'
    }),
    'an entity deleted and re-created as a new map': () => lateWrite({ x: { id: 'x', f: 'f0', g: 'g0' } }, (d) => {
      d.objects.x = { id: 'x', f: 'f0', h: 'h1' }
    }),
    'the entity map REPLACED at the root (whole collection)': () => lateWrite({ x: { id: 'x', f: 'f0' }, y: { id: 'y' } }, (d) => {
      d.objects = { x: { id: 'x', f: 'f1' }, z: { id: 'z' } }
    }),
    'the entity map absent at H_r': () => {
      const atRetirement = A.from<Doc>({ writeBatchIds: [] })
      return { retired: A.change(A.clone(atRetirement), (d) => { d.objects = { x: { id: 'x' } } }), hr: A.getHeads(atRetirement) }
    },
    'several entities put at once (their order is the whole diff\'s)': () => lateWrite(
      { s: 'scalar' as never, l: [1, 2] as never, b: { id: 'b' }, a: { id: 'a' }, m: { id: 'm', n: new A.Counter(1) } as never },
      (d) => {
        ;(d.objects as Record<string, unknown>).s = { id: 's' }
        ;(d.objects as Record<string, unknown>).l = { id: 'l' }
        d.objects.b = { id: 'b2' }
        d.objects.a = { id: 'a2' }
        ;((d.objects.m as Record<string, unknown>).n as A.Counter).increment(2)
        ;(d.objects as Record<string, unknown>).m2 = 'now a scalar'
      },
    ),
    'a scalar THEN, a map NOW': () => lateWrite({ s: 'scalar' as never, x: { id: 'x', f: 'f0' } }, (d) => {
      ;(d.objects as Record<string, unknown>).s = { id: 's' }
      d.objects.x.f = 'f1'
    }),
    'a list THEN, a map NOW': () => lateWrite({ l: [1, 2] as never, x: { id: 'x', f: 'f0' } }, (d) => {
      ;(d.objects as Record<string, unknown>).l = { id: 'l' }
      d.objects.x.f = 'f1'
    }),
    'a map THEN, a scalar NOW': () => lateWrite({ x: { id: 'x', f: 'f0' }, y: { id: 'y' } }, (d) => {
      ;(d.objects as Record<string, unknown>).x = 'gone flat'
      d.objects.y.f = 'f1'
    }),
    'a counter incremented, a date and a list inside an entity': () => lateWrite(
      { m: { id: 'm', n: new A.Counter(1), at: new Date(0), tags: ['a'] } as never },
      (d) => {
        ;((d.objects.m as Record<string, unknown>).n as A.Counter).increment(2)
        ;((d.objects.m as Record<string, unknown>).tags as string[]).push('b')
        ;(d.objects.m as Record<string, unknown>).at = new Date(1)
      },
    ),
    'batch ids: a deletion, a duplicate of one at H_r, forwardedBatchIds created after H_r': () => {
      const atRetirement = A.from<Head>({ objects: { x: { id: 'x' } }, writeBatchIds: ['a', 'b', 'c'] })
      const retired = A.change(A.clone(atRetirement), (d) => {
        d.writeBatchIds.splice(0, 1)
        d.writeBatchIds.push('b', 'd')
        d.forwardedBatchIds = ['c', 'e']
      })
      return { retired, hr: A.getHeads(atRetirement) }
    },
    'batch ids not a list at H_r (a corrupted head)': () => {
      const atRetirement = A.from<Doc>({ objects: { x: { id: 'x' } }, writeBatchIds: 'oops', forwardedBatchIds: ['f'] })
      return { retired: A.change(A.clone(atRetirement), (d) => { d.writeBatchIds = ['ok'] }), hr: A.getHeads(atRetirement) }
    },
    'concurrent puts of the same entity by two writers': () => {
      const atRetirement = born({ x: { id: 'x', f: 'f0' } })
      const left = A.change(A.clone(atRetirement), (d) => { d.objects.x = { id: 'x', f: 'left' } })
      const right = A.change(A.clone(atRetirement), (d) => { d.objects.x.f = 'right'; d.objects.y = { id: 'y' } })
      return { retired: A.merge(left, right), hr: A.getHeads(atRetirement) }
    },
    'a text field spliced inside an entity': () => lateWrite({ x: { id: 'x', label: 'abc' } }, (d) => {
      A.splice(d, ['objects', 'x', 'label'], 1, 1, 'ZZ')
    }),
    'no entity touched: only the batch-id lists moved': () => lateWrite({ x: { id: 'x' } }, (d) => {
      d.writeBatchIds.push('w1')
      d.forwardedBatchIds = ['f1']
    }),
    'the connection collection': () => {
      const atRetirement = A.from<Doc>({ connections: { c: { id: 'c', fromId: 'a' } }, writeBatchIds: [] })
      const retired = A.change(A.clone(atRetirement), (d) => {
        ;((d.connections as Record<string, Doc>).c).fromId = 'b'
        ;(d.writeBatchIds as string[]).push('k')
      })
      return { retired, hr: A.getHeads(atRetirement), collection: 'connection' }
    },
  }

  /** The shapes that read the whole document at `from` (`view`); every other
   * one is planned narrowly. */
  const wholeDocument = new Set([
    'the entity map REPLACED at the root (whole collection)',
    'the entity map absent at H_r',
    'several entities put at once (their order is the whole diff\'s)',
    'edits, a removed field, a removed key, a created entity, a tombstone',
    'concurrent puts of the same entity by two writers',
    // Narrow up to the batch ids, then `view` for them.
    'batch ids not a list at H_r (a corrupted head)',
  ])

  for (const [name, make] of Object.entries(scenarios)) {
    it(`equals the whole-document plan: ${name}`, async () => {
      const { retired, hr, collection = 'object', tombstones = ['dead'] } = make()
      const expected = serialized(referencePlan(retired, collection, hr, new Set(tombstones)))
      expect(expected.kind).toBe('plan')
      const log: string[] = []
      const restore = spyBackend(retired, log)
      let outcome: RetiredHeadForwardPlanOutcome
      try {
        outcome = await planRetiredHeadForward(retired, collection, hr, new Set(tombstones))
      } finally {
        restore()
      }
      expect(serialized(outcome)).toEqual(expected)
      expect(log.includes('materialize:/'), 'read the whole document').toBe(wholeDocument.has(name))
    })
  }

  it('equals it from a forwarding point that is not H_r, and on a head reloaded from storage', async () => {
    const { retired, hr } = fleetLike()
    const reloaded = A.load<Head>(A.save(retired))
    const changes = A.getAllChanges(retired)
    const midway = [A.decodeChange(changes[Math.floor(changes.length / 2)]).hash!]
    for (const doc of [retired, reloaded]) {
      for (const from of [hr, midway]) {
        const expected = serialized(referencePlan(doc, 'object', from, new Set()))
        expect(expected.kind).toBe('plan')
        await expect(planRetiredHeadForward(doc, 'object', from, new Set()).then(serialized)).resolves.toEqual(expected)
      }
    }
  })

  it('on the fleet shape, never REBUILDS a change, never materialises nor diffs the whole document', async () => {
    const { retired, hr } = fleetLike()
    const log: string[] = []
    const restore = spyBackend(retired, log)
    try {
      expect((await planRetiredHeadForward(retired, 'object', hr, new Set())).kind).toBe('plan')
    } finally {
      restore()
    }
    expect(log.filter((call) => call === 'getChangeByHash')).toEqual([])
    expect(log.filter((call) => call === 'diff')).toEqual([])
    expect(log.filter((call) => call === 'materialize:/' || call === 'materialize:_root')).toEqual([])
    expect(log.filter((call) => call.startsWith('getChangeMetaByHash'))).toHaveLength(hr.length)
  })

  it('CONTROL — a replaced entity map, or several entities put at once, take the whole-document path', async () => {
    for (const name of [
      'the entity map REPLACED at the root (whole collection)',
      'several entities put at once (their order is the whole diff\'s)',
    ]) {
      const { retired, hr } = scenarios[name]()
      const log: string[] = []
      const restore = spyBackend(retired, log)
      try {
        await planRetiredHeadForward(retired, 'object', hr, new Set())
      } finally {
        restore()
      }
      // `view(doc, from)`; its `A.diff` may be served from the document's
      // last patch, which never reaches the backend.
      expect(log).toContain('materialize:/')
    }
  })

  // Widen in CI with FORWARD_PLAN_FUZZ_TRIALS (and move FORWARD_PLAN_FUZZ_SEED);
  // a failure names its trial, and the seed reproduces it.
  const fuzzSeed = envNumber('FORWARD_PLAN_FUZZ_SEED', { fallback: 20261105, minimum: 1, maximum: 0x7ffffffe, integer: true })
  const fuzzTrials = envNumber('FORWARD_PLAN_FUZZ_TRIALS', { fallback: 60, minimum: 1, maximum: 100_000, integer: true })
  it(`equals the whole-document plan on seeded random late writes (seed ${fuzzSeed}, ${fuzzTrials} trials)`, { timeout: Math.max(5_000, fuzzTrials * 100) }, async () => {
    let seed = fuzzSeed
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]
    for (let trial = 0; trial < fuzzTrials; trial++) {
      const ids = Array.from({ length: 3 + Math.floor(random() * 10) }, (_, i) => `e${String.fromCharCode(97 + Math.floor(random() * 26))}${i}`)
      const atRetirement = born(Object.fromEntries(ids.map((id) => [id, { id, name: id, pos: { x: 1 }, tags: ['t'], props: { k: 'v' } }])))
      const hr = A.getHeads(atRetirement)
      const replicas = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, w) => A.change(A.clone(atRetirement), (d) => {
        for (let e = 0; e < 1 + Math.floor(random() * 6); e++) {
          const id = pick(ids)
          const r = random()
          const entity = d.objects[id] as Record<string, unknown> | undefined
          if (r < 0.1) d.objects[`new${w}${e}`] = { id: 'new' }
          else if (r < 0.17) delete d.objects[id]
          else if (!entity) continue
          else if (r < 0.5) entity[`f${w}`] = `v${e}`
          else if (r < 0.65) (entity.pos as Record<string, number>).x = e
          else if (r < 0.75) (entity.tags as string[]).push(`t${e}`)
          else if (r < 0.85) delete (entity.props as Record<string, unknown>).k
          else entity.name = `w${w}e${e}`
        }
        d.writeBatchIds.push(`b${w}`)
      }))
      let retired = A.clone(atRetirement)
      for (const replica of replicas) retired = A.merge(retired, replica)
      const tombstones = new Set([pick(ids)])
      const outcome = await planRetiredHeadForward(retired, 'object', hr, tombstones)
      expect(serialized(outcome), `trial ${trial}`).toEqual(serialized(referencePlan(retired, 'object', hr, tombstones)))
    }
  })

  it('yields to the event loop between its phases: no two of its reads share a macrotask', async () => {
    const { retired, hr } = fleetLike()
    const log: string[] = []
    const restore = spyBackend(retired, log)
    let running = true
    const tick = () => { log.push('tick'); if (running) setImmediate(tick) }
    setImmediate(tick)
    try {
      const pending = planRetiredHeadForward(retired, 'object', hr, new Set())
      expect(pending).toBeInstanceOf(Promise)
      expect((await pending).kind).toBe('plan')
    } finally {
      running = false
      restore()
    }
    // The macrotasks that did the plan's reads: the head check, the entity
    // map's diff, the entities, and each batch-id list.
    const slices = log.join(' ').split('tick').map((slice) => slice.trim()).filter(Boolean)
    expect(slices.length).toBeGreaterThanOrEqual(5)
    expect(slices.filter((slice) => slice.includes('getChangeMetaByHash'))).toHaveLength(1)
    const subtreeDiff = slices.findIndex((slice) => /diffPath:(?!_root)/.test(slice))
    const headCheck = slices.findIndex((slice) => slice.includes('getChangeMetaByHash'))
    expect(subtreeDiff).toBeGreaterThan(headCheck)
  })

  it('two plans started together run one after the other, never two slices in one loop iteration', async () => {
    const first = fleetLike()
    const second = fleetLike()
    const log: string[] = []
    const restores = [spyBackend(first.retired, log, 'A:'), spyBackend(second.retired, log, 'B:')]
    let running = true
    const tick = () => { log.push('tick'); if (running) setImmediate(tick) }
    setImmediate(tick)
    try {
      await Promise.all([
        planRetiredHeadForward(first.retired, 'object', first.hr, new Set()),
        planRetiredHeadForward(second.retired, 'object', second.hr, new Set()),
      ])
    } finally {
      running = false
      for (const restore of restores) restore()
    }
    // `setImmediate` callbacks queued in one iteration run back to back, with
    // no timer between them: the ticker marks the iterations.
    // The calling macrotask holds both head checks (synchronous with `to`, by
    // design: 0.07 ms each); every slice after it holds one plan's reads.
    const [calling, ...slices] = log.join(' ').split('tick')
    expect(calling.trim().split(' ').every((call) => /^[AB]:getChangeMetaByHash$/.test(call))).toBe(true)
    expect(slices.filter((slice) => slice.includes('A:') && slice.includes('B:'))).toEqual([])
    expect(slices.filter((slice) => slice.includes('A:')).length).toBeGreaterThanOrEqual(5)
    const reads = log.filter((call) => !call.endsWith(':getChangeMetaByHash'))
    const lastA = reads.map((call) => call.startsWith('A:')).lastIndexOf(true)
    const firstB = reads.findIndex((call) => call.startsWith('B:'))
    expect(firstB).toBeGreaterThan(lastA)
  })

  it('plans over the value it was given while the handle advances between its slices', async () => {
    const { retired, hr } = fleetLike()
    const expected = serialized(referencePlan(retired, 'object', hr, new Set()))
    let advanced: A.Doc<Head> | undefined
    setImmediate(() => {
      // The handle's next change: `retired` becomes an outdated value.
      advanced = A.change(retired, (d) => {
        d.objects.o0.hot = 'after the snapshot'
        d.objects.late = { id: 'late' }
        d.writeBatchIds.push('after')
      })
    })
    const outcome = await planRetiredHeadForward(retired, 'object', hr, new Set())
    expect(advanced).toBeDefined()
    expect(A.getHeads(advanced!)).not.toEqual(A.getHeads(retired))
    expect(serialized(outcome)).toEqual(expected)
  })

  /** A retired head this process holds at T, and a change X after T made
   * ELSEWHERE (another process forwarded up to X and committed
   * `forwarded_heads = X`). */
  function behindTheRow() {
    const base = born({ x: { id: 'x', f: 'f0' } })
    const atT = A.change(A.clone(base), (d) => { d.objects.x.f = 'fT' })
    const elsewhere = A.change(A.clone(atT), (d) => { d.objects.x.f = 'fX'; d.writeBatchIds.push('bX') })
    return { atT, elsewhere, x: A.getHeads(elsewhere) }
  }

  it('REFUSES a `from` the handle learns WHILE the plan waits — never a backwards diff', async () => {
    for (const laneBusy of [false, true]) {
      const { atT, elsewhere, x } = behindTheRow()
      // Another plan holds the lane: this one waits for its turn.
      const busy = fleetLike()
      const ahead = laneBusy ? planRetiredHeadForward(busy.retired, 'object', busy.hr, new Set()) : Promise.resolve()
      let merged = false
      // X reaches the handle (a sync, a durable merge) one iteration later.
      setImmediate(() => { A.merge(atT, elsewhere); merged = true })
      const outcome = await planRetiredHeadForward(atT, 'object', x, new Set())
      await ahead
      await new Promise((resolve) => setImmediate(resolve))
      expect(merged, `lane busy: ${laneBusy}`).toBe(true)
      expect(outcome, `lane busy: ${laneBusy}`).toEqual({ kind: 'unknown-heads', fromHeads: [...x].sort() })
    }
  })

  it('REFUSES a `from` the document holds but AFTER `to` (an outdated value): the diff would run backwards', async () => {
    const { atT, elsewhere, x } = behindTheRow()
    const advanced = A.merge(atT, elsewhere) // `atT` is now an outdated value at T
    expect(A.hasHeads(advanced, x)).toBe(true)
    await expect(planRetiredHeadForward(atT, 'object', x, new Set()))
      .resolves.toEqual({ kind: 'unknown-heads', fromHeads: [...x].sort() })
  })

  it('REFUSES a `from` CONCURRENT with `to` (known, not its ancestor)', async () => {
    const base = born({ x: { id: 'x', f: 'f0' }, y: { id: 'y', f: 'f0' } })
    const atT = A.change(A.clone(base), (d) => { d.objects.x.f = 'fT' })
    const branch = A.change(A.clone(base), (d) => { d.objects.y.f = 'fY' })
    const y = A.getHeads(branch)
    A.merge(atT, branch) // the handle holds Y; the value `atT` does not
    expect(headsPrecede(atT, y, A.getHeads(atT))).toBe(false)
    expect(headsPrecede(atT, A.getHeads(base), A.getHeads(atT))).toBe(true)
    await expect(planRetiredHeadForward(atT, 'object', y, new Set()))
      .resolves.toEqual({ kind: 'unknown-heads', fromHeads: [...y].sort() })
  })

  it('checks the heads in the same synchronous step as `to`, before any yield', () => {
    const { retired, hr } = fleetLike()
    const log: string[] = []
    const restore = spyBackend(retired, log)
    try {
      void planRetiredHeadForward(retired, 'object', hr, new Set())
      expect(log.filter((call) => call === 'getChangeMetaByHash')).toHaveLength(hr.length)
    } finally {
      restore()
    }
  })

  it('is abandoned, reading nothing, when `proceed` says no at its turn', async () => {
    const { retired, hr } = fleetLike()
    const log: string[] = []
    const restore = spyBackend(retired, log)
    try {
      await expect(planRetiredHeadForward(retired, 'object', hr, new Set(), { proceed: () => false }))
        .resolves.toEqual({ kind: 'abandoned' })
    } finally {
      restore()
    }
    expect(log.filter((call) => call.startsWith('diffPath') || call.startsWith('materialize'))).toEqual([])
  })

  it('falls back to the whole-document path when the narrow read THROWS, and logs it', async () => {
    const { retired, hr } = fleetLike()
    const expected = serialized(referencePlan(retired, 'object', hr, new Set()))
    const backend = A.getBackend(retired) as unknown as Record<string, (...args: unknown[]) => unknown>
    const original = backend.diffPath.bind(backend)
    backend.diffPath = (path: unknown, ...rest: unknown[]) => {
      if (path !== '_root') throw new Error('diffPath drifted')
      return original(path, ...rest)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let path: string | undefined
    let warned: string | undefined
    try {
      const outcome = await planRetiredHeadForward(retired, 'object', hr, new Set(), { timing: (t) => { path = t.path } })
      expect(serialized(outcome)).toEqual(expected)
      warned = warn.mock.calls.map((call) => String(call[0])).join('\n')
    } finally {
      delete backend.diffPath
      warn.mockRestore()
    }
    expect(path).toBe('wide')
    expect(warned).toContain('ordinary_head_forward_narrow_failed')
  })

  it('falls back to the whole-document path if diffPath paths ever come back RELATIVE (never an empty plan)', async () => {
    const { retired, hr } = fleetLike()
    const expected = serialized(referencePlan(retired, 'object', hr, new Set()))
    const backend = A.getBackend(retired) as unknown as Record<string, (...args: unknown[]) => unknown>
    const original = backend.diffPath.bind(backend)
    backend.diffPath = (path: unknown, ...rest: unknown[]) => {
      const patches = original(path, ...rest) as Array<{ path: unknown[] }>
      return path === '_root' ? patches : patches.map((patch) => ({ ...patch, path: patch.path.slice(1) }))
    }
    let path: string | undefined
    try {
      const outcome = await planRetiredHeadForward(retired, 'object', hr, new Set(), { timing: (t) => { path = t.path } })
      expect(serialized(outcome)).toEqual(expected)
    } finally {
      delete backend.diffPath
    }
    expect(path).toBe('wide')
  })

  it('slices the entity reads by TIME: past the budget, the next entity waits for the next iteration', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const { retired, hr } = lateWrite(
      Object.fromEntries(ids.map((id) => [id, { id, f: 'f0' }])),
      (d) => { for (const id of ids) d.objects[id].f = 'f1' },
    )
    const entitySlices = async (clock?: () => number) => {
      const log: string[] = []
      const restore = spyBackend(retired, log)
      const now = clock ? vi.spyOn(performance, 'now').mockImplementation(clock) : undefined
      let running = true
      const tick = () => { log.push('tick'); if (running) setImmediate(tick) }
      setImmediate(tick)
      try {
        expect((await planRetiredHeadForward(retired, 'object', hr, new Set())).kind).toBe('plan')
      } finally {
        running = false
        now?.mockRestore()
        restore()
      }
      // An entity read at `from`: a map materialised by its own object id.
      // (The batch-id lists are read from the root: `getWithType:_root`.)
      return log.join(' ').split('tick').filter((slice) => /materialize:(?!_root|\/)/.test(slice) && !slice.includes('getWithType:_root')).length
    }
    // A real clock: six small entities fit in one slice.
    expect(await entitySlices()).toBe(1)
    // A clock that jumps 5 ms per reading: every entity is past the budget.
    let fake = 0
    expect(await entitySlices(() => (fake += 5))).toBe(ids.length)
  })
})

/** QA of 53201bf8 (G4-16): the killing assertions, adapted to the synchronous
 * head check and the time-budgeted entity slices; each keeps what it proves. */
describe('planRetiredHeadForward — QA assertions (G4-16)', () => {
  type Shape = Record<string, unknown>
  const late = (initial: Shape, write: (d: Shape) => void) => {
    const atRetirement = A.from<Shape>({ writeBatchIds: [], ...initial })
    return { retired: A.change(A.clone(atRetirement), write as never), hr: A.getHeads(atRetirement) }
  }
  const equalsReference = async (retired: unknown, hr: string[], tombstones: string[] = []) => {
    const expected = serialized(referencePlan(retired, 'object', hr, new Set(tombstones)))
    const outcome = await planRetiredHeadForward(retired, 'object', hr, new Set(tombstones))
    expect(serialized(outcome)).toEqual(expected)
    return outcome
  }
  const withTicks = async (log: string[], run: () => Promise<unknown>) => {
    let running = true
    const tick = () => { log.push('tick'); if (running) setImmediate(tick) }
    setImmediate(tick)
    try {
      return await run()
    } finally {
      running = false
    }
  }
  const timeout = <T>(p: Promise<T>) => Promise.race([
    p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lane wedged')), 1000)),
  ])

  it('P1 a plan that THROWS does not wedge the lane: plans queued before and started after still resolve', async () => {
    const ok = late({ objects: { x: { id: 'x', f: 'f0' } } }, (d) => { (d.objects as Record<string, Entity>).x.f = 'fA' })
    // Refused before the lane (malformed heads: the synchronous head check
    // throws), and thrown INSIDE the lane (its turn's `proceed`).
    const malformed = planRetiredHeadForward(ok.retired, 'object', ['zz'], new Set())
    const inside = planRetiredHeadForward(ok.retired, 'object', ok.hr, new Set(), {
      proceed: () => { throw new Error('boom inside the lane') },
    })
    const queued = planRetiredHeadForward(ok.retired, 'object', ok.hr, new Set())
    await expect(malformed).rejects.toBeDefined()
    await expect(inside).rejects.toThrow('boom inside the lane')
    expect((await timeout(queued)).kind).toBe('plan')
    expect((await timeout(planRetiredHeadForward(ok.retired, 'object', ok.hr, new Set()))).kind).toBe('plan')
  })

  for (const failing of [0, 1]) {
    it(`P2 a diffPath that throws (call #${failing}) is answered with the whole-document plan, never a quiet empty one`, async () => {
      const { retired, hr } = late({ objects: { x: { id: 'x', f: 'f0' } } }, (d) => { (d.objects as Record<string, Entity>).x.f = 'fA' })
      const backend = A.getBackend(retired as never) as unknown as Record<string, (...args: unknown[]) => unknown>
      const original = backend.diffPath.bind(backend)
      let calls = 0
      backend.diffPath = (...args: unknown[]) => { if (calls++ === failing) throw new Error('boom'); return original(...args) }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let outcome: RetiredHeadForwardPlanOutcome
      try {
        outcome = await planRetiredHeadForward(retired, 'object', hr, new Set())
      } finally {
        delete backend.diffPath
        warn.mockRestore()
      }
      expect(calls).toBeGreaterThan(failing)
      expect(serialized(outcome)).toEqual(serialized(referencePlan(retired, 'object', hr, new Set())))
      expect(outcome.kind === 'plan' && outcome.plan.entities.size).toBe(1)
    })
  }

  it('P3 the entity loop is bounded per macrotask (by time) and is not one entity per macrotask', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `e${i}`)
    const { retired, hr } = late(
      { objects: Object.fromEntries(ids.map((id) => [id, { id, f: 'f0' }])) },
      (d) => { for (const id of ids) (d.objects as Record<string, Entity>)[id].f = 'fA' },
    )
    const entityReadsPerSlice = async (clock?: () => number) => {
      const log: string[] = []
      const restore = spyBackend(retired, log)
      const now = clock ? vi.spyOn(performance, 'now').mockImplementation(clock) : undefined
      try {
        await withTicks(log, async () => expect((await planRetiredHeadForward(retired, 'object', hr, new Set())).kind).toBe('plan'))
      } finally {
        now?.mockRestore()
        restore()
      }
      return log.join(' ').split('tick').map((slice) => slice.trim().split(' ')
        .filter((call) => call.startsWith('materialize:') && call !== 'materialize:_root' && call !== 'materialize:/').length)
        .filter((n) => n > 0)
    }
    // A clock that reads 1 ms later each time: a 4 ms budget holds 4 entities.
    let fake = 0
    const bounded = await entityReadsPerSlice(() => (fake += 1))
    expect(Math.max(...bounded)).toBeLessThanOrEqual(4)
    expect(bounded.reduce((sum, n) => sum + n, 0)).toBe(ids.length + 1) // + the writeBatchIds list
    // The real clock: 100 small entities share a few slices.
    expect((await entityReadsPerSlice()).length).toBeLessThan(ids.length / 2)
  })

  it('P4 the whole-document path yields before `view` too: the head check and the view do not share a macrotask', async () => {
    const { retired, hr } = late({ objects: { x: { id: 'x' } } }, (d) => { d.objects = { x: { id: 'x', f: 1 } } })
    const log: string[] = []
    const restore = spyBackend(retired, log)
    try {
      await withTicks(log, () => planRetiredHeadForward(retired, 'object', hr, new Set()))
    } finally {
      restore()
    }
    expect(log).toContain('materialize:/')
    const slices = log.join(' ').split('tick').map((s) => s.trim()).filter(Boolean)
    expect(slices.filter((s) => s.includes('getChangeMetaByHash') && s.includes('materialize:/'))).toEqual([])
  })

  it('P11 unknown heads are refused BEFORE any diff / entity read touches the document', async () => {
    const { retired } = late({ objects: { x: { id: 'x', f: 'f0' } } }, (d) => { (d.objects as Record<string, Entity>).x.f = 'fA' })
    const foreign = A.getHeads(A.from<Shape>({ other: 1 }))
    const log: string[] = []
    const restore = spyBackend(retired, log)
    try {
      expect((await planRetiredHeadForward(retired, 'object', foreign, new Set())).kind).toBe('unknown-heads')
    } finally {
      restore()
    }
    expect(log.filter((call) => !call.startsWith('getChangeMetaByHash'))).toEqual([])
  })

  it('P5 a batch id that is new twice (own and forwarded list, or pushed twice) is planned once', async () => {
    const { retired, hr } = late({ objects: { x: { id: 'x' } } }, (d) => {
      ;(d.writeBatchIds as string[]).push('n', 'n')
      d.forwardedBatchIds = ['n', 'm', 'm']
    })
    const outcome = await equalsReference(retired, hr)
    expect(outcome.kind === 'plan' && outcome.plan.batchIds).toEqual(['n', 'm'])
  })

  it('P6 an entity that was a counter / a date at H_r (not a map) and is a map now', async () => {
    const { retired, hr } = late({ objects: { k: new A.Counter(1), d: new Date(0), x: { id: 'x' } } }, (d) => {
      ;(d.objects as Record<string, unknown>).k = { id: 'k' }
      ;(d.objects as Record<string, Entity>).x.f = 1
    })
    await equalsReference(retired, hr)
  })

  for (const [name, objects] of Object.entries({ 'a scalar': 'oops', 'a list': [1, 2], 'a counter': new A.Counter(1) })) {
    it(`P7 the entity map is ${name} at both ends: whole-document plan, no throw, no diffPath on a non-object`, async () => {
      const { retired, hr } = late({ objects }, (d) => { (d.writeBatchIds as string[]).push('b1') })
      const log: string[] = []
      const restore = spyBackend(retired, log)
      try {
        await equalsReference(retired, hr)
      } finally {
        restore()
      }
      expect(log.filter((call) => call.startsWith('diffPath:') && call !== 'diffPath:_root')).toEqual([])
    })
  }

  it('P8 the entity map is absent at both ends', async () => {
    const { retired, hr } = late({}, (d) => { (d.writeBatchIds as string[]).push('b1') })
    const outcome = await equalsReference(retired, hr)
    expect(outcome.kind === 'plan' && outcome.plan.batchIds).toEqual(['b1'])
  })

  it('P9 the entity map is replaced by a CONCURRENT writer that wins/loses the root conflict', async () => {
    const atRetirement = A.from<Shape>({ objects: { x: { id: 'x', f: 'f0' } }, writeBatchIds: [] })
    const hr = A.getHeads(atRetirement)
    const left = A.change(A.clone(atRetirement), (d) => { d.objects = { x: { id: 'x', f: 'L' } } })
    const right = A.change(A.clone(atRetirement), (d) => { d.objects = { x: { id: 'x', f: 'R' }, y: { id: 'y' } } })
    await equalsReference(A.merge(A.clone(left), right), hr)
    await equalsReference(A.merge(A.clone(right), left), hr)
    // And only a loser: the same map object wins at both ends.
    const first = A.change(A.clone(atRetirement), (d) => { (d.objects as Record<string, Entity>).x.f = 'F' })
    await equalsReference(A.merge(A.clone(first), right), A.getHeads(first))
    await equalsReference(A.merge(A.clone(right), first), A.getHeads(first))
  })

  it('P10 an entity put + several field edits across many entities keeps the whole diff\'s write order', async () => {
    const ids = ['m', 'c', 'z', 'a', 'q']
    const { retired, hr } = late({ objects: Object.fromEntries(ids.map((id) => [id, { id, f: 0 }])) }, (d) => {
      for (const id of [...ids].reverse()) (d.objects as Record<string, Entity>)[id].f = 1
      ;(d.objects as Record<string, Entity>).newest = { id: 'newest' }
    })
    await equalsReference(retired, hr)
  })
})

describe('hasAllHeads — exactly `A.hasHeads`, without rebuilding the changes', () => {
  const atRetirement = born({ x: { id: 'x', f: 'f0' } })
  const one = A.change(A.clone(atRetirement), (d) => { d.objects.x.f = 'f1' })
  const two = A.change(A.clone(one), (d) => { d.objects.x.f = 'f2' })
  // `two`'s change without its dependency: QUEUED, not in the history.
  const [queuedChange] = A.getChanges(one, two)
  const [withQueue] = A.applyChanges(A.clone(atRetirement), [queuedChange])
  const queued = A.decodeChange(queuedChange).hash!
  const known = A.getHeads(atRetirement)[0]
  const foreign = A.getHeads(born({ y: { id: 'y' } }))[0]

  for (const [name, heads] of Object.entries({
    known: [known], foreign: [foreign], queued: [queued], 'known and queued': [known, queued], none: [] as string[],
  })) {
    it(`agrees with A.hasHeads: ${name}`, () => {
      expect(hasAllHeads(withQueue, heads)).toBe(A.hasHeads(withQueue, heads))
    })
  }

  it('says false for a QUEUED hash, where getMissingDeps would not name it (why it is not used)', () => {
    expect(hasAllHeads(withQueue, [queued])).toBe(false)
    expect(A.getMissingDeps(withQueue, [queued])).not.toContain(queued)
  })

  it('throws on a malformed hash, as A.hasHeads does', () => {
    expect(() => A.hasHeads(withQueue, ['zz'])).toThrow()
    expect(() => hasAllHeads(withQueue, ['zz'])).toThrow()
  })

  it('never calls getChangeByHash', () => {
    const log: string[] = []
    const restore = spyBackend(withQueue, log)
    try {
      hasAllHeads(withQueue, [known, queued, foreign])
    } finally {
      restore()
    }
    expect(log).not.toContain('getChangeByHash')
  })
})

describe('applyRetiredHeadForward — per field, never a whole-entity copy over a present entity', () => {
  it('writes an entity ABSENT from the current head whole, merged against what the other segments serve', async () => {
    const { retired, hr } = lateWrite({ x: { id: 'x', f: 'f0', g: 'g0' } }, (d) => { d.objects.x.f = 'fA' })
    const plan = await planOf(retired, hr)
    let applied: ReturnType<typeof applyRetiredHeadForward> | undefined
    const current = A.change(born(), (d) => {
      applied = applyRetiredHeadForward(d, 'object', plan, () => ({ id: 'x', f: 'fA', g: 'g0' }))
    })
    expect(current.objects.x).toEqual({ id: 'x', f: 'fA', g: 'g0' })
    expect(applied).toMatchObject({ written: ['x'], created: ['x'], conflicts: [] })
  })

  it('merges into a PRESENT entity leaf by leaf, so a peer writing into the same map concurrently keeps its field', async () => {
    const { retired, hr } = lateWrite({ x: { id: 'x', f: 'f0', g: 'g0' } }, (d) => { d.objects.x.f = 'fA' })
    const plan = await planOf(retired, hr)
    // The current head already holds x (B's first write); B then goes offline
    // and sets x.h in ITS copy while the server forwards A's x.f.
    const shared = born({ x: { id: 'x', f: 'f0', g: 'gB' } })
    const peer = A.change(A.clone(shared), (d) => { d.objects.x.h = 'hB' })
    const server = A.change(A.clone(shared), (d) => {
      applyRetiredHeadForward(d, 'object', plan, () => undefined)
    })
    const merged = A.merge(A.clone(server), peer)
    expect(merged.objects.x).toEqual({ id: 'x', f: 'fA', g: 'gB', h: 'hB' })
  })

  it('CONTROL — a whole-entity assignment of the same merged value loses the concurrent peer field', () => {
    // The mutant the test above exists for, written out: same JSON, new map.
    const shared = born({ x: { id: 'x', f: 'f0', g: 'gB' } })
    const peer = A.change(A.clone(shared), (d) => { d.objects.x.h = 'hB' })
    const server = A.change(A.clone(shared), (d) => { d.objects.x = { id: 'x', f: 'fA', g: 'gB' } })
    expect(A.merge(A.clone(server), peer).objects.x).toEqual({ id: 'x', f: 'fA', g: 'gB' })
  })

  it('keeps the current head at a same-field divergence and reports it', async () => {
    const { retired, hr } = lateWrite({ x: { id: 'x', f: 'f0', g: 'g0' } }, (d) => {
      d.objects.x.f = 'fA'
      d.objects.x.g = 'gA'
    })
    const plan = await planOf(retired, hr)
    let applied: ReturnType<typeof applyRetiredHeadForward> | undefined
    const current = A.change(born({ x: { id: 'x', f: 'f0', g: 'gB' } }), (d) => {
      applied = applyRetiredHeadForward(d, 'object', plan, () => undefined)
    })
    expect(current.objects.x).toEqual({ id: 'x', f: 'fA', g: 'gB' })
    expect(applied?.conflicts).toEqual([{ entityId: 'x', paths: ['g'] }])
  })

  it('forwards a field the late writer REMOVED, and descends into nested maps', async () => {
    const { retired, hr } = lateWrite(
      { x: { id: 'x', note: 'n', meta: { a: 1, b: 1 } } },
      (d) => {
        delete d.objects.x.note
        ;(d.objects.x.meta as { a: number }).a = 2
      },
    )
    const plan = await planOf(retired, hr)
    const shared = born({ x: { id: 'x', note: 'n', meta: { a: 1, b: 1 } } })
    const peer = A.change(A.clone(shared), (d) => { (d.objects.x.meta as { b: number }).b = 9 })
    const server = A.change(A.clone(shared), (d) => {
      applyRetiredHeadForward(d, 'object', plan, () => undefined)
    })
    expect(A.merge(A.clone(server), peer).objects.x).toEqual({ id: 'x', meta: { a: 2, b: 9 } })
  })

  it('merges an entity CREATED on both sides field by field against the empty record', async () => {
    const { retired, hr } = lateWrite({}, (d) => { d.objects.n = { id: 'n', f: 'fA' } })
    const plan = await planOf(retired, hr)
    const current = A.change(born({ n: { id: 'n', g: 'gB' } }), (d) => {
      applyRetiredHeadForward(d, 'object', plan, () => undefined)
    })
    expect(current.objects.n).toEqual({ id: 'n', f: 'fA', g: 'gB' })
  })

  it('pushes each batch id once, so a replay adds none', async () => {
    const { retired, hr } = lateWrite({ x: { id: 'x', f: 'f0' } }, (d) => {
      d.writeBatchIds.push('a1')
      d.objects.x.f = 'fA'
    })
    const plan = await planOf(retired, hr)
    const once = A.change(born(), (d) => { applyRetiredHeadForward(d, 'object', plan, () => ({ id: 'x', f: 'fA' })) })
    let replay: ReturnType<typeof applyRetiredHeadForward> | undefined
    const twice = A.change(A.clone(once), (d) => {
      replay = applyRetiredHeadForward(d, 'object', plan, () => ({ id: 'x', f: 'fA' }))
    })
    expect(twice.forwardedBatchIds).toEqual(['a1'])
    expect(replay).toMatchObject({ written: [], batchIdsAdded: [] })
    // A replay that writes nothing makes no Automerge change at all.
    expect(A.getHeads(twice)).toEqual(A.getHeads(once))
  })
})

describe('forwardRetiredHead — the driver', () => {
  const docId = (id: string) => id as DocumentId
  function fakeDb(initial: Record<string, unknown> | null, casHits = true) {
    const queries: Array<{ text: string; params?: unknown[] }> = []
    let row = initial
    const db: Queryable = {
      query: async (text: string, params?: unknown[]) => {
        queries.push({ text, params })
        if (/SELECT collection, document_id/.test(text)) return { rows: row ? [row] as never[] : [], rowCount: row ? 1 : 0 }
        if (/UPDATE read_model_ordinary_head_retirements/.test(text)) return { rows: [], rowCount: casHits ? 1 : 0 }
        return { rows: [], rowCount: 0 }
      },
    }
    return { db, queries, setRow: (next: Record<string, unknown> | null) => { row = next } }
  }

  function harness(overrides: Partial<ForwardRetiredHeadArgs> & { row?: Record<string, unknown> | null } = {}) {
    const { retired, hr } = lateWrite({ x: { id: 'x', f: 'f0', g: 'g0' } }, (d) => {
      d.writeBatchIds.push('a1')
      d.objects.x.f = 'fA'
    })
    const row = overrides.row === undefined
      ? { collection: 'object', document_id: 'R', retirement_heads: hr, forwarded_heads: null, status: 'retired' }
      : overrides.row
    const { db, queries, setRow } = fakeDb(row)
    let currentDoc = born({ x: { id: 'x', f: 'f0', g: 'gB' } })
    const events: string[] = []
    const flushed: string[][] = []
    const args: ForwardRetiredHeadArgs = {
      db,
      key: { landscapeId: 'ls', versionId: 'v' },
      collection: 'object',
      retired: { documentId: docId('R'), doc: () => retired },
      current: async () => ({
        documentId: docId('C'),
        doc: () => currentDoc,
        change: (callback) => {
          events.push('change')
          currentDoc = A.change(currentDoc, (d) => callback(d))
        },
      }),
      servedElsewhere: async () => new Map(),
      tombstones: () => new Set(),
      mayWrite: () => true,
      assertAuthority: async () => { events.push('authority') },
      flush: async (documentIds) => { events.push('flush'); flushed.push([...documentIds]) },
      commit: async (write) => { events.push('commit'); await write(db) },
      log: () => {},
      ...overrides,
    }
    return { args, events, flushed, queries, setRow, current: () => currentDoc, hr, retired }
  }

  it('flushes the RETIRED head as well as the current one before committing: forwarded_heads names the retired head\'s heads', async () => {
    const h = harness()
    await expect(forwardRetiredHead(h.args)).resolves.toBe('forwarded')
    expect(h.flushed).toHaveLength(1)
    expect([...h.flushed[0]].sort()).toEqual(['C', 'R'])
    expect(h.events.indexOf('flush')).toBeLessThan(h.events.indexOf('commit'))
  })

  it('checks authority, writes, flushes, THEN commits forwarded_heads from the value it started from', async () => {
    const h = harness()
    await expect(forwardRetiredHead(h.args)).resolves.toBe('forwarded')
    expect(h.events).toEqual(['authority', 'change', 'flush', 'commit'])
    expect(h.current().objects.x).toEqual({ id: 'x', f: 'fA', g: 'gB' })
    const update = h.queries.filter((q) => /UPDATE read_model_ordinary_head_retirements/.test(q.text))
    expect(update).toHaveLength(1)
    expect(update[0].params?.[4]).toBeNull()
    expect(update[0].params?.[5]).toEqual([...A.getHeads(h.retired)].sort())
  })

  it('writes NOTHING when ownership is gone at entry', async () => {
    const h = harness({ mayWrite: () => false })
    await expect(forwardRetiredHead(h.args)).resolves.toBe('not-owner')
    expect(h.events).toEqual([])
    expect(h.queries).toHaveLength(0)
  })

  it('writes NOTHING when ownership is lost DURING the forward (re-read synchronously before the change)', async () => {
    let owned = true
    const h = harness({
      mayWrite: () => owned,
      servedElsewhere: async () => new Map(),
      // Lost while the current head resolves: after the entry check and the
      // database reads, before the CRDT write.
      current: async () => {
        owned = false
        return {
          documentId: docId('C'),
          doc: () => h.current(),
          change: () => { throw new Error('must not change') },
        }
      },
    })
    await expect(forwardRetiredHead(h.args)).resolves.toBe('not-owner')
    expect(h.events).toEqual(['authority'])
    expect(h.queries.some((q) => /UPDATE/.test(q.text))).toBe(false)
  })

  it('does not even PLAN when ownership is lost while the plan waits for its turn', async () => {
    let reads = 0
    const h = harness({ mayWrite: () => ++reads === 1 })
    const log: string[] = []
    const restore = spyBackend(h.retired, log)
    try {
      await expect(forwardRetiredHead(h.args)).resolves.toBe('not-owner')
    } finally {
      restore()
    }
    expect(h.events).toEqual(['authority'])
    expect(log.filter((call) => call.startsWith('diffPath') || call.startsWith('materialize'))).toEqual([])
  })

  it('logs the plan lane wait, the plan duration and its path on the forward line', async () => {
    const lines: string[] = []
    const h = harness({ log: (line) => { lines.push(line) } })
    await expect(forwardRetiredHead(h.args)).resolves.toBe('forwarded')
    const line = JSON.parse(lines.find((l) => l.includes('ordinary_head_forwarded'))!)
    expect(line).toMatchObject({ planPath: 'narrow' })
    expect(typeof line.planLaneWaitMs).toBe('number')
    expect(typeof line.planMs).toBe('number')
  })

  it('writes NOTHING when the authority check throws', async () => {
    const h = harness({ assertAuthority: async () => { throw new Error('write fence lost') } })
    await expect(forwardRetiredHead(h.args)).rejects.toThrow('write fence lost')
    expect(h.events).toEqual([])
  })

  it('does nothing for a row without H_r or not retired — the projector projects those directly', async () => {
    for (const row of [
      null,
      { collection: 'object', document_id: 'R', retirement_heads: null, forwarded_heads: null, status: 'admitted' },
    ]) {
      const h = harness({ row })
      await expect(forwardRetiredHead(h.args)).resolves.toBe('not-retired')
      expect(h.events).toEqual(['authority'])
    }
  })

  it('starts from forwarded_heads when present, and is nothing once they equal the retired head', async () => {
    const caughtUp = harness()
    caughtUp.setRow({
      collection: 'object', document_id: 'R', retirement_heads: caughtUp.hr,
      forwarded_heads: A.getHeads(caughtUp.retired), status: 'retired',
    })
    await expect(forwardRetiredHead(caughtUp.args)).resolves.toBe('nothing')
    expect(caughtUp.events).toEqual(['authority'])
  })

  it('flushes even when the pass writes nothing, before committing', async () => {
    const h = harness()
    await forwardRetiredHead(h.args)
    h.events.length = 0
    // The same plan again (forwarded_heads still read as NULL by the fake).
    await expect(forwardRetiredHead(h.args)).resolves.toBe('forwarded')
    expect(h.events).toEqual(['authority', 'change', 'flush', 'commit'])
    expect(h.current().forwardedBatchIds).toEqual(['a1'])
  })

  it('refuses unknown heads without writing', async () => {
    const foreign = A.getHeads(A.change(born(), (d) => { d.objects.y = { id: 'y' } }))
    const h = harness({
      row: { collection: 'object', document_id: 'R', retirement_heads: foreign, forwarded_heads: null, status: 'retired' },
    })
    const error = console.error
    console.error = () => {}
    try {
      await expect(forwardRetiredHead(h.args)).resolves.toBe('unknown-heads')
    } finally {
      console.error = error
    }
    expect(h.events).toEqual(['authority'])
  })
})
