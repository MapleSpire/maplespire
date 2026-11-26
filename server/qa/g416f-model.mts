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
 * G4-16f — the SHARED half of the aged-corpus harness: the calibration
 * hypotheses, the synthetic edit stream, and a pure model of the ordinary
 * chain that is driven by the PRODUCTION planner and merger.
 *
 * Two consumers, one definition, and that is the point of the file:
 *
 *  - `g416f-chain-sim.mts` runs the model alone, for every scenario and age,
 *    and prints what the chain looks like (no database, no Automerge);
 *  - `g416f-aged-corpus.mts` drives the REAL rotator and fold writer with the
 *    SAME stream (same seed, same ids, same order) and compares, rotation by
 *    rotation, what the projector did with what this model says it must do.
 *    A disagreement is not averaged away: it makes the arm VOID and is printed
 *    as data, because either the load did not reach the mechanism or the
 *    mechanism is not the one this model encodes — both are findings.
 *
 * NOTHING HERE RESTATES A PRODUCTION CONSTANT. The planner
 * (`planOrdinaryChainFold`, `ordinaryChainFoldWriter.ts`), the merge
 * (`foldOverlaySegmentContents`, `overlayChainFold.ts`), the seal and window
 * (`OVERLAY_SEGMENT_ENTITY_CEILING`, `OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES`), the
 * fold defaults (`DEFAULT_ORDINARY_CHAIN_FOLD_MIN` / `_BUDGET`) and the fsck
 * ceiling (`OVERLAY_CHAIN_CEILING`) are imported. A model that copied them
 * would keep agreeing with itself after production moved.
 *
 * WHAT THE MODEL ASSUMES ABOUT "FOLDABLE", which the writer decides from
 * state the model does not have (`foldOrdinaryChain` step 3b): a listed,
 * non-current segment with a `retired` row, attached by the projector and
 * SETTLED (live heads = forwarded heads). The corpus compares only at
 * QUIESCENCE — after the last fold pass of a step reported a final skip — at
 * which point every retired head and product is attached and settled.
 *
 * COMPACTION (P1), as the tree writes it since G4-16i (`compaction.ts`
 * `applyFold` and its `settleRewrittenSegments` hook,
 * `workspaceCompaction.ts` `settleCompactedOrdinarySegments`): every listed
 * segment is cleared; the head the pass replaces gets a `retired` row at its
 * post-clear heads; a cleared fold product's `forwarded_heads` is advanced to
 * its post-clear heads; a cleared retired head is forwarded by the projector
 * at the re-attach. So after a compaction EVERY non-current segment is
 * retired, settled and empty, and the fold takes them like any other run.
 * See {@link ChainModel.compact} for the measured history of the defect.
 */
import {
  foldOverlaySegmentContents,
  OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES,
  OVERLAY_SEGMENT_ENTITY_CEILING,
} from '../src/readModel/overlayChainFold.js'
import { planOrdinaryChainFold } from '../src/readModel/ordinaryChainFoldWriter.js'
import {
  DEFAULT_ORDINARY_CHAIN_FOLD_BUDGET,
  DEFAULT_ORDINARY_CHAIN_FOLD_MIN,
  DEFAULT_ORDINARY_HEAD_MAX_ACTORS,
  DEFAULT_ORDINARY_HEAD_MAX_CHANGES,
} from '../src/readModel/ordinaryHeadRotation.js'
import { OVERLAY_CHAIN_CEILING } from '../src/maintenance/workspaceFsck.js'

/** Written VERBATIM into every output file of the harness: a number without
 * its hypotheses is a number nobody can re-derive. */
export const CALIBRATION_HYPOTHESES = [
  'rotations per landscape per working day: low 0.39 / mid 4.69 / high 19.53 (G4-16e projection)',
  '250 working days per year',
  'e_h (distinct entities per retired head): arms 50 and 150 (400 optional)',
  'creation share 10 % (30 % optional)',
  're-edits Zipf s=1 over objects',
  'base = 12 000 objects in 24 shards of 512 (as the soak arm of server/scripts/verify-sync-cell-load-soak.mjs seeds it)',
  '12-field ObjectInput with UNIQUE strings (no repeated templates)',
  'fold defaults min 8 / budget 8',
  'rotation at 512 changes or 128 actors',
] as const

