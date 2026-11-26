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
 * THE LIVE EPOCH HOP (G4-16f) — the
 * STATE MACHINE, pure: every effect is a port, so the order of effects is
 * what the unit tests pin. The bridge supplies the ports (`bridge.ts`,
 * "THE LIVE EPOCH HOP: the ports").
 *
 *  1. DETECT — `start(newMetaUrl)` when the root's `modelMetaUrl` differs from
 *     the booted one (the root changes only by sync, so only online).
 *  2. DRAIN — writes keep going to the OLD epoch (they are forwarded, the
 *     user is never blocked); one acknowledgement of the old documents'
 *     heads, and when it already says `durable && forwarded` the latch below
 *     costs nothing. An optimisation only: convergence is step 4's.
 *  3. LOAD — the new meta and its base shards, in the background, into NEW
 *     handles (`ports.load`).
 *  4. SWAP, under ONE bounded latch — no release-and-loop, so a user typing
 *     continuously still converges:
 *       block input → flush the pending write once and pause writes → read
 *       the PAUSED heads (final: nothing writes any more) → wait for
 *       `durable && forwarded` on exactly those heads. The FLUSH AND THE
 *       WAIT share ONE budget of `latchMs` (2 s), started at the block: a
 *       flush that hangs cannot hold the overlay up.
 *        - acknowledged: swap (atomic: the port re-attaches the old epoch if
 *          it fails), lift the block, resume writes; the old documents are
 *          RETAINED, attached and syncing, until their own heads are
 *          acknowledged forwarded (the writers that bypass `flushWrite` — the
 *          tombstone append, a deferred `writeHeldReference` — may still
 *          write them), then released;
 *        - not within `latchMs`: lift, resume, stay on the old epoch (still
 *          forwarded), retry after a backoff (10 s, 30 s, 60 s, then 60 s).
 *     Input is blocked through the swap, so no edit is made during it and
 *     none needs replaying after `projectAll`. The swap's own cost is outside
 *     the budget (about one `projectAll`).
 *  5. A SECOND REPOINT during a hop CANCELS it: the new handles are dropped
 *     unprojected, a held latch released, and the hop restarts with the
 *     newest URL.
 *  6. RETIRED — retirement is PER DOCUMENT: when any held old document is
 *     answered `epochRetired`, the differences of THOSE documents are
 *     collected before the swap, the swap happens, the documents that are not
 *     retired are retained until forwarded like any other, and the
 *     `epoch-retired` banner offers the collected differences as an export
 *     (no automatic re-apply: without the cut base there is no sound
 *     three-way merge).
 *
 * RETAINED SETS outlive the hop that made them: each set is watched by its
 * own poll, under the machine's
 * lifetime signal and NOT the hop's, so a second repoint (which cancels the
 * hop) never strands a set or overwrites it — every set is released only
 * when ITS heads are forwarded. `stop()` (the bridge stops) releases them all.
 *
 * A FAILED acknowledgement (offline, a 503) is `pending`, never a failed hop.
 * A failed hop (a load or a swap that threw) forgets its target, so the same
 * URL started again is retried.
 */

export interface HopDocumentHeads {
  documentId: string
  heads: string[]
}

export interface HopAcknowledgement {
  documentId: string
  durable: boolean
  /** Absent: not an epoch source, nothing to forward (`durableHeads.ts`). */
  forwarded?: boolean
  epochRetired?: boolean
  /** A live source durable past its forward cursor: the server started a
   * pass for it. Diagnostic only for the tab. */
  forwardPending?: boolean
  /** With `forwardPending`, the server could not serve a latch at once
   * now (its roll's own pass first, a compaction holding the slot, another
   * latch of the workspace just served): the tab keeps draining. */
  forwardBusy?: boolean
  /** Forwarded sources: the server's heads of the current epoch's documents
   * at the time of the answer — the tab swaps only once it holds them
   * (never project new documents that lack the forward). */
  targetHeads?: HopDocumentHeads[]
}

