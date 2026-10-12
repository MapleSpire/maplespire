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
 * The `overlay-rotation:*` SESSION advisory lock — one owner of the key text,
 * the acquisition and the hand-back, for the three sites of
 * `staticDeltaProjector` that serialise a workspace's overlay write head.
 *
 * ── why a non-blocking try-lock ───────────────────────────────────────────────
 *
 * `rotateOverlayHead` and `foldOverlayChain` run on the per-workspace
 * `workspaceTails` chain and cannot contend with each other in-process;
 * `recoverAdmittedOverlayRotations` runs on `reloadTail`, a DIFFERENT chain, and
 * takes the same key on a different connection of a pool capped at four.
 *
 * `start()` awaits the recovery pass before it installs either interval, and in
 * `index.ts` `await staticDeltaProjector.start()` is followed directly by
 * `readiness.readModel = true`. A BLOCKING `pg_advisory_lock` there would mean
 * a pod starting while another pod folds a long overlay chain never finishes
 * starting, never reconciles and never publishes readiness.
 *
 * ── measured against a real Postgres ──────────────────────────────────────────
 *
 * | claim | measured |
 * |---|---|
 * | `SET LOCAL lock_timeout` DOES bound `pg_advisory_lock` | 55P03 @ 501 ms |
 * | bare `pg_advisory_lock` has no ceiling | still pending @ 3 005 ms |
 * | bare `client.release()` on a lock-holding client | key still held, 1 |
 * | `client.release(err)` | key dropped, 0 |
 * | the next borrower of that leaked backend | SAME pid, **granted** |
 * | a DIFFERENT connection asking for the same key | pending @ 2 014 ms |
 * | `pg_advisory_unlock` when the session never took it | `false` |
 * | …when it did | `true` |
 * | unlock issued inside an ABORTED transaction | **25P02**, key still held |
 *
 * So a ceiling was available and is deliberately NOT what this module does.
 * Refusing outright needs no constant, and the three obligations are all
 * re-derived from durable state on the next reload tick — the rotation by
 * `recoverCurrentOverlayRotationObligations`, the recovery pass by its own
 * `status = 'admitted'` SELECT, the fold by `scheduleOverlayChainFolds`. A
 * ceiling would be a number to keep true against a holder that spans
 * `repo.create` plus two `repo.flush`es; `closeInactiveAdmittedRotations` and
 * `overlayFoldInFlight` choose refusal for the same reason.
 *
 * ── the hand-back ─────────────────────────────────────────────────────────────
 *
 * `pg_advisory_unlock(...).catch(() => undefined)` followed by a bare
 * `client.release()` is a defect: pg-pool's `_release(client, listener, err)`
 * removes the client only when `err` is truthy; bare, it re-arms the idle
 * listener and hands back the SAME backend — with the key still on it. With a
 * try-lock the next borrower of that connection is then ADMITTED, because an
 * advisory lock is counted per session. Acquisition and hand-back therefore
 * live in one place so no site can pair a try-acquire with a naive release.
 *
 * ── why NOT `db/sessionAdvisoryLock.ts`, which does all this and more ─────────
 *
 * That module is better than this one at what it does, and the
 * read-the-boolean discipline below is ITS discipline restated at this scale.
 * It is deliberately not used here, for three reasons in descending order of
 * how hard they are:
 *
 *  1. **The key space is not the same, and a lock key is a wire format.**
 *     `acquireSessionAdvisoryLock(pool, key: number)` takes a JS `number`; this
 *     key is `hashtextextended(text, 0)`, a full signed int64 computed
 *     server-side, and it routinely exceeds 2^53 — two real values from this
 *     namespace are `7426741074546105541` and `-8987495413501206310`. Passing
 *     it through a `number` changes the key, and a door running the new build
 *     would stop excluding a door running the old one, silently, during exactly
 *     the rolling deploy where two builds run at once. That is the one failure
 *     this lock exists to prevent.
 *  2. **It holds a DEDICATED client for the lock's whole life.** All three sites
 *     here already hold one for their own transaction, and the read-model pool
 *     is capped at four (`DB_READ_MODEL_POOL_MAX ?? '4'`); the recovery pass
 *     loops up to 1 000 rows. Two of four connections per row is the
 *     pool-emptying shape `scheduleOverlayChainFolds`' own comment already
 *     refuses for the same key.
 *  3. **Its guarantees are for a lock held for MINUTES** — a heartbeat, a
 *     keepalive belt, a fencing token, an independent terminate — across a
 *     backup drill. This one is held for one rotation, for which the file's own
 *     slow-log threshold is 50 ms, and a 15 s heartbeat cannot observe anything
 *     shorter than its period. (The FOLD is the long holder, spanning
 *     `repo.create` and two `repo.flush`es, so for it reasons 1 and 2 carry
 *     the argument.)
 */