/** How the stream realises the hypotheses where they leave a choice open. Also
 * written into every output: these are this harness's decisions, not the
 * design's. */
export const STREAM_DECISIONS = [
  'rotations on day d = floor(rate*(d+1)) - floor(rate*d): deterministic, no Poisson noise, so the VOID rule can expect an exact count',
  'Zipf s=1 by rejection-inversion (Hormann & Derflinger 1996, the Apache Commons sampler) over ranks 1..N, N = objects existing at draw time',
  'rank order: the 12 000 base objects in one seeded random permutation, then created objects appended in creation order (a created object enters at the coldest rank)',
  'a head holds exactly e_h DISTINCT ids: round(e_h * creationShare) new ids, the rest drawn Zipf without repetition inside the head',
  'every head of the stream is written whole by one client; the head of the next rotation starts empty (rotation at quiescence)',
  'seeded PRNG (mulberry32), seed fixed per scenario arm, so the simulator and the corpus see the same stream',
] as const

export const WORKING_DAYS_PER_YEAR = 250

export const AGES_YEARS = [0.5, 1, 2, 3] as const
export const BASE_OBJECTS = 12_000
export const BASE_SHARD_SIZE = 512
export const BASE_SHARDS = Math.ceil(BASE_OBJECTS / BASE_SHARD_SIZE)

export const RATES = { low: 0.39, mid: 4.69, high: 19.53 } as const
export type RateName = keyof typeof RATES

export const FOLD_MIN = DEFAULT_ORDINARY_CHAIN_FOLD_MIN
export const FOLD_BUDGET = DEFAULT_ORDINARY_CHAIN_FOLD_BUDGET
export const SEGMENT_CEILING = OVERLAY_SEGMENT_ENTITY_CEILING
export const WINDOW_ENTITIES = OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES
export const FSCK_CHAIN_CEILING = OVERLAY_CHAIN_CEILING
export const ROTATION_MAX_CHANGES = DEFAULT_ORDINARY_HEAD_MAX_CHANGES
export const ROTATION_MAX_ACTORS = DEFAULT_ORDINARY_HEAD_MAX_ACTORS

export const daysAtAge = (years: number): number => Math.round(years * WORKING_DAYS_PER_YEAR)

/** Rotations on working day `day` (0-based), for a rate per day. The 1e-9
 * keeps 4.69 * 100 from flooring to 468. */
export function rotationsOnDay(rate: number, day: number): number {
  return Math.floor(rate * (day + 1) + 1e-9) - Math.floor(rate * day + 1e-9)
}

export function cumulativeRotations(rate: number, days: number): number {
  return Math.floor(rate * days + 1e-9)
}

/** mulberry32: small, seedable, good enough for a workload generator. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Zipf(s = 1) on 1..n by rejection-inversion. For s = 1 the helper
 * functions reduce to h(x) = 1/x, H(x) = ln x, H^-1(y) = e^y. O(1) per draw
 * whatever n, which matters: n reaches ~230 000 on the high arm. */
export function zipfOne(random: () => number, n: number): number {
  if (n <= 1) return 1
  const hIntegralX1 = Math.log(1.5) - 1
  const hIntegralN = Math.log(n + 0.5)
  const sTest = 2 - Math.exp(Math.log(2.5) - 1 / 2)
  for (;;) {
    const u = hIntegralN + random() * (hIntegralX1 - hIntegralN)
    const x = Math.exp(u)
    let k = Math.floor(x + 0.5)
    if (k < 1) k = 1
    else if (k > n) k = n
    if (k - x <= sTest || u >= Math.log(k + 0.5) - 1 / k) return k
  }
}

export const baseObjectId = (index: number): string =>
  `o-${Math.floor(index / BASE_SHARD_SIZE)}-${index % BASE_SHARD_SIZE}`

export interface StreamHead {
  /** 0-based rotation index over the whole run. */
  index: number
  /** Every id the head holds, distinct; created ids included. */
  ids: string[]
  created: string[]
}

export interface StreamOptions {
  seed: number
  eh: number
  creationShare: number
}

/** The synthetic edit stream: one {@link StreamHead} per rotation. */
export class EditStream {
  private readonly random: () => number
  /** rank - 1 -> id */
  private readonly ranked: string[]
  private nextIndex = 0
  private createdCount = 0

