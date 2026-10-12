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

import type {
  AutomergeUrl,
  DocHandle,
  DocumentId,
  Repo,
} from '@automerge/automerge-repo'
import {
  classifyDocumentResolutionError,
  documentIdOf,
  documentRepoState,
  DocumentPermanentlyUnavailableError,
  DocumentTemporarilyUnavailableError,
} from './documentResolution'
import { markClientTimeline } from '../observability/clientTimeline'
import type { PeerAwareness } from './peerAwareness'
import { createWaiverAllocation, WAIVER_BUDGET_MS, type WaiverAllocation } from './waiverBudget'
import { recordWaiverGranted, recordWaiverOutcome, type WaiverOutcome } from './waiverTelemetry'
import { MIN_PROGRESS_BYTES, MIN_PROGRESS_BYTES_PER_SECOND } from './progressBudget'
import { recordProgressExtension, recordResolutionEnd } from './progressTelemetry'

/**
 * Automerge Repo keeps an unavailable handle in its in-memory cache. A later
 * `find()` then returns that terminal handle without checking durable storage or
 * the network again. Remove only that failed cache entry before retrying.
 *
 * This is the one `await` on the retry path that is NOT inside a
 * `Promise.race`. That is safe only because automerge-repo 2.6.0-alpha.2's
 * `removeFromCache` is synchronous in practice (a `detach` and two `delete`s),
 * so it cannot hang. If a later version makes it genuinely async, this call
 * needs the same ceiling every `find()` on this path has.
 */
export async function releaseUnavailableDocument(repo: Repo, url: string): Promise<boolean> {
  // Probe first: the progress query is what registers the handle for a URL the
  // repo has not seen yet, so reading the cache before it can miss the entry.
  if (documentRepoState(repo, url) !== 'unavailable') return false
  return detachCachedDocument(repo, url)
}

/** Shared eviction core: drop the repo's cached query/handle for `url` so the
 * NEXT `find()` re-attaches every source — re-checking durable storage and
 * sending a fresh network request — instead of returning the cached entry. */
async function detachCachedDocument(repo: Repo, url: string): Promise<boolean> {
  const documentId = documentIdOf(url)
  // Do not read `repo.handles` here: that getter rebuilds the whole record on
  // every access (~3.4 ms at 10 000 resident documents), the cache is keyed by
  // `documentId` anyway, and deleting from the returned copy evicts nothing.
  // `removeFromCache` is the only call that both detaches and unloads.
  await repo.removeFromCache(documentId as DocumentId)
  return true
}

/** Base wall-clock ceiling on ONE find/whenReady attempt (see below). */
const DEFAULT_FIND_TIMEOUT_MS = 8_000
/** Escalation cap. The ceiling DOUBLES per attempt so a document that genuinely
 * needs longer than one window (a large doc on a cold, slow link) eventually
 * gets an uninterrupted window big enough to finish — without escalation, an
 * evict-at-deadline retry could restart a long download forever. */
const FIND_TIMEOUT_CAP_MS = 30_000

/** Race sentinel: "our wall-clock ceiling fired", which is NOT the caller's
 * abort (drop it) and NOT the repo's own rejection (classify it) — it means
 * "queue another attempt". Kept a symbol so no error identity can forge it. */
const FIND_DEADLINE = Symbol('find-deadline')

/** Keep the ROOT cause only: ceilings fire once per attempt, and wrapping the
 * previous wrapper each time would build a cause chain as deep as the retry
 * budget. The first raw rejection (or nothing) is what an operator needs. */
function rootCauseOf(error: unknown): unknown {
  return error instanceof DocumentTemporarilyUnavailableError ? error.cause : error
}

/**
 * Why an attempt ended. The two causes cost budgets that differ by an order of
 * magnitude — a `ceiling` re-awaits the SAME query under an escalating window,
 * a `reject` returns in milliseconds — so an incident that only counts
 * `attempts` cannot tell a 22-second wait from a 1.4-second one.
 */
