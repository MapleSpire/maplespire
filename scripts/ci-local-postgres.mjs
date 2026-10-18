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
 * Durability knobs the `ci:local` Postgres container does not need.
 *
 * Every `DROP DATABASE` forces an immediate checkpoint and waits for it, and
 * the DB-gated suites (`createTemporaryRestoreDatabase` and friends) create and
 * drop databases in their `beforeAll`/`afterAll`, eight workers at a time, on
 * ONE cluster. Measured 2026-10-18 on this machine's Docker Desktop storage,
 * five create + five drop per process (the restore-command suite's teardown):
 *
 *               alone      8 processes at once (first DROP)
 *   default     785 ms      ~10 800 ms
 *   fsync=off    17 ms          ~45 ms   (whole teardown ~0.1 s vs ~11 s)
 *
 * Whole DB-gated set (`src/backup src/syncCells src/readModel`, 178 files, 2536
 * tests, 8 workers), same machine, with a neighbour container running an
 * fsync-heavy `pgbench` on the same disk to stand in for other sessions:
 *
 *   default, quiet disk      106 s
 *   default, loaded disk     165 s   (tests: 1020 s cumulative)
 *   fsync=off, loaded disk    50 s   (tests:  306 s cumulative)
 *
 * What triggered this was one `ci:local` run in which `restoreDatabaseCommand`,
 * `backupRestore`, `restoreRoutingReset` and `placementProposer` hit 30-180 s
 * HOOK timeouts while other sessions were loading the machine, and each passed
 * alone in ~17 s. The timeouts themselves did not reproduce on demand (the
 * loaded run above was slow but green); what is measured is that disk contention
 * costs these suites 56% and that the syncs are the cost.
 *
 * The container holds throwaway test data that is re-created at the start of
 * every run, so crash safety buys nothing here. None of these three settings
 * changes what a query returns or what a test can observe; they change only how
 * long Postgres waits on the disk. All three are `sighup` settings, so a
 * RUNNING container (ci-local reuses one) picks them up with a reload and no
 * restart — which is why this is applied on every run rather than baked into
 * `docker run`, where an existing container would never see it.
 *
 * GitHub's runner uses a service container and is not touched: it passed the
 * same suites with the default settings (run 39087812014), on faster storage.
 */
export const TEST_POSTGRES_SETTINGS = Object.freeze({
  fsync: 'off',
  synchronous_commit: 'off',
  full_page_writes: 'off',
})

/** The statements that apply them, in order; the reload comes last. */
export function testPostgresStatements() {
  return [
    ...Object.entries(TEST_POSTGRES_SETTINGS).map(([name, value]) => `ALTER SYSTEM SET ${name} = '${value}'`),
    'SELECT pg_reload_conf()',
  ]
}

/**
 * @param {(sql: string) => void} execSql runs ONE statement against the cluster
 *   and throws if it fails — a swallowed failure would leave the run on the
 *   slow default while claiming otherwise.
 */
export function tunePostgresForTests(execSql) {
  for (const statement of testPostgresStatements()) execSql(statement)
}
