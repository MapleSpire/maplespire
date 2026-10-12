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

import { ColdBuildAdmissionStoppedError, ColdBuildQueueFullError } from './coldBuildAdmission.js'
import { ProjectorOwnershipError, ProjectorStaticWorkspaceError } from './projectorService.js'
import type { WorkspaceKey } from './projector.js'

/**
 * WHY a workspace is not resident, so the 503 can say which — and how OLD that
 * answer is.
 *
 * A workspace can fail to be resident for six distinguishable reasons:
 *
 *  1. a cold build is genuinely in flight;
 *  2. `ensure()` RESOLVED FALSE — the workspace has no resolvable root;
 *  3. `ProjectorOwnershipError`;
 *  4. `ProjectorStaticWorkspaceError`;
 *  5. `ColdBuildQueueFullError`;
 *  6. `ColdBuildAdmissionStoppedError`.
 *
 * Cases 3-6 are deliberately not logged with a stack (that would be one warning
 * per browser retry during a recovery burst), so without this module a consumer
 * polling the 503 — such as the backup drill's cold-API stage — could only
 * report a failure naming no cause.
 *
 * Three properties this module holds:
 *
 * - **The reason vocabulary is DERIVED, never retyped.** The four classes carry
 *   a `code`; `ReadModelWarmupReason` unions `ClassName['code']` rather than
 *   hand-written literals, so renaming a class's code is a compile error rather
 *   than a silent disagreement. (`readonly code = '…'` infers the literal type.)
 * - **`retryable` is per REASON, and it is about the REQUEST.** The classes'
 *   own `retryable` answers a different question ("is retrying this `ensure`
 *   worth it"), and the two diverge: `ProjectorStaticWorkspaceError.retryable`
 *   is false, yet retrying the REQUEST very likely succeeds because
 *   `staticReadModelQueryWorkspaceIfPresent` short-circuits before `ensure()` is
 *   ever called. Only `workspace_root_unresolved` is unambiguously permanent, so
 *   it is the only one that answers `retryable: false` — and the caller must
 *   then omit `Retry-After`, because 503 + `Retry-After` is a promise to
 *   intermediaries as well as to clients.
 * - **A verdict carries its AGE.** Nothing marks "a new attempt is in flight",
 *   so between a failed `ensure()` and the next success the stored reason is a
 *   fact about the PAST. E.g. a queue-full refusal followed by a real cold build
 *   (26-35 s on a first build) would make every 503 in that window blame
 *   admission backpressure for a workspace that is building normally. Carry
 *   the age beside the verdict.
 *
 * An entry is recorded on the event that establishes it and dropped on the event
 * that OBSOLETES it (a successful ensure), NEVER on a read: a poller at 1 Hz
 * would otherwise get the cause once and `cold_build_in_flight` on every later
 * poll. `verdictFor` is therefore non-destructive.
 */
export type ReadModelWarmupReason =
  | ProjectorOwnershipError['code']
  | ProjectorStaticWorkspaceError['code']
  | ColdBuildQueueFullError['code']
  | ColdBuildAdmissionStoppedError['code']
  /** A cold build is in flight, or none has reported back yet. */
  | 'cold_build_in_flight'
  /** `ensure()` resolved false: no root URL for this workspace. */
  | 'workspace_root_unresolved'
  /** Anything else the cold build threw — the one case still worth a stack. */
  | 'cold_build_failed'

/**
 * The ONLY reason a retry can never clear.
 *
 * A Set rather than a boolean on each arm so the default is retryable: a new
 * reason added without thinking lands on the side that keeps the client trying,
 * which is the safe direction — the opposite default would silently tell a
 * client to give up on a transient condition.
 */
const NON_RETRYABLE_REASONS: ReadonlySet<ReadModelWarmupReason> = new Set<ReadModelWarmupReason>([
  'workspace_root_unresolved',
])

export function isWarmupReasonRetryable(reason: ReadModelWarmupReason): boolean {
  return !NON_RETRYABLE_REASONS.has(reason)
}

/** What the 503 body carries. Composed here, not at the route, so there is one
 * place that knows the contract — `syncCells/repoMaintenance.ts` is the shape
 * this matches (closed union, snake_case, `retryable` derived per reason). */
export type ReadModelWarmupVerdict = {
  reason: ReadModelWarmupReason
  retryable: boolean
  /** How long ago the reason was established. 0 for the in-flight default,
   * which is a statement about now rather than a stored verdict. */
  reasonAgeMs: number
}

export type WarmupFailureClass = {
  reason: ReadModelWarmupReason
  /** Is this one of the outcomes the call site deliberately does not log a
   * stack for? `false` means nobody has ever seen this error before. */
  expected: boolean
}

/**
 * Classify by CLASS, never by a duck-typed `code`.
 *
 * Every one of the four carries `code`, so reading it off an arbitrary error
 * would be shorter — and a `pg` error carrying its own `code` would then be
 * reported as expected backpressure. The predicate has to be one a foreign
 * error cannot satisfy. The code is read off the NARROWED instance, so the
 * literal is never retyped here either.
 *
 * KNOWN LIMITATION: a fifth expected refusal added to `ProjectorFleet.ensure()`
 * lands in the fallback below as `{expected: false}`, which restores one
 * `console.error` per request. Making that a compile error would need a shared
 * abstract base on the four classes. `isExpectedRefusal` (wired in `index.ts`)
 * derives from this function so the list exists once.
 */