/** An opaque handle on one retained set of old documents. */
export type RetainToken = number

export interface EpochHopPorts<Handles> {
  /** Step 3: the new meta and (resident) its base shards, into new handles. */
  load(metaUrl: string, signal: AbortSignal): Promise<Handles>
  /** Whether the tab's copies of the NEW documents (the loaded handles) hold
   * `targets` — the documents it did not load are not its concern. Absent:
   * always true. */
  holdsTargets?(handles: Handles, targets: readonly HopDocumentHeads[]): boolean
  /** Whether `metaUrl` is still what the root names: read once
   * more right before the swap. Absent: always true. */
  stillWanted?(metaUrl: string): boolean
  /** Drop handles a cancelled hop loaded (never projected). */
  drop(handles: Handles): void
  /** The heads of every OLD epoch document the tab holds (meta, base shards). */
  oldHeads(): HopDocumentHeads[]
  /** The documents among `oldHeads` the SWAP
   * CARRIES (the tab's own shards, not epoch documents). One the server
   * answers as no epoch source at all need not be durable for the hop to
   * settle: nothing forwards it, the tab keeps holding and writing it. Read
   * after each acknowledgement. Absent: none. */
  carried?(): ReadonlySet<string>
  /** The OLD meta's document id.
   * The hop settles no verdict before the server's answer for it carries
   * `forwarded` (true or false) or `epochRetired`: the proof that the roll
   * passed S7. Between S6b (the root repointed) and S7 (the `superseded`
   * rows) no old document has an epoch row, so every one reads "nothing to
   * forward" — a durable one would swap before its forward, a carried
   * one not durable would too and be carried beside its copy. The old
   * meta is superseded by every roll and by `--adopt-root` (whose new epoch
   * never lists it), so the bit always comes. Absent: no proof asked. */
  oldMetaDocumentId?(): string | null
  /** The server's durable acknowledgement, with the epoch bits. */
  acknowledge(documents: HopDocumentHeads[], signal: AbortSignal, options?: { latch?: boolean }): Promise<HopAcknowledgement[]>
  /** The read-only overlay ("Updating the model…"), edit commands disabled. */
  blockInput(): void
  unblockInput(): void
  /** Run the pending write once, then pause `flushWrite`. */
  flushAndPauseWrites(): Promise<void>
  resumeWrites(): void
  /** ATOMIC: detach the old listeners, assign the new handles, attach,
   * `projectAll` — or, when any step throws, re-attach the old epoch and
   * rethrow, so a failed swap never leaves the tab with no epoch attached.
   * `retired`: on the retired
   * path, the documents the verdict named retired; empty otherwise. */
  swap(handles: Handles, retired?: readonly string[]): Promise<void>
  /** After a swap: keep these old documents attached and syncing. */
  retainOld(documents: HopDocumentHeads[]): RetainToken
  /** The current heads of ONE retained set. */
  retainedHeads(token: RetainToken): HopDocumentHeads[]
  /** Release one retained set: its last heads are forwarded (or the bridge stops). */
  releaseOld(token: RetainToken): void
  /** Step 6: what the local copies of `retired` documents hold that the new epoch does not. */
  collectRetiredDiff(retired: readonly string[]): unknown
  showRetired(diff: unknown): void
  /** How long, in ms, the
   * tab has been QUIET — no remote change projected and no local write. A
   * starved hop waits for a quiet moment before it latches again. Absent:
   * always quiet. */
  quietForMs?(): number
  /** A delay that rejects (or resolves early) on abort. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  log?(event: Record<string, unknown>): void
}

export interface EpochHopOptions {
  latchMs?: number
  backoffMs?: readonly number[]
  /** Between two acknowledgement polls inside the latch; the first interval
   * of a retained set's poll, which then backs off. */
  pollMs?: number
  /** The ceiling of a retained set's backed-off poll. */
  retainedMaxPollMs?: number
  /** Before a latch, how long the tab keeps draining while the server
   * answers `forwardBusy` (default {@link EPOCH_HOP_BUSY_DRAIN_MAX_MS})… */
  busyDrainMaxMs?: number
  /** …asking again this often (default {@link EPOCH_HOP_BUSY_DRAIN_POLL_MS}). */
  busyDrainPollMs?: number
  /** Latches in a row that ended with the
   * old meta's S7 still unproven before the hop gives up (default
   * {@link EPOCH_HOP_S7_PROOF_MAX_ATTEMPTS}). */
  s7ProofMaxAttempts?: number
  /** Latches in a row that EXPIRED before the hop
   * is starved (default {@link EPOCH_HOP_STARVED_AFTER})… */
  starvedAfter?: number
  /** …then the backoff between two latches (default
   * {@link EPOCH_HOP_STARVED_BACKOFF_MS})… */
  starvedBackoffMs?: readonly number[]
  /** …and, after it, how long the tab must be quiet before it latches
   * (default {@link EPOCH_HOP_QUIET_MS}), waiting at most
   * {@link EPOCH_HOP_QUIET_MAX_WAIT_MS} (`quietMaxWaitMs`). */
  quietMs?: number
  quietMaxWaitMs?: number
}