export type BootDocumentRetryCause = 'ceiling' | 'reject'

/** Marks per resolution call. The timeline is a bounded 500-entry ring, so an
 * unmetered per-attempt mark would evict the boot phases an incident is
 * actually read from — the instrument erasing its own subject. The first few
 * attempts carry all the information (which document, which cause, how early);
 * the surfaced error carries the final count. */
const RETRY_MARK_LIMIT = 8

/** How often the waiver looks up while a handshake is in flight.
 * It is a POLL and not an event subscription on purpose: a subscription would
 * have to be torn down on every exit path of the retry loop, and a leaked
 * listener on the network subsystem outlives the boot. A poll holds nothing.
 *
 * It also sets the floor on a waived round: waiting costs at least one tick,
 * which bounds waived rounds at `WAIVER_BUDGET_MS / this` = 40 per allowance.
 * Each waived round is a real `find()` plus a `removeFromCache`, so that is
 * up to 40 network requests per document — reachable only with a peer that
 * oscillates between 0 and 1 on successive polls.
 */
const PEER_WAIT_POLL_MS = 50

/**
 * The waiver's OWN wall, cumulative over one allowance and INDEPENDENT of
 * `budgetMs`. Re-exported here because this is where it acts; `waiverBudget.ts`
 * carries the derivation, the bounded `VITE_BOOT_WAIVER_MS` /
 * `localStorage['maplespire:bootWaiverMs']` override, and why the cap must not
 * adapt to the latency it bounds.
 *
 * Without it the only thing bounding waived rounds is the budget, and
 * `peerExpected()` is true for the WHOLE of a transport's first connection
 * attempt, which is unbounded. A server unreachable without an RST (firewall
 * DROP, dead VPN, captive portal) would otherwise turn a ~1.4 s offline boot
 * into the entire budget, with `navigator.onLine` true throughout.
 *
 * Cumulative per ALLOWANCE, not per round: a per-round cap would let a
 * flapping peer re-arm it forever.
 *
 * The allowance is whatever the caller hands in (`options.waiver`); the boot
 * hands in ONE for all of its documents (see `createWaiverAllocation`). A
 * caller that passes none gets a fresh per-call allowance.
 */
export { WAIVER_BUDGET_MS }

/**
 * The wall-clock the CEILING path spends before it gives up: every escalating
 * window plus every inter-attempt delay, for the given options.
 *
 * It exists so a boot budget can be DERIVED from the schedule it must contain
 * instead of being typed next to it. `budgetMs` clamps the last window, so a
 * budget shorter than its own schedule silently shortens a window a large
 * queued document depends on (a 20 000 ms budget against a 22 000 ms schedule
 * killed five boots of eight). Typed as two independent literals, that
 * relation could break with no test turning red.
 */
export function ceilingScheduleMs(
  tries: number,
  findTimeoutMs: number,
  delayMs: number,
  capMs: number = FIND_TIMEOUT_CAP_MS,
): number {
  const rounds = Math.max(1, tries)
  let total = 0
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    total += Math.min(findTimeoutMs * 2 ** attempt, capMs)
  }
  return total + (rounds - 1) * Math.max(0, delayMs)
}

/**
 * Wait, inside what is left of the budget, for one of the two things that can
 * make the next `find()` mean something different: a peer connecting, or the
 * handshake giving up.
 *
 * Never a bare `await` on anything (the rule for boot paths). The only thing awaited is the caller's own `sleep`, for a duration
 * clamped to what `remainingMs` reports, so this cannot outlive it even if the
 * transport lies about its state forever.
 *
 * `remainingMs` is the MINIMUM of two walls, and the caller composes it: what
 * is left of the whole resolution, and what is left of `WAIVER_BUDGET_MS` for
 * this call. The second is what keeps a server that is unreachable-but-not-
 * refusing from turning one rejection into the entire budget.
 */
