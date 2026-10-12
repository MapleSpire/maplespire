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
 * The minted-id supply: orchestration layer over the minted-id reserve.
 *
 * `mintedIdReserve.ts` is the mechanism (atomic draw-by-removal over one
 * IndexedDB key); this module is its lifecycle: bind the reserve to the pool
 * the last session minted, keep it topped up to a small target, back off when
 * the server is unreachable, fall silent for the session on 401/403/404 (a
 * pure reader must not spam a write-gated endpoint), and drop + re-bind the
 * pool when a mint response reveals the workspace was repointed to another
 * canonical version.
 *
 * It lives HERE and not in bridge.ts (the supply needs neither handles nor the
 * store) nor repo.ts (evaluated at import; the supply has a session
 * lifecycle). Import direction: repo.ts → this module → reserve/kvStore/api —
 * never back, so there is no cycle.
 *
 * Nothing here is ever awaited by the boot or write paths: `take()` is
 * synchronous by contract (a pagehide flush has no continuation to come back
 * to), and every replenish is fire-and-forget behind a single-flight guard.
 */
import {
  createMintedIdReserve,
  drainReserve,
  persistedPoolWorkspace,
  RESERVE_BLOCK_SIZE,
  RESERVE_LOW_WATER,
  type MintedIdReserve,
} from './mintedIdReserve'
import { workspaceKvStore, type KvStore } from '../modelQuery/kvStore'
import { apiFetch } from '../api/http'
import type { WorkspaceRef } from './workspace'

import { API_BASE } from '../api/base'

/** Pool target: one full in-memory block + the persisted low-water remainder.
 * SMALL ON PURPOSE — the pool bounds the window in which a member whose write
 * grant was revoked while offline still holds usable ids (they grant no
 * permission on their own; the write gate still applies at sync time). Do not
 * grow it for throughput: a burst that outruns it falls back to random ids,
 * which is always a valid outcome. */
export const POOL_TARGET = RESERVE_BLOCK_SIZE + RESERVE_LOW_WATER
/** Mirrors the server's MAX_MINTED_IDS_PER_REQUEST — a clamp, never a promise. */
const MAX_IDS_PER_REQUEST = 64
const BACKOFF_START_MS = 5_000
const BACKOFF_CAP_MS = 300_000
/** Never await a fetch without a ceiling: a half-open fetch would pin `inFlight` forever (it is never returned), freezing the
 * whole tab's replenishment across sessions. The abort lands in the ordinary
 * catch → backoff. */
export const MINT_FETCH_TIMEOUT_MS = 15_000

// One active session at a time, like the bridge. `sessionEpoch` follows the
// durableAckEpoch pattern: every continuation captures it and dies silently if
// a stop/switch bumped it while the continuation was in flight.
let active = false
let sessionEpoch = 0
let currentRef: WorkspaceRef | null = null
let store: KvStore | null = null
let reserve: MintedIdReserve | null = null
/** 401/403/404 = silence for the whole workspace session: a reader must cost
 * at most ONE mint request. Re-armed only by the next `startMintedIdSupply` —
 * and every access change restarts the bridge, which is that call. */
let mintForbidden = false
let backoffMs = 0
let backoffTimer: ReturnType<typeof setTimeout> | null = null
/** When the last evidence-driven retry was taken, so that evidence arriving on
 * every frame cannot outpace the backoff ladder. See
 * {@link notifyMintedIdSupplyHostReachable}. */
let lastHostReachableWakeAt = Number.NEGATIVE_INFINITY
/** Single-flight: overlapping triggers join the in-flight replenish. */
let inFlight: Promise<void> | null = null
/** The current session's boot binding (persisted-pool read + hydrate).
 * `replenishOnce` awaits it before reading the deficit — a take can arm a
 * replenish while the boot IIFE is still awaiting IndexedDB, and reading the
 * deficit at that instant sees `reserve === null` and over-mints a FULL pool
 * on top of the one about to be hydrated (~2×POOL_TARGET). Never rejects. */
let bindingReady: Promise<void> = Promise.resolve()
let takenMinted = 0
let takenFallback = 0
let lastMintStatus: number | null = null
let takeOverride: (() => Uint8Array | null) | null = null