/**
 * STARVATION. A tab whose latches keep expiring — its main thread saturated
 * by a large diagram other people edit without pause — latched every 60 s
 * for as long as the
 * session lasted: input frozen up to 2 s each minute, nothing gained. After
 * EPOCH_HOP_STARVED_AFTER expired latches in a row the hop is STARVED
 * (`epoch_hop.latch_starved`, once per run): the next latches come at most
 * once in 10, 20, then 30 minutes, each after a quiet moment (no remote
 * change, no local write for EPOCH_HOP_QUIET_MS) or, failing one, after
 * EPOCH_HOP_QUIET_MAX_WAIT_MS. Nothing is lost meanwhile: the tab stays on
 * its epoch, whose writes the server forwards.
 */
export const EPOCH_HOP_STARVED_AFTER = 3
/** An ask this tab saw take longer than this (the route answers in a few ms:
 * the rest is the tab's own main thread) marks the latch as the tab's slowness. */
export const EPOCH_HOP_SLOW_ASK_MS = 500
export const EPOCH_HOP_STARVED_BACKOFF_MS = [10 * 60_000, 20 * 60_000, 30 * 60_000] as const
export const EPOCH_HOP_QUIET_MS = 3_000
export const EPOCH_HOP_QUIET_MAX_WAIT_MS = 5 * 60_000
export const EPOCH_HOP_QUIET_POLL_MS = 500

/** The S7 proof is BOUNDED. A roll writes `superseded`
 * rows right after its repoint, so the proof comes within seconds; ten
 * latches in a row without it (about 8 minutes of backoff) is a roll stopped
 * between S6b and S7 that nothing resumes, or an old meta the route does not
 * answer. The hop then gives up — `epoch_hop.s7_unproven`, logged and
 * warned — and the tab stays on its epoch, whose edits the server still
 * holds (the old meta is not retired: it is not even superseded). The next
 * repoint, or a reload, starts again. */
export const EPOCH_HOP_S7_PROOF_MAX_ATTEMPTS = 10

/** A latch is not started while the server says it could not serve it
 * (`forwardBusy`) — at most this long per attempt, then it latches anyway. */
export const EPOCH_HOP_BUSY_DRAIN_MAX_MS = 20_000
export const EPOCH_HOP_BUSY_DRAIN_POLL_MS = 500

export const EPOCH_HOP_RETAINED_MAX_POLL_MS = 20_000

export type EpochHopState =
  | { phase: 'idle' }
  | { phase: 'loading' | 'draining' | 'latched' | 'backoff'; metaUrl: string; attempt: number }
  | { phase: 'retired'; metaUrl: string }

export const EPOCH_HOP_LATCH_MS = 2_000
export const EPOCH_HOP_BACKOFF_MS = [10_000, 30_000, 60_000] as const

