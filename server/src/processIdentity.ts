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

// Process identity, so an instrument can tell a restart from a run.
//
// Every counter on `/api/platform/automerge-residency` is CUMULATIVE, and gates
// that read them grade a DELTA across a window, which assumes one process spans
// the window. A restart resets the counters, so `after - before` can go
// negative or — if the fresh process evicts anything before the second probe —
// come out POSITIVE and read as a valid pass. Comparing boot ids detects this.
//
// Deliberately NOT derived from `process.uptime()` or `generatedAt`: an
// equality check between two opaque strings cannot be misinterpreted.

import { randomUUID } from 'node:crypto'

/** Minted ONCE, at module load, and never again for the life of the process.
 * Module scope (rather than a lazy mint) simply has no branch to get wrong. */
const BOOT_ID = randomUUID()

/** An opaque identity for THIS process, stable for its whole life.
 *
 * Two snapshots carrying the same value were produced by one process, so the
 * cumulative counters between them describe one interval. Two snapshots
 * carrying different values describe two processes and cannot be subtracted.
 *
 * It is a random UUID rather than the pid: pids are recycled by the OS, and a
 * supervisor that restarts a crashed server into the same pid — common in
 * containers, where the entrypoint is pid 1 — would publish an identity that
 * says "same process" about a restart.
 */
export function currentProcessBootId(): string {
  return BOOT_ID
}