async function awaitPeerWithinBudget(
  peers: PeerAwareness,
  remainingMs: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<'peer' | 'abandoned' | 'exhausted'> {
  while (remainingMs() > 0) {
    await sleep(Math.min(PEER_WAIT_POLL_MS, remainingMs()))
    if (peers.connectedPeerCount() > 0) return 'peer'
    if (!peers.peerExpected()) return 'abandoned'
  }
  // A wall ran out. WHICH wall is the caller's to say — it is the one that
  // holds both — and the distinction is the whole early-warning signal:
  // "the cap was reached while boots still succeed" is a different fact from
  // "the server went away", and only the first is evidence about the cap.
  return 'exhausted'
}

/** MONOTONE by construction: `performance.now()` cannot go backwards, while
 * `Date.now()` jumps with an NTP correction or a manual clock change — and a
 * backwards jump on a wall-clock budget is an unbounded wait.
 *
 * What it does NOT give is a promise in REAL time. Every bound here is
 * ultimately made of `setTimeout`, which a browser is free to defer: a hidden
 * tab clamps it to ≥ 1 s, and to once a minute under intensive throttling,
 * while `performance.now()` keeps running. So "bounded at `budgetMs`" means
 * bounded in unthrottled time — a boot in a background tab (e.g. a deep link
 * opened in one) can stretch the ceilings and waiver polls well past their
 * nominal figures. */
const monotonicNow = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
)

/**
 * Resolve a ready handle, retrying ONLY a document that has genuinely not
 * synced to this browser yet.
 *
 * A deleted document, a malformed URL and an unrelated fault must not burn the
 * retry budget (20 attempts × 500ms = ~10s) plus a cache eviction that cannot
 * help. `classifyDocumentResolutionError` splits those apart:
 *
 * - `invalid` → surfaced immediately as `DocumentPermanentlyUnavailableError`,
 *   so callers reach their own fallback instead of stalling on a reference that
 *   can never resolve.
 * - `aborted` / `unexpected` → the original error propagates untouched; a
 *   storage-adapter fault is a bug to see, not a sync delay to wait out.
 * - `unavailable` → unchanged offline-first behaviour: evict automerge-repo's
 *   terminal cache entry and retry under the bounded schedule, because the
 *   document may still arrive from a peer or from durable storage.
 *
 * And ONE case rejects nothing at all, which is why every attempt runs under a
 * wall-clock ceiling: with a network adapter attached, `repo.find()` NEVER
 * SETTLES for a document no source answers — no rejection, no `unavailable`,
 * nothing (e.g. a server still warming up leaves requests silently
 * unanswered), and an un-ceilinged `await repo.find()` would freeze the boot
 * forever. The ceiling is a `Promise.race` (it holds even if the callee stops
 * honouring its AbortSignal) and the signal is ALSO forwarded so the repo's
 * internal wait is cancelled rather than leaked. A fired ceiling KEEPS the
 * pending query: the download keeps its progress and the next attempt merely
 * re-awaits it, so a large document queued behind others is never restarted
 * mid-transfer.
 *
 * TWO allowances, not one. `tries` counts attempts that CARRIED INFORMATION;
 * `budgetMs` is a monotone wall clock over the whole call. A single counter
 * would buy 22 s on a silent `find()` but only ~1.4 s on a rejecting one.
 * See the option docs below.
 *
 * The caller cannot abandon a resolution (there is no external AbortSignal):
 * a workspace switch during a failing boot leaves the old root resolving, its
 * result discarded, for up to `budgetMs`. The `Promise.race` below is where a
 * signal would be hung if a caller ever needs one.
 */