class HopCancelled extends Error {
  constructor() { super('epoch hop cancelled'); this.name = 'HopCancelled' }
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new HopCancelled()); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = () => { clearTimeout(timer); reject(new HopCancelled()) }
  signal.addEventListener('abort', onAbort, { once: true })
})

type Verdict =
  | { kind: 'forwarded'; targets: HopDocumentHeads[] }
  /** `busy`: a pending document was answered `forwardBusy`.
   * `unproven`: pending on the S7 proof alone. */
  | { kind: 'pending'; busy?: true; unproven?: true }
  /** `targets`: what the forwards of the batch's LIVE sources wrote (the
   * retired path swaps too, so it waits for them as well). */
  | { kind: 'retired'; retired: string[]; targets: HopDocumentHeads[] }
const PENDING: Verdict = { kind: 'pending' }
const TIMEOUT = Symbol('latch timeout')

/** `durable && forwarded`, where an ABSENT `forwarded` is "nothing to
 * forward" (a document that is not a superseded epoch source — a carried base
 * shard of a meta-only epoch, say): `durableHeads.ts` omits the bit for it.
 * A forwarded verdict carries the union of the answers' target heads.
 *
 * `carried`: documents the swap carries — the
 * tab's own shards. One answered as NO epoch source (no `forwarded`, no
 * `forwardPending`, no `epochRetired`) is settled even when not durable: a
 * shard created offline and written into a meta that was RETIRED meanwhile
 * is claimed by no meta the server reads, so it is never durable, and the
 * hop waited for it for ever (backoff, no banner). Carried, it stays on the
 * screen; the bridge then decides its pointer against the new meta. An own
 * shard the server names as an epoch source (a full roll cut it) is
 * not settled this way. */
export function verdictOf(documents: readonly HopDocumentHeads[], acks: readonly HopAcknowledgement[],
  carried: ReadonlySet<string> = new Set(), oldMetaId: string | null = null): Verdict {
  const byId = new Map(acks.map((a) => [a.documentId, a]))
  // Nothing settles before the old meta's answer
  // proves the roll's S7 (`EpochHopPorts.oldMetaDocumentId`).
  if (oldMetaId !== null) {
    const meta = byId.get(oldMetaId)
    if (!meta || !('forwarded' in meta || meta.epochRetired === true)) {
      return acks.some((a) => a.forwardPending === true && a.forwardBusy === true) ? { kind: 'pending', busy: true } : { kind: 'pending', unproven: true }
    }
  }
  const targets = new Map<string, Set<string>>()
  for (const a of acks) {
    for (const t of a.targetHeads ?? []) {
      const heads = targets.get(t.documentId) ?? new Set<string>()
      for (const h of t.heads) heads.add(h)
      targets.set(t.documentId, heads)
    }
  }
  const union = [...targets].map(([documentId, heads]) => ({ documentId, heads: [...heads].sort() }))
  const retired = new Set(documents.filter((d) => byId.get(d.documentId)?.epochRetired === true).map((d) => d.documentId))
  // The batch's OTHER documents must be forwarded first: a retired verdict
  // used to swap while live sources of the same
  // batch were still on their way, and the tab showed their values go back.
  const settled = documents.every((d) => {
    if (retired.has(d.documentId)) return true
    const a = byId.get(d.documentId)
    // `forwardPending !== true` is a second guard, equivalent today (no
    // test can tell it apart): `durableHeads.ts` never answers `forwardPending`
    // without `forwarded`. Kept so a future answer shape cannot settle a
    // source waiting for its forward.
    if (a && carried.has(d.documentId) && !('forwarded' in a) && a.forwardPending !== true) return true
    return a?.durable === true && a.forwarded !== false
  })
  if (!settled) return acks.some((a) => a.forwardPending === true && a.forwardBusy === true) ? { kind: 'pending', busy: true } : PENDING
  if (retired.size > 0) return { kind: 'retired', retired: [...retired], targets: union }
  return { kind: 'forwarded', targets: union }
}

