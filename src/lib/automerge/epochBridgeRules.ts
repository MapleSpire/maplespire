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

import { hasHeads } from '@automerge/automerge'

/**
 * The epoch decisions the sync bridge makes (G4-16f, the live epoch hop),
 * out of `bridge.ts` so each is unit-tested — the bridge only wires them to
 * its state.
 */

export interface TargetHeads { documentId: string; heads: string[] }

/**
 * Whether the documents the tab is about to project hold what the
 * forwards wrote. A target the tab does not project is not its business; one
 * it projects must be loaded and hold every head.
 */
export function holdsTargets(projected: ReadonlyMap<string, () => unknown>, targets: readonly TargetHeads[]): boolean {
  return targets.every((t) => {
    const doc = projected.get(t.documentId)
    if (!doc) return true
    const current = doc()
    return !!current && hasHeads(current as never, t.heads)
  })
}

export type RepointAction = 'none' | 'cancel' | 'start' | 'probe'

/**
 * Step 1, DETECT: what a root naming `rootMetaUrl` asks of a
 * tab booted on `bootedMetaUrl`. Back to the booted meta: cancel a running
 * hop. Elsewhere: hop — only on a workspace with epochs (a flag-off repoint
 * leaves no forward journal). Not KNOWN to have epochs
 * yet: ask the server once (`probe`) — a tab booted before the FIRST roll that
 * writes nothing afterwards would otherwise never learn it, and never follow.
 */
export function repointAction(args: { bootedMetaUrl: string | null; rootMetaUrl: string | null | undefined; capability: boolean }): RepointAction {
  if (!args.bootedMetaUrl || !args.rootMetaUrl) return 'none'
  if (args.rootMetaUrl === args.bootedMetaUrl) return 'cancel'
  return args.capability ? 'start' : 'probe'
}

/**
 * The capability is STICKY. A `true` from the server or the
 * meta holds for good; a later `false` (a stale or failing answer) never
 * downgrades it.
 */
export function nextEpochCapability(current: boolean, answered: boolean): boolean {
  return current || answered
}

/**
 * What a lifecycle flush (pagehide, stop) does with writes the hop's
 * latch holds. Paused by the latch: lift the pause around ONE flush, re-arm a
 * deferred write first, pause again. Not paused: flush.
 */
export function lifecycleFlushPlan(state: { pausedByHop: boolean; deferredByHop: boolean; pending: boolean }):
  { flush: boolean; liftPause: boolean; requestDeferred: boolean } {
  if (!state.pending && !state.deferredByHop) return { flush: false, liftPause: false, requestDeferred: false }
  return { flush: true, liftPause: state.pausedByHop, requestDeferred: state.pausedByHop && state.deferredByHop }
}

/**
 * The ModelMetas a held shard pointer may name
 * and still be resumed into the current meta — the EPOCH PREDECESSORS of the
 * current one, walked through `epochPredecessorRef` (each roll's meta names
 * the one it superseded). A repoint to another lineage (a repair, the slim
 * script, a reseed) or to another version is not on that chain, so its held
 * pointers are not resurrected. `load` reads a predecessor this browser holds
 * (bounded by the caller); the walk stops at `max` steps or an unknown meta.
 */
export async function epochPredecessorChain(
  current: unknown,
  load: (url: string) => Promise<unknown>,
  max = 8,
): Promise<Set<string>> {
  return (await walkEpochLineage({ current, load, max })).chain
}

/**
 * THE PERSISTED LINEAGE: metaId → its predecessor's id ('' =
 * none: the walk stops), one KV record per concrete workspace, written at
 * each boot and each swap (and with every link a walk had to LOAD) by one
 * atomic `KvStore.update`, so tabs never lose each other's links. The walk
 * then needs no load for any link this browser has seen: a pointer held on
 * E(n−2) survives two rolls and a reload (an in-memory walk stopped after one
 * link at boot and gave the pointer up after three boots).
 */
export const EPOCH_LINEAGE_KEY = 'epoch-lineage:v1'
export const EPOCH_LINEAGE_MAX = 64
export type EpochLineage = Record<string, string>

/** `links` merged into a stored lineage (anything malformed dropped), the
 * newest last, the oldest beyond `max` forgotten. */
export function withLineageLinks(stored: unknown, links: ReadonlyArray<readonly [string, string]>, max = EPOCH_LINEAGE_MAX): EpochLineage {
  const out = new Map<string, string>()
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [meta, pred] of Object.entries(stored as Record<string, unknown>)) if (typeof pred === 'string') out.set(meta, pred)
  }
  for (const [meta, pred] of links) {
    if (!meta || meta === pred) continue
    out.delete(meta)
    out.set(meta, pred)
  }
  return Object.fromEntries([...out].slice(-max))
}

