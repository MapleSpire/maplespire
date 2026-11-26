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

import * as A from '@automerge/automerge'
import { ImmutableString, Repo, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import { afterEach, describe, expect, it } from 'vitest'
import { EPOCH_META_BUILDER_KEYS, typedDifference } from '../modelEpochs.js'
import { metaUrlsAreScalar, readMetaUrls } from '../modelMetaUrls.js'
import {
  EpochRollContended,
  EpochRollStuck,
  ROLL_STEPS,
  baseShardUrlsOf,
  modelEpochLock,
  modelEpochLockKey,
  recoverModelEpoch,
  resolveStuckRepointing,
  rollModelEpoch,
  type EpochRowSnapshot,
  type EpochRowStore,
  type RollPorts,
  type RollStep,
} from './modelEpochRoll.js'
import { projectionInboundEdges, projectionLockOrderViolations, unknownAdvisoryKeys } from './lockEdgeScan.js'

/**
 * G4-16f — the roll's STATE MACHINE, DB-free: a real in-memory
 * Repo, and an in-memory row store that enforces the two partial unique
 * indexes of `read_model_model_epochs` the way PostgreSQL does. The SQL of
 * `sqlEpochRowStore` is pinned separately against a real database
 * (`modelEpochStore.integration.test.ts`). A crash is a throw from the
 * `afterStep` hook right after that step's durable action; the "restart" is
 * a second `rollModelEpoch` on the same Repo (whose documents stand in for
 * storage) and the same rows.
 */
type Meta = Record<string, unknown>
type Row = EpochRowSnapshot & { predecessor: number | null; serverHashes: string[] }
interface DocRow { role: string; createdEpoch: number; supersededEpoch: number | null; forwardCursor: string[] | null }

class MemoryRows implements EpochRowStore {
  rows: Row[] = []
  docs = new Map<string, DocRow>()
  private one(pred: (r: Row) => boolean): EpochRowSnapshot | null {
    const r = this.rows.find(pred)
    return r ? { ...r, cutHeads: { ...r.cutHeads }, slots: [...r.slots] } : null
  }
  async published() { return this.one((r) => r.state === 'published') }
  async inFlight() { return this.one((r) => ['preparing', 'prepared', 'repointing'].includes(r.state)) }
  async maxEpochNo() { return this.rows.reduce((m, r) => Math.max(m, r.epochNo), -1) }
  journalOpen = false
  async forwardPending() { return this.journalOpen }
  async recordLegacy(metaUrl: string, baseUrls: string[]) {
    if (this.rows.some((r) => r.epochNo === 0)) return
    this.rows.push({ epochNo: 0, kind: 'legacy', state: 'published', metaUrl, cutHeads: {}, slots: baseUrls.map((url, slot) => ({ slot, url })),
      publishedAt: new Date(), predecessor: null, serverHashes: [] })
    for (const url of [metaUrl, ...baseUrls]) this.docs.set(url, { role: url === metaUrl ? 'meta' : 'base', createdEpoch: 0, supersededEpoch: null, forwardCursor: null })
  }
  async insertPreparing(row: { epochNo: number; kind: 'full' | 'meta' | 'legacy'; predecessor: number; cutHeads: Record<string, string[]>; instanceId: string }) {
    if (this.rows.some((r) => r.epochNo === row.epochNo)) throw new EpochRollContended('pk')
    if (this.rows.some((r) => ['preparing', 'prepared', 'repointing'].includes(r.state))) throw new EpochRollContended('in flight')
    this.rows.push({ epochNo: row.epochNo, kind: row.kind, state: 'preparing', metaUrl: null, cutHeads: row.cutHeads, slots: [],
      publishedAt: null, predecessor: row.predecessor, serverHashes: [] })
  }
  async recordSlots(epochNo: number, slots: Array<{ slot: number; url: string }>) { this.rows.find((r) => r.epochNo === epochNo)!.slots = slots }
  async recordMeta(epochNo: number, metaUrl: string) { this.rows.find((r) => r.epochNo === epochNo)!.metaUrl = metaUrl }
  async setState(epochNo: number, from: Row['state'][], to: Row['state']) {
    const r = this.rows.find((x) => x.epochNo === epochNo && from.includes(x.state))
    if (!r) return false
    r.state = to
    return true
  }
  async publish(args: { epochNo: number; predecessor: number; created: Array<{ url: string; role: 'meta' | 'base'; slot: number | null }>; superseded: Array<{ url: string; cutHeads: string[] }> }) {
    const prev = this.rows.find((r) => r.epochNo === args.predecessor && r.state === 'published')
    if (prev) prev.state = 'retained'
    const row = this.rows.find((r) => r.epochNo === args.epochNo && (r.state === 'repointing' || r.state === 'published'))!
    row.state = 'published'
    row.publishedAt ??= new Date()
    if (this.rows.filter((r) => r.state === 'published').length !== 1) throw new Error('unique published violated')
    for (const c of args.created) if (!this.docs.has(c.url)) this.docs.set(c.url, { role: c.role, createdEpoch: args.epochNo, supersededEpoch: null, forwardCursor: null })
    for (const s of args.superseded) {
      if (!this.docs.has(s.url)) this.docs.set(s.url, { role: 'adopted', createdEpoch: args.predecessor, supersededEpoch: null, forwardCursor: null })
      const d = this.docs.get(s.url)!
      if (d.supersededEpoch === null) { d.supersededEpoch = args.epochNo; d.forwardCursor ??= s.cutHeads }
    }
  }
  async recordServerChangeHashes(epochNo: number, hashes: string[]) {
    const r = this.rows.find((x) => x.epochNo === epochNo)!
    r.serverHashes = [...new Set([...r.serverHashes, ...hashes])]
  }
  resolutions = new Map<number, string>()
  async recordResolution(epochNo: number, resolution: 'repoint' | 'adopt-root') { this.resolutions.set(epochNo, resolution) }
  async adoptRoot(args: Parameters<EpochRowStore['adoptRoot']>[0]) {
    const stuck = this.rows.find((r) => r.epochNo === args.stuck && r.state === 'repointing')
    const prev = this.rows.find((r) => r.epochNo === args.predecessor && r.state === 'published')
    if (!stuck || !prev) throw new Error('adoptRoot: rows moved')
    stuck.state = 'retained'
    prev.state = 'retained'
    this.rows.push({ epochNo: args.epochNo, kind: 'meta', state: 'published', metaUrl: args.metaUrl, cutHeads: args.cutHeads, slots: [],
      publishedAt: new Date(), predecessor: args.stuck, serverHashes: [] })
    this.resolutions.set(args.stuck, 'adopt-root')
    this.resolutions.set(args.epochNo, 'adopt-root')
    for (const doc of args.docs) {
      if (!this.docs.has(doc.url)) this.docs.set(doc.url, { role: doc.role, createdEpoch: doc.createdEpoch, supersededEpoch: null, forwardCursor: null })
      const d = this.docs.get(doc.url)!
      if (doc.supersededCursor && d.supersededEpoch === null) { d.supersededEpoch = args.epochNo; d.forwardCursor ??= doc.supersededCursor }
    }
  }
  async isEpochDocument(url: string) { return this.docs.has(url) }
}

const repos: Repo[] = []
afterEach(async () => { await Promise.all(repos.splice(0).map((r) => r.shutdown())) })

async function workspace() {
  const repo = new Repo({ network: [] })
  repos.push(repo)
  const base1 = repo.create<Meta>({ objects: { o1: { id: 'o1', name: 'One', n: 1 } } })
  const base2 = repo.create<Meta>({ objects: { o2: { id: 'o2', name: 'Two' } } })
  const conn = repo.create<Meta>({ connections: { c1: { id: 'c1', from: 'o1', to: 'o2' } } })
  const head = repo.create<Meta>({ objects: {} })
  const chead = repo.create<Meta>({ connections: {} })
  const registry = repo.create<Meta>({ diagrams: {} })
  // A TEXT-authority meta, as every workspace has today.
  const meta = repo.create<Meta>({
    objectShardUrls: [base1.url, base2.url, head.url],
    connectionShardUrls: [conn.url, chead.url],
    editsObjectShardUrls: [head.url], editsConnectionShardUrls: [chead.url],
    editsObjectShardUrl: head.url, editsConnectionShardUrl: chead.url,
    groups: { g: { id: 'g', name: 'G' } }, deletedObjectIds: ['gone'],
  })
  // Some history the epoch must drop.
  for (let i = 0; i < 20; i += 1) base1.change((d) => { ((d.objects as Record<string, Meta>).o1!).n = i })
  const root = repo.create<Meta>({ modelMetaUrl: meta.url, shardUrls: [registry.url] })
  await Promise.all([base1, base2, conn, head, chead, registry, meta, root].map((h) => h.whenReady()))
  return { repo, root, meta, base1, base2, conn, head, chead }
}
type World = Awaited<ReturnType<typeof workspace>>

function ports(w: World, rows: MemoryRows, extra: Partial<RollPorts> = {}): RollPorts & { lockLog: string[] } {
  const lockLog: string[] = []
  let held = false
  return {
    repo: w.repo,
    key: { landscapeId: 'l', versionId: 'v' },
    rootUrl: w.root.url,
    instanceId: 'test',
    rows,
    lock: {
      async acquire() { if (held) return 'refused'; held = true; lockLog.push('acquire'); return 'acquired' },
      async release(state) { if (state === 'acquired') { held = false; lockLog.push('release') } },
    },
    async createFromBinary(binary) {
      const handle = w.repo.import<Meta>(binary)
      await handle.whenReady()
      return handle as DocHandle<unknown>
    },
    async verifyDurable(expected) {
      for (const { documentId, heads } of expected) {
        const doc = (await w.repo.find<Meta>(documentId as DocumentId)).doc()
        if (JSON.stringify([...A.getHeads(doc as A.Doc<unknown>)].sort()) !== JSON.stringify([...heads].sort())) return false
      }
      return true
    },
    mayWrite: () => true,
    lockLog,
    ...extra,
  }
}

const rootMeta = (w: World) => (w.root.doc() as Meta).modelMetaUrl as string

async function assertCoherent(w: World, rows: MemoryRows) {
  const published = rows.rows.filter((r) => r.state === 'published')
  expect(published).toHaveLength(1)
  expect(rows.rows.filter((r) => ['preparing', 'prepared', 'repointing'].includes(r.state))).toEqual([])
  expect(rootMeta(w)).toBe(published[0]!.metaUrl)
  const meta = (await w.repo.find<Meta>(published[0]!.metaUrl as DocumentId)).doc()
  expect(metaUrlsAreScalar(meta)).toBe(true)
  return { published: published[0]!, meta }
}

describe('rollModelEpoch', () => {
  it('a full roll: legacy epoch 0 recorded, base shards recreated without history, meta born scalar, root repointed, predecessor superseded', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const p = ports(w, rows)
    const result = await rollModelEpoch(p, 'full')
    expect(result).toMatchObject({ outcome: 'rolled', epochNo: 1, kind: 'full' })
    const { published, meta } = await assertCoherent(w, rows)
    expect(rows.rows.find((r) => r.epochNo === 0)!.state).toBe('retained')
    // Base shards recreated in place, overlays kept, order unchanged.
    const objects = readMetaUrls(meta, 'objectShardUrls')!
    expect(objects).toHaveLength(3)
    expect(objects[2]).toBe(w.head.url)
    expect(objects[0]).not.toBe(w.base1.url)
    const newBase1 = (await w.repo.find<Meta>(objects[0] as DocumentId)).doc()
    expect(A.getAllChanges(newBase1 as A.Doc<unknown>)).toHaveLength(1)
    expect(typedDifference(w.base1.doc() as A.Doc<unknown>, A.getHeads(w.base1.doc() as A.Doc<unknown>), newBase1 as A.Doc<unknown>, A.getHeads(newBase1 as A.Doc<unknown>))).toBeNull()
    // Everything that is not a URL field carried, with datatypes.
    expect(typedDifference(w.meta.doc() as A.Doc<unknown>, published.cutHeads[w.meta.url]!, meta as A.Doc<unknown>, A.getHeads(meta as A.Doc<unknown>),
      { omitRootKeys: EPOCH_META_BUILDER_KEYS })).toBeNull()
    // The predecessor's meta and base shards are superseded; overlays are not epoch documents.
    for (const url of [w.meta.url, w.base1.url, w.base2.url, w.conn.url]) expect(rows.docs.get(url)!.supersededEpoch, url).toBe(1)
    // Their forward cursor starts at the CUT heads the new documents were built from.
    expect(rows.docs.get(w.base1.url)!.forwardCursor).toEqual([...A.getHeads(w.base1.doc() as A.Doc<unknown>)])
    expect(published.cutHeads[w.base1.url]).toEqual([...A.getHeads(w.base1.doc() as A.Doc<unknown>)])
    expect(rows.docs.get(w.meta.url)!.forwardCursor).toEqual(published.cutHeads[w.meta.url])
    expect(rows.docs.has(w.head.url)).toBe(false)
    // S8: the successor hint, its hash recorded for the forwarder to exclude.
    expect(String(((w.meta.doc() as Meta).epochSuccessorRef as { val: string }).val)).toBe(published.metaUrl)
    expect(rows.rows.find((r) => r.epochNo === 1)!.serverHashes).toHaveLength(1)
    expect(p.lockLog).toEqual(['acquire', 'release'])
  })

  it('a meta-only roll CARRIES the base shards: same URLs, never superseded', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    await rollModelEpoch(ports(w, rows), 'meta')
    const { meta } = await assertCoherent(w, rows)
    expect(readMetaUrls(meta, 'objectShardUrls')).toEqual([w.base1.url, w.base2.url, w.head.url])
    expect(rows.docs.get(w.base1.url)!.supersededEpoch).toBeNull()
    expect(rows.docs.get(w.meta.url)!.supersededEpoch).toBe(1)
  })

  it('two rolls in a row: epoch 2 supersedes epoch 1\'s documents and reads its SCALAR lists', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    await rollModelEpoch(ports(w, rows), 'full')
    const first = rootMeta(w)
    await rollModelEpoch(ports(w, rows), 'full')
    const { published, meta } = await assertCoherent(w, rows)
    expect(published.epochNo).toBe(2)
    expect(rows.docs.get(first)!.supersededEpoch).toBe(2)
    expect(readMetaUrls(meta, 'objectShardUrls')![2]).toBe(w.head.url)
  })

  it('a shard that JOINED after the predecessor roll (an overflow shard) is superseded by the next, from its cut', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    await rollModelEpoch(ports(w, rows), 'full')
    // A browser appends an overflow base shard to epoch 1's meta (no row).
    const overflow = w.repo.create<Meta>({ objects: { o9: { id: 'o9', name: 'Overflow' } } })
    await overflow.whenReady()
    const meta1 = await w.repo.find<Meta>(rootMeta(w) as DocumentId)
    meta1.change((m) => {
      const refs = m.objectShardRefs as unknown[]
      refs.splice(2, 0, new A.ImmutableString(overflow.url)) // before the head, as an overflow is placed
    })
    expect(rows.docs.has(overflow.url)).toBe(false)
    await rollModelEpoch(ports(w, rows), 'full')
    const doc = rows.docs.get(overflow.url)
    expect(doc?.supersededEpoch).toBe(2)
    // Its cursor is its CUT, never empty.
    expect(doc?.forwardCursor).toEqual([...A.getHeads(overflow.doc() as A.Doc<unknown>)])
    expect(rows.rows.find((r) => r.epochNo === 2)!.cutHeads[overflow.url]).toEqual(doc?.forwardCursor)
  })

  it('the lock refused: nothing happens', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const p = ports(w, rows, { lock: { acquire: async () => 'refused', release: async () => undefined } })
    expect(await rollModelEpoch(p, 'full')).toEqual({ outcome: 'skipped', reason: 'model_epoch_lock_contended' })
    expect(rows.rows).toEqual([])
    expect(rootMeta(w)).toBe(w.meta.url)
  })

  it('S0 refuses while a forward journal is open (R4-a): nothing rolls, the next call does', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    rows.journalOpen = true
    expect(await rollModelEpoch(ports(w, rows), 'full')).toEqual({ outcome: 'skipped', reason: 'epoch_forward_pending' })
    expect(rows.rows).toEqual([])
    expect(rootMeta(w)).toBe(w.meta.url)
    rows.journalOpen = false
    expect(await rollModelEpoch(ports(w, rows), 'full')).toMatchObject({ outcome: 'rolled' })
  })

  it('no write authority: nothing happens', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    expect(await rollModelEpoch(ports(w, rows, { mayWrite: () => false }), 'full')).toEqual({ outcome: 'skipped', reason: 'not_owned' })
    expect(rows.rows).toEqual([])
  })

  it('a second roller loses at S2 (the in-flight unique index)', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    await rows.recordLegacy(w.meta.url, baseShardUrlsOf(w.meta.doc()).objects.concat(baseShardUrlsOf(w.meta.doc()).connections))
    await rows.insertPreparing({ epochNo: 7, kind: 'full', predecessor: 0, cutHeads: {}, instanceId: 'other' })
    // Without the lock (stubbed open), the in-flight row would be OURS to
    // recover; a live competitor is excluded by the lock in production. Here
    // we only pin that a second INSERT cannot happen.
    await expect(rows.insertPreparing({ epochNo: 8, kind: 'full', predecessor: 0, cutHeads: {}, instanceId: 'me' })).rejects.toThrow(EpochRollContended)
  })

  it('S5 refuses to go on when a new document is not durable', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    await expect(rollModelEpoch(ports(w, rows, { verifyDurable: async () => false }), 'full')).rejects.toThrow(/not durable/)
    expect(rootMeta(w)).toBe(w.meta.url)
    // The next attempt abandons that row and rolls a new number.
    const result = await rollModelEpoch(ports(w, rows), 'full')
    expect(result).toMatchObject({ outcome: 'rolled', epochNo: 2 })
    expect(rows.rows.find((r) => r.epochNo === 1)!.state).toBe('abandoned')
    await assertCoherent(w, rows)
  })

  it('a root repointed by someone else during the roll: stuck, the row stays repointing, nothing swept', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const p = ports(w, rows, {
      hooks: { afterStep: (s) => { if (s === 'S6a') w.root.change((r) => { r.modelMetaUrl = w.head.url }) } },
    })
    await expect(rollModelEpoch(p, 'full')).rejects.toThrow(EpochRollStuck)
    expect(rows.rows.find((r) => r.epochNo === 1)!.state).toBe('repointing')
    expect(rootMeta(w)).toBe(w.head.url)
  })

  describe('a crash after each step, then a restart, leaves exactly one coherent state', () => {
    for (const crashAt of ROLL_STEPS) {
      it(`crash after ${crashAt}`, async () => {
        const w = await workspace()
        const rows = new MemoryRows()
        const crash: (s: RollStep) => void = (s) => { if (s === crashAt) throw new Error(`crash after ${s}`) }
        await expect(rollModelEpoch(ports(w, rows, { hooks: { afterStep: crash } }), 'full')).rejects.toThrow(`crash after ${crashAt}`)
        const restart = await rollModelEpoch(ports(w, rows), 'full')
        const { published } = await assertCoherent(w, rows)
        const beforeRepoint = ['S1', 'S2', 'S3', 'S4', 'S5'].includes(crashAt)
        if (beforeRepoint) {
          // Abandoned (nothing left the process), then a fresh roll.
          if (crashAt !== 'S1') expect(rows.rows.find((r) => r.epochNo === 1)!.state).toBe('abandoned')
          expect(restart.outcome).toBe('rolled')
        } else if (crashAt === 'S6a' || crashAt === 'S6b') {
          // Rolled FORWARD, never abandoned.
          expect(restart).toMatchObject({ outcome: 'recovered', epochNo: 1 })
          expect(published.epochNo).toBe(1)
        } else {
          // S7 and S8: already published. S8's hint is redone on restart, and
          // the restart then rolls one more epoch (age is the caller's check).
          expect(rows.rows.find((r) => r.epochNo === 1)!.state).not.toBe('abandoned')
        }
        // EVERY epoch that has a successor carries its hint — S8 is redone on
        // restart even when the restart then rolls another epoch.
        const live = rows.rows.filter((r) => r.state === 'published' || r.state === 'retained').sort((a, b) => a.epochNo - b.epochNo)
        expect(live[live.length - 1]!.epochNo).toBe(published.epochNo)
        for (let i = 0; i + 1 < live.length; i += 1) {
          const older = (await w.repo.find<Meta>(live[i]!.metaUrl as DocumentId)).doc() as Meta
          expect(String((older.epochSuccessorRef as { val: string } | undefined)?.val), `epoch ${live[i]!.epochNo}`).toBe(live[i + 1]!.metaUrl)
        }
      })
    }
  })

  it('recoverModelEpoch ALONE rolls a post-S6a crash forward and rolls nothing new', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const crash: (s: RollStep) => void = (s) => { if (s === 'S6a') throw new Error('crash after S6a') }
    await expect(rollModelEpoch(ports(w, rows, { hooks: { afterStep: crash } }), 'full')).rejects.toThrow('crash after S6a')
    expect(await recoverModelEpoch(ports(w, rows))).toMatchObject({ outcome: 'recovered', epochNo: 1 })
    await assertCoherent(w, rows)
    // Nothing in flight any more: recovery is a no-op, and never a new roll.
    expect(await recoverModelEpoch(ports(w, rows))).toEqual({ outcome: 'nothing_in_flight' })
    expect(rows.rows.map((r) => r.epochNo).sort()).toEqual([0, 1])
  })

  it('past its build budget the attempt is ABANDONED before S6a, with an alert; the root is untouched', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const log: Array<Record<string, unknown>> = []
    let t = 0
    const before = rootMeta(w)
    // The clock jumps only once S1 is behind: the S3 rebuild is what is late.
    let s1Done = false
    const result = await rollModelEpoch(ports(w, rows, {
      buildBudgetMs: 5, now: () => (s1Done ? (t += 10) : t), log: (e) => log.push(e),
      hooks: { afterStep: (s) => { if (s === 'S1') s1Done = true } },
    }), 'full')
    expect(result).toEqual({ outcome: 'skipped', reason: 'build_budget_exceeded' })
    expect(rows.rows.find((r) => r.epochNo === 1)!.state).toBe('abandoned')
    expect(rootMeta(w)).toBe(before)
    expect(log.find((e) => e.event === 'model_epoch.roll.build_budget_exceeded')).toMatchObject({ alert: true, epochNo: 1, at: 'S3' })
    // CONTROL: within its budget, the same workspace rolls.
    expect(await rollModelEpoch(ports(w, rows), 'full')).toMatchObject({ outcome: 'rolled', epochNo: 2 })
  })

  it('ONE shard past its own budget abandons the attempt, the total budget unspent', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const log: Array<Record<string, unknown>> = []
    let t = 0
    const result = await rollModelEpoch(ports(w, rows, {
      buildBudgetMs: 1_000_000, shardBudgetMs: 5, now: () => (t += 10), log: (e) => log.push(e),
    }), 'full')
    expect(result).toEqual({ outcome: 'skipped', reason: 'build_budget_exceeded' })
    expect(rows.rows.find((r) => r.epochNo === 1)!.state).toBe('abandoned')
    expect(log.find((e) => e.event === 'model_epoch.roll.build_budget_exceeded')).toMatchObject({ at: 'S3-shard', built: 1 })
    expect(rootMeta(w)).toBe(w.meta.url)
  })

  it('S1\'s flush counts — past the budget at S1, no row is even written', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    let calls = 0
    const result = await rollModelEpoch(ports(w, rows, { buildBudgetMs: 5, now: () => (calls++ === 0 ? 0 : 1_000) }), 'full')
    expect(result).toEqual({ outcome: 'skipped', reason: 'build_budget_exceeded' })
    expect(rows.rows.filter((r) => r.epochNo > 0)).toEqual([])
    expect(rootMeta(w)).toBe(w.meta.url)
  })

  it('an S5 durability check that never answers is cut at the budget — abandoned, never repointed', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const log: Array<Record<string, unknown>> = []
    const result = await rollModelEpoch(ports(w, rows, {
      buildBudgetMs: 200, verifyDurable: () => new Promise<boolean>(() => {}), log: (e) => log.push(e),
    }), 'full')
    expect(result).toEqual({ outcome: 'skipped', reason: 'build_budget_exceeded' })
    expect(rows.rows.find((r) => r.epochNo === 1)!.state).toBe('abandoned')
    expect(log.find((e) => e.event === 'model_epoch.roll.build_budget_exceeded')).toMatchObject({ at: 'S5' })
    expect(rootMeta(w)).toBe(w.meta.url)
  }, 10_000)

  it('a cut entry with NO heads is refused BEFORE S6a — abandoned, the root untouched, never stuck repointing', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const log: Array<Record<string, unknown>> = []
    // A corrupt cut record: once the shards are built, one superseded entry
    // has no heads (the in-memory store holds the roll's own cut map).
    const corrupt = (s: RollStep) => { if (s === 'S3') rows.rows.find((r) => r.epochNo === 1)!.cutHeads[w.base2.url] = [] }
    await expect(rollModelEpoch(ports(w, rows, { log: (e) => log.push(e), hooks: { afterStep: corrupt } }), 'full'))
      .rejects.toThrow(/no cut heads for superseded/)
    expect(rows.rows.find((r) => r.epochNo === 1)!.state).toBe('abandoned')
    expect(rootMeta(w)).toBe(w.meta.url)
    expect(log.find((e) => e.event === 'model_epoch.roll.invalid_cut')).toMatchObject({ alert: true, epochNo: 1 })
    // Nothing in flight: recovery has nothing to roll forward into the same refusal.
    expect(await recoverModelEpoch(ports(w, rows))).toEqual({ outcome: 'nothing_in_flight' })
    // CONTROL: with a sound cut, the next attempt rolls.
    expect(await rollModelEpoch(ports(w, rows), 'full')).toMatchObject({ outcome: 'rolled', epochNo: 2 })
  })

  it('S8 records its hash BEFORE the hint exists — a crash at the record leaves no unrecorded hint', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    const original = rows.recordServerChangeHashes.bind(rows)
    let lose = true
    rows.recordServerChangeHashes = async (epochNo: number, hashes: string[]) => {
      if (lose) { lose = false; throw new Error('crash at the hash record') }
      return original(epochNo, hashes)
    }
    await expect(rollModelEpoch(ports(w, rows), 'full')).rejects.toThrow('crash at the hash record')
    expect((w.meta.doc() as Meta).epochSuccessorRef).toBeUndefined() // nothing written without its record
    expect(await recoverModelEpoch(ports(w, rows))).toEqual({ outcome: 'nothing_in_flight' })
    const epoch1 = rows.rows.find((r) => r.epochNo === 1)!
    const written = A.getChangesMetaSince(w.meta.doc() as A.Doc<unknown>, epoch1.cutHeads[w.meta.url]!).map((m) => m.hash)
    expect(written).toHaveLength(1)
    expect(epoch1.serverHashes).toEqual(written)
  })

  it('a CLIENT change touching `epochSuccessorRef` is never classified as the server\'s', async () => {
    const w = await workspace()
    const rows = new MemoryRows()
    expect(await rollModelEpoch(ports(w, rows), 'full')).toMatchObject({ outcome: 'rolled', epochNo: 1 })
    const epoch1 = rows.rows.find((r) => r.epochNo === 1)!
    const s8 = [...epoch1.serverHashes]
    expect(s8).toHaveLength(1)
    // An offline browser writes the same hint AND a group into the old meta.
    const before = A.getHeads(w.meta.doc() as A.Doc<unknown>)
    w.meta.change((m) => {
      delete m.epochSuccessorRef
      m.epochSuccessorRef = new ImmutableString(epoch1.metaUrl!)
      ;(m.groups as Record<string, unknown>).late = { id: 'late', name: 'Late group' }
    })
    const client = A.getChangesMetaSince(w.meta.doc() as A.Doc<unknown>, before).map((m) => m.hash)
    expect(await recoverModelEpoch(ports(w, rows))).toEqual({ outcome: 'nothing_in_flight' })
    expect(rows.rows.find((r) => r.epochNo === 1)!.serverHashes).toEqual(s8)
    expect(s8).not.toContain(client[0])
  })

  describe('epoch:resolve-repointing', () => {
    /** A roll stuck `repointing`: a foreign writer repointed the root right after S6a. */
    async function stuck() {
      const w = await workspace()
      const rows = new MemoryRows()
      // The foreign meta: a script's copy of the predecessor (same lists).
      const foreign = w.repo.create<Meta>(JSON.parse(JSON.stringify(w.meta.doc())) as Meta)
      await foreign.whenReady()
      await expect(rollModelEpoch(ports(w, rows, {
        hooks: { afterStep: (s) => { if (s === 'S6a') w.root.change((r) => { r.modelMetaUrl = foreign.url }) } },
      }), 'full')).rejects.toThrow(EpochRollStuck)
      const row = rows.rows.find((r) => r.epochNo === 1)!
      expect(row.state).toBe('repointing')
      // The symptom: every pass's recovery throws on it; no new roll can run.
      await expect(recoverModelEpoch(ports(w, rows))).rejects.toThrow(EpochRollStuck)
      return { w, rows, foreign, stuckMeta: row.metaUrl! }
    }

    it('--repoint: S6b again onto the stuck row\'s meta, then S7 and S8 — published, coherent, recorded', async () => {
      const { w, rows, stuckMeta } = await stuck()
      expect(await resolveStuckRepointing(ports(w, rows), 'repoint')).toEqual({ outcome: 'repointed', epochNo: 1, metaUrl: stuckMeta })
      const { published } = await assertCoherent(w, rows)
      expect(published.epochNo).toBe(1)
      expect(rows.resolutions.get(1)).toBe('repoint')
      expect(rows.docs.get(w.meta.url)!.supersededEpoch).toBe(1)
      expect(String(((w.meta.doc() as Meta).epochSuccessorRef as { val: string }).val)).toBe(stuckMeta)
      // Unblocked: recovery has nothing in flight; the next roll runs.
      expect(await recoverModelEpoch(ports(w, rows))).toEqual({ outcome: 'nothing_in_flight' })
      expect(await rollModelEpoch(ports(w, rows), 'full')).toMatchObject({ outcome: 'rolled', epochNo: 2 })
    })

    it('--adopt-root: the root\'s meta becomes epoch 2 (kind meta); both old epochs retained, their documents forwarded from their cut or their birth', async () => {
      const { w, rows, foreign, stuckMeta } = await stuck()
      const stuckRow = rows.rows.find((r) => r.epochNo === 1)!
      const result = await resolveStuckRepointing(ports(w, rows), 'adopt-root')
      expect(result).toMatchObject({ outcome: 'adopted', epochNo: 2, metaUrl: foreign.url })
      // (Not `assertCoherent`: an adopted meta is whatever the root named, not born scalar.)
      const published = rows.rows.filter((r) => r.state === 'published')
      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({ epochNo: 2, kind: 'meta', metaUrl: foreign.url })
      expect(rootMeta(w)).toBe(foreign.url)
      expect(rows.rows.find((r) => r.epochNo === 0)!.state).toBe('retained')
      expect(stuckRow.state).toBe('retained')
      expect(rows.rows.filter((r) => ['preparing', 'prepared', 'repointing'].includes(r.state))).toEqual([])
      expect(rows.resolutions.get(1)).toBe('adopt-root')
      // The predecessor meta: superseded from the stuck roll's CUT.
      expect(rows.docs.get(w.meta.url)).toMatchObject({ supersededEpoch: 2, forwardCursor: stuckRow.cutHeads[w.meta.url] })
      // The stuck roll's own meta and recreated base shards: from their BIRTH.
      const stuckMetaDoc = (await w.repo.find<Meta>(stuckMeta as DocumentId)).doc() as A.Doc<unknown>
      expect(rows.docs.get(stuckMeta)).toMatchObject({ supersededEpoch: 2, forwardCursor: [A.decodeChange(A.getAllChanges(stuckMetaDoc)[0]!).hash] })
      for (const slot of stuckRow.slots) expect(rows.docs.get(slot.url), slot.url).toMatchObject({ supersededEpoch: 2 })
      // The foreign meta still lists the predecessor's base shards: CARRIED.
      expect(rows.docs.get(w.base1.url)!.supersededEpoch).toBeNull()
      // Both old metas point at the live one, by recorded server changes.
      for (const old of [w.meta, await w.repo.find<Meta>(stuckMeta as DocumentId)]) {
        expect(String(((old.doc() as Meta).epochSuccessorRef as { val: string }).val)).toBe(foreign.url)
      }
      expect(rows.rows.find((r) => r.epochNo === 2)!.serverHashes).toHaveLength(2)
      // Unblocked.
      expect(await recoverModelEpoch(ports(w, rows))).toEqual({ outcome: 'nothing_in_flight' })
      expect(await rollModelEpoch(ports(w, rows), 'full')).toMatchObject({ outcome: 'rolled', epochNo: 3 })
    })

    it('a row repointing with the root STILL ON THE PREDECESSOR (or already on its meta) is not stuck — no door adopts or repoints it; recovery rolls it forward', async () => {
      for (const crashAt of ['S6a', 'S6b'] as const) {
        const w = await workspace()
        const rows = new MemoryRows()
        await expect(rollModelEpoch(ports(w, rows, { hooks: { afterStep: (s) => { if (s === crashAt) throw new Error(`crash after ${s}`) } } }), 'full'))
          .rejects.toThrow(`crash after ${crashAt}`)
        const row = rows.rows.find((r) => r.epochNo === 1)!
        expect(row.state).toBe('repointing')
        const before = rootMeta(w)
        expect(before).toBe(crashAt === 'S6a' ? w.meta.url : row.metaUrl)
        for (const mode of ['adopt-root', 'repoint'] as const) {
          expect(await resolveStuckRepointing(ports(w, rows), mode), `${crashAt} ${mode}`).toEqual({ outcome: 'nothing_stuck' })
        }
        expect(rootMeta(w)).toBe(before)
        expect(rows.rows.map((r) => r.epochNo).sort()).toEqual([0, 1])
        expect(rows.resolutions.size).toBe(0)
        expect(await recoverModelEpoch(ports(w, rows))).toMatchObject({ outcome: 'recovered', epochNo: 1 })
      }
    })

    it('--adopt-root REFUSES a stuck row whose cut has an entry with no heads — nothing adopted, the row still repointing', async () => {
      const { w, rows, foreign } = await stuck()
      // The predecessor meta's cut entry is empty (a corrupt record).
      rows.rows.find((r) => r.epochNo === 1)!.cutHeads[w.meta.url] = []
      const result = await resolveStuckRepointing(ports(w, rows), 'adopt-root')
      expect(result).toEqual({ outcome: 'refused', reason: `no cut heads for ${w.meta.url}` })
      expect(rows.rows.find((r) => r.epochNo === 1)!.state).toBe('repointing')
      expect(rows.rows.some((r) => r.epochNo === 2)).toBe(false)
      expect(rows.docs.get(w.meta.url)!.supersededEpoch).toBeNull()
      expect((w.meta.doc() as Meta).epochSuccessorRef).toBeUndefined()
      expect(rootMeta(w)).toBe(foreign.url)
    })

    it('--adopt-root REFUSES a root that names an OLDER epoch meta (already an epoch document) — nothing written', async () => {
      const w = await workspace()
      const rows = new MemoryRows()
      expect(await rollModelEpoch(ports(w, rows), 'full')).toMatchObject({ outcome: 'rolled', epochNo: 1 })
      // Epoch 2 gets stuck: a script repoints the root to epoch 0's meta, superseded by epoch 1.
      await expect(rollModelEpoch(ports(w, rows, {
        hooks: { afterStep: (s) => { if (s === 'S6a') w.root.change((r) => { r.modelMetaUrl = w.meta.url }) } },
      }), 'full')).rejects.toThrow(EpochRollStuck)
      expect(rows.docs.get(w.meta.url)!.supersededEpoch).toBe(1)
      const result = await resolveStuckRepointing(ports(w, rows), 'adopt-root')
      expect(result).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('already an epoch document') })
      expect(rows.rows.find((r) => r.epochNo === 2)!.state).toBe('repointing')
      expect(rows.rows.some((r) => r.epochNo === 3)).toBe(false)
      expect(rows.resolutions.size).toBe(0)
      // --repoint is the door.
      expect(await resolveStuckRepointing(ports(w, rows), 'repoint')).toMatchObject({ outcome: 'repointed', epochNo: 2 })
    })

    it('nothing stuck: a door that changes nothing', async () => {
      const w = await workspace()
      const rows = new MemoryRows()
      expect(await resolveStuckRepointing(ports(w, rows), 'adopt-root')).toEqual({ outcome: 'nothing_stuck' })
      expect(await rollModelEpoch(ports(w, rows), 'full')).toMatchObject({ outcome: 'rolled', epochNo: 1 })
      expect(await resolveStuckRepointing(ports(w, rows), 'repoint')).toEqual({ outcome: 'nothing_stuck' })
    })
  })

  it('the key text is the wire format of the exclusion', () => {
    expect(modelEpochLockKey('ls', 'v')).toBe('model-epoch:ls:v')
  })
})