import type { PoolClient } from 'pg'
// The SAME clock and the SAME number as the only other module that issues
// `pg_advisory_unlock` on a pooled client, imported rather than restated.
import { ADVISORY_LOCK_RELEASE_CEILING_MS, withCeiling } from '../db/sessionAdvisoryLock.js'
import type { MetricSample } from '../runtime/metrics.js'

/** What this session knows about the key — not "did I take it". A throw from
 * the acquisition leaves `unknown`, which is neither of the other two: the
 * server may have granted the lock and lost the reply. */
export type OverlayRotationLockState = 'acquired' | 'refused' | 'unknown'

export type OverlayRotationKind = 'object' | 'connection'

/**
 * How the key TEXT becomes the int64 Postgres locks on — the other half of the
 * wire format of the exclusion (see {@link overlayRotationLockKey}).
 *
 * `hashtext($1)` and `hashtextextended($1, 0)` are different functions
 * returning different values, so a door using one excludes nothing from a door
 * using the other. Every taker — the session takers here and the
 * transaction-scope takers in `overlayHistoryStore.ts` — uses this one copy;
 * the tests assert the LITERAL rather than importing it, since a test that
 * derives its expectation from the constant under test agrees with any value.
 *
 * Other advisory-lock sites spell the same expression for DIFFERENT key spaces;
 * they cannot de-exclude this one (a different key text is a different lock),
 * so they are deliberately not unified here.
 *
 * The SQL parameter is a parameter, not baked in, so a call site with a
 * preceding parameter hashes the right value.
 */
export const overlayRotationLockHash = (parameter = '$1'): string =>
  `hashtextextended(${parameter}, 0)`

/**
 * The key text — the WIRE FORMAT OF AN EXCLUSION. Every taker (the session
 * takers in `staticDeltaProjector` and the transaction-scope takers
 * `synchronizeOverlaySegments` / `synchronizeOverlayHead` in
 * `overlayHistoryStore`) must call this rather than spell the string: a copy
 * that differs by a hair stops excluding the others, and two transactions can
 * then each promote a different row and trip
 * `idx_read_model_overlay_segments_current`. `overlayRotationLock.test.ts` pins
 * the literal.
 */
export function overlayRotationLockKey(
  landscapeId: string,
  versionId: string,
  kind: OverlayRotationKind,
): string {
  return `overlay-rotation:${landscapeId}:${versionId}:${kind}`
}

/**
 * Take the key, or report that someone else holds it. Never waits.
 *
 * The hash is computed server-side, so every door on one cluster agrees
 * regardless of build; changing the expression would be the same silent
 * de-exclusion as changing the key text.
 *
 * A throw is NOT converted into `refused`. "The server said no" and "I never
 * learned the answer" are different facts with opposite hand-backs, and folding
 * them together is how a lock-holding connection goes back into the pool.
 *
 * NEITHER IS A MISSING ROW. Against a real Postgres it is unreachable — the
 * statement returns exactly one row — but every fake pool in this tree
 * defaults to `{ rows: [], rowCount: 0 }`, and reading that as "refused" would
 * make an unstubbed test silently do nothing. `unknown` makes it loud instead.
 */
