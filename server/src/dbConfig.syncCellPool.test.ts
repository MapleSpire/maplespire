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
import { syncCellDatabasePoolConfig } from './dbConfig.js'

// QA (2026-10-11): the sync-cell pool default moved 4 -> 5 so the LISTEN
// checkout every hash-mode coordinator now pins (workspace_version_created)
// does not come out of the 4 working connections M2/TB4q measured. Reverting
// the default left every server unit test green.
describe('syncCellDatabasePoolConfig', () => {
  /** The working set the pool was measured with (dbConfig.ts comment). */
  const MEASURED_WORKING_CONNECTIONS = 4
  /** One LISTEN checkout pinned for the coordinator's whole life. */
  const PINNED_LISTEN_CHECKOUTS = 1

  it('defaults to the measured working set PLUS the pinned LISTEN checkout', () => {
    expect(syncCellDatabasePoolConfig({ DATABASE_URL: 'postgres://cell/db' }).max)
      .toBe(MEASURED_WORKING_CONNECTIONS + PINNED_LISTEN_CHECKOUTS)
  })

  it('an explicit SYNC_CELL_DB_POOL_MAX still wins', () => {
    expect(syncCellDatabasePoolConfig({ DATABASE_URL: 'postgres://cell/db', SYNC_CELL_DB_POOL_MAX: '9' }).max).toBe(9)
  })
})
