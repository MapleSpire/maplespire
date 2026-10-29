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

/**
 * The shared healer, and THE INVARIANT the per-defect arms of
 * `loadGateSeedProjection.integration.test.ts` each pin one corner of:
 *
 *   A FIELD A CLIENT WROTE DOES NOT DISAPPEAR FROM THE DOCUMENT UNLESS A CLIENT
 *   DELETED IT — whatever the interleaving of client bursts, syncs and server
 *   heals.
 *
 * Stated as a property over random schedules rather than as examples, because
 * an example proves only the schedule its author imagined. Each property runs
 * on many seeds with the shipped policy AND on the same seeds with a naive
 * policy (re-put every conflicting entity) as a CONTROL that must violate it —
 * a property that cannot fail has measured nothing.
 *
 * Two regimes, because a `$` replacement has one loss window by construction
 * (a client writing into its branch between the server's sample and its receipt
 * of the heal — one round trip, see the module comment) and the property must
 * not be weakened to hide it:
 *
 *  - CONTENTION: every entity exists and is known to every client before the
 *    first write; clients burst same-field writes, sync at random, and may
 *    write again before they receive the server's document. No `$` can occur.
 *    The shipped policy writes NOTHING here, so the window does not exist;
 *    the control re-puts and orphans the writes made before receipt.
 *  - CREATION: clients create the same keys concurrently in bursts (`$`), and
 *    every client receives the server's document after each tick before it
 *    writes again — the online regime, in which the union must carry every
 *    field of every branch. The control "keeps what is published" for a
 *    creation without a base.
 */

import { describe, expect, it } from 'vitest'
import * as A from '@automerge/automerge'
import type { DocumentId } from '@automerge/automerge-repo'
import {
  applyWholeEntityHealing,
  healWholeEntityConflicts,
  planWholeEntityHealing,
} from './overlayConflictHealing.js'
import { collectAutomergeEntityConflicts, wholeEntityConflictIds } from './overlayHistoryProtocol.js'
import type { OverlayEntityBase } from './overlayHistoryStore.js'

type Rec = Record<string, unknown> & { id: string }
interface Doc { objects: Record<string, Rec> }

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Deterministic PRNG so a failing seed is a reproducible schedule. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Policy = 'shipped' | 'control-reput'

/** The server: one document, a read model (`published`), the entity-base table
 *  with `captureOverlayEntityBases`' semantics (first sight wins, `existed`
 *  from the published rows), and the two policies. */
class ServerModel {
  doc: A.Doc<Doc>
  readonly published = new Map<string, Rec>()
  readonly bases = new Map<string, OverlayEntityBase>()
  heals = 0

  constructor(initial: Record<string, Rec>, readonly policy: Policy) {
    this.doc = A.from<Doc>({ objects: copy(initial) })
    this.publish()
  }

  private captureBases(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.bases.has(id)) continue
      const row = this.published.get(id)
      this.bases.set(id, { existed: row !== undefined, data: row ? copy(row) : undefined })
    }
  }

  private publish(): void {
    this.captureBases(Object.keys(this.doc.objects))
    for (const [id, value] of Object.entries(this.doc.objects)) this.published.set(id, copy(value))
  }

  /** One projection tick: sample, heal or publish. Returns what it did. */
  tick(): 'healed' | 'published' {
    const source = this.doc
    const conflicts = collectAutomergeEntityConflicts(source.objects)
    if (this.policy === 'shipped') {
      const ids = wholeEntityConflictIds(conflicts)
      if (ids.length) {
        this.captureBases(ids)
        const plan = planWholeEntityHealing<Rec>({
          sourceConflicts: conflicts,
          bases: this.bases,
          current: (id) => this.published.get(id),
          selected: (id) => source.objects[id],
        })
        if (plan.resolved.size) {
          this.doc = A.change(this.doc, (d) => applyWholeEntityHealing(d.objects, plan, conflicts))
          this.heals += 1
          return 'healed'
        }
      }
    } else if (conflicts.size) {
      // The naive control policy: EVERY conflicting entity re-put, and for an
      // entity without a base, the previously published value.
      this.captureBases([...conflicts.keys()])
      this.doc = A.change(this.doc, (d) => {
        for (const id of conflicts.keys()) {
          d.objects[id] = copy(this.published.get(id) ?? source.objects[id])
        }
      })
      this.heals += 1
      return 'healed'
    }
    this.publish()
    return 'published'
  }

  /** Production re-triggers a projection after its own heal; three is more
   *  than any schedule here needs, and the count is asserted. */
  settle(): void {
    for (let round = 0; round < 3; round += 1) if (this.tick() === 'published') return
    throw new Error('the heal did not converge in three ticks')
  }
}

