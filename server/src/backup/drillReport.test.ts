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
import { signDrillReport, verifyDrillReport, type DrillReport } from './drillReport.js'

const KEY = 'drill-signing-key-for-tests'

function report(overrides: Partial<DrillReport> = {}): DrillReport {
  return {
    reportVersion: 1,
    drillId: 'drill_0123456789abcdef01234567',
    startedAt: '2026-08-08T00:00:00.000Z',
    finishedAt: '2026-08-08T00:00:19.000Z',
    rtoMs: 19_000,
    outcome: 'passed',
    applicationRevision: 'abc123',
    source: { database: 'maplespire', postgresVersion: '16.9', snapshotAt: '2026-08-08 00:00:00+00' },
    bundle: {
      directory: '/var/backups/maplespire',
      dumpBytes: 4_096,
      dumpSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
    },
    verification: null,
    coldApi: null,
    retiredWorkspaces: [],
    error: null,
    ...overrides,
  }
}

describe('drill report signature', () => {
  it('round-trips', () => {
    const signed = signDrillReport(report(), KEY, 'k1')
    expect(signed.signingKeyId).toBe('k1')
    expect(verifyDrillReport(signed, KEY)).toBe(true)
  })

  it('rejects a report whose outcome was edited after signing', () => {
    // The whole reason a drill report is signed: "failed" is the field somebody
    // under pressure would be tempted to change.
    const signed = signDrillReport(report({ outcome: 'failed', error: 'restore diverged' }), KEY)
    const forged = {
      ...signed,
      report: { ...signed.report, outcome: 'passed' as const, error: null },
    }
    expect(verifyDrillReport(forged, KEY)).toBe(false)
  })

  it('rejects a signature made with a different key', () => {
    expect(verifyDrillReport(signDrillReport(report(), 'other-key'), KEY)).toBe(false)
  })

  it('treats an unsigned report as unverified rather than as verified', () => {
    // No key configured is a legitimate deployment, and the drill still records
    // the run — but "we could not check" must never read as "it checks out".
    const unsigned = signDrillReport(report(), undefined)
    expect(unsigned.signature).toBeNull()
    expect(unsigned.reportSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(verifyDrillReport(unsigned, KEY)).toBe(false)
    expect(verifyDrillReport(unsigned, undefined)).toBe(false)
  })

  it('signs the content, not the key order', () => {
    const canonical = signDrillReport(report(), KEY)
    const reordered = signDrillReport(
      // Same fields, declared in a different order — JSON.stringify would differ.
      { ...report(), error: null, outcome: 'passed', reportVersion: 1 },
      KEY,
    )
    expect(reordered.signature).toBe(canonical.signature)
  })

  it('changes when any nested field changes', () => {
    const base = signDrillReport(report(), KEY)
    const changed = signDrillReport(report({ rtoMs: 19_001 }), KEY)
    expect(changed.signature).not.toBe(base.signature)
    expect(changed.reportSha256).not.toBe(base.reportSha256)
  })
})
