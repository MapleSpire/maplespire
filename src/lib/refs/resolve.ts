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
 * The three states a cross-entity reference can be in.
 *
 * `unknown` is the whole point. A windowed client cannot tell "deleted" from
 * "not loaded": the ADR list is a bounded page (`DecisionRecordsView` caps at
 * 2 000) and the diagram registry is a server-fed summary of ONE entry under
 * `isRegistrySummaryOnlyActive()`. A two-state resolver has to guess, and both
 * guesses are wrong in a user-visible way — `dangling` reports healthy links
 * broken, `live` walks the user into a dead end.
 *
 * So the absence of proof gets its own answer, and one UI rule follows from it:
 *
 *   **`unknown` must never render like `dangling`.**
 *
 * Only a reader that sees the whole collection may promote `unknown` to
 * `dangling`: a tombstone on the client, the integrity scan on the server.
 */
export type RefState = 'live' | 'dangling' | 'unknown'

export interface RefResolution<T> {
  state: RefState
  /** Present only when `state === 'live'`. */
  target?: T
}

export interface RefLookup<T> {
  get(id: string): T | undefined
  /**
   * True only when a miss PROVES absence — i.e. the whole target collection is
   * resident. There is deliberately no default: silently assuming completeness
   * is the exact mistake this module exists to prevent.
   */
  complete: boolean
  /**
   * Ids proven dead — an Automerge tombstone, or a 404 from a resolve-on-click
   * probe. A hit here answers `dangling` even when `complete` is false, which is
   * the only way a windowed client can ever say `dangling` at all.
   */
  deleted?: ReadonlySet<string>
}

/**
 * Resolve one reference.
 *
 * `id` is typed nullable for the callers that hold an optional field, but note
 * what an absent id means HERE: a reference that was declared and points
 * nowhere, which is `dangling`. A field that is optional *by design*
 * (`Diagram.parentObjectId` absent means "not a drill-down") must not be passed
 * — the caller decides whether a reference exists before asking what it is.
 */
export function resolveRef<T>(id: string | null | undefined, lookup: RefLookup<T>): RefResolution<T> {
  if (!id) return { state: 'dangling' }
  if (lookup.deleted?.has(id)) return { state: 'dangling' }
  const target = lookup.get(id)
  if (target !== undefined) return { state: 'live', target }
  return { state: lookup.complete ? 'dangling' : 'unknown' }
}

/**
 * Build a lookup over a resident array.
 *
 * This walks `items` to build the map, so memoise it — calling it inside a
 * render loop turns a per-link resolution into a per-link full scan, which is
 * the cost class the reverse maps in `modelStore` exist to avoid.
 */
export function lookupFromArray<T extends { id: string }>(
  items: readonly T[],
  options: { complete: boolean; deleted?: ReadonlySet<string> },
): RefLookup<T> {
  const byId = new Map(items.map((item) => [item.id, item]))
  return { get: (id) => byId.get(id), complete: options.complete, deleted: options.deleted }
}

/** Build a lookup over an index that is already keyed by id. */
export function lookupFromMap<T>(
  byId: ReadonlyMap<string, T>,
  options: { complete: boolean; deleted?: ReadonlySet<string> },
): RefLookup<T> {
  return { get: (id) => byId.get(id), complete: options.complete, deleted: options.deleted }
}

/**
 * Whether the UI may offer the reference as an action.
 *
 * `unknown` is actionable BY DESIGN — the click is what resolves it. Only
 * `dangling` is inert.
 */
export function isActionableRef(state: RefState): boolean {
  return state !== 'dangling'
}

/**
 * Labels captured when a reference was created go stale on rename. Prefer the
 * live name and fall back to the stored snapshot — never the other way round,
 * and never to a blank string, because a chip with no text cannot be removed by
 * a user who cannot see it.
 */
export function refLabel<T>(
  resolution: RefResolution<T>,
  live: (target: T) => string,
  fallback: string,
): string {
  if (resolution.state === 'live' && resolution.target !== undefined) {
    const label = live(resolution.target).trim()
    if (label) return label
  }
  return fallback
}