class ClientModel {
  fork: A.Doc<Doc>
  constructor(readonly name: string, server: ServerModel) {
    this.fork = A.clone(server.doc)
  }
}

interface Ledger {
  /** Every value any client ever wrote at `<id>.<field>`. */
  written: Map<string, Set<string>>
  /** Every entity any client created. */
  created: Set<string>
}

const ENTITY_POOL = ['e0', 'e1', 'e2', 'e3']
const FIELD_POOL = ['f0', 'f1', 'f2']

function writeOnce(client: ClientModel, rng: () => number, step: number, ledger: Ledger, mayCreate: boolean): void {
  const id = ENTITY_POOL[Math.floor(rng() * ENTITY_POOL.length)]
  const field = FIELD_POOL[Math.floor(rng() * FIELD_POOL.length)]
  const value = `${client.name}:${step}`
  const exists = client.fork.objects[id] !== undefined
  if (!exists && !mayCreate) return
  client.fork = A.change(client.fork, (d) => {
    if (d.objects[id] === undefined) {
      d.objects[id] = { id, type: 'app', name: id, [field]: value }
    } else {
      d.objects[id][field] = value
    }
  })
  ledger.created.add(id)
  const key = `${id}.${field}`
  if (!ledger.written.has(key)) ledger.written.set(key, new Set())
  ledger.written.get(key)!.add(value)
}

function sync(client: ClientModel, server: ServerModel): void {
  server.doc = A.merge(server.doc, client.fork)
  client.fork = A.merge(client.fork, server.doc)
}

/** Fields that survive: a written value is at every written key, or the key
 *  was never written. Returns the violations, empty when the invariant holds. */
function violations(doc: A.Doc<Doc>, ledger: Ledger): string[] {
  const out: string[] = []
  for (const id of ledger.created) {
    if (doc.objects[id] === undefined) out.push(`${id}: entity gone`)
  }
  for (const [key, values] of ledger.written) {
    const [id, field] = key.split('.')
    const actual = doc.objects[id]?.[field]
    if (typeof actual !== 'string' || !values.has(actual)) out.push(`${key}: ${String(actual)} not in {${[...values].join(', ')}}`)
  }
  return out
}

function runContention(seed: number, policy: Policy): { violations: string[]; heals: number } {
  const rng = mulberry32(seed)
  const initial: Record<string, Rec> = Object.fromEntries(
    ENTITY_POOL.map((id) => [id, { id, type: 'app', name: id }]),
  )
  const server = new ServerModel(initial, policy)
  const clients = [0, 1, 2].map((index) => new ClientModel(`c${index}`, server))
  const ledger: Ledger = { written: new Map(), created: new Set() }
  for (let step = 0; step < 24; step += 1) {
    const client = clients[Math.floor(rng() * clients.length)]
    const burst = 1 + Math.floor(rng() * 3)
    for (let write = 0; write < burst; write += 1) writeOnce(client, rng, step * 10 + write, ledger, false)
    // Sync, and let the server project. The client does NOT receive the
    // server's document again until its next sync: the window is open.
    sync(client, server)
    server.settle()
  }
  for (const client of clients) sync(client, server)
  server.settle()
  return { violations: violations(server.doc, ledger), heals: server.heals }
}

function runCreation(seed: number, policy: Policy): { violations: string[]; heals: number; residualDollar: string[] } {
  const rng = mulberry32(seed)
  const server = new ServerModel({}, policy)
  const clients = [0, 1, 2].map((index) => new ClientModel(`c${index}`, server))
  const ledger: Ledger = { written: new Map(), created: new Set() }
  for (let step = 0; step < 16; step += 1) {
    // Every client bursts BEFORE anyone syncs: concurrent creations of the
    // same keys are the norm, not the exception, in this regime.
    for (const client of clients) {
      const burst = 1 + Math.floor(rng() * 3)
      for (let write = 0; write < burst; write += 1) writeOnce(client, rng, step * 10 + write, ledger, true)
    }
    for (const client of [...clients].sort(() => rng() - 0.5)) sync(client, server)
    server.settle()
    // The online regime: the heal reaches every client before it writes again.
    for (const client of clients) client.fork = A.merge(client.fork, server.doc)
  }
  return {
    violations: violations(server.doc, ledger),
    heals: server.heals,
    residualDollar: wholeEntityConflictIds(collectAutomergeEntityConflicts(server.doc.objects)),
  }
}

const SEEDS = Array.from({ length: 40 }, (_, index) => 1_000 + index * 7)

