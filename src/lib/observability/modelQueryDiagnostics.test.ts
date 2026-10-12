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

import { beforeEach, describe, expect, it } from 'vitest'
import {
  readModelQueryDiagnostics,
  recordModelQueryOperation,
  resetModelQueryDiagnostics,
} from './modelQueryDiagnostics'

describe('model query diagnostics', () => {
  beforeEach(resetModelQueryDiagnostics)

  it('aggregates bounded privacy-minimal counters', () => {
    recordModelQueryOperation({ operation: 'idb.scanPrefix', durationMs: 12, rowsRead: 100, resultRows: 4, fullScan: true })
    recordModelQueryOperation({ operation: 'idb.scanPrefix', durationMs: 5, rowsRead: 10, resultRows: 2, fullScan: true, failed: true })
    expect(readModelQueryDiagnostics()).toEqual({
      prohibitedFullScanCount: 2,
      operations: {
        'idb.scanPrefix': {
          calls: 2,
          failures: 1,
          rowsRead: 110,
          resultRows: 6,
          fullScans: 2,
          totalDurationMs: 17,
          maxDurationMs: 12,
        },
      },
    })
  })
})