export interface EpochHop {
  /** Step 1 (or 5): hop to `metaUrl`; a running hop to another URL is cancelled. */
  start(metaUrl: string): void
  /** Abandon whatever runs (the bridge stops); every retained set is released. */
  stop(): void
  /** Cancel the running hop only (the root repointed BACK to the epoch the
   * tab holds); retained sets keep their watch. */
  cancel(): void
  state(): EpochHopState
  /** How many retained old sets are still waiting for their forward. */
  retained(): number
  /** Settles when the hop started last has finished (or was cancelled) AND
   * every retained set it knows of has been released. */
  settled(): Promise<void>
}

export function createEpochHop<Handles>(ports: EpochHopPorts<Handles>, options: EpochHopOptions = {}): EpochHop {
  const latchMs = options.latchMs ?? EPOCH_HOP_LATCH_MS
  const backoff = options.backoffMs ?? EPOCH_HOP_BACKOFF_MS
  const pollMs = options.pollMs ?? 250
  const retainedMaxPollMs = options.retainedMaxPollMs ?? EPOCH_HOP_RETAINED_MAX_POLL_MS
  const busyDrainMax = options.busyDrainMaxMs ?? EPOCH_HOP_BUSY_DRAIN_MAX_MS
  const busyDrainPoll = options.busyDrainPollMs ?? EPOCH_HOP_BUSY_DRAIN_POLL_MS
  const sleep = ports.sleep ?? defaultSleep
  let state: EpochHopState = { phase: 'idle' }
  let controller: AbortController | null = null
  let running: Promise<void> = Promise.resolve()
  let target: string | null = null
  /** The machine's lifetime: only `stop()` aborts it. Retained sets live on it. */
  let lifetime = new AbortController()
  const watchers = new Map<RetainToken, Promise<void>>()

  const check = (signal: AbortSignal) => { if (signal.aborted) throw new HopCancelled() }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  /** The latch being traced (diagnostics: how long a latch took to converge). */
  let latchStartedAt: number | null = null
  const sinceLatch = () => (latchStartedAt === null ? null : Math.round(now() - latchStartedAt))
  const s7ProofMaxAttempts = options.s7ProofMaxAttempts ?? EPOCH_HOP_S7_PROOF_MAX_ATTEMPTS
  const starvedAfter = options.starvedAfter ?? EPOCH_HOP_STARVED_AFTER
  const starvedBackoff = options.starvedBackoffMs ?? EPOCH_HOP_STARVED_BACKOFF_MS
  const quietMs = options.quietMs ?? EPOCH_HOP_QUIET_MS
  const quietMaxWaitMs = options.quietMaxWaitMs ?? EPOCH_HOP_QUIET_MAX_WAIT_MS
  /** The last answer inside a latch (was it the S7 proof alone?). */
  let lastLatchVerdict: Verdict | null = null
  /** The current latch's answered asks and the slowest one, as THIS tab
   * saw them. */
  let latchAsksAnswered = 0
  let latchSlowestAskMs = 0

  /** One acknowledgement. A FAILED one (offline, a 503) is `pending`, never
   * a failed hop: the latch lifts at its deadline and the backoff retries. */
  async function ask(documents: HopDocumentHeads[], signal: AbortSignal, context = 'drain'): Promise<Verdict> {
    check(signal)
    if (documents.length === 0) return { kind: 'forwarded', targets: [] }
    const sentAt = now()
    try {
      // The latch's asks say so — the server then starts
      // the pass after the running one at once, without its rest.
      const acks = context === 'latch'
        ? await ports.acknowledge(documents, signal, { latch: true })
        : await ports.acknowledge(documents, signal)
      // A retained set is asked after its swap: S7 was proven before it.
      const verdict = verdictOf(documents, acks, ports.carried?.(),
        context === 'retained' ? null : (ports.oldMetaDocumentId?.() ?? null))
      if (context === 'latch') {
        lastLatchVerdict = verdict
        latchAsksAnswered += 1
        latchSlowestAskMs = Math.max(latchSlowestAskMs, now() - sentAt)
      }
      if (context === 'latch') {
        ports.log?.({
          event: 'epoch_hop.ask', ms: Math.round(now() - sentAt),
          atMs: sinceLatch(),
          documents: documents.length,
          durable: acks.filter((a) => a.durable).length,
          notForwarded: acks.filter((a) => a.forwarded === false).length,
          forwardPending: acks.filter((a) => a.forwardPending === true).length,
          targets: verdict.kind === 'forwarded' ? verdict.targets.length : 0,
          verdict: verdict.kind,
        })
      }
      return verdict
    } catch (error) {
      if (error instanceof HopCancelled || signal.aborted) throw new HopCancelled()
      ports.log?.({ event: 'epoch_hop.ack_failed', error: error instanceof Error ? error.message : String(error) })
      return PENDING
    }
  }

  /** Poll until `documents` are forwarded (or retired); unbounded — the
   * caller races it against its deadline. FORWARDED counts only once the
   * tab's new handles hold the answer's target heads: a swap
   * projects the new documents, and one that lacked the forward would show —
   * and let a concurrent flush write back — a value without it. */
  async function pollUntilSettled(documents: HopDocumentHeads[], handles: Handles, signal: AbortSignal): Promise<Verdict> {
    let forwardedAt: number | null = null
    // FROZEN at the first settled verdict: what the forwards
    // had written then is what this swap needs; later answers may name the
    // targets' later forwards, and chasing them would never end.
    let frozen: HopDocumentHeads[] | null = null
    const holds = (targets: HopDocumentHeads[]) => !ports.holdsTargets || ports.holdsTargets(handles, targets)
    for (;;) {
      const verdict = await ask(documents, signal, 'latch')
      if (verdict.kind === 'retired') {
        frozen ??= verdict.targets
        if (holds(frozen)) return { ...verdict, targets: frozen }
      }
      if (verdict.kind === 'forwarded') {
        forwardedAt ??= now()
        frozen ??= verdict.targets
        if (holds(frozen)) {
          ports.log?.({ event: 'epoch_hop.targets_held', waitedMs: Math.round(now() - forwardedAt),
            atMs: sinceLatch() })
          return verdict
        }
      }
      await sleep(pollMs, signal)
    }
  }

  /** One retained set, polled under the LIFETIME signal until its own last
   * heads are forwarded, then released. Only `stop()` ends the watch early
   * (and releases). The poll backs off: `pollMs`, doubled up to
   * `retainedMaxPollMs`. */
  function watchRetained(token: RetainToken): void {
    const signal = lifetime.signal
    const watch = (async () => {
      try {
        for (let interval = pollMs; ; interval = Math.min(interval * 2, retainedMaxPollMs)) {
          const verdict = await ask(ports.retainedHeads(token), signal, 'retained')
          // `retired` too: nothing will ever forward it, and holding it does
          // not make it forwardable.
          if (verdict.kind !== 'pending') break
          await sleep(interval, signal)
        }
      } catch (error) {
        if (!(error instanceof HopCancelled) && !signal.aborted) throw error
      } finally {
        watchers.delete(token)
        ports.releaseOld(token)
      }
    })()
    watch.catch(() => undefined)
    watchers.set(token, watch)
  }

  async function run(metaUrl: string, signal: AbortSignal, mine: AbortController): Promise<void> {
    let handles: Handles | null = null
    let latched = false
    let swapped = false
    const lift = () => {
      if (!latched) return
      latched = false
      ports.unblockInput()
      ports.resumeWrites()
    }
    try {
      state = { phase: 'loading', metaUrl, attempt: 0 }
      // A load that IGNORES the signal cannot hold a cancelled
      // hop: the race ends the wait, and handles that arrive late are dropped.
      const loading = ports.load(metaUrl, signal)
      let onAbandon: (() => void) | null = null
      const abandoned = new Promise<never>((_, reject) => {
        if (signal.aborted) { reject(new HopCancelled()); return }
        onAbandon = () => reject(new HopCancelled())
        signal.addEventListener('abort', onAbandon, { once: true })
      })
      abandoned.catch(() => undefined)
      try {
        handles = await Promise.race([loading, abandoned])
        // Loaded: the abort listener is not left on the hop's signal.
        if (onAbandon) signal.removeEventListener('abort', onAbandon)
      } catch (error) {
        if (signal.aborted) loading.then((late) => ports.drop(late), () => undefined)
        throw error
      }
      check(signal)
      // Step 2: one acknowledgement while the user keeps writing the old epoch.
      state = { phase: 'draining', metaUrl, attempt: 0 }
      let drained = await ask(ports.oldHeads(), signal)
      let unproven = 0
      let expired = 0
      let starved = false
      for (let attempt = 0; ; attempt += 1) {
        check(signal)
        // No latch while the server says it could not serve one now —
        // the user keeps typing (forwarded) instead of meeting an overlay
        // bound to time out and a 10 s backoff. Bounded: then it latches.
        if (attempt > 0) drained = await ask(ports.oldHeads(), signal)
        const busyUntil = now() + busyDrainMax
        while (drained.kind === 'pending' && drained.busy && now() < busyUntil) {
          ports.log?.({ event: 'epoch_hop.busy_drain', attempt })
          await sleep(busyDrainPoll, signal)
          drained = await ask(ports.oldHeads(), signal)
        }
        check(signal)
        // Step 4: the ONE bounded latch. The budget starts at the block and
        // covers the flush AND the acknowledgement, its latency included.
        state = { phase: 'latched', metaUrl, attempt }
        ports.blockInput()
        latched = true
        latchStartedAt = now()
        latchAsksAnswered = 0
        latchSlowestAskMs = 0
        ports.log?.({ event: 'epoch_hop.latch', attempt })
        const budget = new AbortController()
        const onAbort = () => budget.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        const deadline = sleep(latchMs, budget.signal).then(() => TIMEOUT, () => TIMEOUT)
        let verdict: Verdict = PENDING
        let paused: HopDocumentHeads[] = []
        try {
          const flushing = ports.flushAndPauseWrites()
          const flushed = await Promise.race([flushing.then(() => true), deadline])
          if (flushed === TIMEOUT) {
            // A flush that outlived the budget: whenever it settles, writes
            // must not stay paused behind a latch already lifted.
            flushing.then(() => { if (!latched) ports.resumeWrites() }, () => undefined)
          } else {
            check(signal)
            ports.log?.({ event: 'epoch_hop.flushed', atMs: sinceLatch() })
            paused = ports.oldHeads()
            const polled = pollUntilSettled(paused, handles, budget.signal)
            polled.catch(() => undefined)
            const settled = await Promise.race([polled, deadline])
            verdict = typeof settled === 'symbol' ? PENDING : settled
          }
        } finally {
          budget.abort()
          signal.removeEventListener('abort', onAbort)
        }
        ports.log?.({ event: 'epoch_hop.latch_end', attempt, verdict: verdict.kind, atMs: sinceLatch() })
        latchStartedAt = null
        check(signal)
        // A repoint back (or elsewhere) that arrived during the latch: the
        // root no longer names this epoch, so it is not swapped to.
        if (verdict.kind !== 'pending' && ports.stillWanted && !ports.stillWanted(metaUrl)) throw new HopCancelled()
        if (verdict.kind === 'retired') {
          // Step 6: what only the RETIRED documents hold, collected BEFORE the
          // swap; the others are retained until forwarded like any swap.
          const retired = new Set(verdict.retired)
          const diff = ports.collectRetiredDiff(verdict.retired)
          await ports.swap(handles, verdict.retired)
          swapped = true
          const live = paused.filter((d) => !retired.has(d.documentId))
          // ALWAYS handed over, even empty: the port then
          // drops what it pinned for the swap; an empty set releases at once.
          watchRetained(ports.retainOld(live))
          lift()
          state = { phase: 'retired', metaUrl }
          ports.log?.({ event: 'epoch_hop.retired', metaUrl, retired: verdict.retired })
          ports.showRetired(diff)
          return
        }
        if (verdict.kind === 'forwarded') {
          await ports.swap(handles)
          swapped = true
          // Retained BEFORE the lift: no bypassing write lands unwatched.
          watchRetained(ports.retainOld(paused))
          lift()
          ports.log?.({ event: 'epoch_hop.swapped', metaUrl, attempt })
          state = { phase: 'idle' }
          return
        }
        // Not acknowledged within the latch: lift, stay on the old epoch, retry.
        lift()
        // BOUNDED on the S7 proof — latches in a row that
        // ended on it alone; any other pending answer resets the count.
        const onlyUnproven = lastLatchVerdict?.kind === 'pending' && lastLatchVerdict.unproven === true
        unproven = onlyUnproven ? unproven + 1 : 0
        lastLatchVerdict = null
        if (unproven >= s7ProofMaxAttempts) {
          ports.log?.({ event: 'epoch_hop.s7_unproven', metaUrl, attempts: unproven })
          // The same url may be started again (the next repoint, a reload).
          if (controller === mine) target = null
          return
        }
        state = { phase: 'backoff', metaUrl, attempt }
        ports.log?.({ event: 'epoch_hop.latch_timeout', metaUrl, attempt })
        // A latch that expired on the tab's own slowness (not on the S7
        // proof, which has its own bound) counts towards starvation, and
        // only the TAB's slowness — no ask answered within the
        // latch, or one this tab saw answered late. A server still forwarding
        // a large backlog answers fast with `forwardPending`: the ordinary
        // backoff, not ten minutes.
        const tabSlow = latchAsksAnswered === 0 || latchSlowestAskMs > EPOCH_HOP_SLOW_ASK_MS
        if (!onlyUnproven && tabSlow) expired += 1
        if (expired >= starvedAfter) {
          if (!starved) {
            starved = true
            ports.log?.({ event: 'epoch_hop.latch_starved', metaUrl, expired, attempt })
          }
          await sleep(starvedBackoff[Math.min(expired - starvedAfter, starvedBackoff.length - 1)]!, signal)
          const waitStarted = now()
          while (ports.quietForMs && ports.quietForMs() < quietMs && now() - waitStarted < quietMaxWaitMs) {
            await sleep(EPOCH_HOP_QUIET_POLL_MS, signal)
          }
          ports.log?.({ event: 'epoch_hop.quiet_wait', metaUrl, waitedMs: Math.round(now() - waitStarted),
            quiet: !ports.quietForMs || ports.quietForMs() >= quietMs })
        } else {
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]!, signal)
        }
      }
    } catch (error) {
      if (!(error instanceof HopCancelled)) {
        ports.log?.({ event: 'epoch_hop.failed', metaUrl, error: error instanceof Error ? error.message : String(error) })
        // A FAILED hop (not a cancelled one) must not swallow the next
        // `start` of the same URL: forget the target.
        if (controller === mine) target = null
      }
    } finally {
      // CANCELLED (or failed) mid-hop: a held latch is released, unprojected
      // new handles are dropped.
      lift()
      if (handles && !swapped) ports.drop(handles)
      if (state.phase !== 'retired') state = { phase: 'idle' }
    }
  }

  return {
    start(metaUrl) {
      if (target === metaUrl && controller && !controller.signal.aborted) return
      // Step 5: a second repoint cancels the running hop (never a retained set).
      controller?.abort()
      const mine = new AbortController()
      controller = mine
      target = metaUrl
      const previous = running
      running = previous.then(() => run(metaUrl, mine.signal, mine))
    },
    stop() {
      controller?.abort()
      target = null
      lifetime.abort()
      lifetime = new AbortController()
    },
    cancel() {
      controller?.abort()
      target = null
    },
    state: () => state,
    retained: () => watchers.size,
    settled: async () => {
      await running
      while (watchers.size > 0) await Promise.all([...watchers.values()])
    },
  }
}
