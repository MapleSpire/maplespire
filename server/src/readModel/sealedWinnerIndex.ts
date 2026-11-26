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
 * THE SEALED-WINNER INDEX (G4-16f). What the PARKED sealed fold products of
 * one kind serve, without any of them resident.
 *
 * A sealed product (`ordinaryChainFoldWriter.ts`: a fold marker and at least
 * `OVERLAY_SEGMENT_ENTITY_CEILING` entities) is never folded again and never
 * projected, so once the projector has read it, its content is fixed for the
 * projector's life: a change degrades it (`ORDINARY_FOLD_PRODUCT_CHANGED`)
 * and only a cold build lifts that. Its document, and the two JS copies the
 * projector used to keep (the per-shard map of the extraction and the
 * watcher's snapshot), can then go: what every reader needs is the value
 * each entity ends up with in the LAST-WINS merge over ModelMeta's list
 * (`extractModelEntities`'s `Object.assign`, `servedOutsideCurrentHead`).
 *
 * For each entity id this keeps ONE entry: the latest sealed product holding
 * it in ModelMeta ORDER (never in the order the products were read: the
 * cold build reads in list order, a product parked mid-session can sit
 * before one parked earlier). A product then serves only the ids it WINS
 * (`idsWonBy`). That is the same merge result: an id a product loses is
 * overwritten by a later sealed product in the very same pass, whatever
 * unsealed segment sits between them.
 *
 * IDS, NOT VALUES (G4-16f C5). The index holds `id -> winning url` and
 * `url -> ids won`. A value is held (PINNED) only for a product added with
 * its values and not yet `unpin`ned — the projector pins a product read
 * from its document until the extract cache has committed it
 * (`sealedProductCache.ts`, `onWritten`), and reads the value of every
 * other product from that extract (`sealedWinners.ts`). A pinned product
 * keeps the values of the ids it still wins only: one that loses an id to
 * a later product drops that value. Memory: O(distinct entities held by
 * parked products) ids, plus the values of the pinned products' wins.
 *
 * `innerIdOf`: the text of an entity's inner `id` (`parameterText`, what
 * the duplicate-id rule compares) where it differs from its map key, so a
 * reader that needs only the ids of the merge (the registry pass's defect
 * list) gets the same duplicate-id defects without any value.
 *
 * WHAT IT CANNOT DO: give a loser's value back. A winner unlisted, or the
 * relative order of two indexed products changed (only a client rewriting
 * ModelMeta's lists can do either; compaction detaches the projector first),
 * leaves the index unable to answer: `orderMatches` says so and the
 * projector degrades the products until a cold build.
 *
 * Pure: no I/O, no Automerge. Pinned values are stored as given; the caller
 * hands in plain copies, never live document objects.
 */
/** The rank `add` wants, over one list: the LAST position of `url` (-1 when
 * unlisted). Last, as the merge's last-wins `Object.assign` counts a url
 * listed twice. Rank by the list the caller MERGED, never by a later one. */
export function sealedRankIn(list: readonly string[]): (url: string) => number {
  return (url) => list.lastIndexOf(url)
}

export class SealedWinnerIndex<T = unknown> {
  /** entity id -> the product that wins it. */
  private readonly winners = new Map<string, string>()
  /** product url -> the ids it wins (possibly none). */
  private readonly wonBy = new Map<string, Set<string>>()
  /** Indexed product urls, in the list order they were ranked by. */
  private order: string[] = []
  /** PINNED product url -> the value of each id it wins. */
  private readonly pins = new Map<string, Map<string, T>>()
  /** entity id -> its winner's inner-id text, where that differs from the id. */
  private readonly innerIds = new Map<string, string | null>()

  /** Products indexed. */
  get products(): number { return this.order.length }

  /** Entities indexed (each once). */
  get entities(): number { return this.winners.size }

  /** Values held in memory, over every pinned product. */
  get pinnedValues(): number {
    let count = 0
    for (const values of this.pins.values()) count += values.size
    return count
  }

  /** Values held in memory for `url` (0 when it is not pinned). */
  pinnedValuesOf(url: string): number { return this.pins.get(url)?.size ?? 0 }

  /** Products whose values are held in memory. */
  get pinnedProducts(): number { return this.pins.size }

  has(url: string): boolean { return this.wonBy.has(url) }

  /**
   * Index product `url` holding the entity ids `ids`. `rankOf` is the
   * position of a url in ModelMeta's CURRENT list for the kind (-1 when
   * unlisted): an id already won by another product goes to whichever of the
   * two ranks later. Adding a product twice replaces nothing it already wins.
   *
   * `innerIds`: an id's inner-id text where it differs from the id
   * (`innerIdOf`); an id absent from it has an inner id equal to it. Given
   * by every caller (possibly empty), so none can forget it. `values`
   * (optional): the product's entity map; the value of every id it wins is
   * PINNED. A value the map lacks for one of `ids` is refused (a throw,
   * before anything is indexed): `undefined` is never held as a value.
   */
  add(
    url: string,
    ids: Iterable<string>,
    rankOf: (url: string) => number,
    innerIds: ReadonlyMap<string, string | null>,
    values?: Readonly<Record<string, T>>,
  ): void {
    const rank = rankOf(url)
    if (rank < 0) throw new Error(`sealed product ${url} is not listed; not indexed`)
    const idList = [...ids]
    if (values) {
      const missing = idList.find((id) => values[id] === undefined)
      if (missing !== undefined) throw new Error(`sealed product ${url}: no value for ${missing}; not indexed`)
    }
    let won = this.wonBy.get(url)
    if (!won) {
      won = new Set()
      this.wonBy.set(url, won)
      // Kept in list order, by the same ranks.
      const at = this.order.findIndex((other) => rankOf(other) > rank)
      if (at < 0) this.order.push(url)
      else this.order.splice(at, 0, url)
    }
    let pinned = this.pins.get(url)
    if (values && !pinned) {
      pinned = new Map()
      this.pins.set(url, pinned)
    }
    for (const id of idList) {
      const current = this.winners.get(id)
      if (current !== undefined && current !== url && rankOf(current) > rank) continue
      if (current !== undefined && current !== url) {
        this.wonBy.get(current)?.delete(id)
        this.pins.get(current)?.delete(id)
      }
      this.winners.set(id, url)
      won.add(id)
      if (values && pinned) pinned.set(id, values[id] as T)
      if (innerIds.has(id)) this.innerIds.set(id, innerIds.get(id) ?? null)
      else this.innerIds.delete(id)
    }
  }

  /** The ids `url` wins in the merge (a fresh array, possibly empty; empty
   * for a product not indexed). */
  idsWonBy(url: string): string[] {
    return [...(this.wonBy.get(url) ?? [])]
  }

  /** Does `url` win `id`? */
  wins(url: string, id: string): boolean {
    return this.winners.get(id) === url
  }

  /** The text of `id`'s inner id in the merge (`parameterText` of the
   * winner's `id` field): `id` itself unless the winner said otherwise. */
  innerIdOf(id: string): string | null {
    return this.innerIds.has(id) ? this.innerIds.get(id)! : id
  }

  /** Are `url`'s values held in memory? */
  isPinned(url: string): boolean { return this.pins.has(url) }

  /** The PINNED value `url` serves for `id`: undefined when it does not win
   * `id`, or when its values are not held (ask `isPinned`). A pinned product
   * that wins `id` always has one (`add`, `pin`). */
  pinnedValue(url: string, id: string): T | undefined {
    return this.winners.get(id) === url ? this.pins.get(url)?.get(id) : undefined
  }

  /** Hold `url`'s values again (its extract went missing): the value of
   * every id it currently wins, from `values`. THROWS, pinning nothing, when
   * `values` lacks one of them: a pinned product answers for every id it
   * wins, never with `undefined`. */
  pin(url: string, values: Readonly<Record<string, T>>): void {
    if (!this.wonBy.has(url)) return
    const pinned = new Map<string, T>()
    for (const id of this.wonBy.get(url)!) {
      if (values[id] === undefined) throw new Error(`sealed product ${url}: no value for ${id}; not pinned`)
      pinned.set(id, values[id] as T)
    }
    this.pins.set(url, pinned)
  }

  /** Drop `url`'s values from memory (its extract is committed). */
  unpin(url: string): void {
    this.pins.delete(url)
  }

  /** Does `list` (ModelMeta's current list for the kind) still name every
   * indexed product, in the order they were ranked? */
  orderMatches(list: readonly string[]): boolean {
    const indexed = list.filter((url) => this.wonBy.has(url))
    return indexed.length === this.order.length && indexed.every((url, at) => url === this.order[at])
  }
}