/**
 * Synchronous by contract — callable from the write scheduler's flush tail and
 * from pagehide, where an await loses the document. Null means "create with an
 * ordinary random id" (never block a creation on the supply).
 *
 * A take under pagehide arms a timer that will never fire — harmless, and
 * nothing else is possible there.
 */
export function takeMintedDocumentIdBytes(): Uint8Array | null {
  if (takeOverride) return takeOverride()
  const bytes = reserve?.take() ?? null
  if (active) {
    if (bytes) takenMinted += 1
    else takenFallback += 1
    setTimeout(() => scheduleReplenish(), 0)
  }
  return bytes
}

/**
 * Boot a supply session for `ref`. Never awaited by the caller: the pool
 * hydration and the top-up run entirely off the boot path.
 *
 * The reserve re-binds to the pool the LAST session minted — the canonical key
 * travels in the mint response, never in the alias ref, so it is read back
 * from the persisted pool itself. With no pool yet, the binding waits for the
 * first successful mint.
 */
export function startMintedIdSupply(ref: WorkspaceRef): void {
  sessionEpoch += 1
  const epoch = sessionEpoch
  active = true
  currentRef = ref
  mintForbidden = false
  lastMintStatus = null
  backoffMs = 0
  if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }
  lastHostReachableWakeAt = Number.NEGATIVE_INFINITY
  reserve = null
  const boundStore = workspaceKvStore()
  store = boundStore
  bindingReady = (async () => {
    const workspace = await persistedPoolWorkspace(boundStore)
    if (epoch !== sessionEpoch) return
    if (workspace) {
      const bound = createMintedIdReserve(boundStore, workspace)
      const drawn = await bound.hydrate()
      if (epoch !== sessionEpoch) {
        if (drawn > 0) drainReserve(bound) // drawn ids die with the superseded session
        return
      }
      reserve = bound
    }
    scheduleReplenish()
  })().catch((error) => {
    console.warn('[mintedIdSupply] boot hydration failed; creations fall back to random ids', error)
  })
}

/**
 * End the session. stopBridge calls this AFTER `flushPendingWritesForLifecycle`
 * on purpose: the final flush legitimately creates documents that must still
 * be named with the OUTGOING workspace's ids (the `drainReserve` contract), so
 * the drain is the last word, and the epoch bump kills every deferred
 * replenish a flush-time take may have armed.
 */
export function stopMintedIdSupply(): void {
  sessionEpoch += 1
  active = false
  currentRef = null
  store = null
  mintForbidden = false
  backoffMs = 0
  if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }
  lastHostReachableWakeAt = Number.NEGATIVE_INFINITY
  if (reserve) drainReserve(reserve)
  reserve = null
}

/** Back online: reset the backoff and top up immediately (the mint response is
 * also how a repoint that happened while offline is OBSERVED — see below). */
export function notifyMintedIdSupplyOnline(): void {
  if (!active) return
  backoffMs = 0
  if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }
  scheduleReplenish()
}

/**
 * Evidence arrived that the host this module talks to is answering.
 *
 * ── Why a wake is needed ────────────────────────────────────────────────────
 * `window 'online'` answers "does the BROWSER have a network" — not the
 * question. A server that goes down and comes back while the browser stays
 * online fires no such event, so a mint that failed during the outage would
 * sleep on its backoff ladder (5 s doubling to a 300 s cap) long after the
 * mint could answer. Meanwhile `takeMintedDocumentIdBytes` returns null and
 * every interactively-created document takes a RANDOM id.
 *
 * ── Why this is not an edge on "connected" ──────────────────────────────────
 * The bridge's `syncTransportConnected` cannot carry a reliable false→true
 * edge: it is written at several sites, the bridge sets it true at the end of
 * every successful boot without transport evidence, and a client that booted
 * while the server was down never sees it lowered (the adapter emits
 * `peer-disconnected` only once a handshake has set `remotePeerId`).
 *
 * ── What it is instead ──────────────────────────────────────────────────────
 * A no-op unless a backoff is actually ARMED. That single condition replaces
 * the edge: with no backoff there is nothing to wake, so this may be called on
 * every inbound frame without any caller-side state. And the rate limit is the
 * CURRENT backoff rather than a constant, which gives the property the design
 * has to have — **this can never increase the mint's request rate, it can only
 * re-phase it.** A wake takes the retry the ladder was already going to take,
 * earlier and on evidence, instead of at an arbitrary point in the wait.
 *
 * Callers should prefer evidence from the mint's OWN host
 * (`VITE_SYNC_API_URL`): a successful `durable-heads` acknowledgement or
 * diagram render is a 200 from the same origin the mint posts to. The sync
 * WebSocket (`VITE_AUTOMERGE_URL`) is weaker evidence — a separately
 * configured endpoint — but it is bounded by the same rate limit, so it costs
 * nothing the ladder was not already spending.
 */
