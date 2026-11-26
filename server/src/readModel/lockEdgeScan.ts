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
 * GATE G5 — the INBOUND EDGE into the projection mutex (task T-G5, decisions D8
 * and D16).
 *
 * WHY THE EXISTING RULE HAD TO BE REWRITTEN BEFORE ADDING KEYS TO IT. The
 * subsystem documents "exactly ONE global lock order: `read-model-projection:`
 * before `overlay-rotation:`", and `projectionLockOrderViolations` (gate A8,
 * below) encodes it as: never take the projection xact
 * lock while holding ANY session lock.
 *
 * That encoding is STRONGER than the invariant it protects, and D8's arbitration
 * measured the consequence: the maintenance lock D8 introduces —
 * `maintenance-workspace:<job>:<lid>:<vid>`, held at session scope on the
 * coordinator's own client — is taken OUTSIDE any projection transaction, and a
 * maintenance job that then does a projection takes the projection mutex WHILE
 * holding it. Under A8's encoding that is a violation. It is nevertheless safe,
 * and the reason is the whole point of this gate.
 *
 * A DEADLOCK NEEDS A CYCLE, WHICH NEEDS BOTH DIRECTIONS:
 *
 *   (out) somebody holds key K and then wants the projection mutex;
 *   (in)  somebody holds the projection mutex and then wants key K.
 *
 * A8 asserts (out) is absent. It cannot see (in) at all — it only inspects what
 * is held when the PROJECTION lock is taken, never what is taken while the
 * projection lock is held. So A8 forbids a direction that is harmless on its
 * own, and is blind to the direction that completes the cycle.
 *
 * A new key is therefore safe to add exactly when it never creates the INBOUND
 * edge: nothing acquires it from inside a projection transaction. That is what
 * this scanner asserts, and it is the assertion that has to hold before any new
 * advisory key is introduced.
 *
 * WHY A SCANNER AND NOT A COMMENT. The hazard is created by an EDIT — routing an
 * existing path "through the projection transaction for uniformity", or taking a
 * convenient lock inside a projector. A comment cannot notice that edit; a
 * statement-stream scan driven by real work can.
 */

export interface LockEdgeCall {
  sql: string
  params?: readonly unknown[]
}

export const PROJECTION_KEY_PREFIX = 'read-model-projection:'

/** An acquisition, in either scope. Deliberately includes the TRY form: the
 *  projector's session-lock sites all use `pg_try_advisory_lock`, and a detector
 *  matching only the blocking spelling would track an empty stack for ever and
 *  report zero violations because it stopped looking. */
function acquiredKey(call: LockEdgeCall): { key: string; scope: 'session' | 'xact' } | null {
  const text = String(call.sql)
  const key = String((call.params ?? [])[0] ?? '')
  // Checked before the bare form: `pg_advisory_xact_lock(` contains neither
  // `pg_advisory_lock(` nor `pg_try_advisory_lock(` as a substring, but relying
  // on that silently is how the next spelling gets mis-bucketed.
  if (text.includes('pg_advisory_xact_lock(') || text.includes('pg_try_advisory_xact_lock(')) {
    return { key, scope: 'xact' }
  }
  if (text.includes('pg_advisory_lock(') || text.includes('pg_try_advisory_lock(')) {
    return { key, scope: 'session' }
  }
  return null
}

function releasedKey(call: LockEdgeCall): string | null {
  const text = String(call.sql)
  if (!text.includes('pg_advisory_unlock(')) return null
  return String((call.params ?? [])[0] ?? '')
}

function endsTransaction(call: LockEdgeCall): boolean {
  return /^\s*(COMMIT|ROLLBACK)\b/i.test(String(call.sql))
}

/**
 * Every acquisition made while a projection mutex is held.
 *
 * The projection mutex is an XACT lock, so it is held from the statement that
 * takes it until the transaction ends — which is why `COMMIT`/`ROLLBACK` clears
 * it rather than an unlock call. Getting that wrong in the permissive direction
 * would make this gate silently stop looking after the first transaction.
 */