export function classifyWarmupFailure(error: unknown): WarmupFailureClass {
  if (error instanceof ProjectorOwnershipError) return { reason: error.code, expected: true }
  if (error instanceof ProjectorStaticWorkspaceError) return { reason: error.code, expected: true }
  if (error instanceof ColdBuildQueueFullError) return { reason: error.code, expected: true }
  if (error instanceof ColdBuildAdmissionStoppedError) return { reason: error.code, expected: true }
  return { reason: 'cold_build_failed', expected: false }
}

export type WarmupOutcomeLog = {
  /** Record the result of an `ensure()` that RESOLVED. `started === false` is
   * the no-root case; `true` clears the entry, because the workspace is now
   * resident and any recorded reason is obsolete. */
  noteSettled: (key: WorkspaceKey, started: boolean) => void
  /** Record the result of an `ensure()` that REJECTED, and say whether the
   * caller should log a stack for it. */
  noteFailed: (key: WorkspaceKey, error: unknown) => WarmupFailureClass
  /** The full 503 body fields, including the in-flight default. NON-DESTRUCTIVE:
   * calling it twice must answer the same thing. */
  verdictFor: (key: WorkspaceKey) => ReadModelWarmupVerdict
  /** Entries currently held — for the bound's own test. */
  size: () => number
  /** Log lines withheld by the flood bound, so a test can prove the bound bites
   * and an operator can see that it did. */
  suppressedLogCount: () => number
}

const DEFAULT_MAX_ENTRIES = 256

/**
 * How many DISTINCT keys may log `workspace_root_unresolved` before the rest
 * are counted silently.
 *
 * It exists because that reason — alone among the seven — is reachable with a
 * key nobody has validated. `canonicalWorkspaceKey` returns its argument
 * unchanged unless `versionId === 'current'` (`rbac/workspaceGate.ts`), and
 * with `AUTH` off (the shipped default) `checkWorkspaceAccess` returns true, so
 * an arbitrary `?landscapeId=x&versionId=<anything>` reaches `ensure()`, gets
 * `resolveRootUrl` -> null, and lands here. The key set is therefore NOT
 * bounded by real workspaces.
 *
 * RESIDUAL: the entry map is bounded, so a
 * flood of novel keys can still evict a real workspace's entry between two
 * drill polls, degrading that poll's answer to `cold_build_in_flight`. The
 * recency refresh in `record` keeps a workspace that is being polled alive
 * through a flood; a flood in the gap is not covered, and the failure is a
 * less specific answer rather than a wrong one.
 */
const DEFAULT_MAX_LOGGED_UNRESOLVED = 32

/** The SAME shape `ProjectorFleet` keys its residency map with
 * (`projectorService.ts`): two maps about one workspace that disagree on what
 * identifies it is a defect nothing can see. */
function keyOf(key: WorkspaceKey): string {
  return `${key.landscapeId}/${key.versionId}`
}

type Entry = { reason: ReadModelWarmupReason; at: number }

export function createWarmupOutcomeLog(options: {
  /** Called ONCE per (workspace, reason) transition, never per request: the
   * drill polls this path ~118 times in one stage and a browser recovery burst
   * is worse. */
  log?: (line: string) => void
  now?: () => number
  maxEntries?: number
  maxLoggedUnresolved?: number
} = {}): WarmupOutcomeLog {
  const log = options.log ?? ((line: string) => console.log(line))
  const now = options.now ?? Date.now
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const maxLoggedUnresolved = Math.max(0, options.maxLoggedUnresolved ?? DEFAULT_MAX_LOGGED_UNRESOLVED)
  // A `Map` preserves insertion order, so the oldest entry is the first key out.
  const entries = new Map<string, Entry>()
  let loggedUnresolved = 0
  let suppressed = 0

  const shouldLog = (reason: ReadModelWarmupReason): boolean => {
    if (reason !== 'workspace_root_unresolved') return true
    if (loggedUnresolved < maxLoggedUnresolved) {
      loggedUnresolved += 1
      return true
    }
    suppressed += 1
    return false
  }

  const record = (key: WorkspaceKey, reason: ReadModelWarmupReason): void => {
    const k = keyOf(key)
    const previous = entries.get(k)
    // Refresh recency on EVERY touch, including an unchanged reason. Without
    // this, a stable correctly-recorded workspace drifts to the head of the map
    // and is the FIRST thing a flood of novel keys evicts — which silently
    // disarms the detector this module exists to be.
    entries.delete(k)
    entries.set(k, { reason, at: now() })
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    if (previous?.reason === reason) return
    if (!shouldLog(reason)) {
      if (suppressed === 1) {
        log(
          `[read-model] further ${reason} lines are suppressed after ${maxLoggedUnresolved} distinct workspaces`
          + ' (an unvalidated workspace id reaches this path)',
        )
      }
      return
    }
    log(
      `[read-model] ${keyOf(key)} is not resident: ${reason}`
      + (previous ? ` (was ${previous.reason})` : ''),
    )
  }

  return {
    noteSettled(key, started) {
      if (started) {
        // The obsoleting event, not a read. See the header.
        entries.delete(keyOf(key))
        return
      }
      record(key, 'workspace_root_unresolved')
    },
    noteFailed(key, error) {
      const classified = classifyWarmupFailure(error)
      record(key, classified.reason)
      return classified
    },
    verdictFor(key) {
      const entry = entries.get(keyOf(key))
      if (!entry) {
        return { reason: 'cold_build_in_flight', retryable: true, reasonAgeMs: 0 }
      }
      return {
        reason: entry.reason,
        retryable: isWarmupReasonRetryable(entry.reason),
        reasonAgeMs: Math.max(0, now() - entry.at),
      }
    },
    size() {
      return entries.size
    },
    suppressedLogCount() {
      return suppressed
    },
  }
}