export function notifyMintedIdSupplyHostReachable(now: number = Date.now()): void {
  // No backoff armed => nothing is waiting => nothing to wake. This is what
  // makes the function safe to call from a hot path.
  if (!active || mintForbidden || !backoffTimer) return
  if (now - lastHostReachableWakeAt < backoffMs) return
  lastHostReachableWakeAt = now
  clearTimeout(backoffTimer)
  backoffTimer = null
  // The ladder is NOT reset. Resetting it would let a host that answers HTTP
  // while the mint itself keeps failing pull the retry rate back to 5 s
  // forever; keeping it is what bounds this to "no faster than the ladder".
  scheduleReplenish()
}

/** Probe surface (DEV hook + tests) — synchronous fields only, never an API. */
export function mintedIdSupplyStats(): {
  available: number
  poolWorkspace: string | null
  takenMinted: number
  takenFallback: number
  lastMintStatus: number | null
} {
  return {
    available: reserve?.available() ?? 0,
    poolWorkspace: reserve?.workspace ?? null,
    takenMinted,
    takenFallback,
    lastMintStatus,
  }
}

/** Test hook: override the synchronous take (null restores the real supply). */
export function __setMintedIdTakeForTest(take: (() => Uint8Array | null) | null): void {
  takeOverride = take
}

/** Wall-clock ceiling on a bulk pre-provision. An import must never be held
 * hostage by a slow or unreachable mint endpoint — it falls back to random
 * ids. */
export const MINT_CAPACITY_DEADLINE_MS = 15_000

/**
 * How long a bulk pre-provision will wait for a top-up ALREADY IN FLIGHT before
 * asking for its own ids.
 *
 * Separate from `MINT_CAPACITY_DEADLINE_MS` on purpose. An unbounded
 * `await inFlight` on a top-up that started just before the call would cost
 * its whole 15 s `MINT_FETCH_TIMEOUT_MS` — the entire capacity budget — so the
 * loop below would run ZERO times and `ensureMintedIdCapacity` would return
 * short without issuing a single request (pinned by the test 'does not
 * inherit a slow background top-up's ceiling').
 *
 * Racing the joined request is acceptable, but note pool depth is a SECURITY
 * parameter (see POOL_TARGET), not just a cost. What makes it acceptable:
 *
 *  - the overshoot is bounded by ONE request. After the ceiling expires this
 *    calls `replenishOnce` directly while the joined request is still running;
 *    both read the same deficit, so the excess is at most one request's worth,
 *    transient, and spent by the burst that asked for it;
 *  - no id can be lost or handed out twice. `deposit` is serialized per reserve
 *    and APPENDS inside one atomic `store.update` (`mintedIdReserve.ts`), so
 *    two concurrent deposits cannot clobber each other.
 *
 * WORST CASE for a caller is NOT this plus MINT_CAPACITY_DEADLINE_MS. The loop
 * below tests its deadline only at the TOP, so an iteration entered at
 * `deadline − 1 ms` still runs a full `replenishOnce`, itself bounded by
 * MINT_FETCH_TIMEOUT_MS. Only one such overshoot is possible (the next check
 * exits), so the real bound is 2 + 15 + 15 ≈ 32 s, plus the unbounded-by-clock
 * `hydrate` loop that follows it.
 */
export const MINT_JOIN_DEADLINE_MS = 2_000

