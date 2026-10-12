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

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlatformReferenceIntegrity } from './PlatformReferenceIntegrity'
import type { ReferenceFinding, ReferenceIntegrityReport, ReferenceRepairResult } from '../../lib/platform/api'

const mocks = vi.hoisted(() => ({ scan: vi.fn(), repair: vi.fn() }))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../lib/platform/api', () => ({
  scanReferenceIntegrity: mocks.scan,
  repairReferenceIntegrity: mocks.repair,
}))

const finding = (over: Partial<ReferenceFinding> = {}): ReferenceFinding => ({
  landscapeId: 'L1', versionId: 'V1', kind: 'diagram.groupIds', severity: 'dangling',
  sourceId: 'dg-1', field: 'groupIds', targetId: 'grp-gone', repairIsRemoval: true, ...over,
})

const report = (over: Partial<ReferenceIntegrityReport> = {}): ReferenceIntegrityReport => ({
  reportOnly: true, scannedAt: '2026-08-08T00:00:00Z', workspaces: 1,
  findings: [finding()], countsByKind: { 'diagram.groupIds': 1 },
  checkedKinds: ['diagram.groupIds'], uncheckedKinds: ['diagram.skinId', 'comment.diagramId'],
  truncated: false, ...over,
})

const repairResult = (over: Partial<ReferenceRepairResult> = {}): ReferenceRepairResult => ({
  reportOnly: true, landscapeId: 'L1', versionId: 'V1', applied: 0, skipped: 0, truncated: false,
  plans: [{ finding: finding(), action: 'strip-composition', safeToApply: true }], ...over,
})

const scanNow = () => fireEvent.click(screen.getByTestId('reference-scan'))
const scopeToWorkspace = () => {
  const inputs = screen.getAllByRole('textbox')
  fireEvent.change(inputs[0], { target: { value: 'L1' } })
  fireEvent.change(inputs[1], { target: { value: 'V1' } })
}

