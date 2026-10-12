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

import { hostname } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A claim on an unfinished bundle directory, written by whoever is filling it.
 *
 * ## Why this exists — the exclusion was on the SCHEDULER, never on the bundle
 *
 * The drill's mutual exclusion is a Postgres advisory lock on the scheduler,
 * which does not protect the RESOURCE: three parties write into the bundle root
 * holding no advisory lock at all — the one-shot CLI
 * (`scripts/backup-restore-drill.ts`), the boot sweep, and an abandoned run
 * that is still dumping after its key went back. Without this, the only thing
 * keeping a recursive delete off a live run would be TIME
 * (`ORPHAN_MINIMUM_AGE_MS` and the two clocks on `PartialBundle`). Time is a
 * proxy: a dump BLOCKED on a lock advances nothing, and hours later the sweep
 * would delete a directory whose writer is very much alive.
 *
 * This asks the direct question instead: does the writer still answer?
 *
 * ## Why a FILE and not the directory name
 *
 * The name has no hostname, and pid liveness across hosts is not a weak answer
 * but a CONFIDENT WRONG one in both directions: a local pid that happens to be
 * alive makes a remote corpse immortal, and a local pid that is dead makes a
 * remote live writer deletable. Adding a host to the name would change a format
 * that `retention.ts` parses back — the one thing `bundleName`'s own header
 * warns about, where "a format change made every age unreadable, every partial
 * immortal, and the sweep a no-op reporting success". A sidecar file is
 * additive: an older build's partial simply has none, and reads as `unknown`
 * (falling back to the age gate).
 */
export const BUNDLE_OWNER_FILE = '.owner.json'

export type BundleOwner = {
  /** `os.hostname()` of the writer. The gate on whether `pid` means anything. */
  readonly host: string
  /** The writing process. Same value as the one in the directory name. */
  readonly pid: number
  /** Wall clock at claim time, ms. A THIRD clock beside `PartialBundle`'s two,
   *  and the only one written by the party that actually owns the directory. */
  readonly startedAt: number
  /** What is writing: `drill` (scheduler tick) or `cli` (one-shot). Recorded so
   *  a report can say which party is holding, not merely that someone is. */
  readonly kind: string
}

/**
 * The liveness of a claim, THREE-valued on purpose.
 *
 * `unknown` is not a weaker `dead`: "the writer is on another host, so its pid
 * means nothing to me" and "no process answers to that pid" are different
 * facts — one must keep the directory, the other may release it.
 */
export type BundleOwnerLiveness = 'live' | 'dead' | 'unknown'

/** Claim a partial directory. Best-effort: a failure to write the claim must
 *  never fail the backup; without it the sweep falls back to the age gate. */
export async function writeBundleOwner(
  directory: string,
  kind: string,
  now: number = Date.now(),
): Promise<BundleOwner | null> {
  const owner: BundleOwner = { host: hostname(), pid: process.pid, startedAt: now, kind }
  try {
    await writeFile(join(directory, BUNDLE_OWNER_FILE), JSON.stringify(owner), 'utf8')
    return owner
  } catch {
    return null
  }
}

/** Read a claim. `null` for absent, unreadable, or malformed — all of which the
 *  caller must treat as `unknown`, never as unowned. */
