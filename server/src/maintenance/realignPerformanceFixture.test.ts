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
import {
  planFixtureRealignment,
  STALE_WRITE_HEAD_KIND,
  WRITE_HEAD_KIND,
  type FixtureRealignmentFacts,
} from './realignPerformanceFixture.js'

const facts = (overrides: Partial<FixtureRealignmentFacts> = {}): FixtureRealignmentFacts => ({
  rootUrl: 'automerge:rootdocumentid000000001',
  rootResolved: true,
  staticSource: 'performance-seed-editable',
  rootWriteHeadId: 'writeheadid00000000000001',
  allowList: [
    { documentId: 'rootdocumentid000000001', kind: 'root' },
    { documentId: 'writeheadid00000000000001', kind: STALE_WRITE_HEAD_KIND },
    { documentId: 'objectbase0000000000000001', kind: 'object-base' },
    { documentId: 'connbase000000000000000001', kind: 'connection-base' },
  ],
  admittedIds: new Set(['rootdocumentid000000001', 'writeheadid00000000000001']),
  ...overrides,
})

const codes = (f: FixtureRealignmentFacts) => planFixtureRealignment(f).blockers.map((b) => b.code)

describe('planFixtureRealignment', () => {
  it('plans the write-head relabel and the claim of every listed-but-unadmitted document', () => {
    const { blockers, plan } = planFixtureRealignment(facts())
    expect(blockers).toEqual([])
    expect(plan!.relabelWriteHeadId).toBe('writeheadid00000000000001')
    expect(plan!.claimDocumentIds).toEqual(['connbase000000000000000001', 'objectbase0000000000000001'])
    expect(plan!.admittedButUnlisted).toEqual([])
  })

  it('NEVER claims a document that is admitted but not listed — it only reports it', () => {
    // GUARDS AGAINST: planning `claimDocumentIds` from the admitted∪listed union instead of
    // listed∧¬admitted. That direction is the DANGEROUS one — an admitted
    // document missing from the manifest is one `static_allowed` will stop
    // serving, and claiming it again changes nothing while hiding the finding.
    // This door exists to re-align a fixture with its own manifest, never to
    // extend the manifest's reach.
    const { plan } = planFixtureRealignment(facts({
      admittedIds: new Set(['rootdocumentid000000001', 'writeheadid00000000000001', 'ghostdoc0000000000000001']),
    }))
    expect(plan!.admittedButUnlisted).toEqual(['ghostdoc0000000000000001'])
    expect(plan!.claimDocumentIds).not.toContain('ghostdoc0000000000000001')
  })

  it('is idempotent: a fixture already re-aligned plans nothing', () => {
    const { blockers, plan } = planFixtureRealignment(facts({
      allowList: [
        { documentId: 'rootdocumentid000000001', kind: 'root' },
        { documentId: 'writeheadid00000000000001', kind: WRITE_HEAD_KIND },
      ],
      admittedIds: new Set(['rootdocumentid000000001', 'writeheadid00000000000001']),
    }))
    expect(blockers).toEqual([])
    expect(plan!.relabelWriteHeadId).toBeNull()
    expect(plan!.claimDocumentIds).toEqual([])
  })

  it('refuses a workspace with no static manifest — that door is promote-summary', () => {
    // Without the guard this door would claim and relabel on an
    // ORDINARY landscape, where `read_model_static_documents` is empty, so the
    // claim set is empty and the relabel is a silent no-op — a run that
    // reports success for a workspace it cannot help.
    expect(codes(facts({ staticSource: null }))).toEqual(['not-a-static-workspace'])
    expect(planFixtureRealignment(facts({ staticSource: null })).plan).toBeNull()
  })

  it('refuses when the root names a write head the manifest does not list', () => {
    // Planning the relabel anyway (UPDATE ... WHERE document_id = head) would
    // match zero rows and the run reports "applied, 0 relabelled" — a green
    // run over a head that `static_allowed` will never serve.
    expect(codes(facts({ rootWriteHeadId: 'unlistedhead000000000001' }))).toEqual(['write-head-not-listed'])
  })

  it('refuses a write head listed under some third kind rather than guessing', () => {
    expect(codes(facts({
      allowList: [
        { documentId: 'rootdocumentid000000001', kind: 'root' },
        { documentId: 'writeheadid00000000000001', kind: 'diagram' },
      ],
    }))).toEqual(['write-head-unexpected-kind'])
  })

  it('plans the claims even when the root names no write head at all', () => {
    const { blockers, plan } = planFixtureRealignment(facts({ rootWriteHeadId: null }))
    expect(blockers).toEqual([])
    expect(plan!.relabelWriteHeadId).toBeNull()
    expect(plan!.claimDocumentIds).toEqual(['connbase000000000000000001', 'objectbase0000000000000001'])
  })

  it('stops at the first blocker for a missing or unresolved root', () => {
    expect(codes(facts({ rootUrl: null }))).toEqual(['no-such-workspace'])
    expect(codes(facts({ rootResolved: false }))).toEqual(['root-unresolved'])
  })
})