export function projectionInboundEdges(calls: readonly LockEdgeCall[]): string[] {
  const violations: string[] = []
  const heldProjectionKeys: string[] = []
  const heldSessionKeys: string[] = []

  for (const call of calls) {
    if (endsTransaction(call)) {
      heldProjectionKeys.length = 0
      continue
    }

    const released = releasedKey(call)
    if (released !== null) {
      const at = heldSessionKeys.lastIndexOf(released)
      if (at >= 0) heldSessionKeys.splice(at, 1)
      continue
    }

    const acquired = acquiredKey(call)
    if (acquired === null) continue

    if (acquired.key.startsWith(PROJECTION_KEY_PREFIX)) {
      // Taking the projection mutex is not an inbound edge INTO it. Whether
      // that acquisition is itself safe is gate A8's question, and keeping the
      // two apart is the point of this rewrite: one gate, one direction.
      if (acquired.scope === 'xact') heldProjectionKeys.push(acquired.key)
      continue
    }

    if (acquired.scope === 'session') heldSessionKeys.push(acquired.key)

    if (heldProjectionKeys.length > 0) {
      violations.push(
        `${acquired.key} acquired while holding ${heldProjectionKeys.join(', ')} — `
        + 'this is the INBOUND edge into the projection mutex; combined with any path that holds this '
        + 'key and then waits for the mutex, it is a cycle',
      )
    }
  }

  return violations
}

/**
 * GATE A8 — the ONE global lock order in this subsystem, made executable.
 * (Moved here from `overlayChainFoldPass.test.ts` so that every overlay-rotation
 * holder's test can run it: the static plane's rotation and fold there, the
 * ordinary rotator in `ordinaryHeadRotator.integration.test.ts`.)
 *
 * `read-model-projection:` before `overlay-rotation:`, always. It holds only
 * because nothing that takes an `overlay-rotation` lock ever asks for the
 * projection mutex: rotation, fold, admitted-rotation recovery and the
 * ordinary rotator hold `overlay-rotation` at SESSION scope on their own
 * client and run their transactions with a bare `BEGIN`, deliberately NOT
 * through `withReadModelProjectionTransaction`. Route any of them through it
 * "for uniformity" and the order inverts against `publish()`, which holds the
 * mutex and then takes `overlay-rotation` as an XACT lock inside
 * `synchronizeOverlaySegments` — a real 40P01, on one workspace, needing no
 * fan-out.
 *
 * A comment cannot notice that edit, which is the whole reason this scanner
 * exists rather than a paragraph. The hazard shape is produced for free by
 * `publishAdmittedRotation`, which COMMITS its transaction and then calls
 * `metaHandle.change` while the session lock is still held — firing the
 * ModelMeta listener, whose publish is the transaction that wants the mutex.
 *
 * Process-wide on purpose, not per-connection. The dangerous cycle here is
 * partly in JavaScript — one path holds a session lock and then waits for a
 * pool slot held by a path waiting on that lock — and Postgres cannot see that
 * one at all: only one side is waiting in the lock manager, so there is no
 * cycle to detect and no 40P01 to catch it. A caller whose stream mixes
 * INDEPENDENT paths (a real projector over a real pool) must therefore hand it
 * the statements of ONE path — every statement issued while that path's call
 * is on the stack — not one connection's.
 */
export function projectionLockOrderViolations(
  calls: readonly (readonly [string, (readonly unknown[])?])[],
): string[] {
  const held: string[] = []
  const violations: string[] = []
  for (const [sql, params] of calls) {
    const text = String(sql)
    const key = String((params ?? [])[0] ?? '')
    // `pg_advisory_lock(` cannot match `pg_advisory_xact_lock(` — the xact form
    // spells `advisory_xact_lock` — so these three branches are disjoint. The
    // TRY form is spelled `pg_try_advisory_lock(` and does not match the bare
    // one either, which is why it is named explicitly: the projector's three
    // session-lock sites all use it, and matching only the blocking form
    // would leave this detector tracking an empty `held` stack for ever —
    // reporting zero violations because it stopped looking, not because there
    // are none.
    if (text.includes('pg_advisory_lock(') || text.includes('pg_try_advisory_lock(')) held.push(key)
    else if (text.includes('pg_advisory_unlock(')) {
      const at = held.lastIndexOf(key)
      if (at >= 0) held.splice(at, 1)
    } else if (text.includes('pg_advisory_xact_lock(') && key.startsWith('read-model-projection:')) {
      if (held.length > 0) violations.push(`${key} taken while holding ${held.join(', ')}`)
    }
  }
  return violations
}