  constructor(private readonly options: StreamOptions) {
    if (!Number.isInteger(options.eh) || options.eh < 1) throw new Error(`eh must be a positive integer, got ${options.eh}`)
    this.random = mulberry32(options.seed)
    this.ranked = Array.from({ length: BASE_OBJECTS }, (_, index) => baseObjectId(index))
    for (let at = this.ranked.length - 1; at > 0; at -= 1) {
      const other = Math.floor(this.random() * (at + 1))
      const swap = this.ranked[at]!
      this.ranked[at] = this.ranked[other]!
      this.ranked[other] = swap
    }
  }

  get objectCount(): number { return this.ranked.length }

  next(): StreamHead {
    const createdN = Math.round(this.options.eh * this.options.creationShare)
    const reEdits = this.options.eh - createdN
    if (reEdits > this.ranked.length) throw new Error('more re-edits per head than objects')
    const picked = new Set<string>()
    let guard = 0
    while (picked.size < reEdits) {
      picked.add(this.ranked[zipfOne(this.random, this.ranked.length) - 1]!)
      if ((guard += 1) > reEdits * 10_000) throw new Error('zipf draw did not converge')
    }
    const created: string[] = []
    for (let i = 0; i < createdN; i += 1) {
      const id = `o-new-${this.createdCount}`
      this.createdCount += 1
      created.push(id)
      this.ranked.push(id)
    }
    const head: StreamHead = { index: this.nextIndex, ids: [...picked, ...created], created }
    this.nextIndex += 1
    return head
  }
}

export const STREAM_SEED = (rate: RateName, eh: number): number =>
  ({ low: 0x16f0_0001, mid: 0x16f0_0002, high: 0x16f0_0003 })[rate] ^ Math.imul(eh, 0x9E37)

type SegmentKind = 'head' | 'product'

interface ModelSegment {
  url: string
  kind: SegmentKind
  /** id -> the rotation index that last wrote it (last wins). */
  entities: Record<string, number>
  /** `Object.keys(entities).length`, kept in step: the planner asks for it
   * per candidate per pass, and recounting a 1 024-entity product each time
   * made the 3-year high arm minutes long. */
  size: number
  /** A `retired` row: rotated heads, fold products, and (since G4-16i) the
   * head a compaction replaced. The current head is never a candidate. */
  retiredRow: boolean
}

export interface ChainSnapshot {
  rotations: number
  folds: number
  compactions: number
  /** Overlay list length (`editsObjectShardUrls`), current head included:
   * what `overlay-chain-bounded` compares against the fsck ceiling. */
  overlayListed: number
  fsckCeiling: number
  overFsckCeiling: boolean
  /** `objectShardUrls`: base shards + overlay. */
  objectShardUrls: number
  baseShards: number
  sealedProducts: number
  unsealedProducts: number
  retiredHeads: number
  /** Non-current overlay segments below the seal: the planner's candidates. */
  unsealedTail: number
  productSizes: { min: number; median: number; max: number; sum: number } | null
  /** Sum of entity entries over every overlay segment (duplicates counted). */
  totalEntityEntries: number
  /** Distinct ids across the overlay (the effective set). */
  distinctOverlayEntities: number
  /** Every object that exists: base + created (what ro_objects must hold). */
  objectsTotal: number
  /** ModelMeta changes the model predicts: one per rotation (the publish),
   * one per fold (the substitution), and per compaction one per new base
   * shard plus one for the head repoint. A lower bound: whatever else writes
   * ModelMeta (the rotator's own bookkeeping, if any) is not modelled — the
   * corpus reads the real `A.stats(meta).numChanges` beside it. */
  modelMetaSplices: number
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * The ordinary object chain, as ModelMeta lists it, with nothing in it but
 * what the planner and the merge need. `urls` are synthetic (`m:<n>`) — the
 * planner compares strings and never parses them.
 */
export class ChainModel {
  private readonly segments = new Map<string, ModelSegment>()
  /** `editsObjectShardUrls`, current head LAST. */
  private overlay: string[] = []
  private current: string
  private seq = 0
  private baseShards = BASE_SHARDS
  /** Free slots in the base shards, for compaction's placement of created ids
   * (`applyFold`: fill shards with room, then mint shards of `shardSize`). */
  private baseRoom: number[]
  /** Created ids compaction has already given a base shard. */
  private readonly placed = new Set<string>()
  rotations = 0
  folds = 0
  compactions = 0
  private created = 0
  private splices = 0