/**
 * The G5 and A8 lock scanners (`lockEdgeScan.ts`) over the statements the
 * `model-epoch:` key's port issues around a fenced row transaction. The
 * rule they pin: the roll's row transactions assert the write
 * fence FOR UPDATE on their own client and never take the projection mutex
 * while the session key is held — the same discipline as compaction's settle.
 * The real fenced runner's stream is scanned by
 * `modelEpochStep.integration.test.ts`; this pins the key port and the rule.
 */
describe('model-epoch key and the lock-order scanners', () => {
  function recordingPool(calls: Array<{ sql: string; params?: unknown[] }>) {
    return {
      async connect() {
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params })
            if (sql.includes('pg_try_advisory_lock(')) return { rows: [{ locked: true }] }
            if (sql.includes('pg_advisory_unlock(')) return { rows: [{ released: true }] }
            return { rows: [] }
          },
          release() {},
        } as never
      },
    }
  }

  it('acquire and release issue the shared try-lock and a read unlock on the key text', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const lock = modelEpochLock(recordingPool(calls), { landscapeId: 'l', versionId: 'v' })
    const state = await lock.acquire()
    expect(state).toBe('acquired')
    await lock.release(state)
    expect(calls.map((c) => [c.sql.match(/pg_\w+/)![0], c.params![0]])).toEqual([
      ['pg_try_advisory_lock', 'model-epoch:l:v'], ['pg_advisory_unlock', 'model-epoch:l:v'],
    ])
    expect(calls[0]!.sql).toContain('hashtextextended($1, 0)')
  })

  it('a fenced row transaction under the key passes both scanners; the projection mutex inside it does not', async () => {
    const key = 'model-epoch:l:v'
    const fenced = [
      { sql: 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', params: [key] },
      { sql: 'BEGIN' },
      { sql: 'SELECT write_fence FROM read_model_projection_state WHERE landscape_id = $1 FOR UPDATE', params: ['l'] },
      { sql: 'INSERT INTO read_model_model_epochs (landscape_id) VALUES ($1)', params: ['l'] },
      { sql: 'COMMIT' },
      { sql: 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', params: [key] },
    ]
    expect(projectionInboundEdges(fenced)).toEqual([])
    expect(unknownAdvisoryKeys(fenced)).toEqual([]) // registered in KNOWN_ADVISORY_KEY_PREFIXES
    expect(projectionLockOrderViolations(fenced.map((c) => [c.sql, c.params] as const))).toEqual([])
    // Control: the same transaction routed through the projection mutex is flagged.
    const throughMutex = [fenced[0]!, fenced[1]!,
      { sql: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', params: ['read-model-projection:l:v'] }, ...fenced.slice(2)]
    expect(projectionLockOrderViolations(throughMutex.map((c) => [c.sql, c.params] as const))).not.toEqual([])
  })
})