/**
 * Walk `current`'s epoch predecessors: through the persisted `lineage` where
 * it has the link, `load`ing the predecessor meta where it does not (the
 * caller bounds `load`: local only at boot, the network only when a held
 * pointer needs it). `learned`: the links the walk found that `lineage` did
 * not hold, to persist. Bounded by `max`; a cycle stops it.
 */
/** What a walk's `load` returns for a predecessor meta that is GONE for good
 * (a meta the server's GC deleted answers "unavailable" while the server
 * is reachable). The walk stops there and
 * DECIDES — the chain ends — instead of calling itself incomplete at every
 * boot, which kept the entry alive and re-spent the budget for ever. */
export const EPOCH_LINK_GONE: unique symbol = Symbol('epoch link gone')

export async function walkEpochLineage(args: {
  current: unknown
  /** The current meta's id: its own link is `learned` too. */
  currentId?: string
  lineage?: EpochLineage
  load: (url: string) => Promise<unknown>
  max?: number
}): Promise<{ chain: Set<string>; learned: Array<[string, string]>; complete: boolean }> {
  const lineage = args.lineage ?? {}
  const max = args.max ?? 8
  const chain = new Set<string>()
  const learned: Array<[string, string]> = []
  let pred = predecessorIdOf(args.current)
  if (args.currentId && lineage[args.currentId] !== (pred ?? '')) learned.push([args.currentId, pred ?? ''])
  // `complete`: the walk reached the chain's end (or its bound,
  // or a cycle) — not a link it could not load.
  let complete = true
  for (let step = 0; step < max && pred; step += 1) {
    if (chain.has(pred) || pred === args.currentId) break
    chain.add(pred)
    let next: string | null | undefined = lineage[pred]
    if (next === undefined) {
      const doc = await args.load(`automerge:${pred}`).catch(() => undefined)
      // Gone: decided, nothing learned (its own predecessor is unknown).
      if (doc === EPOCH_LINK_GONE) break
      if (!doc) { complete = false; break }
      next = predecessorIdOf(doc)
      learned.push([pred, next ?? ''])
    }
    pred = next || null
  }
  return { chain, learned, complete }
}

/** The id of the meta `doc`'s `epochPredecessorRef` names (an automerge URL
 * only), or null. */
export function predecessorIdOf(doc: unknown): string | null {
  const url = predecessorRef(doc)
  return url ? url.slice('automerge:'.length) : null
}

/**
 * The capability probes a repoint sends while the capability is unknown
 * (extracted from the bridge so it is unit-tested): at `delays` (the last one outlives the
 * server's 60 s negative memo), stopped as soon as `wanted()` says no (the
 * capability came, the root went back, the bridge stopped). One series per
 * repoint TARGET: a series that ran out is not resumed for
 * the same target, a new target starts a fresh one.
 */
export const REPOINT_PROBE_DELAYS_MS = [0, 2_000, 5_000, 15_000, 65_000] as const

export interface RepointProbeScheduler {
  schedule(target: string): void
  stop(): void
  pending(): boolean
}

export function createRepointProbeScheduler(ports: {
  wanted(): boolean
  probe(): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}, delays: readonly number[] = REPOINT_PROBE_DELAYS_MS): RepointProbeScheduler {
  let timer: unknown = null
  let attempt = 0
  let target: string | null = null
  let exhausted = false
  const step = () => {
    timer = null
    if (!ports.wanted()) { attempt = 0; return }
    ports.probe()
    attempt += 1
    const next = delays[attempt]
    if (next !== undefined) timer = ports.setTimer(step, next)
    else exhausted = true
  }
  return {
    schedule(next) {
      if (next !== target) { if (timer !== null) ports.clearTimer(timer); timer = null; target = next; attempt = 0; exhausted = false }
      if (timer !== null || exhausted) return
      timer = ports.setTimer(step, delays[Math.min(attempt, delays.length - 1)]!)
    },
    stop() {
      if (timer !== null) ports.clearTimer(timer)
      timer = null
      attempt = 0
      target = null
      exhausted = false
    },
    pending: () => timer !== null,
  }
}

/** A question about a RANDOM-id shard nobody answered is asked
 * again after these delays (the last one repeats)… */