export async function readBundleOwner(directory: string): Promise<BundleOwner | null> {
  let raw: string
  try {
    raw = await readFile(join(directory, BUNDLE_OWNER_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BundleOwner>
    if (typeof parsed.host !== 'string' || parsed.host === '') return null
    // `Number.isInteger` rather than `typeof number`: NaN and Infinity are both
    // numbers and neither is a pid, and `process.kill(NaN, 0)` throws a TypeError
    // rather than the ESRCH this module reasons about.
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) return null
    if (!Number.isFinite(parsed.startedAt)) return null
    return {
      host: parsed.host,
      pid: parsed.pid as number,
      startedAt: parsed.startedAt as number,
      kind: typeof parsed.kind === 'string' ? parsed.kind : 'unknown',
    }
  } catch {
    return null
  }
}

/**
 * Does this claim still answer?
 *
 * `signal 0` performs the permission and existence checks and delivers nothing.
 * The three outcomes and why none may be folded together:
 *
 *  - it returns → the process exists and is ours: **live**;
 *  - `EPERM` → the process EXISTS and belongs to another user: **live**. Reading
 *    this as dead is the expensive mistake available here — a drill running as
 *    a different uid in the same container namespace would have its directory
 *    deleted mid-dump;
 *  - `ESRCH` → nothing answers: **dead**.
 *
 * A claim from another host is `unknown` WITHOUT asking, because asking would
 * consult this host's pid table about a pid that does not live in it and return
 * a confident answer to a question nobody asked.
 *
 * ## The residuals, named rather than left to be found
 *
 * **PID REUSE, for a pid that is not ours.** Handled where it is decidable and
 * not elsewhere: the `owner.pid === self.pid` branch above closes the case that
 * matters in production, and for any other pid nothing portable in Node exposes
 * a start time. A recycled foreign pid therefore reads `live` for a writer that
 * is long gone. That is the KEEP side, which `pruneBackupBundles` chooses
 * everywhere by design, but it is not free — an immortal partial fills the
 * volume, so the backups themselves become the failure. So a held
 * partial is counted, its bytes feed `overBudget`, and its host/pid/kind reach
 * the drill summary where an operator can see the same one held night after
 * night.
 *
 * **The claim names the ORCHESTRATOR, not the process writing bytes.**
 * `NativePgTools.dump` spawns `pg_dump` as a CHILD of node, and a child is not
 * killed when node exits — so for the one-shot CLI and any non-container
 * deployment, an abandoned run's claim reads `dead` while an orphaned `pg_dump`
 * is still filling the directory (measured: orchestrator gone, writer alive,
 * dump still growing).
 *
 * This is a COVERAGE GAP, not a regression: `dead` falls through to the age
 * gate. Closing it properly means locking on an identity that survives the
 * supervisor: an `flock` taken on a descriptor INHERITED by the dump child is
 * released by the kernel only when the last holder of the open file description
 * exits, so it expires exactly when the writing stops (what pgBackRest and
 * barman do).
 */
export function bundleOwnerLiveness(
  owner: BundleOwner | null,
  host: string = hostname(),
  probe: (pid: number) => void = (pid) => { process.kill(pid, 0) },
  self: { pid: number; startedAt: number } = {
    pid: process.pid,
    startedAt: Date.now() - process.uptime() * 1000,
  },
): BundleOwnerLiveness {
  if (!owner) return 'unknown'
  if (owner.host !== host) return 'unknown'
  // A claim carrying OUR OWN pid that predates OUR OWN start was written by a
  // process that no longer exists, and the pid has since been handed to us.
  // Probing it would be this process signalling itself and answering `live`
  // about a corpse.
  //
  // Not a hypothetical: in the shipped deployment it is the 100 % case rather
  // than a rare wraparound. `docker-entrypoint-drill.sh` ends in `exec "$@"`,
  // so node is **pid 1** in the drill container; abandonment calls
  // `process.exit(1)` (`drillScheduler.ts`); `restart: always` restarts the
  // SAME container, giving the same `os.hostname()` and pid 1 again. Without
  // this check the sweep — the only thing that reclaims abandoned dumps — would
  // veto every one of them, forever.
  //
  // This is the one identity question with perfect information available: for
  // any OTHER pid, nothing portable in Node exposes a start time, so the probe
  // below is all there is.
  if (owner.pid === self.pid && owner.startedAt < self.startedAt) return 'dead'
  try {
    probe(owner.pid)
    return 'live'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return 'live'
    if (code === 'ESRCH') return 'dead'
    // Anything else — EINVAL from a bad signal, a TypeError from a pid that got
    // past validation — is a failure to ASK, not an answer. Never `dead`.
    return 'unknown'
  }
}
