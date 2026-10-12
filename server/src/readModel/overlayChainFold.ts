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

import { canonicalOverlayDocumentIds } from './overlayHistoryProtocol.js'

/**
 * Overlay CHAIN folding. This is deliberately NOT `compactOverlay`, and
 * the name is different on purpose: confusing the two is a data-loss defect.
 *
 * A promoted (summary) workspace rotates a new overlay segment every
 * OVERLAY_SEGMENT_SIZE write batches, and NOTHING ever removes one — every
 * `editsObjectShardUrls` / `editsConnectionShardUrls` reference in the repo is
 * a reader or an appender. So ModelMeta, the projector's in-memory segment
 * state, and the rebuild cost all grow without bound on a workspace that is
 * actually being edited.
 *
 * WHY NOT `compactOverlay`. That routine folds overlay values into the BASE
 * shards and then clears the folded entries. Both halves lose data here:
 *   - the static delta projector never opens the base shards (its own header
 *     says so), so a value folded there is never reprojected; and
 *   - clearing an overlay entry makes `updateStaticOverlaySegment` see "no
 *     winner", which it turns into a `deleteIds` — i.e. the row leaves
 *     `ro_objects` while the Automerge documents stay correct. The user sees
 *     the object vanish from Model Objects and from the server render.
 *
 * So the fold stays INSIDE the overlay world: merge the oldest contiguous
 * PREFIX of retired segments into one new segment and substitute it at the
 * prefix's slot. The effective (last-wins) entity set is unchanged BY
 * CONSTRUCTION, so the pass emits no deletes at all.
 *
 * This module is pure: no repo, no SQL, no clock. The pass that drives it owns
 * durability ordering (flush the merged segment, witness it in storage, claim
 * it, and only THEN publish the single ModelMeta change) and ownership fencing.
 */

/** Why CONTIGUITY and not any subset: ModelMeta order IS the last-wins order.
 * Merging a contiguous run keeps every surviving segment on the older side
 * older and every one on the newer side newer, so the substitution is
 * order-preserving. Merging a non-contiguous subset would move values across
 * segments that outrank them.
 *
 * Contiguity, not prefix-ness, is what the invariant needs: any contiguous
 * window (`[2,3]`, `[1,2,3]`) substitutes with zero last-wins inversions, while
 * a gapped one (`[0,2]`, `[0,4]`) inverts. Since a window that skips `sealed`
 * segments is not a prefix, the `requireContiguous` refusal inside
 * `substituteOverlayPrefix` is what enforces this. */
export type OverlayChainFoldSkip =
  | 'no-current-head'
  | 'head-not-listed'
  | 'chain-below-threshold'
  | 'budget-below-two'
  | 'no-foldable-run'

export interface OverlayChainFoldPlan {
  /** The contiguous OLDEST FOLDABLE run to merge. Empty when nothing is to be
   * done — check `skippedReason` for why. */
  fold: string[]
  /** Everything not folded, current head LAST. */
  tail: string[]
  /** Where `fold` begins in the canonical order, so that
   * `[...canonical.slice(0, foldAt), ...fold, ...canonical.slice(foldAt + fold.length)]`
   * reconstructs it. Zero whenever no segment is sealed, which is why
   * `fold.concat(tail)` still equals the canonical order for every caller that
   * supplies no sizes. */
  foldAt: number
  /** Entities the pass will merge, when sizes were supplied. This is the
   * quantity the advisory-lock hold is proportional to — see `windowEntities`. */
  windowEntities?: number
  skippedReason?: OverlayChainFoldSkip
}