export const UNMINTED_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const
/** …at most this many times (a `null` that never ends — a revoked access, a route that throws — no longer asks every minute
 * until the session ends; ~17 minutes, then the next boot asks again). */
export const UNMINTED_RETRY_MAX_ATTEMPTS = 20
/** An answer that will not change by asking again (a 4xx refusal). */
export const ANSWER_REFUSED: unique symbol = Symbol('answer refused')
/** No answer because the session EXPIRED (a 401): asked again, as "no
 * answer", but a series stops after {@link EXPIRED_ANSWERS_MAX} of them in a
 * row (a session nobody refreshes no longer costs 20 refused requests
 * over ~17 minutes). */
export const ANSWER_EXPIRED: unique symbol = Symbol('session expired')
export const EXPIRED_ANSWERS_MAX = 2

/**
 * Ask `ask` again until it answers (extracted from the bridge so the
 * schedule is tested). `null` is "no answer" (offline,
 * timed out, a 5xx); {@link ANSWER_REFUSED} stops the series; any other value
 * goes to `answered`, once. `alive` is read before every arm and every
 * answer: a session that ended in the meantime arms nothing (no orphan timer
 * after a stop, whatever was in flight then) and hears nothing.
 */
export function retryUntilAnswered<T>(ports: {
  ask(): Promise<T | null | typeof ANSWER_REFUSED | typeof ANSWER_EXPIRED>
  alive(): boolean
  answered(value: T): void
  setTimer(fn: () => void, ms: number): void
}, delays: readonly number[] = UNMINTED_RETRY_DELAYS_MS, maxAttempts = UNMINTED_RETRY_MAX_ATTEMPTS,
/** Expired answers already in a row before the series (the caller's first ask). */
expiredBefore = 0): void {
  let attempt = 0
  let expired = expiredBefore
  const arm = () => {
    if (!ports.alive() || attempt >= maxAttempts || expired >= EXPIRED_ANSWERS_MAX) return
    const delay = delays[Math.min(attempt, delays.length - 1)]!
    attempt += 1
    ports.setTimer(() => {
      if (!ports.alive()) return
      void ports.ask().then((answer) => {
        if (!ports.alive() || answer === ANSWER_REFUSED) return
        expired = answer === ANSWER_EXPIRED ? expired + 1 : 0
        if (answer === null || answer === ANSWER_EXPIRED) arm()
        else ports.answered(answer)
      }, () => { expired = 0; arm() })
    }, delay)
  }
  arm()
}

/** A 401: the session expired (`… HTTP 401`, durableSync.ts). */
export function isExpiredSession(error: unknown): boolean {
  return /\bHTTP 401\b/.test(error instanceof Error ? error.message : String(error))
}

/** Whether a failed request will fail the same way if asked again: a 4xx
 * other than an expired session (401: refreshed in the same session), a
 * timeout (408) or a rate limit (429).
 * The durable-heads client throws `… HTTP <status>` (durableSync.ts). */
export function isPermanentRefusal(error: unknown): boolean {
  const status = /\bHTTP (\d{3})\b/.exec(error instanceof Error ? error.message : String(error))?.[1]
  if (!status) return false
  const code = Number(status)
  return code >= 400 && code < 500 && code !== 401 && code !== 408 && code !== 429
}

/**
 * The hop's invariant: the objects in the store when the hop began loading
 * that are, 5 s after its swap, neither in the store nor lines of the
 * retired export. Not one the swap projected and that left the store since
 * (a DELETE in the new epoch — another user's, or hers), nor an explicit
 * delete of hers (`tombstones`); and nothing at all under boot-from-server,
 * whose store is the server render of a window recomposed on its own
 * schedule.
 */
export function hopUnaccounted(input: {
  before: ReadonlySet<string>; afterSwap: ReadonlySet<string>; now: ReadonlySet<string>
  exported: ReadonlySet<string>; tombstones: ReadonlySet<string>; bootFromServer: boolean
}): string[] {
  if (input.bootFromServer) return []
  return [...input.before].filter((id) => !input.now.has(id) && !input.exported.has(id)
    && !input.afterSwap.has(id) && !input.tombstones.has(id))
}

function predecessorRef(doc: unknown): string | null {
  const ref = (doc as { epochPredecessorRef?: unknown } | null | undefined)?.epochPredecessorRef
  if (ref === undefined || ref === null) return null
  const text = typeof ref === 'string' ? ref : String((ref as { val?: unknown }).val ?? ref)
  return text.startsWith('automerge:') ? text : null
}
