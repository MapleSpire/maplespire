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

import { randomBytes } from 'node:crypto'
import * as A from '@automerge/automerge'
import { ImmutableString, isValidAutomergeUrl, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import { buildEpochMeta, buildEpochShard } from '../modelEpochs.js'
import { readMetaUrl, readMetaUrls } from '../modelMetaUrls.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import type { PoolClient } from 'pg'
import type { SealedRepo } from '../rbac/sealedRepo.js'
import { acquireOverlayRotationLock, releaseOverlayRotationLock } from './overlayRotationLock.js'
import type { WorkspaceKey } from './projector.js'
import type { ModelEpochKind } from './modelEpochStore.js'

/**
 * THE ROLL — one new epoch of a workspace's ModelMeta (and, for a `full`
 * epoch, of its base shards). G4-16f. The steps S0-S9 below run in that
 * order.
 *
 * Called from the compaction pass (`modelEpochStep.ts`), which already holds
 * both `overlay-rotation:` keys and has detached the projector; this function
 * takes the third key itself (`model-epoch:`, through {@link RollPorts.lock})
 * and expects the caller to hold the lifecycle lock for the whole call.
 *
 * WHAT MAKES IT SOUND: the new epoch equals the old documents' state at
 * `H_cut`, and `H_cut` is committed (S2) BEFORE the root is repointed (S6b) —
 * the `H_r` rule of `ordinaryHeadForwarding.ts`. Everything outside the
 * causal past of `H_cut` is a late write and is forwarded
 * (`modelEpochForwarder.ts`).
 *
 * CRASH SAFETY, by state, under the `model-epoch:` key (so any in-flight row
 * found here is from a dead attempt):
 *  - `preparing` / `prepared`: nothing has left the process — abandoned; the
 *    claimed documents are unreferenced and GC sweeps them after its age
 *    floor (its marking skips `abandoned`);
 *  - `repointing`: the new meta's URL MAY have reached a peer (a root change
 *    syncs before it is flushed), so it is never abandoned — rolled forward;
 *  - `published` with no successor hint on the predecessor: S8 redone.
 *
 * `hooks.afterStep` exists for the crash tests ONLY: throwing from it is a
 * crash right after that step's durable action.
 */

export const ROLL_STEPS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6a', 'S6b', 'S7', 'S8'] as const
export type RollStep = (typeof ROLL_STEPS)[number]

export function modelEpochLockKey(landscapeId: string, versionId: string): string {
  return `model-epoch:${landscapeId}:${versionId}`
}

export interface EpochRowSnapshot {
  epochNo: number
  kind: ModelEpochKind
  state: 'preparing' | 'prepared' | 'repointing' | 'published' | 'retained' | 'abandoned' | 'retired'
  metaUrl: string | null
  cutHeads: Record<string, string[]>
  slots: Array<{ slot: number; url: string }>
  publishedAt: Date | null
}

/** The SQL the roll needs, as operations — `modelEpochStore.ts` implements
 * them, each inside the write-fenced transaction the caller's port runs
 * (`fenced`), and the tests implement them in memory. */
export interface EpochRowStore {
  /** The current (`published`) epoch, or null when the workspace never rolled. */
  published(): Promise<EpochRowSnapshot | null>
  /** The row in flight (`preparing`/`prepared`/`repointing`), or null. */
  inFlight(): Promise<EpochRowSnapshot | null>
  /** The highest epoch number of any row, abandoned included (-1 when none). */
  maxEpochNo(): Promise<number>
  /** Is a forward journal open for the workspace (R4-a)? S0 refuses then. */
  forwardPending(): Promise<boolean>
  /** Record the workspace's pre-epoch documents once, as epoch 0 `legacy`,
   * `published`, with its documents (`created_epoch` 0). Idempotent. */
  recordLegacy(metaUrl: string, baseUrls: string[]): Promise<void>
  /** S2. Throws {@link EpochRollContended} on a unique violation. */
  insertPreparing(row: { epochNo: number; kind: ModelEpochKind; predecessor: number; cutHeads: Record<string, string[]>; instanceId: string }): Promise<void>
  recordSlots(epochNo: number, slots: Array<{ slot: number; url: string }>): Promise<void>
  recordMeta(epochNo: number, metaUrl: string): Promise<void>
  setState(epochNo: number, from: EpochRowSnapshot['state'][], to: EpochRowSnapshot['state']): Promise<boolean>
  /** S7, ONE transaction: `epochNo` → `published`, its predecessor →
   * `retained`; the new documents recorded (`created_epoch` = epochNo);
   * `superseded_epoch` = epochNo and `forward_cursor` = their cut heads on the
   * predecessor's documents the new epoch no longer lists (`superseded`).
   * Idempotent. */
  publish(args: { epochNo: number; predecessor: number; created: Array<{ url: string; role: 'meta' | 'base'; slot: number | null }>; superseded: Array<{ url: string; cutHeads: string[] }> }): Promise<void>
  /** S8's change hash, so the forwarder excludes the server's own write. */
  recordServerChangeHashes(epochNo: number, hashes: string[]): Promise<void>
  /** `epoch:resolve-repointing` records which door resolved a stuck row. */
  recordResolution(epochNo: number, resolution: 'repoint' | 'adopt-root'): Promise<void>
  /**
   * `epoch:resolve-repointing --adopt-root`, ONE transaction: the stuck
   * `repointing` row and the published one → `retained`; a new `published`
   * epoch `epochNo` (kind `meta`, predecessor = the stuck one) naming the
   * root's own meta, cut at its current heads; `docs` recorded — each with
   * the epoch that created it, and `supersededCursor` non-null for one the
   * new epoch supersedes (its forward cursor), null for one it carries.
   */
  adoptRoot(args: {
    stuck: number; predecessor: number; epochNo: number; metaUrl: string; cutHeads: Record<string, string[]>
    docs: Array<{ url: string; role: 'meta' | 'base' | 'adopted'; slot: number | null; createdEpoch: number; supersededCursor: string[] | null }>
  }): Promise<void>
  /** Does the workspace already record `url` as an epoch document (any epoch,
   * any state)? `--adopt-root` refuses such a pointer. */
  isEpochDocument(url: string): Promise<boolean>
}

/** `adoptRoot` (SQL) refuses a meta that already has an epoch-document row. */
export class EpochAdoptKnownDocument extends Error {
  constructor(url: string) {
    super(`--adopt-root: ${url} is already an epoch document`)
    this.name = 'EpochAdoptKnownDocument'
  }
}

export class EpochRollContended extends Error {
  constructor(message: string) { super(message); this.name = 'EpochRollContended' }
}
/** S6b found the root pointing at neither the predecessor nor the new meta:
 * a non-epoch writer repointed it. The row stays `repointing` (never swept);
 * the operator path is `npm run epoch:resolve-repointing`
 * ({@link resolveStuckRepointing}). */
export class EpochRollStuck extends Error {
  constructor(message: string) { super(message); this.name = 'EpochRollStuck' }
}

export interface RollLock {
  acquire(): Promise<'acquired' | 'refused' | 'unknown'>
  release(state: 'acquired' | 'refused' | 'unknown'): Promise<void>
  /** The CACHED "session alive" flag: false once the lock's
   * client reported `error` or `end`. Not a round trip, so a write can still
   * follow a session that died a moment before — the forward journal's lease
   * bounds that window. Absent: assume alive. */
  alive?(): boolean
}

/**
 * The `model-epoch:` key as a {@link RollLock}: a session try-lock on its
 * own pooled client, through the SAME acquire and release as the
 * `overlay-rotation:` keys (`overlayRotationLock.ts`) — three-state acquire
 * under a ceiling, an unlock whose boolean is read, the client destroyed on
 * `unknown` or a `false` unlock. The key text is the wire format of the
 * exclusion; {@link modelEpochLockKey} is its one spelling.
 */
export function modelEpochLock(pool: { connect(): Promise<PoolClient> }, key: WorkspaceKey): RollLock {
  const lockKey = modelEpochLockKey(key.landscapeId, key.versionId)
  let client: PoolClient | null = null
  let sessionAlive = false
  let held = false
  const dead = () => { sessionAlive = false }
  return {
    async acquire() {
      client = await pool.connect()
      sessionAlive = true
      // `on` exists on a real pg client; a test double without it is alive.
      ;(client as { on?: (event: string, fn: () => void) => void }).on?.('error', dead)
      ;(client as { on?: (event: string, fn: () => void) => void }).on?.('end', dead)
      try {
        const state = await acquireOverlayRotationLock(client, lockKey)
        held = state === 'acquired'
        return state
      } catch {
        return 'unknown'
      }
    },
    alive: () => held && sessionAlive,
    async release(state) {
      const owned = client
      client = null
      held = false
      if (owned) {
        ;(owned as { off?: (event: string, fn: () => void) => void }).off?.('error', dead)
        ;(owned as { off?: (event: string, fn: () => void) => void }).off?.('end', dead)
        await releaseOverlayRotationLock(owned, lockKey, state)
      }
    },
  }
}

export interface RollPorts {
  repo: SealedRepo
  key: WorkspaceKey
  rootUrl: string
  instanceId: string
  rows: EpochRowStore
  lock: RollLock
  /** Mint, flush, claim (`createClaimedDocumentFromBinary`). */
  createFromBinary(binary: Uint8Array): Promise<DocHandle<unknown>>
  /** S5: each document's DURABLE heads equal these, read through storage —
   * not the handle (`Repo.flush` skips a handle that is not ready). */
  verifyDurable(expected: Array<{ documentId: DocumentId; heads: string[] }>): Promise<boolean>
  /** The process's write authority, checked synchronously before every
   * `change` (the `mayWrite` of the other writers). */
  mayWrite(): boolean
  hooks?: { afterStep?: (step: RollStep) => void | Promise<void> }
  log?: (event: Record<string, unknown>) => void
  /** Budget of S1 to S5 (default ROLL_BUILD_BUDGET_MS). */
  buildBudgetMs?: number
  /** Budget of ONE base shard's rebuild (default ROLL_SHARD_BUDGET_MS). */
  shardBudgetMs?: number
  now?: () => number
}

/** The S1-S5 budget: the projector stays detached while they run. */
export const ROLL_BUILD_BUDGET_MS = 120_000
/** One shard's rebuild budget. */
export const ROLL_SHARD_BUDGET_MS = 60_000

export type RollResult =
  | { outcome: 'rolled'; epochNo: number; metaUrl: string; kind: ModelEpochKind }
  | { outcome: 'recovered'; epochNo: number; metaUrl: string }
  | { outcome: 'nothing_in_flight' }
  | { outcome: 'skipped'; reason: 'model_epoch_lock_contended' | 'not_owned' | 'no_model_meta' | 'degenerate_model_meta' | 'epoch_forward_pending' | 'build_budget_exceeded' }

interface Root { modelMetaUrl?: string }
type Meta = Record<string, unknown>

const headsOf = (doc: unknown): string[] => [...A.getHeads(doc as A.Doc<unknown>)]
/** Every URL here comes from a row or a document the roll itself validated.
 * Each resolution runs under a DEADLINE: a document
 * that never arrives fails the roll — which leaves a `preparing` row the next
 * pass abandons, or a `repointing` one it rolls forward — instead of holding
 * the model-epoch key and the lifecycle lock for ever. */
export const ROLL_FIND_TIMEOUT_MS = 30_000
const find = <T>(repo: SealedRepo, url: string) => findReadyDocument<T>(repo, url, ROLL_FIND_TIMEOUT_MS)

/** Which entries of a ModelMeta's base lists are BASE shards: the list minus
 * the overlay segments and heads — compaction's own split (`compaction.ts`). */
export function baseShardUrlsOf(meta: unknown): { objects: string[]; connections: string[] } {
  const overlay = new Set<string>([
    ...(readMetaUrls(meta, 'editsObjectShardUrls') ?? []),
    ...(readMetaUrls(meta, 'editsConnectionShardUrls') ?? []),
  ])
  for (const head of [readMetaUrl(meta, 'editsObjectShardUrl'), readMetaUrl(meta, 'editsConnectionShardUrl')]) {
    if (head) overlay.add(head)
  }
  const pick = (field: 'objectShardUrls' | 'connectionShardUrls') =>
    [...new Set((readMetaUrls(meta, field) ?? []).filter((url) => !overlay.has(url) && isValidAutomergeUrl(url)))]
  return { objects: pick('objectShardUrls'), connections: pick('connectionShardUrls') }
}

async function step(ports: RollPorts, name: RollStep): Promise<void> {
  ports.log?.({ event: 'model_epoch.roll.step', step: name, landscapeId: ports.key.landscapeId, versionId: ports.key.versionId })
  await ports.hooks?.afterStep?.(name)
}

function assertMayWrite(ports: RollPorts): void {
  if (!ports.mayWrite()) throw new Error('model epoch roll: write authority lost')
}

/**
 * Roll one epoch, or recover the one a dead attempt left. `kind`: `full`
 * recreates every base shard; `meta` carries them.
 */
export async function rollModelEpoch(ports: RollPorts, kind: Exclude<ModelEpochKind, 'legacy'>): Promise<RollResult> {
  if (!ports.mayWrite()) return { outcome: 'skipped', reason: 'not_owned' }
  const lockState = await ports.lock.acquire().catch(() => 'unknown' as const)
  try {
    if (lockState !== 'acquired') return { outcome: 'skipped', reason: 'model_epoch_lock_contended' }
    const recovered = await recoverInFlight(ports)
    if (recovered) return recovered
    return await rollUnderLock(ports, kind)
  } finally {
    await ports.lock.release(lockState)
  }
}

/**
 * RECOVERY ALONE: finish or abandon a dead attempt,
 * redo a missing S8, and roll nothing new. The step runs it on every pass
 * BEFORE the due check and whatever the flag says: a crash after S6a must not
 * wait for the next due date — nor for ever once the flag is turned off.
 */
export async function recoverModelEpoch(ports: RollPorts): Promise<RollResult> {
  if (!ports.mayWrite()) return { outcome: 'skipped', reason: 'not_owned' }
  const lockState = await ports.lock.acquire().catch(() => 'unknown' as const)
  try {
    if (lockState !== 'acquired') return { outcome: 'skipped', reason: 'model_epoch_lock_contended' }
    return (await recoverInFlight(ports)) ?? { outcome: 'nothing_in_flight' }
  } finally {
    await ports.lock.release(lockState)
  }
}

/** A dead attempt's row, under the lock. */
async function recoverInFlight(ports: RollPorts): Promise<RollResult | null> {
  const row = await ports.rows.inFlight()
  if (!row) {
    // A published epoch whose S8 never ran: redo it (idempotent).
    await ensureSuccessorHint(ports)
    return null
  }
  if (row.state === 'preparing' || row.state === 'prepared') {
    await ports.rows.setState(row.epochNo, [row.state], 'abandoned')
    ports.log?.({ event: 'model_epoch.roll.abandoned', epochNo: row.epochNo, state: row.state })
    return null
  }
  // `repointing`: roll forward, never abandon.
  if (!row.metaUrl) throw new EpochRollStuck(`epoch ${row.epochNo} is repointing without a meta URL`)
  const predecessor = await ports.rows.published()
  if (!predecessor?.metaUrl) throw new EpochRollStuck(`epoch ${row.epochNo} is repointing with no published predecessor`)
  await repointAndPublish(ports, row, predecessor)
  return { outcome: 'recovered', epochNo: row.epochNo, metaUrl: row.metaUrl }
}

async function rollUnderLock(ports: RollPorts, kind: Exclude<ModelEpochKind, 'legacy'>): Promise<RollResult> {
  const { repo } = ports
  // S0 (R4-a): an open forward journal names documents this roll would
  // supersede; it lives seconds, so the next pass rolls.
  if (await ports.rows.forwardPending()) return { outcome: 'skipped', reason: 'epoch_forward_pending' }
  const rootHandle = await find<Root>(repo, ports.rootUrl)
  const metaUrl = rootHandle.doc()?.modelMetaUrl
  if (!metaUrl || !isValidAutomergeUrl(metaUrl)) return { outcome: 'skipped', reason: 'no_model_meta' }
  const metaHandle = await find<Meta>(repo, metaUrl)
  const meta = metaHandle.doc()
  if (!meta || readMetaUrls(meta, 'objectShardUrls') === undefined || readMetaUrls(meta, 'connectionShardUrls') === undefined) {
    return { outcome: 'skipped', reason: 'degenerate_model_meta' }
  }
  const base = baseShardUrlsOf(meta)
  const baseUrls = [...base.objects, ...base.connections]
  let published = await ports.rows.published()
  if (!published) {
    // The workspace's first roll: its current documents become epoch 0.
    await ports.rows.recordLegacy(metaUrl, baseUrls)
    published = await ports.rows.published()
  }
  if (!published || published.metaUrl !== metaUrl) {
    throw new EpochRollStuck(`the root names ${metaUrl} but the published epoch names ${published?.metaUrl ?? 'nothing'}`)
  }
  const recreate = kind === 'full' ? baseUrls : []
  const baseHandles = await Promise.all(recreate.map((url) => find<Meta>(repo, url)))

  // THE BUILD BUDGET: the roll runs
  // under the lifecycle lock with the projector detached, so S1's flush, the
  // S3 rebuild — the whole of it AND each shard — and S5's durability check
  // all count against it. Past it, before S6a, the attempt is ABANDONED
  // (nothing leaked) with an alert naming the workspace; the next pass tries
  // again, and a workspace that exceeds it every time is the alert's to
  // resolve (raise the budget). A wait (a flush, the durability read) is cut
  // at the budget's end rather than awaited past it.
  const budget = ports.buildBudgetMs ?? ROLL_BUILD_BUDGET_MS
  const shardBudget = ports.shardBudgetMs ?? ROLL_SHARD_BUDGET_MS
  const clock = ports.now ?? (() => Date.now())
  const started = clock()
  const remaining = () => budget - (clock() - started)
  let inserted: number | null = null
  const overBudget = async (where: 'S1' | 'S3' | 'S3-shard' | 'S5', detail: Record<string, unknown> = {}): Promise<RollResult> => {
    if (inserted !== null) await ports.rows.setState(inserted, ['preparing', 'prepared'], 'abandoned')
    ports.log?.({ event: 'model_epoch.roll.build_budget_exceeded', alert: true, at: where, ...(inserted !== null ? { epochNo: inserted } : {}),
      budgetMs: budget, shardBudgetMs: shardBudget, ...detail, landscapeId: ports.key.landscapeId, versionId: ports.key.versionId })
    return { outcome: 'skipped', reason: 'build_budget_exceeded' }
  }

  // S1: the cut heads, then a flush — everything up to them is durable, and
  // anything after them is, by definition, a late write.
  const cutHeads: Record<string, string[]> = { [metaUrl]: headsOf(metaHandle.doc()) }
  recreate.forEach((url, i) => { cutHeads[url] = headsOf(baseHandles[i]!.doc()) })
  if (!(await withinBudget(repo.flush([metaHandle.documentId, ...baseHandles.map((h) => h.documentId)]), remaining())).ok) {
    return overBudget('S1')
  }
  await step(ports, 'S1')

  // S2
  // The next number after EVERY row, abandoned ones included: an abandoned
  // attempt keeps its number (its row is the record GC reads), so numbers
  // may skip. The predecessor is still the published epoch.
  const epochNo = (await ports.rows.maxEpochNo()) + 1
  await ports.rows.insertPreparing({ epochNo, kind, predecessor: published.epochNo, cutHeads, instanceId: ports.instanceId })
  inserted = epochNo
  await step(ports, 'S2')

  // S3: one fresh document per recreated base shard.
  const created: Array<{ documentId: DocumentId; url: string; heads: string[] }> = []
  const slots: Array<{ slot: number; url: string }> = []
  const mapped = new Map<string, string>()
  for (let i = 0; i < recreate.length; i += 1) {
    if (remaining() < 0) {
      await ports.rows.recordSlots(epochNo, slots)
      return overBudget('S3', { built: i, of: recreate.length })
    }
    const oldUrl = recreate[i]!
    const shardStarted = clock()
    const doc = buildEpochShard<Meta>(baseHandles[i]!.doc() as A.Doc<unknown>, cutHeads[oldUrl]!)
    const handle = await ports.createFromBinary(A.save(doc))
    created.push({ documentId: handle.documentId, url: handle.url, heads: headsOf(handle.doc()) })
    slots.push({ slot: i, url: handle.url })
    mapped.set(oldUrl, handle.url)
    // ONE shard past its own budget is the alert's signal even when the total
    // is not yet spent: the next one is likely as big. The build is
    // synchronous, so the check follows it; its document is recorded in the
    // slots for GC like every other abandoned product.
    const shardMs = clock() - shardStarted
    if (shardMs > shardBudget || remaining() < 0) {
      await ports.rows.recordSlots(epochNo, slots)
      return overBudget(shardMs > shardBudget ? 'S3-shard' : 'S3', { built: i + 1, of: recreate.length, shard: oldUrl, shardMs })
    }
  }
  if (kind === 'meta') baseUrls.forEach((url, i) => { mapped.set(url, url); slots.push({ slot: i, url }) })
  await ports.rows.recordSlots(epochNo, slots)
  await step(ports, 'S3')

  // S4: the meta, born scalar-native.
  const newMetaDoc = buildEpochMeta<Meta>(metaHandle.doc() as A.Doc<unknown>, cutHeads[metaUrl]!, {
    epoch: epochNo, predecessorUrl: metaUrl, baseShardUrl: (url) => mapped.get(url),
  })
  const newMeta = await ports.createFromBinary(A.save(newMetaDoc))
  created.push({ documentId: newMeta.documentId, url: newMeta.url, heads: headsOf(newMeta.doc()) })
  await ports.rows.recordMeta(epochNo, newMeta.url)
  await step(ports, 'S4')

  // S5: durable, read through storage — inside the budget too.
  const durable = await withinBudget(ports.verifyDurable(created.map(({ documentId, heads }) => ({ documentId, heads }))), remaining())
  if (!durable.ok || remaining() < 0) return overBudget('S5')
  if (!durable.value) {
    throw new Error(`model epoch ${epochNo}: a new document is not durable at its created heads`)
  }
  await ports.rows.setState(epochNo, ['preparing'], 'prepared')
  await step(ports, 'S5')

  const row: EpochRowSnapshot = {
    epochNo, kind, state: 'prepared', metaUrl: newMeta.url, cutHeads, slots, publishedAt: null,
  }
  await repointAndPublish(ports, row, published)
  return { outcome: 'rolled', epochNo, metaUrl: newMeta.url, kind }
}

/** `work`, or `{ ok: false }` once `ms` have passed (the work is left to
 * finish on its own; nothing after it waits for it). */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  if (ms <= 0) {
    work.catch(() => undefined)
    return { ok: false }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<{ ok: false }>((resolve) => { timer = setTimeout(() => resolve({ ok: false }), Math.min(ms, 2_147_483_647)) })
  try {
    return await Promise.race([work.then((value) => ({ ok: true as const, value })), expired])
  } finally {
    clearTimeout(timer)
    work.catch(() => undefined)
  }
}

/** S6a → S8, shared by a fresh roll and the recovery of a `repointing` row. */
async function repointAndPublish(ports: RollPorts, row: EpochRowSnapshot, predecessor: EpochRowSnapshot): Promise<void> {
  const { repo } = ports
  const newMetaUrl = row.metaUrl!
  const oldMetaUrl = predecessor.metaUrl!
  // S7's SUPERSEDED set, computed and VALIDATED BEFORE S6a:
  // a refusal after S6b — the root already repointed — leaves the row
  // `repointing` for ever, since recovery rolls such a row forward into the
  // same refusal.
  //
  // SUPERSEDED = what this epoch was CUT from and no longer lists: every URL
  // with a cut entry (the old meta and every base shard it recreated —
  // including one that joined after the predecessor epoch, a browser's
  // adopted overflow shard), never the predecessor's slot list, which misses
  // those and names shards the cut never read. A cut
  // entry is the forwarding base: without one there is nothing sound to
  // forward from, so the roll refuses rather than default to an empty cursor
  // (which would replay a whole history and bring deleted entities back).
  const newMeta = (await find<Meta>(repo, newMetaUrl)).doc()
  const listed = new Set<string>([
    ...(readMetaUrls(newMeta, 'objectShardUrls') ?? []),
    ...(readMetaUrls(newMeta, 'connectionShardUrls') ?? []),
  ])
  const superseded = Object.keys(row.cutHeads)
    .filter((url) => url !== newMetaUrl && !listed.has(url))
    .map((url) => ({ url, cutHeads: row.cutHeads[url] ?? [] }))
  const invalid = superseded.filter((s) => s.cutHeads.length === 0).map((s) => `no cut heads for superseded ${s.url}`)
  if (!superseded.some((s) => s.url === oldMetaUrl)) invalid.push(`the predecessor meta ${oldMetaUrl} has no cut entry`)
  if (invalid.length > 0) {
    const message = `model epoch ${row.epochNo}: ${invalid.join('; ')}`
    if (row.state === 'repointing') throw new EpochRollStuck(message) // only a row an older build left
    // Nothing left the process: abandoned, with an alert.
    await ports.rows.setState(row.epochNo, ['prepared'], 'abandoned')
    ports.log?.({ event: 'model_epoch.roll.invalid_cut', alert: true, epochNo: row.epochNo, invalid,
      landscapeId: ports.key.landscapeId, versionId: ports.key.versionId })
    throw new Error(message)
  }
  if (row.state !== 'repointing') {
    // S6a: BEFORE touching the root, so no state that may have leaked is
    // ever abandoned.
    if (!(await ports.rows.setState(row.epochNo, ['prepared'], 'repointing'))) {
      throw new Error(`model epoch ${row.epochNo}: lost its prepared state before the repoint`)
    }
    await step(ports, 'S6a')
  }
  // S6b
  const rootHandle = await find<Root>(repo, ports.rootUrl)
  const pointer = rootHandle.doc()?.modelMetaUrl
  if (pointer !== newMetaUrl) {
    if (pointer !== oldMetaUrl) {
      throw new EpochRollStuck(`epoch ${row.epochNo}: the root names ${String(pointer)}, neither the predecessor nor the new meta`)
    }
    assertMayWrite(ports)
    rootHandle.change((root) => { (root as Root).modelMetaUrl = newMetaUrl })
  }
  await repo.flush([rootHandle.documentId])
  await step(ports, 'S6b')

  // S7: one transaction.
  const createdRows: Array<{ url: string; role: 'meta' | 'base'; slot: number | null }> = [{ url: newMetaUrl, role: 'meta', slot: null }]
  for (const slot of row.slots) {
    if (row.kind === 'full') createdRows.push({ url: slot.url, role: 'base', slot: slot.slot })
  }
  await ports.rows.publish({ epochNo: row.epochNo, predecessor: predecessor.epochNo, created: createdRows, superseded })
  await step(ports, 'S7')

  // S8
  await writeSuccessorHint(ports, oldMetaUrl, newMetaUrl, row.epochNo)
  await step(ports, 'S8')
}

/**
 * S8. THE HASH IS RECORDED BEFORE THE HINT EXISTS ANYWHERE:
 * the change is built on a detached copy, its hash recorded, and only then
 * applied to the handle — so no crash can leave a server hint the forwarder
 * would read as a late write, and the server's own changes are known by
 * RECORDED HASH ONLY. (An earlier version recovered that gap by scanning the document for
 * changes that touch `_root.epochSuccessorRef`, which also classified a
 * CLIENT change touching that key — and every other op it carried — as the
 * server's.) A crash between the record and the write costs one recorded hash
 * no change carries; the redo writes, and records, another.
 */
async function writeSuccessorHint(ports: RollPorts, oldMetaUrl: string, newMetaUrl: string, epochNo: number): Promise<void> {
  const handle = await find<Meta>(ports.repo, oldMetaUrl)
  const current = handle.doc() as Meta | undefined
  const existing = current?.epochSuccessorRef
  if (existing && typeof existing === 'object' && String((existing as { val?: unknown }).val) === newMetaUrl) return
  const doc = handle.doc() as A.Doc<unknown>
  const before = A.getHeads(doc)
  const built = A.change(A.clone(doc, { actor: randomBytes(16).toString('hex') }), (meta) => {
    (meta as Meta).epochSuccessorRef = new ImmutableString(newMetaUrl)
  })
  const changes = A.getChangesSince(built, before)
  await ports.rows.recordServerChangeHashes(epochNo, changes.map((c) => A.decodeChange(c).hash!))
  assertMayWrite(ports)
  handle.update((d) => A.applyChanges(d, changes)[0])
  await ports.repo.flush([handle.documentId])
}

export type ResolveRepointingResult =
  | { outcome: 'nothing_stuck' }
  | { outcome: 'model_epoch_lock_contended' }
  | { outcome: 'not_owned' }
  | { outcome: 'repointed'; epochNo: number; metaUrl: string }
  | { outcome: 'adopted'; epochNo: number; metaUrl: string; superseded: string[] }
  | { outcome: 'refused'; reason: string }

/**
 * `epoch:resolve-repointing`: the
 * operator's door on a row stuck `repointing` — S6b found the root naming
 * NEITHER the predecessor nor the row's meta (a non-epoch writer repointed
 * it). Until resolved the row holds the in-flight index: every epoch step
 * re-throws `EpochRollStuck`, and a promotion counts it as a blocker.
 *
 *  - `repoint`: S6b again, onto the stuck row's meta — then S7 and S8 as a
 *    fresh roll would. Whatever the root's foreign meta received meanwhile is
 *    NOT carried (it was never an epoch document): choose this when that
 *    meta is a stray (a script's mistake).
 *  - `adopt-root`: the root's CURRENT meta becomes an epoch — a new
 *    `published` row (kind `meta`, cut at its current heads, predecessor =
 *    the stuck row); the stuck row and the published one become `retained`.
 *    Their documents were advertised, so they stay readable and forwarded
 *    like any predecessor: the predecessor meta and the stuck roll's cut
 *    sources from their cut heads, the stuck roll's own new documents from
 *    their birth; whatever the adopted meta still lists is carried. Both old
 *    metas get the successor hint (recorded server change, as S8).
 *
 * Under the `model-epoch:` key here; the caller holds the lifecycle lock (as
 * for `rollModelEpoch`) and runs the rows fenced. Either door is recorded on
 * the rows (`resolution`).
 */
export async function resolveStuckRepointing(ports: RollPorts, mode: 'repoint' | 'adopt-root'): Promise<ResolveRepointingResult> {
  if (!ports.mayWrite()) return { outcome: 'not_owned' }
  const lockState = await ports.lock.acquire().catch(() => 'unknown' as const)
  try {
    if (lockState !== 'acquired') return { outcome: 'model_epoch_lock_contended' }
    const row = await ports.rows.inFlight()
    if (!row || row.state !== 'repointing' || !row.metaUrl) return { outcome: 'nothing_stuck' }
    const predecessor = await ports.rows.published()
    if (!predecessor?.metaUrl) return { outcome: 'refused', reason: `epoch ${row.epochNo} is repointing with no published predecessor` }
    const rootHandle = await find<Root>(ports.repo, ports.rootUrl)
    const pointer = rootHandle.doc()?.modelMetaUrl
    // Not stuck: the root names one of the two, and recovery rolls it forward.
    if (pointer === row.metaUrl || pointer === predecessor.metaUrl) return { outcome: 'nothing_stuck' }
    if (mode === 'repoint') {
      assertMayWrite(ports)
      rootHandle.change((root) => { (root as Root).modelMetaUrl = row.metaUrl! })
      await ports.repo.flush([rootHandle.documentId])
      ports.log?.({ event: 'model_epoch.resolve_repointing', mode, epochNo: row.epochNo, foreign: pointer ?? null,
        landscapeId: ports.key.landscapeId, versionId: ports.key.versionId })
      await ports.rows.recordResolution(row.epochNo, 'repoint')
      // S6b now finds the root on the new meta: on to S7 and S8.
      await repointAndPublish(ports, row, predecessor)
      return { outcome: 'repointed', epochNo: row.epochNo, metaUrl: row.metaUrl }
    }
    // ADOPT-ROOT.
    if (!pointer || !isValidAutomergeUrl(pointer)) return { outcome: 'refused', reason: `the root names ${String(pointer)}, not a document URL` }
    // A meta the workspace ALREADY records — an older superseded epoch meta,
    // say — would be current and, its `superseded_epoch` still set, a
    // late-write source forwarded into itself; if it lists superseded base
    // shards, those would be current again too.
    // Refused: `--repoint` is the door then.
    if (await ports.rows.isEpochDocument(pointer)) {
      return { outcome: 'refused', reason: `the root names ${pointer}, already an epoch document: --adopt-root cannot publish it again; use --repoint` }
    }
    const adopted = await find<Meta>(ports.repo, pointer)
    const adoptedDoc = adopted.doc()
    if (!adoptedDoc || readMetaUrls(adoptedDoc, 'objectShardUrls') === undefined) {
      return { outcome: 'refused', reason: `the root's meta ${pointer} is not a ModelMeta (no object shard list)` }
    }
    const listed = new Set<string>([
      ...(readMetaUrls(adoptedDoc, 'objectShardUrls') ?? []), ...(readMetaUrls(adoptedDoc, 'connectionShardUrls') ?? []),
    ])
    const docs: Parameters<EpochRowStore['adoptRoot']>[0]['docs'] = []
    const superseded: string[] = []
    // The stuck roll's cut sources (the predecessor meta, the shards it recreated).
    for (const [url, cutHeads] of Object.entries(row.cutHeads)) {
      if (url === pointer || listed.has(url)) continue
      if (cutHeads.length === 0) return { outcome: 'refused', reason: `no cut heads for ${url}` }
      docs.push({ url, role: url === predecessor.metaUrl ? 'meta' : 'adopted', slot: null, createdEpoch: predecessor.epochNo, supersededCursor: cutHeads })
      superseded.push(url)
    }
    // The stuck roll's OWN documents: its meta and (full) its base shards.
    const own: Array<{ url: string; role: 'meta' | 'base'; slot: number | null }> = [{ url: row.metaUrl, role: 'meta', slot: null }]
    if (row.kind === 'full') for (const s of row.slots) own.push({ url: s.url, role: 'base', slot: s.slot })
    for (const doc of own) {
      if (doc.url === pointer) continue
      const carried = listed.has(doc.url)
      const birth = carried ? null : birthOf((await find<Meta>(ports.repo, doc.url)).doc() as A.Doc<unknown>)
      docs.push({ ...doc, createdEpoch: row.epochNo, supersededCursor: birth })
      if (!carried) superseded.push(doc.url)
    }
    const epochNo = (await ports.rows.maxEpochNo()) + 1
    docs.push({ url: pointer, role: 'meta', slot: null, createdEpoch: epochNo, supersededCursor: null })
    await ports.rows.adoptRoot({
      stuck: row.epochNo, predecessor: predecessor.epochNo, epochNo, metaUrl: pointer,
      cutHeads: { [pointer]: headsOf(adoptedDoc) }, docs,
    })
    ports.log?.({ event: 'model_epoch.resolve_repointing', mode, epochNo, stuck: row.epochNo, metaUrl: pointer, superseded,
      landscapeId: ports.key.landscapeId, versionId: ports.key.versionId })
    // The successor hints: a client holding either old meta learns the live one.
    await writeSuccessorHint(ports, predecessor.metaUrl, pointer, epochNo)
    await writeSuccessorHint(ports, row.metaUrl, pointer, epochNo)
    return { outcome: 'adopted', epochNo, metaUrl: pointer, superseded }
  } finally {
    await ports.lock.release(lockState)
  }
}

/** The heads of a document's FIRST change: an epoch document's birth. */
const birthOf = (doc: A.Doc<unknown>): string[] => {
  const first = A.getAllChanges(doc)[0]
  return first ? [A.decodeChange(first).hash!] : []
}

/** Recovery of S8 alone: the published epoch's predecessor lacks its hint. */
async function ensureSuccessorHint(ports: RollPorts): Promise<void> {
  const published = await ports.rows.published()
  if (!published || published.kind === 'legacy' || !published.metaUrl) return
  const predecessorMeta = (await find<Meta>(ports.repo, published.metaUrl)).doc()?.epochPredecessorRef
  const predecessorUrl = predecessorMeta && typeof predecessorMeta === 'object' ? String((predecessorMeta as { val?: unknown }).val) : null
  if (!predecessorUrl || !isValidAutomergeUrl(predecessorUrl)) return
  await writeSuccessorHint(ports, predecessorUrl, published.metaUrl, published.epochNo)
}