export interface OverlayChainFoldOptions {
  /** Do nothing until the retired chain reaches this length. */
  minChain?: number
  /** At most this many segments per pass. A workspace at 3 000 segments
   * converges over several passes instead of blocking the projector for
   * minutes. */
  budget?: number
  /**
   * A segment holding at least this many entities is SEALED: never a fold
   * candidate again, so no pass can merge it into something larger.
   *
   * Without it the merged segment is the oldest element of the chain it
   * produces, so every pass folds the previous merge back in and its entity
   * count is monotone non-decreasing with limit "every distinct entity ever
   * written to the overlay" — on a ~12 000-object landscape, nearly every
   * entity ends up in ONE Automerge document within a dozen passes.
   */
  segmentCeiling?: number
  /**
   * The most entities ONE pass may merge.
   *
   * `budget` counts SEGMENTS, which says nothing about what is inside the
   * advisory lock; the ceiling must be measured against what is INSIDE the
   * lock. Measured: `repo.create` + `repo.flush` runs at ~0.586 ms per entity
   * (12-field `ObjectInput`) and ~0.25 ms per entity (9-field), so 32 segments
   * of 512 is 16 384 entities and up to ~9.6 s inside a key that
   * `synchronizeOverlaySegments` takes with `lock_timeout = 0`.
   *
   * It also bounds the WASM heap, which is the harm that cannot be undone:
   * wasm32 linear memory never shrinks, so materialising a 12 000-entity
   * document permanently raises the projector's high-water mark (measured at
   * ~740 MB retained per pass; `removeFromCache` gives almost none of it back).
   */
  windowEntities?: number
  /**
   * Entity count for a listed url, or `undefined` when it is not known.
   *
   * UNKNOWN IS TREATED AS UNSEALED AND AS ZERO, deliberately. The only source
   * cheap enough to consult at plan time is the projector's own
   * `read_model_overlay_segments` row, so a segment this projector has not yet
   * projected has no count — and refusing to fold it would make a cold
   * projector unable to fold anything at all. The cost of the other direction
   * is a pass that merges more than `windowEntities`; the fold re-derives its
   * obligation on the next reload tick either way.
   */
  entityCountOf?: (url: string) => number | undefined
}

// The invariant above is enforced in `substituteOverlayPrefix`
// (`staticDeltaProjector.ts`), at the one place that can violate it. That check
// tolerates exactly one gap, the current write head, because
// `canonicalOverlayDocumentIds` relocates it and raw list positions are
// therefore NOT the canonical order; do not add a pure contiguity helper here
// that cannot know this.

// The knobs below go through `envNumber` (never a hand-rolled bounded parse) so
// they are declared, linted by `local/no-bare-env-number`, clamped at a
// maximum, and rejected loudly via `env.knob_rejected`. The maximum matters:
// `OVERLAY_CHAIN_CEILING = 4 * OVERLAY_CHAIN_FOLD_MIN`, so an unbounded
// `AM_OVERLAY_CHAIN_FOLD_MIN` would both stop the fold and raise the fsck
// ceiling that detects a stopped fold — disabling a mechanism and its detector
// with one knob.
import { envNumber } from '../envNumber.js'

export const OVERLAY_CHAIN_FOLD_MIN = envNumber('AM_OVERLAY_CHAIN_FOLD_MIN', {
  fallback: 64, minimum: 2, maximum: 4_096, integer: true,
})
/** `minimum: 1`, not 2, and the difference is a KILL SWITCH. With a floor of 2
 * the planner's named `budget-below-two` refusal becomes unreachable from the
 * environment — `index.ts` passes `undefined` for both fold options, so these
 * constants are the only production source — and an operator setting
 * `AM_OVERLAY_CHAIN_FOLD_BUDGET=1` to stop a misbehaving fold would instead
 * fall back to 32, i.e. get SIXTEEN TIMES the work per pass and sixteen times
 * the lock hold, in exactly the direction they were trying to avoid. Keeping 1
 * admissible preserves both the disable path and the skip reason that names
 * it. */
export const OVERLAY_CHAIN_FOLD_BUDGET = envNumber('AM_OVERLAY_CHAIN_FOLD_BUDGET', {
  fallback: 32, minimum: 1, maximum: 4_096, integer: true,
})