/** `LIFECYCLE_LOCK_CLASS` (`maintenance/lifecycleApplyLock.ts`), restated as
 * a WIRE value — it must never change there either — so this scanner does
 * not import the maintenance layer. Pinned equal by `lockEdgeScan.test.ts`. */
export const LIFECYCLE_LOCK_CLASS_ON_THE_WIRE = 0x5359

const isLifecycle = (call: LockEdgeCall) => Number((call.params ?? [])[0]) === LIFECYCLE_LOCK_CLASS_ON_THE_WIRE
  && /pg_(try_)?advisory_(xact_)?(un)?lock\(\s*\$1\s*,\s*\$2\s*\)/.test(String(call.sql))
const isRotationKey = (key: string) => key.startsWith('overlay-rotation:')

export interface LifecycleRotationEdge {
  /** `rotation→lifecycle`: holds an `overlay-rotation:` key, then asks for
   * the lifecycle lock (the compaction pass's epoch step). `lifecycle→rotation`:
   * the opposite (a promotion or demotion whose publish takes the rotation key). */
  direction: 'rotation→lifecycle' | 'lifecycle→rotation'
  form: 'try' | 'blocking'
}

/**
 * GATE G4-16f — the `overlay-rotation:` ↔ LIFECYCLE
 * edge. The compaction pass holds both rotation keys (session) and the epoch
 * step then asks for the lifecycle lock; a promotion or demotion holds the
 * lifecycle lock and its static publish takes the rotation key
 * (`promoteSummaryWorkspace.ts`, the `overlay-rotation:` acquisition its
 * `lock_timeout` ceiling bounds). Opposite orders. That is a CYCLE only if
 * BOTH sides wait; the rule this gate makes executable: the
 * `rotation→lifecycle` side is a TRY, always — the step answers
 * `lifecycle_lock_contended` and the fold stands; the door's wait is bounded
 * by its own ceiling. Mutual refusal, never a deadlock.
 *
 * Returns every edge seen, and a violation for a BLOCKING `rotation→lifecycle`
 * acquisition.
 */
export function lifecycleRotationEdges(calls: readonly LockEdgeCall[]): { edges: LifecycleRotationEdge[]; violations: string[] } {
  const edges: LifecycleRotationEdge[] = []
  const violations: string[] = []
  const rotationSession: string[] = []
  const rotationXact: string[] = []
  let lifecycleHeld = 0
  for (const call of calls) {
    const text = String(call.sql)
    if (endsTransaction(call)) { rotationXact.length = 0; continue }
    if (isLifecycle(call)) {
      if (text.includes('pg_advisory_unlock(')) { lifecycleHeld = Math.max(0, lifecycleHeld - 1); continue }
      const form = text.includes('pg_try_advisory') ? 'try' : 'blocking'
      if (rotationSession.length + rotationXact.length > 0) {
        edges.push({ direction: 'rotation→lifecycle', form })
        if (form === 'blocking') {
          violations.push(`the lifecycle lock WAITED for while holding ${[...rotationSession, ...rotationXact].join(', ')} — `
            + 'a promotion holds it and waits for the rotation key: a cycle. This side must be a try-lock')
        }
      }
      lifecycleHeld += 1
      continue
    }
    const released = releasedKey(call)
    if (released !== null) {
      const at = rotationSession.lastIndexOf(released)
      if (at >= 0) rotationSession.splice(at, 1)
      continue
    }
    const acquired = acquiredKey(call)
    if (acquired === null || !isRotationKey(acquired.key)) continue
    if (lifecycleHeld > 0) {
      edges.push({ direction: 'lifecycle→rotation', form: text.includes('pg_try_advisory') ? 'try' : 'blocking' })
    }
    ;(acquired.scope === 'session' ? rotationSession : rotationXact).push(acquired.key)
  }
  return { edges, violations }
}

const isModelEpochKey = (key: string) => key.startsWith('model-epoch:')

export interface ModelEpochRotationEdge {
  /** `rotation→model-epoch`: holds an `overlay-rotation:` key, then asks for
   * the `model-epoch:` key — the compaction pass's epoch step and forwarder,
   * and the epoch SWEEP's forwarder. `model-epoch→rotation`:
   * the opposite order, which nothing may take. */
  direction: 'rotation→model-epoch' | 'model-epoch→rotation'
  form: 'try' | 'blocking'
}