export async function acquireOverlayRotationLock(
  client: Pick<PoolClient, 'query'>,
  lockKey: string,
): Promise<OverlayRotationLockState> {
  // UNDER A CEILING. `pg_try_advisory_lock` bounds the LOCK WAIT, not the
  // ROUND TRIP: a socket black-holed by a stateful firewall returns neither
  // error nor answer for `tcp_retries2`, ~15 minutes on Linux — and this
  // statement runs on the chain `start()` awaits, so an unanswered acquire
  // would be the same never-ready pod as a blocking lock.
  const { rows } = await withCeiling(
    client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${overlayRotationLockHash()}) AS locked`,
      [lockKey],
    ),
    ADVISORY_LOCK_RELEASE_CEILING_MS,
    `pg_try_advisory_lock did not answer within ${ADVISORY_LOCK_RELEASE_CEILING_MS} ms`,
  )
  if (rows[0]?.locked === true) {
    refusalStreaks.delete(lockKey)
    return 'acquired'
  }
  return rows[0]?.locked === false ? 'refused' : 'unknown'
}

/**
 * Hand the key and the connection back together, and READ THE ANSWER.
 *
 * The three branches are three different states of knowledge, and each one's
 * hand-back was measured:
 *
 *  - `refused` — a definite `false` from the server means nothing was taken, so
 *    the connection is clean and goes back bare. (`acquireLifecycleApplyLock`
 *    takes the same branch for the same reason.)
 *  - `unknown` — the acquisition threw. The lock may be held by a session we no
 *    longer have a handle on, and ENDING THE SESSION is the only thing that
 *    returns it: `release(err)` destroys the client, measured to take the key
 *    from 1 to 0 where a bare release leaves it at 1.
 *  - `acquired` — issue the unlock and read its boolean. `false` says this
 *    session did not hold the key it thought it held, which is reported AND
 *    paid for by ending the session, exactly as `releaseLifecycleApplyLock`
 *    does.
 *
 * WHAT THAT BOOLEAN CANNOT SEE. An advisory lock is COUNTED: a session that took
 * the key twice gets `true` from the first unlock while still holding it. So
 * the detector catches count 1 → 0 and is blind to count 2 → 1. No path in this
 * tree reaches the acquisition twice on one session — each of the three sites
 * is one `connect` → one acquire → one release, the two on `workspaceTails`
 * cannot overlap, and the recovery loop releases in its `finally` before the
 * next iteration connects — so this is latent rather than live, but the state
 * IS constructible (`overlayRotationLock.integration.test.ts` builds it
 * deliberately).
 *
 * A THROW from the unlock must not be swallowed. It is reachable: a statement
 * issued inside an aborted transaction raises 25P02, with the key still held
 * afterwards. The connection then goes
 * back destroyed, because that is the only hand-back that returns the key.
 */
export async function releaseOverlayRotationLock(
  client: PoolClient,
  lockKey: string,
  state: OverlayRotationLockState,
): Promise<void> {
  if (state === 'refused') {
    client.release()
    return
  }
  if (state === 'unknown') {
    client.release(new Error(
      `overlay rotation lock ${lockKey}: acquisition gave no answer, ending the session`,
    ))
    return
  }
  // EXACTLY ONE `release`, outside the `try`. pg-pool throws on a second
  // release, so a bare release inside the `try` and a `release(err)` in the
  // `catch` is a window where one throw becomes two — the second one escaping
  // a `finally` at all three call sites and replacing the caller's real error
  // with this one. A single release makes that window impossible rather than
  // merely unreachable.
  let failure: Error | undefined
  try {
    // The same ceiling as the acquire, and for a sharper reason: this is the
    // await that RETURNS THE KEY, and a hang here wedges the scheduler. The
    // clock is imported from `sessionAdvisoryLock`, which bounds the identical
    // statement.
    const { rows } = await withCeiling(
      client.query<{ released: boolean }>(
        `SELECT pg_advisory_unlock(${overlayRotationLockHash()}) AS released`,
        [lockKey],
      ),
      ADVISORY_LOCK_RELEASE_CEILING_MS,
      `pg_advisory_unlock did not answer within ${ADVISORY_LOCK_RELEASE_CEILING_MS} ms`,
    )
    if (rows[0]?.released !== true) {
      console.warn(JSON.stringify({
        event: 'read_model.overlay_rotation_lock_not_held',
        lockKey,
        detail: 'pg_advisory_unlock reported this session did not hold the key',
      }))
      // DESTROYED, not returned clean — matching `releaseLifecycleApplyLock`.
      // "The session holds nothing" would rest on the SAME statement whose
      // answer has just contradicted the acquisition; ending the session is
      // the only way to return anything it does hold.
      failure = new Error(
        `overlay rotation lock ${lockKey}: pg_advisory_unlock answered false, ending the session`,
      )
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  }
  // `undefined` is falsy, which is pg-pool's own test for "hand it back clean".
  client.release(failure)
}

/**
 * Consecutive refusals per key, and when the run started.
 *
 * COUNT THE SAMPLES SEPARATELY FROM THE VERDICT. Without this, refusal #1 and
 * refusal #2 000 are byte-identical log lines, and they are opposite facts:
 * one is another pod healthily folding a chain for 400 ms, the other is a key
 * nobody will ever release — producible by a bare `release()` on some other
 * path, or by an older build during a rolling deploy. The second one stops rotation and
 * folding for that `(workspace, kind)` for ever, and the two things they bound
 * — the write head past `OVERLAY_SEGMENT_SIZE`, and a chain nothing else ever
 * shortens — then grow without limit.
 *
 * EVICTED ON THE ACQUISITION, never on a read. A cache dropped by its reader is
 * never dropped once the reader loses interest, and the reader here is the
 * refusal path — which by definition stops running the moment the problem is
 * over. `acquireOverlayRotationLock` deletes the entry on success, because
 * success is the event that makes it obsolete.
 *
 * …AND AGED OUT, because these entries are the VALUE OF TWO PUBLISHED GAUGES.
 * Without aging, one transient refusal on a workspace later demoted or handed
 * over would latch `contended_keys` at 1 and grow `longest_refusal_seconds`
 * for the process's life — reporting a wedged holder for a workspace that is
 * gone. A transient refusal is the EXPECTED event in a multi-pod fleet.
 *
 * So an entry also carries WHEN IT LAST REFUSED, and one older than
 * {@link REFUSAL_STREAK_TTL_MS} is not published. The pruning happens on the
 * WRITE path — inside the report below — never in the sample function: a map
 * swept only by its reader is swept only while someone is asking, which is the
 * same defect one level down.
 */
const refusalStreaks = new Map<string, { count: number; since: number; lastAt: number }>()

/**
 * How long after its last refusal a streak stops describing anything.
 *
 * A workspace this pod still serves re-attempts on the projector tick, so an
 * entry it is genuinely contending on is refreshed every few seconds. An entry
 * that has gone quiet is one of two things and both are silence: the key was
 * acquired (which evicts it outright), or the pod stopped serving the
 * workspace. Ten minutes is far longer than any tick and far shorter than a
 * process lifetime.
 *
 * Note what aging out deliberately does NOT lose: a wedged holder is only
 * reported while somebody is still ASKING for the key, and if nobody is asking
 * then nothing is blocked and the head is not growing. The gauge answers "is
 * anything stuck now", and "nothing is trying" is a correct zero.
 */
const REFUSAL_STREAK_TTL_MS = 600_000

/**
 * Report a contended rotation lock, so a stalled static-projector tick is
 * visible.
 *
 * Deliberately NOT a `read_model_projection_state` degradation. A refused lock
 * is another writer doing the same work, the read model stays coherent, and the
 * obligation is re-derived on the next tick — a degradation would be a durable
 * mark for a fault that has already healed, whose only lift lives in a module
 * the fleet will not attach here.
 *
 * What DOES catch the permanent case durably is a pair of `npm run fsck`
 * checks, one per starved mechanism, and BOTH are needed:
 *
 *  - a fold starved for ever leaves a chain nothing shortens, which is
 *    `overlay-chain-bounded`;
 *  - a ROTATION starved for ever leaves the opposite signature — a SHORT chain
 *    with one unbounded head — because rotation is the only thing that appends
 *    to the chain. So `overlay-chain-bounded` gets greener as that fault
 *    worsens, and `overlay-head-bounded` is the check that sees it.
 *
 * Both are runnable, rather than a log line somebody has to stumble on. What
 * neither is, is CONTINUOUS: fsck is a command. That is what
 * {@link overlayRotationLockMetricSamples} is for.
 */
export function reportOverlayRotationLockContended(detail: {
  path: 'rotate' | 'recover-admitted' | 'fold'
  landscapeId: string
  versionId: string
  kind: OverlayRotationKind
  /** `unknown` — the acquisition answered a shape nobody can read — is reported
   * on the same line rather than silently as a refusal, because the two have
   * opposite hand-backs and only one of them means somebody else is working. */
  state?: OverlayRotationLockState
  now?: number
}): void {
  const lockKey = overlayRotationLockKey(detail.landscapeId, detail.versionId, detail.kind)
  const at = detail.now ?? Date.now()
  const previous = refusalStreaks.get(lockKey)
  const streak = { count: (previous?.count ?? 0) + 1, since: previous?.since ?? at, lastAt: at }
  refusalStreaks.set(lockKey, streak)
  refusalsTotal += 1
  // Pruned HERE, on the write path, and not in the sample function: a map swept
  // only by its reader is swept only while someone is asking. The map holds at
  // most two entries per workspace this process has ever served, so the scan is
  // trivial and needs no schedule of its own.
  for (const [key, entry] of refusalStreaks) {
    if (key !== lockKey && at - entry.lastAt > REFUSAL_STREAK_TTL_MS) refusalStreaks.delete(key)
  }
  console.warn(JSON.stringify({
    event: 'read_model.overlay_rotation_lock_contended',
    path: detail.path,
    landscapeId: detail.landscapeId,
    versionId: detail.versionId,
    kind: detail.kind,
    state: detail.state ?? 'refused',
    lockKey,
    consecutiveRefusals: streak.count,
    refusedForMs: at - streak.since,
  }))
}

/**
 * Process-lifetime refusals, so a `rate()` over the counter below is meaningful.
 *
 * Deliberately NOT cleared by the test seam, and deliberately not derived from
 * the streak map: the map is evicted on every acquisition, so its counts answer
 * "is anything stuck NOW" and can only ever go down. Read this one as a DELTA
 * across the work under test — nothing resets it, so an assertion on its
 * absolute value passes or fails on test ORDER (`docScope.ts` carries the
 * same note over the same shape).
 */
let refusalsTotal = 0

/**
 * The /metrics samples this module owns.
 *
 * Built HERE rather than in `index.ts` so their presence is unit-testable:
 * nothing in CI mounts that route, so a sample living only inside it is covered
 * by nothing, and deleting one would surface first as a dashboard series
 * quietly going flat. `docScopeMetricSamples()` is the precedent and says the
 * same thing over the same hazard.
 *
 * WHY A METRIC AT ALL, now that both permanent cases have an fsck check: a
 * verdict has a TIMESTAMP and a guarantee has an INTERVAL. `npm run fsck` is a
 * command somebody runs; these are sampled every scrape, which is the only form
 * that covers the interval where a takeover or a wedged holder actually
 * happens. The two are not substitutes.
 *
 * NO WORKSPACE LABELS, on purpose. The streak map is keyed by lock key, so a
 * label per key would put `(landscape, version, kind)` into the time-series
 * cardinality — unbounded across a fleet, and worst exactly when the fault is
 * widespread. These three answer "is anything stuck, and for how long", and the
 * log line that fires beside them carries which. A metric that says WHICH is
 * how a monitoring bill becomes the incident.
 */
export function overlayRotationLockMetricSamples(now: number = Date.now()): MetricSample[] {
  // FILTERED BY AGE, not merely counted. An entry whose last refusal is older
  // than the TTL describes a workspace this pod no longer contends on, and
  // publishing it latches both gauges for the life of the process — see
  // {@link refusalStreaks}. Filtering rather than deleting, because the
  // delete belongs on the write path.
  let longestMs = 0
  let live = 0
  for (const streak of refusalStreaks.values()) {
    if (now - streak.lastAt > REFUSAL_STREAK_TTL_MS) continue
    live += 1
    longestMs = Math.max(longestMs, now - streak.since)
  }
  return [
    {
      name: 'maplespire_overlay_rotation_lock_refusals_total',
      help: 'Overlay rotation/fold passes that found the advisory key held, since process start.',
      type: 'counter',
      values: [{ value: refusalsTotal }],
    },
    {
      name: 'maplespire_overlay_rotation_lock_contended_keys',
      help: 'Overlay rotation keys currently in a consecutive-refusal streak. Zero is the healthy value.',
      type: 'gauge',
      values: [{ value: live }],
    },
    {
      // The one that separates a healthy neighbour from a wedged holder. A pod
      // folding a long chain refuses its neighbours for seconds; a key nobody
      // will ever release refuses them for the life of the process, and both
      // produce identical `refusals_total` slopes.
      //
      // ZERO, never NaN, when nothing is refusing: "no key is stuck" is a real
      // answer to the question, not a measurement that could not be taken. The
      // NaN idiom in this tree is for the second case only.
      name: 'maplespire_overlay_rotation_lock_longest_refusal_seconds',
      help: 'Age of the oldest unbroken refusal streak. Grows without bound when a key is never released.',
      type: 'gauge',
      values: [{ value: Number((longestMs / 1000).toFixed(3)) }],
    },
  ]
}

/** Test seam. The streaks are module state on purpose — the call sites are
 * three methods of a class the fleet constructs per process — and module state
 * that no lifecycle call resets makes a test pass or fail on ORDER.
 *
 * `refusalsTotal` is NOT reset: a counter that goes backwards makes every
 * `rate()` over it lie. Tests read it as a delta. */
export function __resetOverlayRotationRefusalStreaks(): void {
  refusalStreaks.clear()
}

/**
 * Test seam: how many entries the map actually HOLDS, before the age filter.
 *
 * The published gauges cannot answer this — they filter by TTL, so a stale
 * entry and a pruned one look identical from outside. Without a seam, deleting
 * the write-path prune loop above would pass every test.
 *
 * The distinction is memory, not correctness — a map swept only by its reader
 * is swept only while someone is scraping.
 */
export function __overlayRotationStreakEntryCount(): number {
  return refusalStreaks.size
}