/**
 * The entity ceiling a folded segment is SEALED at, and the entity budget one
 * pass may merge. See `OverlayChainFoldOptions.segmentCeiling` /
 * `.windowEntities` for what each buys and the measurements behind them.
 *
 * WHY 1 024 AND 2 048, derived rather than picked:
 *
 *  - the window budget is set by the lock. `synchronizeOverlaySegments` takes
 *    the same advisory key as the fold, and `withReadModelProjectionTransaction`
 *    issues `SET LOCAL lock_timeout = 0` before it, deliberately — so the fold's
 *    hold has no ceiling on the waiter's side and the bound has to live here.
 *    At the measured ~0.586 ms/entity for `repo.create` + `repo.flush`, 2 048
 *    entities is ~1.2 s — well under the 5 000 ms `STATIC_PLANE_LOCK_WAIT_MS`
 *    the projection transaction's own `lock_timeout` uses elsewhere (an
 *    unbounded pass on a ~12 000-object landscape takes ~7 s).
 *  - the segment ceiling is then the largest value that still lets a window
 *    merge two of them: `2 * 1024 = 2048 = windowEntities`. A larger ceiling
 *    would seal segments that no window can ever pair, and a fold that can
 *    never pair two segments is a fold that does nothing.
 *  - and it must satisfy the chain ceiling. `overlay-chain-bounded` refuses a
 *    chain past `OVERLAY_CHAIN_CEILING` (256), and a sealed run holds
 *    `ceil(D / segmentCeiling)` segments, so the pair is satisfiable only while
 *    `D <= segmentCeiling * (CEILING - minChain - 1)` = 1 024 x 191 = 195 584
 *    entities. That is the design's stated capacity; `overlay-segment-bounded`
 *    in `workspaceFsck.ts` is what reports the operand.
 *
 * KNOWN RESIDUAL, the price of the trade: a bounded window can only
 * deduplicate entities that appear TWICE INSIDE IT. On a workload that
 * rewrites every entity uniformly, the two copies sit ~`D / segmentSize`
 * segments apart, so they never share a window and the sealed run grows with
 * TOTAL WRITES rather than with distinct entities (e.g. ~60 000 entries for
 * ~12 000 distinct ids at a 5x rewrite rate — ~10 MB on disk at ~212
 * B/entity, versus ~740 MB of unrecoverable WASM heap for an unbounded merge).
 * Leveled (amortised) compaction would remove this residual.
 */
export const OVERLAY_SEGMENT_ENTITY_CEILING = envNumber('AM_OVERLAY_SEGMENT_ENTITY_CEILING', {
  fallback: 1_024, minimum: 2, maximum: 65_536, integer: true,
})
/** The MINIMUM is `2 * OVERLAY_SEGMENT_ENTITY_CEILING`, not 2, and that is a
 * correctness bound rather than taste: a window that cannot hold two sealed
 * segments can never pair them, so a fold configured below it would refuse
 * every run while reporting work to do. */
export const OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES = envNumber('AM_OVERLAY_CHAIN_FOLD_WINDOW_ENTITIES', {
  fallback: 2 * OVERLAY_SEGMENT_ENTITY_CEILING,
  minimum: 2 * OVERLAY_SEGMENT_ENTITY_CEILING,
  maximum: 131_072,
  integer: true,
})

/**
 * Decide which segments a fold pass may merge.
 *
 * `documentIds` is the raw ModelMeta list and `currentDocumentId` the write
 * head. Both are normalised through `canonicalOverlayDocumentIds`, which puts
 * the head LAST — so the candidate list is the canonical order MINUS its final
 * element. Reading `canonicalOverlayDocumentIds()` output as candidates
 * directly would swallow the head clients are writing into.
 */