describe('the healing invariant — no client-written field disappears without a client delete', () => {
  it('CONTENTION regime, shipped policy: holds on every seed, and the server never writes', () => {
    for (const seed of SEEDS) {
      const run = runContention(seed, 'shipped')
      expect(run.violations, `seed ${seed}`).toEqual([])
      expect(run.heals, `seed ${seed}`).toBe(0)
    }
  })

  it('CONTENTION regime, CONTROL (re-put every conflicting entity, T-G1c\'s bench behaviour): violated', () => {
    // The property can fail. Not on every seed — a re-put only orphans a write
    // when a client writes before receiving it — but on this many schedules
    // the window is hit; the count is printed with the failure if it ever is not.
    const violated = SEEDS.filter((seed) => runContention(seed, 'control-reput').violations.length > 0)
    expect(violated.length, `violating seeds: ${violated.length}/${SEEDS.length}`).toBeGreaterThan(0)
  })

  it('CREATION regime, shipped policy: every branch\'s fields survive the union, `$` is resolved, one heal per conflict', () => {
    for (const seed of SEEDS) {
      const run = runCreation(seed, 'shipped')
      expect(run.violations, `seed ${seed}`).toEqual([])
      expect(run.residualDollar, `seed ${seed}`).toEqual([])
    }
  })

  it('CREATION regime, CONTROL (keep the published value for a creation without a base): violated', () => {
    const violated = SEEDS.filter((seed) => runCreation(seed, 'control-reput').violations.length > 0)
    expect(violated.length, `violating seeds: ${violated.length}/${SEEDS.length}`).toBeGreaterThan(0)
  })
})

describe('planWholeEntityHealing — per entity, never a deletion', () => {
  function twoBranches() {
    const empty = A.from<Doc>({ objects: {} })
    const left = A.change(A.clone(empty), (d) => {
      d.objects.w = { id: 'w', type: 'app', name: 'W', fromLeft: 'L' }
      d.objects.s = { id: 's', type: 'app', name: 'S', hot: 'left' }
    })
    const right = A.change(A.clone(empty), (d) => {
      d.objects.w = { id: 'w', type: 'app', name: 'W', fromRight: 'R' }
    })
    // `s` exists on one side only: no `$`. Then two forks contest its `hot`.
    const joined = A.merge(A.merge(A.clone(empty), left), right)
    const sLeft = A.change(A.clone(joined), (d) => { d.objects.s.hot = 'u0' })
    const sRight = A.change(A.clone(joined), (d) => { d.objects.s.hot = 'u1'; d.objects.s.u1 = 'r0' })
    return A.merge(A.merge(joined, sLeft), sRight)
  }

  it('plans ONLY the `$` entity when a same-field entity shares the sample (QA finding 2, T-G1c)', () => {
    const doc = twoBranches()
    const conflicts = collectAutomergeEntityConflicts(doc.objects)
    expect([...conflicts.keys()].sort()).toEqual(['s', 'w'])
    expect(Object.keys(conflicts.get('s')!)).toEqual(['hot'])
    // The read model never published `s.hot`: a sample-wide gate would heal
    // `s` too and delete `hot` from the document.
    const plan = planWholeEntityHealing<Rec>({
      sourceConflicts: conflicts,
      bases: new Map([['w', { existed: false, data: undefined }], ['s', { existed: true, data: { id: 's', type: 'app', name: 'S' } }]]),
      current: (id) => (id === 's' ? { id: 's', type: 'app', name: 'S' } : undefined),
      selected: (id) => doc.objects[id],
    })
    expect(plan.entityIds).toEqual(['w'])
    expect([...plan.resolved.keys()]).toEqual(['w'])
    expect(plan.resolved.get('w')).toEqual({ id: 'w', type: 'app', name: 'W', fromLeft: 'L', fromRight: 'R' })
    expect(plan.recorded).toEqual([])
    expect(plan.skipped).toEqual([])

    const healed = A.change(doc, (d) => applyWholeEntityHealing(d.objects, plan, conflicts))
    // `s` untouched: its contested leaf is still there, both values still in
    // the CRDT, and the key was never re-put.
    expect(['u0', 'u1']).toContain(healed.objects.s.hot)
    expect(healed.objects.s.u1).toBe('r0')
    expect(Object.keys(A.getConflicts(healed.objects.s, 'hot') ?? {})).toHaveLength(2)
    expect(Object.keys(A.getConflicts(healed.objects, 's') ?? {}).length).toBeLessThanOrEqual(1)
    // `w` healed: one map, both branches' fields, no `$` left.
    expect(healed.objects.w).toEqual({ id: 'w', type: 'app', name: 'W', fromLeft: 'L', fromRight: 'R' })
    expect(Object.keys(A.getConflicts(healed.objects, 'w') ?? {}).length).toBeLessThanOrEqual(1)
  })

  it('records a same-field conflict INSIDE the `$` branches for the ledger, and resolves it to the published value', () => {
    const empty = A.from<Doc>({ objects: {} })
    const left = A.change(A.clone(empty), (d) => { d.objects.w = { id: 'w', type: 'app', name: 'Left' } })
    const right = A.change(A.clone(empty), (d) => { d.objects.w = { id: 'w', type: 'app', name: 'Right' } })
    const doc = A.merge(A.merge(A.clone(empty), left), right)
    const conflicts = collectAutomergeEntityConflicts(doc.objects)
    const plan = planWholeEntityHealing<Rec>({
      sourceConflicts: conflicts,
      bases: new Map([['w', { existed: false, data: undefined }]]),
      current: () => ({ id: 'w', type: 'app', name: 'Published' }),
      selected: (id) => doc.objects[id],
    })
    expect(plan.resolved.get('w')).toEqual({ id: 'w', type: 'app', name: 'Published' })
    expect(plan.recorded).toHaveLength(1)
    expect(plan.recorded[0]).toMatchObject({ entityId: 'w', conflictPaths: ['name'] })
  })
})