  constructor(
    private readonly options: {
      minChain?: number
      budget?: number
      segmentCeiling?: number
      windowEntities?: number
    } = {},
  ) {
    this.current = this.mint('head', true)
    this.overlay = [this.current]
    this.baseRoom = Array.from({ length: BASE_SHARDS }, (_, shard) =>
      BASE_SHARD_SIZE - Math.min(BASE_SHARD_SIZE, BASE_OBJECTS - shard * BASE_SHARD_SIZE))
  }

  private mint(kind: SegmentKind, retiredRow: boolean, entities: Record<string, number> = {}): string {
    const url = `m:${this.seq}`
    this.seq += 1
    this.segments.set(url, { url, kind, entities, retiredRow, size: Object.keys(entities).length })
    return url
  }

  private baseUrls(): string[] {
    return Array.from({ length: this.baseShards }, (_, index) => `base:${index}`)
  }

  /** The head the stream wrote is retired; a fresh empty head is current. */
  rotate(head: StreamHead): { folds: number; retiredUrl: string } {
    const retiredUrl = this.current
    const segment = this.segments.get(this.current)!
    for (const id of head.ids) segment.entities[id] = head.index
    segment.size = Object.keys(segment.entities).length
    this.created += head.created.length
    segment.retiredRow = true
    const next = this.mint('head', true)
    this.overlay.push(next)
    this.current = next
    this.rotations += 1
    this.splices += 1
    return { folds: this.foldToQuiescence(), retiredUrl }
  }

  /** Every fold the model made, in order: read by the post-hoc checker
   * (`g416f-void-check.mts`) to compare each real fold's sources and entity
   * count. Recording only — nothing here reads it back. */
  readonly foldLog: Array<{ sources: string[]; product: string; entities: number }> = []

  /** Every fold the writer would make before reporting a final skip: the
   * projector asks for another pass right after each fold lands. */
  foldToQuiescence(): number {
    let made = 0
    for (;;) {
      const plan = planOrdinaryChainFold({
        shardUrls: [...this.baseUrls(), ...this.overlay],
        overlayUrls: this.overlay,
        currentUrl: this.current,
        foldable: (url) => this.segments.get(url)?.retiredRow === true,
        entityCountOf: (url) => this.segments.get(url)?.size ?? 0,
        minChain: this.options.minChain ?? FOLD_MIN,
        budget: this.options.budget ?? FOLD_BUDGET,
        segmentCeiling: this.options.segmentCeiling ?? SEGMENT_CEILING,
        windowEntities: this.options.windowEntities ?? WINDOW_ENTITIES,
      })
      if (!plan.fold.length) return made
      const merged = foldOverlaySegmentContents(plan.fold.map((url) => this.segments.get(url)!.entities))
      const product = this.mint('product', true, merged)
      const at = this.overlay.indexOf(plan.fold[0]!)
      this.overlay.splice(at, plan.fold.length, product)
      for (const url of plan.fold) this.segments.delete(url)
      this.foldLog.push({ sources: [...plan.fold], product, entities: Object.keys(merged).length })
      this.folds += 1
      this.splices += 1
      made += 1
    }
  }