export function planOverlayChainFold(
  documentIds: readonly string[],
  currentDocumentId: string | undefined,
  options: OverlayChainFoldOptions = {},
): OverlayChainFoldPlan {
  const minChain = options.minChain ?? OVERLAY_CHAIN_FOLD_MIN
  const budget = options.budget ?? OVERLAY_CHAIN_FOLD_BUDGET
  const ordered = canonicalOverlayDocumentIds(documentIds, currentDocumentId)

  // No head means we cannot tell which segment clients still write into, and a
  // fold that swallows the write head loses every edit landing during the pass.
  // Refuse rather than guess.
  if (!currentDocumentId) {
    return { fold: [], tail: ordered, foldAt: 0, skippedReason: 'no-current-head' }
  }
  // A head the list does not carry is NOT the same case, and the difference
  // matters: `canonicalOverlayDocumentIds` APPENDS an unlisted head, so it ends
  // up last either way and a check on the last element cannot tell them apart.
  // ModelMeta's two fields disagreeing means the write head and the segment
  // list were written by different hands (a legacy shape, or a rotation whose
  // publish did not complete). Folding would still exclude the head, but acting
  // on a meta that contradicts itself is how a repair becomes a defect. What
  // lifts this refusal: the next rotation writes `current` and the list in ONE
  // `metaHandle.change`, so the disagreement is self-healing.
  if (!documentIds.some((url) => url === currentDocumentId)) {
    return { fold: [], tail: ordered, foldAt: 0, skippedReason: 'head-not-listed' }
  }
  // Merging one segment into one segment costs a document and buys nothing.
  if (budget < 2) return { fold: [], tail: ordered, foldAt: 0, skippedReason: 'budget-below-two' }

  const retired = ordered.slice(0, -1)
  if (retired.length < minChain) {
    return { fold: [], tail: ordered, foldAt: 0, skippedReason: 'chain-below-threshold' }
  }

  // No sizes supplied => nothing is sealed and no window budget applies, so the
  // run below is the oldest PREFIX. That keeps every caller that cannot cheaply
  // count entities on the simple prefix contract.
  const sizeOf = options.entityCountOf
  const segmentCeiling = options.segmentCeiling ?? Number.POSITIVE_INFINITY
  const windowEntities = options.windowEntities ?? Number.POSITIVE_INFINITY
  const sealed = (url: string): boolean => {
    const size = sizeOf?.(url)
    return size !== undefined && size >= segmentCeiling
  }

  let cursor = 0
  while (cursor < retired.length) {
    if (sealed(retired[cursor]!)) { cursor += 1; continue }
    let end = cursor
    let entities = 0
    while (end < retired.length && end - cursor < budget && !sealed(retired[end]!)) {
      const next = entities + (sizeOf?.(retired[end]!) ?? 0)
      // ALWAYS admit two. A window budget that can refuse the second segment
      // makes a run of large-but-unsealed segments permanently unfoldable,
      // which is a fold that reports work to do and never does it.
      if (next > windowEntities && end - cursor >= 2) break
      entities = next
      end += 1
    }
    if (end - cursor >= 2) {
      const fold = ordered.slice(cursor, end)
      return {
        fold,
        tail: [...ordered.slice(0, cursor), ...ordered.slice(end)],
        foldAt: cursor,
        windowEntities: sizeOf ? entities : undefined,
      }
    }
    // A run of one: `end` is the sealed segment that stopped it, so resume
    // after it. (Advancing to `end` would be equivalent — the `sealed()` guard
    // skips it in one extra iteration — just marginally slower.)
    //
    // `+ 1`, never `+ 2`: that skips a segment as a run start, so a foldable
    // pair beginning at `end + 1` is silently invisible. Pinned by a test.
    cursor = end + 1
  }

  // REPAIR. No pair is mergeable — but a segment already PAST the ceiling is
  // not merely unmergeable, it is exactly what the ceiling exists to bound,
  // and sealing it means no ordinary window can ever reach it again.
  //
  // This happens in practice: a bulk import puts the whole landscape in one
  // head, `rotateOverlayHead` retires it WHOLE (it creates an empty successor
  // and never splits), and the resulting segment is `>= segmentCeiling` from
  // birth — sealed, excluded from every window for ever, and reported
  // `degraded` by `overlay-segment-bounded` permanently unless something
  // repairs it. A detector for a state that cannot be left gets muted.
  //
  // Splitting ONE segment into `ceil(n / ceiling)` parts is the repair, and it
  // is the one case where a window of a single segment is worth a pass: the
  // ordinary "one into one buys nothing" argument does not hold, because the
  // output is smaller than the input in the dimension that matters.
  //
  // STRICTLY GREATER, not `>=`. A segment exactly AT the ceiling is what a
  // correct split produces; re-splitting it would emit one part identical to
  // its input and loop for ever.
  //
  // THE COST: this pass is as large as the segment
  // it repairs, so it can exceed `windowEntities`. That is unavoidable — the
  // segment cannot be split without being read — and it is paid ONCE per
  // oversized segment, against a permanent violation otherwise. The current
  // head is not a candidate (`retired` excludes it), so an oversized head is
  // repaired only after a rotation retires it, which is the correct order:
  // clients are still writing into it.
  if (sizeOf) {
    for (let at = 0; at < retired.length; at += 1) {
      const size = sizeOf(retired[at]!)
      if (size === undefined || size <= segmentCeiling) continue
      return {
        fold: [retired[at]!],
        tail: [...ordered.slice(0, at), ...ordered.slice(at + 1)],
        foldAt: at,
        windowEntities: size,
      }
    }
  }

  // Every candidate run is shorter than two segments and nothing is oversized —
  // the chain is past the threshold and there is still nothing worth merging. A
  // NAMED reason, because a fold that refuses for ever is otherwise
  // indistinguishable from one that is working.
  return { fold: [], tail: ordered, foldAt: 0, skippedReason: 'no-foldable-run' }
}