beforeEach(() => {
  mocks.scan.mockResolvedValue(report())
  mocks.repair.mockResolvedValue(repairResult())
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('coverage is always stated', () => {
  it('names what was NOT checked even when nothing was found', async () => {
    // "0 findings" without this line reads as "0 problems", which is a lie by
    // omission: skins and comments are never checked at all.
    mocks.scan.mockResolvedValue(report({ findings: [], countsByKind: {} }))
    render(<PlatformReferenceIntegrity />)
    scanNow()
    await screen.findByTestId('reference-unchecked')
  })

  it('says the documents were not walked when they were not', async () => {
    render(<PlatformReferenceIntegrity />)
    scanNow()
    await screen.findByText('platform.referenceIntegrity.coverage.documentsNotWalked')
  })

  it('flags a truncated result rather than presenting the counts as complete', async () => {
    mocks.scan.mockResolvedValue(report({ truncated: true }))
    render(<PlatformReferenceIntegrity />)
    scanNow()
    await screen.findByTestId('reference-truncated')
  })

  it('flags truncation reported by the document walk too, not only by SQL', async () => {
    mocks.scan.mockResolvedValue(report({
      documents: {
        findings: [], countsByKind: {}, checkedKinds: [],
        diagramsWalked: 1, diagramsSkipped: 0, truncated: true,
      },
    }))
    render(<PlatformReferenceIntegrity />)
    scanNow()
    await screen.findByTestId('reference-truncated')
  })
})

describe('repair is never one click away', () => {
  it('offers no Apply until a dry run has said what it would do', async () => {
    render(<PlatformReferenceIntegrity />)
    scopeToWorkspace()
    scanNow()
    await screen.findByTestId('reference-dry-run')
    expect(screen.queryByTestId('reference-apply')).toBeNull()

    fireEvent.click(screen.getByTestId('reference-dry-run'))
    await screen.findByTestId('reference-apply')
    expect(mocks.repair).toHaveBeenCalledWith(expect.objectContaining({ apply: false }))
  })

  it('does not offer repair at all without a workspace — it is never fleet-wide', async () => {
    render(<PlatformReferenceIntegrity />)
    scanNow()
    await screen.findByTestId('reference-dry-run')
    expect((screen.getByTestId('reference-dry-run') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends apply only when the operator asks for it, and re-scans afterwards', async () => {
    render(<PlatformReferenceIntegrity />)
    scopeToWorkspace()
    scanNow()
    await screen.findByTestId('reference-dry-run')
    fireEvent.click(screen.getByTestId('reference-dry-run'))
    await screen.findByTestId('reference-apply')

    mocks.repair.mockResolvedValue(repairResult({ reportOnly: false, applied: 1 }))
    fireEvent.click(screen.getByTestId('reference-apply'))
    await screen.findByTestId('reference-applied')
    expect(mocks.repair).toHaveBeenLastCalledWith(expect.objectContaining({ apply: true }))
    // The report on screen must not outlive the change it described...
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(2))
    // ...but the confirmation must survive that refresh, or the operator cannot
    // tell whether anything happened.
    expect(screen.queryByTestId('reference-applied')).not.toBeNull()
  })

  it('hides Apply when the server judged every finding unsafe', async () => {
    mocks.repair.mockResolvedValue(repairResult({
      plans: [{ finding: finding(), action: 'manual', safeToApply: false, reason: 'still mapped to a workspace' }],
    }))
    render(<PlatformReferenceIntegrity />)
    scopeToWorkspace()
    scanNow()
    await screen.findByTestId('reference-dry-run')
    fireEvent.click(screen.getByTestId('reference-dry-run'))
    await screen.findByTestId('reference-declined')
    expect(screen.queryByTestId('reference-apply')).toBeNull()
  })

  it("shows the server's own reason for a refusal, verbatim", async () => {
    // A console that paraphrases a refusal invites a second-guess.
    mocks.repair.mockResolvedValue(repairResult({
      plans: [{ finding: finding(), action: 'manual', safeToApply: false, reason: 'still mapped to a workspace' }],
    }))
    render(<PlatformReferenceIntegrity />)
    scopeToWorkspace()
    scanNow()
    await screen.findByTestId('reference-dry-run')
    fireEvent.click(screen.getByTestId('reference-dry-run'))
    await screen.findByText(/still mapped to a workspace/)
  })
})

describe('findings', () => {
  it('merges the document-walk findings into the same table', async () => {
    mocks.scan.mockResolvedValue(report({
      documents: {
        findings: [finding({ kind: 'group.parentObjectId', sourceId: 'grp-1', targetId: 'obj-gone' })],
        countsByKind: { 'group.parentObjectId': 1 }, checkedKinds: [],
        diagramsWalked: 1, diagramsSkipped: 0, truncated: false,
      },
    }))
    render(<PlatformReferenceIntegrity />)
    scanNow()
    await waitFor(() => expect(screen.getAllByTestId('reference-finding')).toHaveLength(2))
  })

  it('never lets an abstaining leg zero out the other leg’s count', async () => {
    // Both legs seed every kind they cover with an explicit zero — that IS the
    // coverage card. They share the two ADR kinds, so a spread-merge would let
    // the abstaining leg's 0 overwrite the leg that actually counted, rendering
    // `decisionRecord.related.adr: 0` above a table listing findings of that kind.
    mocks.scan.mockResolvedValue(report({
      findings: [finding({ kind: 'decisionRecord.related.adr', sourceId: 'adr-1', targetId: 'adr-gone' })],
      countsByKind: { 'decisionRecord.related.adr': 3, 'decisionRecord.related.diagram': 0 },
      documents: {
        findings: [finding({ kind: 'decisionRecord.related.diagram', sourceId: 'adr-2', targetId: 'dg-gone' })],
        // The document leg abstained on the record kind and answered the other.
        countsByKind: { 'decisionRecord.related.adr': 0, 'decisionRecord.related.diagram': 2 },
        checkedKinds: [], diagramsWalked: 1, diagramsSkipped: 0, truncated: false,
      },
    }))
    render(<PlatformReferenceIntegrity />)
    scanNow()
    const coverage = await screen.findByTestId('reference-coverage')
    expect(coverage.textContent).toContain('decisionRecord.related.adr: 3')
    expect(coverage.textContent).toContain('decisionRecord.related.diagram: 2')
  })

  it('marks a by-design finding differently from damage', async () => {
    // `object.parentId` is re-rooted by both read paths on purpose; showing it
    // as an error would leave every scan permanently red on a healthy model.
    mocks.scan.mockResolvedValue(report({
      findings: [finding({ kind: 'object.parentId', severity: 'expected' })],
    }))
    render(<PlatformReferenceIntegrity />)
    scanNow()
    const row = await screen.findByTestId('reference-finding')
    expect(row.getAttribute('data-severity')).toBe('expected')
  })

  it('surfaces a failed scan with a retry rather than an empty screen', async () => {
    mocks.scan.mockRejectedValue(new Error('boom'))
    render(<PlatformReferenceIntegrity />)
    scanNow()
    await screen.findByText('boom')
  })
})