export async function resolveReadyHandleWithRetry<T>(
  repo: Repo,
  url: AutomergeUrl,
  options: {
    tries?: number
    delayMs?: number
    sleep?: (ms: number) => Promise<void>
    findTimeoutMs?: number
    /**
     * WALL-CLOCK allowance for the whole resolution. When set, it — not
     * `tries` — decides when to stop, and `tries` becomes an anti-hot-loop
     * guard for a document that rejects instantly.
     *
     * Why: the ceiling path and the rejection path cost ~15x apart. With
     * `tries: 3, findTimeoutMs: 3000`, a silent `find()` consumes 3 000 + 500 + 6 000 + 500 +
     * 12 000 = 22 000 ms; a rejecting one consumes three sub-millisecond
     * rejections plus two 500 ms delays, ~1.0–1.5 s — short enough to give up
     * on a small root document while its socket is still handshaking.
     */
    budgetMs?: number
    /**
     * Who is connected, and who is coming. Supplied ONLY by the
     * boot-critical call sites, and only together with `budgetMs` — a waived
     * attempt has no bound but the wall clock, so waiving without one would
     * be exactly the unbounded wait this helper exists to forbid.
     */
    peers?: PeerAwareness
    /**
     * The waiver allowance to spend from. SHARED by every document of one
     * boot at the boot-critical call sites, so an unreachable server costs
     * the allowance once for the whole boot rather than once per document.
     *
     * Omitted, a caller gets a FRESH per-call allowance, which is what every
     * unbudgeted, peer-blind call site wants.
     */
    waiver?: WaiverAllocation
    /**
     * The ABSOLUTE wall, from the first request, once `budgetMs` has become a
     * STALL wall. Only meaningful together with `budgetMs` and a
     * `peers` that can answer `inboundBytes()`; without those the stall wall
     * never moves and this is unreachable.
     *
     * It exists because the stall wall alone is not a bound: a peer that keeps
     * the socket warm forever would hold a boot open forever, and "no
     * unbounded wait on a boot path" is the rule this helper enforces.
     * `progressBudget.ts` carries the default and why it is 120 s.
     */
    maxBudgetMs?: number
    /** Bytes that must arrive inside one window for it to count as progress.
     * Defaults to `MIN_PROGRESS_BYTES`; a caller that passes 0 makes ANY byte
     * count, which is how a heartbeat would hold the wall open. */
    progressMinBytes?: number
    /** Test seam for the budget clock. Production uses a monotone one. */
    now?: () => number
  } = {},
): Promise<DocHandle<T>> {
  const tries = Math.max(1, options.tries ?? 20)
  const delayMs = Math.max(0, options.delayMs ?? 500)
  const findTimeoutMs = Math.max(0, options.findTimeoutMs ?? DEFAULT_FIND_TIMEOUT_MS)
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const budgetMs = options.budgetMs === undefined ? null : Math.max(0, options.budgetMs)
  const now = options.now ?? monotonicNow
  const startedAt = now()
  const maxBudgetMs = options.maxBudgetMs === undefined ? null : Math.max(0, options.maxBudgetMs)
  const progressMinBytes = Math.max(0, options.progressMinBytes ?? MIN_PROGRESS_BYTES)
  /**
   * The moment `budgetMs` is counted from. It STARTS at the request and moves
   * forward every time the transport is caught delivering, which is what turns `budgetMs` from "how long may this document take" — a quantity
   * no constant can bound, because it includes every other document's turn on
   * a serial server — into "how long may the server be QUIET", which one can.
   */
  let budgetAnchor = startedAt
  /** Bytes at the last moment the anchor moved. The comparison is CUMULATIVE,
   * never per-window: on a server shared by several joiners a client can go
   * several 3 s windows without being served while the server is working.
   * "When did bytes last arrive" is the question `budgetMs` means; "did bytes
   * arrive inside THIS window" would charge those idle windows.
   *
   * Initialised to what the transport had ALREADY delivered when this call
   * began, never to 0: starting at 0 makes the first delta "everything this
   * tab has ever received", so the first ceiling would move the wall for free
   * and a silent server would run to the absolute wall instead of the stall
   * wall.
   */
  let lastProgressBytes = options.peers?.inboundBytes?.() ?? 0
  /** Total wall bought from progress. Reported, so the margin against
   * `maxBudgetMs` is a figure a run prints rather than a hope. */
  let extendedMs = 0
  /** What is left of the STALL wall, or `Infinity` for a caller that set no
   * budget — so every `Math.min` below is a no-op on the unbudgeted sites. */
  const stallRemainingMs = (): number => (
    budgetMs === null ? Number.POSITIVE_INFINITY : budgetMs - (now() - budgetAnchor)
  )
  /** What is left of the ABSOLUTE wall. Unbounded for a caller that set none. */
  const hardRemainingMs = (): number => (
    maxBudgetMs === null ? Number.POSITIVE_INFINITY : maxBudgetMs - (now() - startedAt)
  )
  /** Both walls at once. Only the end of the loop asks them separately, to
   * report which wall stopped the call. */
  const remainingMs = (): number => Math.min(stallRemainingMs(), hardRemainingMs())
  /** Waiving requires BOTH a peer oracle and a wall clock to waive inside.
   * Without the clock there is nothing bounding the waived rounds, so a
   * caller that passes only `peers` gets the ordinary schedule. */
  const peers = options.peers
  const canWaive = peers !== undefined && budgetMs !== null
  /** The allowance every waived round of this call spends from. Its own wall
   * (see WAIVER_BUDGET_MS): the budget alone would let a transport that never
   * finishes its handshake consume all of it. SHARED across a boot when the
   * caller hands one in; a fresh per-call one otherwise. */
  const waiver = options.waiver ?? createWaiverAllocation()
  const waiverRemainingMs = (): number => waiver.remainingMs()
  /** The transport's byte count when this resolution began. The rejection
   * limb compares against THIS rather than against the window it just left:
   * a rejection returns in microseconds, so a per-window delta is always 0 and
   * would forgive nothing. `null` when the oracle cannot answer. */
  const progressAtCallStart = options.peers?.inboundBytes?.() ?? null
  /** Move the stall anchor if the transport has delivered at least
   * `progressMinBytes` since it last moved. Returns the delta it consumed, or
   * 0 — the threshold is what stops a heartbeat from holding the wall open for
   * ever, and it belongs HERE, on the anchor, rather than on the decision to
   * charge an attempt. */
  const noteProgress = (): number => {
    if (progressAtCallStart === null) return 0
    const current = peers?.inboundBytes?.() ?? 0
    const delta = current - lastProgressBytes
    // A RATE, not an absolute floor. A cumulative comparison alone would let a
    // trickle (say 500 B/s) clear any absolute threshold given enough seconds
    // and hold the stall wall open forever. The anchor moves at most once per
    // ceiling, so `sinceMs` is never smaller than a window and the rate
    // subsumes any absolute floor.
    const sinceMs = Math.max(1, now() - budgetAnchor)
    if (delta * 1_000 < MIN_PROGRESS_BYTES_PER_SECOND * sinceMs) return 0
    lastProgressBytes = current
    budgetAnchor = now()
    return delta
  }
  let lastError: unknown
  let findAttempts = 0
  let marks = 0
  /**
   * The mark carries the TRANSPORT, not just the document: a rejection caused
   * by a socket that dropped (close code 1006) and came back just after the
   * boot gave up is only legible from `readClientTimeline()` if `transport`
   * and `closeCode` sit in the same timeline as the rejection.
   */
  const markRetry = (
    attempt: number,
    cause: BootDocumentRetryCause,
    waived?: boolean,
    progressBytes?: number,
  ): void => {
    if (marks >= RETRY_MARK_LIMIT) return
    marks += 1
    const transport = peers?.transportState?.() ?? null
    markClientTimeline('boot.document.retry', {
      document: documentIdOf(url),
      attempt,
      cause,
      waived,
      // Present only on a window the transport was caught delivering through.
      // Its absence on a `ceiling` mark is the fact an incident is
      // read for: the window expired with the socket QUIET.
      progressBytes,
      transport: transport?.phase,
      closeCode: transport?.closeCode ?? undefined,
    })
  }

  /** The inter-attempt delay, never longer than what is left of the budget
   * and skipped on the last permitted attempt — sleeping past the deadline
   * only postpones the caller's own fallback. */
  const pause = async (): Promise<void> => {
    if (attempt >= tries - 1) return
    const left = remainingMs()
    if (left <= 0) return
    await sleep(Math.min(delayMs, left))
  }

  let attempt = 0
  for (; attempt < tries; attempt += 1) {
    // The budget decides, and it is checked HERE — before an attempt is
    // started, never in the middle of one. The guard is `findAttempts`, not
    // `attempt`: a budget of 0 must still mean "one attempt, no retries", and
    // a productive ceiling gives `attempt` back, so a loop guarded on
    // `attempt` would stop consulting the walls at the exact moment they
    // become the only thing bounding the call.
    if (findAttempts > 0 && remainingMs() <= 0) break
    const controller = new AbortController()
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    // findTimeoutMs: 0 disables the ceiling explicitly, for a caller that
    // manages its own outer deadline; read as a "0ms ceiling" it would fail
    // every attempt instantly.
    const escalatedMs = findTimeoutMs === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(findTimeoutMs * 2 ** attempt, FIND_TIMEOUT_CAP_MS)
    // CLAMPED to what is left: without this, the last window of a budgeted
    // call could overshoot by a whole escalated ceiling (up to 30 s), and
    // "bounded at budgetMs" would be a claim the code does not make.
    const ceilingMs = Math.min(escalatedMs, remainingMs())
    const deadline: Promise<typeof FIND_DEADLINE> = Number.isFinite(ceilingMs)
      ? new Promise((resolve) => { deadlineTimer = setTimeout(() => resolve(FIND_DEADLINE), ceilingMs) })
      : new Promise<never>(() => undefined)
    const windowStartedAt = now()
    // Kept in a variable and pre-observed: when the deadline wins the race this
    // promise is still pending and may reject much later (the abort below); an
    // unobserved rejection would surface as an unhandled-rejection crash.
    findAttempts += 1
    const attemptPromise = (async () => {
      const handle = await repo.find<T>(url, { signal: controller.signal })
      // Inert in 2.6 (find only resolves ready handles) but kept: it is the
      // documented contract this helper exists to replace at call sites.
      await handle.whenReady()
      return handle
    })()
    attemptPromise.catch(() => undefined)
    try {
      const outcome = await Promise.race([attemptPromise, deadline])
      if (outcome !== FIND_DEADLINE) {
        // Reported on the SUCCESS path too, and that is the half that matters:
        // `maxExtendedMs` is a margin, and a margin read only from failures is
        // read only after it has already run out.
        recordResolutionEnd(extendedMs, null)
        return outcome
      }
      // Ceiling fired: cancel the repo-side wait and go around. Never routed
      // through the abort classification — a deadline means "retry", while a
      // caller's abort means "drop", and those are opposite instructions.
      controller.abort()
      // A window that expired while the socket was DELIVERING is not evidence
      // about this document: the sync server generates messages one document
      // at a time, so it means "not my turn yet", and the turn ahead belongs
      // to documents this boot also needs. Without this, a throttled boot can
      // abandon a document while the server is pushing hundreds of kilobytes
      // down the same socket.
      //
      // So the window costs neither an attempt nor the stall wall — but
      // `maxBudgetMs` still runs, and the mark carries the byte count so the
      // two kinds of ceiling can be told apart afterwards. Each condition is
      // load-bearing:
      //  - a connected peer, because bytes with no peer are somebody else's
      //    socket or a race with teardown;
      //  - `progressMinBytes` (inside `noteProgress`), because a heartbeat
      //    would otherwise hold the wall open forever (see progressBudget.ts);
      //  - `maxBudgetMs !== null`, because extending without an absolute wall
      //    is the unbounded boot wait this helper exists to forbid;
      //  - `hardRemainingMs() > 0`, because once the absolute wall is spent a
      //    fast transport would keep handing `attempt` back at a 0 ms window —
      //    a CPU spin. The `findAttempts` loop guard closes the same door; the
      //    two checks are deliberately redundant.
      const deliveredBytes = noteProgress()
      const productive = maxBudgetMs !== null
        && hardRemainingMs() > 0
        && (peers?.connectedPeerCount() ?? 0) > 0
      if (productive) {
        // The anchor moves in `noteProgress()` and NOWHERE else. Moving it
        // here too would reset the stall wall on every expired window with a
        // connected but silent peer, and `budgetMs` would bound nothing.
        const windowMs = Math.max(0, now() - windowStartedAt)
        extendedMs += windowMs
        if (deliveredBytes > 0) recordProgressExtension(deliveredBytes)
        markRetry(attempt + 1, 'ceiling', undefined, deliveredBytes || undefined)
        // No `console.warn` here, and no `pause()`. The warn below is the
        // early warning for a server that leaves `find()` UNANSWERED, which
        // this is the opposite of; emitting it per productive window would
        // bury that case in noise. The pause is a back-off from a peer that
        // is not answering — there is nothing here to back off from.
        attempt -= 1
        continue
      }
      lastError = new DocumentTemporarilyUnavailableError(url, attempt + 1, { cause: rootCauseOf(lastError) })
      // NOTHING is evicted on a ceiling. The sync server serves documents ONE
      // AT A TIME, so a fired ceiling means the document is QUEUED BEHIND
      // another, not stalled; re-awaiting recovers it, while evicting would
      // throw the request away and send it to the back of that serial queue.
      // Telling 'queued' from 'stalled' would need per-document progress,
      // which `DocumentQuery.peek()` does not expose in 2.6.0-alpha.2. On
      // reconnect automerge-repo re-syncs the documents it holds handles for,
      // and the bound on the wait is `budgetMs`.
      //
      // The warn is the only visible trace of a server leaving find()
      // unanswered. It logs document id + attempt, never contents.
      console.warn(
        `[handleRetry] find ceiling ${ceilingMs}ms fired for ${documentIdOf(url)}`
          + ` (attempt ${attempt + 1}/${tries})`,
      )
      markRetry(attempt + 1, 'ceiling')
      await pause()
    } catch (error) {
      // The probe is lazy: automerge-repo's own "is unavailable" message decides
      // the common offline case without re-entering the find machinery.
      const outcome = classifyDocumentResolutionError(error, () => documentRepoState(repo, url))
      if (outcome === 'invalid') throw new DocumentPermanentlyUnavailableError(url, { cause: error })
      if (outcome !== 'unavailable') throw error
      lastError = error
      // A rejection that arrives while a peer is still connecting is not a
      // verdict about the document — it is "nobody is here to answer yet"
      // (the handshake typically lands up to ~700 ms later). Such a rejection
      // is waived only while the WAIVER's own wall has something left; past
      // that it is charged like any other, so `tries` ends the call instead
      // of the budget. The `waiverRemainingMs()` check is here rather than
      // inside the waiter so the retry mark says `waived: false` for a round
      // the allowance no longer paid for.
      const noPeerButOneIsComing = canWaive
        && peers!.connectedPeerCount() === 0
        && peers!.peerExpected()
      const waived = noPeerButOneIsComing && waiverRemainingMs() > 0
      /**
       * A "bounced" rejection: the socket dropped mid-transfer after the
       * shared waiver allowance was already spent. Two separate questions:
       *
       *   may we WAIT for the peer?          — a time budget (the waiver)
       *   is this rejection INFORMATIVE?     — a fact about who was connected
       *
       * A rejection caused by the socket going away says nothing about the
       * document, and an exhausted allowance does not change that. So the
       * round buys no wait — it pays the ordinary inter-attempt delay — but it
       * is not charged as an attempt either.
       *
       * What keeps the offline boot fast is the same witness the ceiling limb
       * uses: forgiveness requires the transport to have delivered real bytes
       * DURING THIS CALL. Against a server that is down `inboundBytes()` never
       * moves, nothing is forgiven, and `tries` ends the boot in ~1.4 s.
       *
       * `hardRemainingMs() > 0` is the same deliberately redundant spin guard
       * as in the ceiling limb.
       */
      const deliveredThisCall = progressAtCallStart === null
        ? 0
        : Math.max(0, (peers?.inboundBytes?.() ?? 0) - progressAtCallStart)
      // NOT `noteProgress()`: a bounce must not move the stall anchor. While
      // the socket is down nothing arrives, and the wall since the last real
      // delivery is exactly what has to keep running.
      const bounced = !waived
        && noPeerButOneIsComing
        && maxBudgetMs !== null
        && hardRemainingMs() > 0
        && deliveredThisCall >= progressMinBytes
      markRetry(attempt + 1, 'reject', waived, bounced ? deliveredThisCall : undefined)
      await releaseUnavailableDocument(repo, url)
      if (bounced) {
        recordProgressExtension(deliveredThisCall)
        // No wait — that is the allowance's job and the allowance is spent.
        // Just the ordinary back-off, so a socket that stays down cannot spin:
        // with no bytes arriving the stall wall runs out and ends the call.
        attempt -= 1
        await pause()
        continue
      }
      if (waived) {
        // Counted BEFORE the wait, so a wait that somehow never returns still
        // shows up as a grant with no matching outcome rather than vanishing.
        recordWaiverGranted()
        // The waiver's remaining wall has to be read from INSIDE the wait, not
        // charged to it afterwards: the allowance only moves when a wait ends,
        // so composing on it directly would report a full allowance for the
        // whole of the first wait and bound nothing at all. A deadline taken
        // up front cannot drift that way.
        const waitStartedAt = now()
        const waiverDeadline = waitStartedAt + waiverRemainingMs()
        const arrival = await awaitPeerWithinBudget(
          peers!,
          () => Math.min(remainingMs(), waiverDeadline - now()),
          sleep,
        )
        const waitedMs = Math.max(0, now() - waitStartedAt)
        waiver.spend(waitedMs)
        // Split here because this is the only place that knows which wall ran
        // out. `clipped` — the cap ended a wait a peer might still have
        // satisfied — is the early warning that moves BEFORE any boot fails.
        // `budget-exhausted` means the server is gone; folding the two
        // together would raise false alarms during outages.
        const outcome: WaiverOutcome = arrival === 'peer'
          ? 'peer'
          : arrival === 'abandoned'
            ? 'abandoned'
            : waiverDeadline - now() <= 0 ? 'clipped' : 'budget-exhausted'
        recordWaiverOutcome(outcome, waitedMs)
        // A peer answered the door: retry WITHOUT spending an attempt (the
        // loop's own `attempt += 1` cancels this). Anything else — the
        // handshake gave up, or a wall ran out — and the rejection was as
        // informative as it will ever get, so it costs its attempt.
        if (arrival === 'peer') attempt -= 1
        continue
      }
      await pause()
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer)
    }
  }

  // WHICH wall stopped this, said once, from outside the loop — the loop
  // reports how far it got, and the two must not be confused.
  // `hard-cap` is the only alarming answer: it means the transport was still
  // delivering when the client gave up, so no client setting fixes it.
  recordResolutionEnd(
    extendedMs,
    hardRemainingMs() <= 0 ? 'hard-cap' : stallRemainingMs() <= 0 ? 'stall' : null,
  )
  // Retryable to the end: the caller may try again later (a peer can still show
  // up). The message keeps the repo's "is unavailable" wording and `cause`
  // carries the last raw rejection (never an intermediate wrapper).
  // The count an operator needs is how many times we ASKED, not how many of
  // those the schedule chose to charge for: a waived round is a real request
  // that really failed.
  throw new DocumentTemporarilyUnavailableError(url, findAttempts, { cause: rootCauseOf(lastError) })
}