/**
 * Merge segment contents in ModelMeta order, last one wins.
 *
 * Behaviourally identical to `mergeStaticOverlaySegments`, and pinned to it by
 * a test so the producers of last-wins overlay order cannot drift. The
 * difference is the return
 * shape: a fold has to write a SEGMENT back, so it keeps the record keys,
 * where the projector only needs the values.
 *
 * Tombstones are deliberately NOT applied. A fold must not change the
 * effective set; `deletedObjectIds` lives in ModelMeta, is applied downstream,
 * and can be cleared — dropping an id here would make that clearing resurrect
 * nothing instead of resurrecting the value.
 */
export function foldOverlaySegmentContents<T>(
  segments: readonly Record<string, T>[],
): Record<string, T> {
  const merged = new Map<string, T>()
  for (const segment of segments) {
    for (const [id, value] of Object.entries(segment)) merged.set(id, value)
  }
  return Object.fromEntries(merged)
}

/**
 * Cut a merged map into segments of at most `bound` entities.
 *
 * ORDER IS IRRELEVANT HERE, and that is the whole reason this is safe: the
 * merge has already resolved last-wins, so each id appears EXACTLY ONCE in
 * `merged`. Any partition of it into contiguous, disjoint segments substituted
 * at the window's slot preserves the effective set — there is no id whose
 * winner could be decided by the order of two output parts.
 *
 * Returns `[{}]` for an empty input rather than `[]`, so a caller that
 * substitutes the result never removes the window without putting anything
 * back. A fold of segments that are all empty is degenerate but not a licence
 * to shorten the chain by deleting content-free history the GC still owns.
 */
export function splitMergedOverlaySegment<T>(
  merged: Record<string, T>,
  bound: number,
): Record<string, T>[] {
  const entries = Object.entries(merged)
  if (!entries.length) return [{}]
  const limit = Math.max(1, Math.trunc(bound))
  const parts: Record<string, T>[] = []
  for (let at = 0; at < entries.length; at += limit) {
    parts.push(Object.fromEntries(entries.slice(at, at + limit)))
  }
  return parts
}
