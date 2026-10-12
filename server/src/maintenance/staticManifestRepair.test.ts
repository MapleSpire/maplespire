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

import { describe, expect, it, vi } from 'vitest'
import {
  assessStaticManifestWorkspace,
  repairPerformanceStaticManifests,
} from './staticManifestRepair.js'

const healthyRow = {
  landscape_id: 'land',
  version_id: 'version',
  source: 'performance-seed-editable',
  mapped_documents: '31',
  stored_mapped_documents: '31',
  static_documents: '20',
  missing_static_documents: '11',
  backfillable_documents: '11',
  unavailable_mapped_documents: '0',
  static_documents_without_mapping: '0',
  diagrams: '10',
  mapped_diagrams: '10',
  stored_diagrams: '10',
  model_meta_documents: '1',
  stored_model_meta_documents: '1',
  root_mapped: true,
  root_stored: true,
}

describe('performance static manifest repair', () => {
  it('accepts a complete durable mapping while exposing the exact backfill', () => {
    expect(assessStaticManifestWorkspace(healthyRow)).toMatchObject({
      missingStaticDocuments: 11,
      backfillableDocuments: 11,
      issues: [],
      warnings: [],
    })
  })

  it('fails closed when storage, root, model metadata or diagrams are incomplete', () => {
    const audit = assessStaticManifestWorkspace({
      ...healthyRow,
      stored_mapped_documents: '30',
      unavailable_mapped_documents: '1',
      root_mapped: false,
      root_stored: false,
      model_meta_documents: '0',
      stored_model_meta_documents: '0',
      mapped_diagrams: '9',
      stored_diagrams: '9',
    })
    expect(audit.issues).toEqual([
      'root-not-mapped',
      'root-missing-storage',
      'model-meta-cardinality',
      'model-meta-missing-storage',
      'diagram-document-not-mapped',
      'diagram-document-missing-storage',
    ])
    expect(audit.warnings).toEqual(['declared-static-base-unavailable:1'])
  })

  it('is report-only by default and applies only after every workspace is safe', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [healthyRow] })
      .mockResolvedValueOnce({ rows: [healthyRow] })
      .mockResolvedValueOnce({ rows: [], rowCount: 11 })
    const db = { query } as never

    await expect(repairPerformanceStaticManifests(db)).resolves.toMatchObject({
      reportOnly: true,
      safeToApply: true,
      proposedBackfill: 11,
      backfilled: 0,
    })
    expect(query).toHaveBeenCalledTimes(1)

    await expect(repairPerformanceStaticManifests(db, { apply: true })).resolves.toMatchObject({
      reportOnly: false,
      safeToApply: true,
      proposedBackfill: 11,
      backfilled: 11,
    })
    expect(String(query.mock.calls[2][0])).toContain('retained-static-base')
  })
})