/**
 * Ensure the reserve can name `count` documents, AWAITING the mint.
 *
 * `takeMintedDocumentIdBytes` never blocks — rule 1 of `createHandleNamed`, and
 * right: an interactive create must not wait on the network. A BULK path is
 * different in the one way that matters. It knows its count BEFORE it starts,
 * and it is already asynchronous behind a progress UI, so it can pay for its
 * own ids instead of spending whatever the background top-up happens to have
 * accumulated.
 *
 * Without it, an import larger than the reserve (e.g. a Structurizr import of
 * 17 views needing 18 documents against ~16 ids in hand) gives the overflow
 * random ids, which the sync gates cannot place without the index, and those
 * documents are lost. The background top-up is asynchronous and the burst is
 * synchronous, so it can never catch up from inside the loop; the only place
 * to fix it is in front of the loop.
 *
 * BEST-EFFORT BY CONTRACT. Returns how many ids are actually in hand, and a
 * caller must not treat a short answer as a reason to abort: falling back to
 * random ids is still the documented behaviour, and refusing to import because
 * the network is down would be a worse failure than the one this prevents.
 */
export async function ensureMintedIdCapacity(count: number): Promise<number> {
  if (!active || count <= 0) return capacityNow()
  const epoch = sessionEpoch
  // Join a top-up already in flight rather than racing it: two concurrent
  // requests would both read the same deficit and over-mint. On its OWN
  // ceiling — `inFlight` is bounded by the fetch timeout plus however long
  // IndexedDB takes, which is not a bound this path may inherit whole.
  if (inFlight) {
    let joinTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      inFlight.catch(() => { /* armBackoff already ran */ }),
      new Promise<void>((resolve) => { joinTimer = setTimeout(resolve, MINT_JOIN_DEADLINE_MS) }),
    ])
    if (joinTimer !== undefined) clearTimeout(joinTimer)
  }
  // Stamped after the join (tidiness only: the join ceiling above is what
  // keeps the loop from being starved).
  const deadline = Date.now() + MINT_CAPACITY_DEADLINE_MS
  while (active && epoch === sessionEpoch && !mintForbidden && Date.now() < deadline) {
    const before = await capacity()
    if (epoch !== sessionEpoch || before >= count) break
    try {
      // Aim past the requirement so the burst does not leave the reserve empty
      // for whatever the user does next. `replenishOnce` clamps each request to
      // MAX_IDS_PER_REQUEST, so a count above that is served by looping.
      await replenishOnce(epoch, count + RESERVE_LOW_WATER)
    } catch {
      armBackoff()
      break
    }
    if (epoch !== sessionEpoch) break
    // No forward progress means the server will not give us more — a 4xx that
    // set `mintForbidden`, a short block, or an observed repoint that dropped
    // the pool. Asking again only re-collects the same refusal, and the
    // deadline alone would then spin for its full 15 s.
    if (await capacity() <= before) break
  }
  // Minting alone is not enough, and this is the half that is easy to miss:
  // `take()` is SYNCHRONOUS and can only see the block already drawn into
  // memory — at most RESERVE_BLOCK_SIZE. A burst of 38 against a full pool of
  // 38 still takes 22 random ids, because the other 22 are sitting persisted
  // behind an async `hydrate()` the synchronous loop can never wait for. Draw
  // them now, while we are still allowed to await.
  while (reserve && reserve.available() < count && epoch === sessionEpoch) {
    if (await reserve.hydrate() === 0) break // pool exhausted; the rest falls back
  }
  return capacity()
}

/**
 * Ids this session can still name documents with.
 *
 * `available()` alone is the WRONG measure and silently caps at
 * RESERVE_BLOCK_SIZE: it counts only the block currently drawn into memory,
 * with the rest sitting persisted behind `remaining()`. A capacity loop written
 * against it can never observe more than 16 and so never terminates for a
 * larger burst — it just spends its deadline. The takeable total is both.
 */
async function capacity(): Promise<number> {
  if (!reserve) return 0
  return reserve.available() + await reserve.remaining()
}

function capacityNow(): number {
  return reserve?.available() ?? 0
}