describe('healWholeEntityConflicts — the driver', () => {
  interface Fixture {
    db: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> }
    inserts: string[]
    flushed: string[][]
    changes: number
  }

  function fixture(published: Map<string, Rec>): Fixture {
    const captured = new Map<string, { existed: boolean; data: Rec | undefined }>()
    const fx: Fixture = { inserts: [], flushed: [], changes: 0, db: { query: async () => ({ rows: [], rowCount: 0 }) } }
    fx.db = {
      async query(text: string, params?: unknown[]) {
        if (text.includes('INSERT INTO read_model_overlay_entity_bases')) {
          fx.inserts.push(text)
          for (const id of (params?.[4] as string[]) ?? []) {
            if (!captured.has(id)) captured.set(id, { existed: published.has(id), data: published.get(id) })
          }
          return { rows: [], rowCount: 0 }
        }
        if (text.includes('FROM read_model_overlay_entity_bases')) {
          const ids = (params?.[4] as string[]) ?? []
          return {
            rows: ids.filter((id) => captured.has(id)).map((id) => ({
              entity_id: id, existed: captured.get(id)!.existed, data: captured.get(id)!.data ?? null,
            })),
            rowCount: 0,
          }
        }
        throw new Error(`unexpected query: ${text.slice(0, 60)}`)
      },
    }
    return fx
  }

  function conflicted() {
    const empty = A.from<Doc>({ objects: {} })
    const left = A.change(A.clone(empty), (d) => { d.objects.w = { id: 'w', type: 'app', name: 'W', fromLeft: 'L' } })
    const right = A.change(A.clone(empty), (d) => { d.objects.w = { id: 'w', type: 'app', name: 'W', fromRight: 'R' } })
    return A.merge(A.merge(A.clone(empty), left), right)
  }

  function handleOver(fx: Fixture, initial: A.Doc<Doc>) {
    let doc = initial
    return {
      documentId: 'doc-w' as DocumentId,
      doc: () => doc,
      change(callback: (d: unknown) => void) {
        fx.changes += 1
        doc = A.change(doc, (d) => callback(d))
      },
      current: () => doc,
    }
  }

  const key = { landscapeId: 'ls', versionId: 'v1' }

  it('returns `none` and touches nothing when the sample has no `$`', async () => {
    const fx = fixture(new Map())
    const doc = A.from<Doc>({ objects: { s: { id: 's', type: 'app', name: 'S' } } })
    const handle = handleOver(fx, doc)
    const outcome = await healWholeEntityConflicts<Rec>({
      db: fx.db, key, collection: 'object', handle,
      repo: { flush: async (ids) => { fx.flushed.push(ids ?? []) } },
      sourceConflicts: collectAutomergeEntityConflicts(doc.objects),
      sampledHeads: A.getHeads(doc),
      current: () => undefined,
      selected: (id) => doc.objects[id],
    })
    expect(outcome).toBe('none')
    expect(fx.inserts).toEqual([])
    expect(fx.changes).toBe(0)
    expect(fx.flushed).toEqual([])
  })

  it('heals and flushes when the heads still match the sample', async () => {
    const fx = fixture(new Map())
    const doc = conflicted()
    const handle = handleOver(fx, doc)
    const recorded: unknown[] = []
    const outcome = await healWholeEntityConflicts<Rec>({
      db: fx.db, key, collection: 'object', handle,
      repo: { flush: async (ids) => { fx.flushed.push(ids ?? []) } },
      sourceConflicts: collectAutomergeEntityConflicts(doc.objects),
      sampledHeads: A.getHeads(doc),
      current: () => undefined,
      selected: (id) => doc.objects[id],
      recordConflicts: async (rows) => { recorded.push(...rows) },
    })
    expect(outcome).toBe('healed')
    expect(fx.changes).toBe(1)
    expect(fx.flushed).toEqual([['doc-w']])
    expect(handle.current().objects.w).toEqual({ id: 'w', type: 'app', name: 'W', fromLeft: 'L', fromRight: 'R' })
    expect(Object.keys(A.getConflicts(handle.current().objects, 'w') ?? {}).length).toBeLessThanOrEqual(1)
    // Disjoint branches: nothing for the ledger.
    expect(recorded).toEqual([])
  })

  it('returns `stale` and writes NOTHING when the document moved between the sample and the change (T-G1c residual (c))', async () => {
    const fx = fixture(new Map())
    const sampled = conflicted()
    // A peer's write lands after the sample was taken (during the bases round
    // trip): the live document is ahead of the sampled heads.
    const moved = A.change(A.clone(sampled), (d) => { d.objects.w.late = 'peer' })
    const handle = handleOver(fx, moved)
    const outcome = await healWholeEntityConflicts<Rec>({
      db: fx.db, key, collection: 'object', handle,
      repo: { flush: async (ids) => { fx.flushed.push(ids ?? []) } },
      sourceConflicts: collectAutomergeEntityConflicts(sampled.objects),
      sampledHeads: A.getHeads(sampled),
      current: () => undefined,
      selected: (id) => sampled.objects[id],
    })
    expect(outcome).toBe('stale')
    expect(fx.changes).toBe(0)
    expect(fx.flushed).toEqual([])
    // The bases were still captured — that part is idempotent and must happen
    // before the next attempt anyway.
    expect(fx.inserts).toHaveLength(1)
    expect(handle.current().objects.w.late).toBe('peer')
  })

  it('writes into `connections` for the connection collection', async () => {
    const fx = fixture(new Map())
    const empty = A.from<{ connections: Record<string, Rec> }>({ connections: {} })
    const left = A.change(A.clone(empty), (d) => { d.connections.c = { id: 'c', fromId: 'a', toId: 'b', fromLeft: 'L' } })
    const right = A.change(A.clone(empty), (d) => { d.connections.c = { id: 'c', fromId: 'a', toId: 'b', fromRight: 'R' } })
    let doc = A.merge(A.merge(A.clone(empty), left), right)
    const outcome = await healWholeEntityConflicts<Rec>({
      db: fx.db, key, collection: 'connection',
      handle: { documentId: 'doc-c' as DocumentId, doc: () => doc, change: (cb) => { doc = A.change(doc, (d) => cb(d)) } },
      repo: { flush: async (ids) => { fx.flushed.push(ids ?? []) } },
      sourceConflicts: collectAutomergeEntityConflicts(doc.connections),
      sampledHeads: A.getHeads(doc),
      current: () => undefined,
      selected: (id) => doc.connections[id],
    })
    expect(outcome).toBe('healed')
    expect(doc.connections.c).toEqual({ id: 'c', fromId: 'a', toId: 'b', fromLeft: 'L', fromRight: 'R' })
  })

  it('persists the heal into a document that has NO collection map', async () => {
    // Reached only with unknown sampled heads (the heads check otherwise
    // reports the movement), but the write must not be lost when it is:
    // `(mutable[field] ??= {})` yields the plain `{}` it assigned, not the
    // document's map.
    const fx = fixture(new Map())
    const sampled = conflicted()
    let doc = A.from<Record<string, unknown>>({ marker: 1 })
    const outcome = await healWholeEntityConflicts<Rec>({
      db: fx.db, key, collection: 'object',
      handle: { documentId: 'doc-absent' as DocumentId, doc: () => doc, change: (cb) => { doc = A.change(doc, (d) => cb(d)) } },
      repo: { flush: async (ids) => { fx.flushed.push(ids ?? []) } },
      sourceConflicts: collectAutomergeEntityConflicts(sampled.objects),
      sampledHeads: null,
      current: () => undefined,
      selected: (id) => sampled.objects[id],
    })
    expect(outcome).toBe('healed')
    expect((doc.objects as Record<string, Rec> | undefined)?.w)
      .toEqual({ id: 'w', type: 'app', name: 'W', fromLeft: 'L', fromRight: 'R' })
  })
})
