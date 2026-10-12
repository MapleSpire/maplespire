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

import { describe, expect, it } from 'vitest'
import { NativePgTools, pgDumpArgs } from './backupRestore.js'

/**
 * The dump is NEVER filtered, and this is the thing that says so.
 *
 * WHAT IT IS DEFENDING AGAINST. A restored `sync_workspace_ownership` can wedge
 * a live cell: every mapped write refused with `fence-mismatch`, and no
 * reconcile pass repairs it. The cheapest-looking remedy is one flag —
 * `--exclude-table=sync_workspace_ownership` — and the wedge is gone.
 *
 * It is not a remedy: it makes a backup quietly incomplete, verified green by
 * a manifest that no longer knows the table exists, and discovered on the day
 * somebody restores it. The fence's durable half is the floor `acquireMissing`
 * feeds to `ensureMinimumToken`; a recovery without it re-issues tokens from
 * zero. The real remedies are `restore:reset-routing` (which RELEASES and keeps
 * the numbers) and the runbook's "stop the cells first" — both cost more than a
 * flag, which is exactly why this gate exists.
 *
 * It asserts against `pgDumpArgs`, the single builder both transports call,
 * rather than against the source text of two call sites. Text-pinning a
 * command line is a false-red generator for the next person with a legitimate
 * reason to touch it; asserting the built argv is not.
 */

/** Any flag that would narrow what `pg_dump` writes. `--exclude-table-data`
 * matters as much as `--exclude-table`: it keeps the schema, so a manifest
 * comparing table PRESENCE would still pass while every row was gone. */
const FILTERS = ['--table', '-t', '--exclude-table', '-T', '--exclude-table-data', '--schema', '--exclude-schema']

const filtersIn = (args: readonly string[]): string[] =>
  args.filter((arg) => FILTERS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))

const CONNECTION = {
  host: 'db.internal', port: 5432, user: 'maplespire', password: 'x', database: 'maplespire',
}

describe('the dump is never narrowed — R4 / B4-5', () => {
  it('the native transport passes no table or schema filter', () => {
    const args = pgDumpArgs({ snapshotId: 'snap-1', outputFile: '/tmp/out.dump' })
    expect(filtersIn(args)).toEqual([])
    // Non-vacuous: the builder really did produce a command line, so an empty
    // filter list is a fact about the flags and not about an empty array.
    expect(args).toContain('--format=custom')
    expect(args).toContain('--snapshot')
    expect(args).toContain('/tmp/out.dump')
  })

  it('the container transport passes no table or schema filter either', () => {
    // Two call sites, and only one of them was ever going to be edited by
    // someone reaching for a quick fix. Both build from here, so both are here.
    const args = pgDumpArgs({ snapshotId: 'snap-2', outputFile: '/tmp/remote.dump', connection: CONNECTION })
    expect(filtersIn(args)).toEqual([])
    expect(args).toContain('--dbname')
    expect(args).toContain('maplespire')
    expect(args).toContain('--format=custom')
  })

  it('the two transports differ ONLY in how they address the server', () => {
    // If they ever diverge in what they SELECT, the two assertions above would
    // still pass while the bundles stopped being the same backup.
    const native = pgDumpArgs({ snapshotId: 'snap-3', outputFile: '/tmp/o.dump' })
    const container = pgDumpArgs({ snapshotId: 'snap-3', outputFile: '/tmp/o.dump', connection: CONNECTION })
    const addressing = ['--host', 'db.internal', '--port', '5432', '--username', 'maplespire', '--dbname', 'maplespire']
    expect(container).toEqual([...addressing, ...native])
  })

  it('the NATIVE call site really passes the built argv — not just the builder', async () => {
    // The assertions above pin the BUILDER, but this call site is otherwise
    // executed by nothing: `ci:local` borrows the client binaries from the
    // Postgres container, so every real dump in the suite goes through
    // `DockerPgTools`. The call site is driven here through an injected runner
    // rather than assumed to use the builder.
    const recorded: Array<{ command: string; args: string[] }> = []
    const tools = new NativePgTools('pg_dump', 'pg_restore', 1_000, async (command, args) => {
      recorded.push({ command, args })
    })
    await tools.dump({ connection: CONNECTION, snapshotId: 'snap-4', outputFile: '/tmp/native.dump' })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.command).toBe('pg_dump')
    expect(filtersIn(recorded[0]!.args)).toEqual([])
    // …and it is the SAME argv the builder produces, so the gate above is not
    // asserting one thing while production runs another.
    expect(recorded[0]!.args).toEqual(pgDumpArgs({ snapshotId: 'snap-4', outputFile: '/tmp/native.dump' }))
  })

  it('the detector can actually fire', () => {
    // The positive control, inline. Every assertion above is `toEqual([])`, and
    // an empty result is what a predicate that matches nothing returns too —
    // so the predicate is shown finding each flag it claims to look for.
    expect(filtersIn([...pgDumpArgs({ snapshotId: 's', outputFile: '/tmp/o' }), '--exclude-table=sync_workspace_ownership']))
      .toEqual(['--exclude-table=sync_workspace_ownership'])
    // The predicate returns the ARGUMENT it matched, not the flag it matched
    // on — which is what an operator reading a failure needs to see.
    expect(filtersIn(['--exclude-table', 'sync_workspace_ownership'])).toEqual(['--exclude-table'])
    expect(filtersIn(['-T', 'sync_workspace_ownership'])).toEqual(['-T'])
    expect(filtersIn(['--exclude-table-data=sync_workspace_ownership']))
      .toEqual(['--exclude-table-data=sync_workspace_ownership'])
    expect(filtersIn(['--table=versions'])).toEqual(['--table=versions'])
    // …and is not so greedy that it flags the flags that are actually there.
    expect(filtersIn(['--format=custom', '--no-owner', '--snapshot', 'x'])).toEqual([])
  })
})