/**
 * GATE G4-16f — the `overlay-rotation:` ↔ `model-epoch:`
 * edge, REGISTERED. Compaction holds both rotation keys and then its epoch
 * step and its forwarder take the `model-epoch:` key; the epoch sweep now does
 * the same, in the same order (object, connection, model-epoch), so the fold
 * writer and compaction — which check for an open forward journal ONCE and
 * then fold or clear — never run beside a sweep's forwarder. One direction
 * only, and a try on both sides: no cycle, mutual refusal at worst.
 *
 * Returns every edge seen, and a violation for a `model-epoch→rotation`
 * acquisition (the inverted order) or a BLOCKING one in either direction.
 */
export function modelEpochRotationEdges(calls: readonly LockEdgeCall[]): { edges: ModelEpochRotationEdge[]; violations: string[] } {
  const edges: ModelEpochRotationEdge[] = []
  const violations: string[] = []
  const rotation: string[] = []
  const epoch: string[] = []
  for (const call of calls) {
    const released = releasedKey(call)
    if (released !== null) {
      for (const held of [rotation, epoch]) {
        const at = held.lastIndexOf(released)
        if (at >= 0) held.splice(at, 1)
      }
      continue
    }
    const acquired = acquiredKey(call)
    if (acquired === null || acquired.scope !== 'session') continue
    const form = String(call.sql).includes('pg_try_advisory') ? 'try' : 'blocking'
    if (isModelEpochKey(acquired.key)) {
      if (rotation.length > 0) {
        edges.push({ direction: 'rotation→model-epoch', form })
        if (form === 'blocking') violations.push(`${acquired.key} WAITED for while holding ${rotation.join(', ')}: this side must be a try-lock`)
      }
      epoch.push(acquired.key)
    } else if (isRotationKey(acquired.key)) {
      if (epoch.length > 0) {
        edges.push({ direction: 'model-epoch→rotation', form })
        violations.push(`${acquired.key} taken while holding ${epoch.join(', ')}: the order is overlay-rotation THEN model-epoch, never the reverse`)
      }
      rotation.push(acquired.key)
    }
  }
  return { edges, violations }
}

/**
 * The keys this subsystem is allowed to acquire at all, for the gate that checks
 * a NEW one was thought about.
 *
 * Not an ordering — a REGISTRY. D8 adds `maintenance-workspace:`; anything else
 * appearing in a statement stream is a key nobody has reasoned about, and the
 * reasoning is what this whole gate exists to force.
 *
 * G4-16f adds `model-epoch:` (`modelEpochRoll.ts`, the epoch roll and its
 * forwarder). The reasoning, as this gate asks: it is a SESSION try-lock taken
 * on its own client, never from inside a projection transaction (no inbound
 * edge), and the row transactions run under it assert the write fence on the
 * pass's own client instead of taking the projection mutex (no A8 edge) —
 * pinned by `modelEpochRoll.test.ts`, "the lock-order scanners". Its one edge
 * with another key — taken under both `overlay-rotation:` keys, never the
 * reverse — is {@link modelEpochRotationEdges}'s, pinned on the real sweep by
 * `modelEpochForwarder.integration.test.ts`.
 */
export const KNOWN_ADVISORY_KEY_PREFIXES = [
  PROJECTION_KEY_PREFIX,
  'overlay-rotation:',
  'maintenance-workspace:',
  'model-epoch:',
] as const

export function unknownAdvisoryKeys(calls: readonly LockEdgeCall[]): string[] {
  const unknown = new Set<string>()
  for (const call of calls) {
    const acquired = acquiredKey(call)
    if (acquired === null) continue
    // A numeric key is one of the legacy namespaced locks (the maintenance
    // coordinator's per-job key, the sync-cell fences); those are not
    // `hashtextextended` string keys and are outside this registry.
    if (acquired.key === '' || /^\d+$/.test(acquired.key)) continue
    if (KNOWN_ADVISORY_KEY_PREFIXES.some((prefix) => acquired.key.startsWith(prefix))) continue
    unknown.add(acquired.key)
  }
  return [...unknown]
}