function scheduleReplenish(): void {
  if (!active || mintForbidden || inFlight || backoffTimer) return
  const epoch = sessionEpoch
  inFlight = replenishOnce(epoch)
    .catch(() => {
      // Network-level failure (offline, server down). NEVER an immediate
      // retry: the backoff timer is the only re-trigger until online/boot.
      if (epoch === sessionEpoch) armBackoff()
    })
    .finally(() => { inFlight = null })
}

async function replenishOnce(epoch: number, target: number = POOL_TARGET): Promise<void> {
  // The boot take-vs-binding race: wait for the binding before reading the
  // deficit, with the epoch guard AFTER the await (the promise read here may
  // already belong to a stopped or superseded session).
  await bindingReady
  if (epoch !== sessionEpoch) return
  const ref = currentRef
  const boundStore = store
  if (!ref || !boundStore) return
  const available = reserve?.available() ?? 0
  const remaining = reserve ? await reserve.remaining() : 0
  if (epoch !== sessionEpoch) return
  const deficit = target - (available + remaining)
  if (deficit <= 0) return
  const count = Math.max(1, Math.min(deficit, MAX_IDS_PER_REQUEST))
  // The ref goes out AS ROUTED (`current` alias included): the server is the
  // authority that canonicalises, and its answer carries the canonical key
  // the pool binds to. No client-side pre-check of the write grant either —
  // that would race the server's answer and duplicate its authority.
  const response = await apiFetch(`${API_BASE}/api/automerge/mint-document-ids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ landscapeId: ref.landscapeId, versionId: ref.versionId, count }),
    signal: AbortSignal.timeout(MINT_FETCH_TIMEOUT_MS), // see MINT_FETCH_TIMEOUT_MS
  })
  if (epoch !== sessionEpoch) return
  lastMintStatus = response.status
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    // Forbidden (read-only grant), unauthenticated, or the workspace raced a
    // deletion: all three mean "not for this session". One request, then
    // silence until the next bridge start.
    mintForbidden = true
    return
  }
  if (!response.ok) {
    armBackoff()
    return
  }
  const body = await response.json() as { landscapeId: string; versionId: string; ids: string[] }
  if (epoch !== sessionEpoch) return
  const canonical = `${body.landscapeId}/${body.versionId}`
  if (!reserve || reserve.workspace !== canonical) {
    // Drop + re-mint on an OBSERVED repoint: the pool was bound to another
    // canonical version (set-default moved the alias while this client was
    // away). Ids already spent on documents are handled server-side (a
    // displaced id falls back to a durable first-owner-wins claim); the unspent
    // block is just dropped — spending it would read displaced/foreign on
    // every gate.
    if (reserve) drainReserve(reserve)
    reserve = createMintedIdReserve(boundStore, canonical)
  }
  await reserve.deposit(body.ids) // replaces any foreign persisted pool — reserve semantics
  if (epoch !== sessionEpoch) return
  if (reserve.available() === 0) await reserve.hydrate()
  backoffMs = 0
}

function armBackoff(): void {
  if (!active || mintForbidden) return
  backoffMs = backoffMs === 0 ? BACKOFF_START_MS : Math.min(backoffMs * 2, BACKOFF_CAP_MS)
  if (backoffTimer) return // one timer, ever
  const epoch = sessionEpoch
  backoffTimer = setTimeout(() => {
    backoffTimer = null
    if (epoch !== sessionEpoch) return
    scheduleReplenish()
  }, backoffMs)
}

// DEV/E2E probe (the __repoFlush pattern, repo.ts): the e2e specs assert the
// boot top-up and the minted/fallback split through this, never through a
// store shortcut. Not an API.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __mintedIdSupply?: unknown }).__mintedIdSupply = {
    available: () => mintedIdSupplyStats().available,
    poolWorkspace: () => mintedIdSupplyStats().poolWorkspace,
    remaining: () => reserve?.remaining() ?? Promise.resolve(0),
    takenMinted: () => mintedIdSupplyStats().takenMinted,
    takenFallback: () => mintedIdSupplyStats().takenFallback,
    lastMintStatus: () => mintedIdSupplyStats().lastMintStatus,
  }
}
