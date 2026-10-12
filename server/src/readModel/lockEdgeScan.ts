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
 * before `overlay-rotation:`", and `projectionLockOrderViolations` (gate A8, in
 * `overlayChainFoldPass.test.ts`) encodes it as: never take the projection xact
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
 * The keys this subsystem is allowed to acquire at all, for the gate that checks
 * a NEW one was thought about.
 *
 * Not an ordering — a REGISTRY. D8 adds `maintenance-workspace:`; anything else
 * appearing in a statement stream is a key nobody has reasoned about, and the
 * reasoning is what this whole gate exists to force.
 */
export const KNOWN_ADVISORY_KEY_PREFIXES = [
  PROJECTION_KEY_PREFIX,
  'overlay-rotation:',
  'maintenance-workspace:',
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