  /**
   * One `compactOverlay(apply)` at quiescence, as `compaction.ts` writes it
   * since G4-16i: every overlay entry folded into the base and CLEARED from
   * its segment (the conditional clear deletes an entry equal to its
   * snapshot, and at quiescence every entry is); created ids placed in base
   * shards with room, then in new shards of 512; and, when there was
   * anything to fold (`prepareFold` returns before writing on an empty
   * overlay without tombstones), a fresh head minted WITHOUT the rotator.
   * Between the clear and the ModelMeta repoint, `settleRewrittenSegments`
   * retires the replaced head and advances every cleared product's
   * `forwarded_heads`; the re-attach forwards the cleared retired heads. So
   * every non-current segment is left retired, settled and empty, and the
   * fold that follows takes them. Returns the folds the projector should
   * then make, and the replaced head (bound by the post-hoc checker to the
   * real document the `compaction_segments_settled` line names as retired).
   *
   * HISTORY, dated: before G4-16i (measured 2026-11-06, a P1 smoke run of
   * this harness) a cleared product kept
   * `forwarded_heads` NULL, stayed unsettled for good, and made every later
   * compaction refuse `retired_head_forward_pending` (5 of 5 after the first
   * clear); the replaced head stayed listed with no row and split fold runs.
   * That was the model of the shipped defect then; it is not the tree now.
   */
  compact(): { folded: number; newBaseShards: number; folds: number; mintedHead: boolean; replacedUrl: string | null } {
    const effective = new Set<string>()
    for (const url of this.overlay) for (const id of Object.keys(this.segments.get(url)!.entities)) effective.add(id)
    if (effective.size === 0) return { folded: 0, newBaseShards: 0, folds: 0, mintedHead: false, replacedUrl: null }
    this.compactions += 1
    // Placement: a created id has no base shard until compaction gives it one.
    let toPlace = [...effective].filter((id) => id.startsWith('o-new-') && !this.placed.has(id))
    for (let shard = 0; shard < this.baseRoom.length && toPlace.length; shard += 1) {
      const take = Math.min(this.baseRoom[shard]!, toPlace.length)
      for (const id of toPlace.slice(0, take)) this.placed.add(id)
      this.baseRoom[shard] = this.baseRoom[shard]! - take
      toPlace = toPlace.slice(take)
    }
    let newBaseShards = 0
    while (toPlace.length) {
      const take = Math.min(BASE_SHARD_SIZE, toPlace.length)
      for (const id of toPlace.slice(0, take)) this.placed.add(id)
      this.baseRoom.push(BASE_SHARD_SIZE - take)
      this.baseShards += 1
      newBaseShards += 1
      this.splices += 1
      toPlace = toPlace.slice(take)
    }
    for (const url of this.overlay) Object.assign(this.segments.get(url)!, { entities: {}, size: 0 })
    // The replaced head: retired at its post-clear heads by the settle.
    const replacedUrl = this.current
    this.segments.get(replacedUrl)!.retiredRow = true
    const next = this.mint('head', true)
    this.overlay.push(next)
    this.current = next
    this.splices += 1
    return { folded: effective.size, newBaseShards, folds: this.foldToQuiescence(), mintedHead: true, replacedUrl }
  }

  /** The current write head's url in the model (for tests of the model). */
  get currentUrl(): string { return this.current }

  snapshot(): ChainSnapshot {
    const listed = this.overlay.map((url) => this.segments.get(url)!)
    const nonCurrent = listed.filter((segment) => segment.url !== this.current)
    const size = (segment: ModelSegment) => segment.size
    const products = nonCurrent.filter((segment) => segment.kind === 'product')
    const sealed = products.filter((segment) => size(segment) >= (this.options.segmentCeiling ?? SEGMENT_CEILING))
    const sizes = products.map(size)
    const distinct = new Set<string>()
    let entries = 0
    for (const segment of listed) {
      for (const id of Object.keys(segment.entities)) distinct.add(id)
      entries += size(segment)
    }
    return {
      rotations: this.rotations,
      folds: this.folds,
      compactions: this.compactions,
      overlayListed: this.overlay.length,
      fsckCeiling: FSCK_CHAIN_CEILING,
      overFsckCeiling: this.overlay.length > FSCK_CHAIN_CEILING,
      objectShardUrls: this.baseShards + this.overlay.length,
      baseShards: this.baseShards,
      sealedProducts: sealed.length,
      unsealedProducts: products.length - sealed.length,
      retiredHeads: nonCurrent.filter((segment) => segment.kind === 'head').length,
      unsealedTail: nonCurrent.filter((segment) => size(segment) < (this.options.segmentCeiling ?? SEGMENT_CEILING)).length,
      productSizes: sizes.length
        ? { min: Math.min(...sizes), median: median(sizes), max: Math.max(...sizes), sum: sizes.reduce((a, b) => a + b, 0) }
        : null,
      totalEntityEntries: entries,
      distinctOverlayEntities: distinct.size,
      objectsTotal: BASE_OBJECTS + this.created,
      modelMetaSplices: this.splices,
    }
  }
}
