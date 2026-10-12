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

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, EyeOff, Link2Off, Play, Search, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import * as api from '../../lib/platform/api'
import { cn } from '../../lib/utils'
import { EmptyState, InlineError, SectionCard, SkeletonRows } from '../admin/shared'
import { Button } from '../ui/button'

/**
 * Cross-entity references whose target no longer exists.
 *
 * Two rules this screen is built around, both of which a naive report would get
 * wrong in a way that costs trust:
 *
 *  1. **A clean scan is not a clean model.** Some references neither leg can
 *     check — skins are client plugins the server cannot resolve, a comment
 *     cannot dangle at all — so `uncheckedKinds` is rendered even at zero
 *     findings. "0" without that line is a lie by omission.
 *  2. **Repair never runs by accident.** The scan is read-only, the repair
 *     defaults to a dry run, and Apply only appears once a dry run has said what
 *     it would do. Findings the server declined keep their stated reason next to
 *     them rather than being hidden.
 */

type ScanState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; report: api.ReferenceIntegrityReport }

const SEVERITY_STYLE: Record<api.ReferenceFinding['severity'], string> = {
  dangling: 'border-error-border bg-error-bg text-error-text',
  orphaned: 'border-error-border bg-error-bg text-error-text',
  unreadable: 'border-warning-border bg-warning-bg text-warning-text',
  // Reported for visibility, never as damage — the read paths handle it by design.
  expected: 'border-line bg-surface-200 text-fg-secondary',
}

export function PlatformReferenceIntegrity() {
  const { t } = useTranslation()
  const [scan, setScan] = useState<ScanState>({ status: 'idle' })
  const [landscapeId, setLandscapeId] = useState('')
  const [versionId, setVersionId] = useState('')
  const [withDocuments, setWithDocuments] = useState(false)
  const [repair, setRepair] = useState<api.ReferenceRepairResult | null>(null)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const scoped = landscapeId.trim() !== '' && versionId.trim() !== ''
  const message = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback

  /** `keepRepair` is set by the refresh that FOLLOWS an apply: clearing the
   *  result there would wipe the "repaired N" confirmation the operator just
   *  earned, leaving them unsure whether anything happened. A scan the operator
   *  starts themselves does clear it — that report is about to be replaced. */
  const runScan = (keepRepair = false) => {
    setScan({ status: 'loading' })
    if (!keepRepair) setRepair(null)
    setRepairError(null)
    api.scanReferenceIntegrity({
      ...(scoped ? { landscapeId: landscapeId.trim(), versionId: versionId.trim() } : {}),
      documents: withDocuments && scoped,
    })
      .then((report) => setScan({ status: 'ok', report }))
      .catch((error) => setScan({ status: 'error', message: message(error, t('platform.referenceIntegrity.scanFailed')) }))
  }

  const runRepair = async (apply: boolean) => {
    if (!scoped || busy) return
    setBusy(true)
    setRepairError(null)
    try {
      const result = await api.repairReferenceIntegrity({
        landscapeId: landscapeId.trim(),
        versionId: versionId.trim(),
        documents: withDocuments,
        apply,
      })
      setRepair(result)
      if (apply) runScan(true)
    } catch (error) {
      setRepairError(message(error, t('platform.referenceIntegrity.repairFailed')))
    } finally {
      setBusy(false)
    }
  }

  const report = scan.status === 'ok' ? scan.report : null
  const findings = report ? [...report.findings, ...(report.documents?.findings ?? [])] : []
  // SUM, never spread-override. Both legs seed every kind they cover with an
  // explicit zero (that is the coverage card), and they share the two ADR kinds,
  // so `{...sql, ...docs}` would let the abstaining leg's 0 erase the other's
  // real count. The legs cover disjoint populations, so adding them is correct.
  const counts = report
    ? Object.entries(report.documents?.countsByKind ?? {}).reduce<Record<string, number>>(
        (merged, [kind, count]) => ({ ...merged, [kind]: (merged[kind] ?? 0) + count }),
        { ...report.countsByKind },
      )
    : {}
  const truncated = Boolean(report?.truncated || report?.documents?.truncated)
  const repairable = repair?.plans.filter((plan) => plan.safeToApply) ?? []
  const declined = repair?.plans.filter((plan) => !plan.safeToApply) ?? []

  return (
    <div data-testid="platform-reference-integrity" className="mx-auto w-full max-w-5xl px-8 py-8">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold text-fg">{t('platform.referenceIntegrity.title')}</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-fg-secondary">
          {t('platform.referenceIntegrity.description')}
        </p>
      </header>

      <SectionCard className="mb-6 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
              {t('platform.referenceIntegrity.landscapeId')}
            </span>
            <input
              value={landscapeId}
              onChange={(e) => setLandscapeId(e.target.value)}
              placeholder={t('platform.referenceIntegrity.allWorkspaces')}
              className="w-56 rounded-md border border-line bg-surface-100 px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-line-strong"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
              {t('platform.referenceIntegrity.versionId')}
            </span>
            <input
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
              placeholder={t('platform.referenceIntegrity.allWorkspaces')}
              className="w-56 rounded-md border border-line bg-surface-100 px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-line-strong"
            />
          </label>
          <Button onClick={() => runScan()} disabled={scan.status === 'loading'} data-testid="reference-scan">
            <Search className="mr-1.5 h-3.5 w-3.5" />
            {t('platform.referenceIntegrity.scan')}
          </Button>
        </div>

        <label className="mt-3 flex items-start gap-2 text-[12.5px] text-fg-secondary">
          <input
            type="checkbox"
            checked={withDocuments}
            disabled={!scoped}
            onChange={(e) => setWithDocuments(e.target.checked)}
            data-testid="reference-walk-documents"
            className="mt-0.5"
          />
          <span>
            {t('platform.referenceIntegrity.walkDocuments')}
            <span className="ml-1 text-fg-subtle">
              {scoped
                ? t('platform.referenceIntegrity.walkDocumentsHint')
                : t('platform.referenceIntegrity.walkDocumentsNeedsWorkspace')}
            </span>
          </span>
        </label>
      </SectionCard>

      {scan.status === 'loading' && <SkeletonRows rows={5} />}
      {scan.status === 'error' && <InlineError message={scan.message} onRetry={() => runScan()} />}

      {report && (
        <>
          {findings.length === 0 ? (
            <EmptyState
              title={t('platform.referenceIntegrity.empty.title')}
              description={t('platform.referenceIntegrity.empty.description')}
            />
          ) : (
            <SectionCard className="mb-4">
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wide text-fg-subtle">
                    <th className="px-4 py-2.5 font-medium">{t('platform.referenceIntegrity.columns.severity')}</th>
                    <th className="px-4 py-2.5 font-medium">{t('platform.referenceIntegrity.columns.reference')}</th>
                    <th className="px-4 py-2.5 font-medium">{t('platform.referenceIntegrity.columns.source')}</th>
                    <th className="px-4 py-2.5 font-medium">{t('platform.referenceIntegrity.columns.target')}</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((finding, index) => (
                    <tr
                      key={`${finding.kind}:${finding.sourceId}:${finding.targetId}:${index}`}
                      data-testid="reference-finding"
                      data-severity={finding.severity}
                      className="border-b border-line last:border-0"
                    >
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                          SEVERITY_STYLE[finding.severity],
                        )}>
                          {t(`platform.referenceIntegrity.severity.${finding.severity}`)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-fg">{finding.kind}</div>
                        <div className="text-[11.5px] text-fg-subtle">{finding.field}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[12px] text-fg-secondary">{finding.sourceId}</td>
                      <td className="px-4 py-3 font-mono text-[12px] text-fg-secondary">{finding.targetId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>
          )}

          <SectionCard className="mb-4 p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
              <EyeOff className="h-3.5 w-3.5 text-fg-subtle" />
              {t('platform.referenceIntegrity.coverage.title')}
            </h2>
            {/* Rendered even at zero findings: "0" without this is a lie by omission. */}
            <p data-testid="reference-unchecked" className="text-[12.5px] text-fg-secondary">
              {t('platform.referenceIntegrity.coverage.unchecked', { kinds: report.uncheckedKinds.join(', ') })}
            </p>
            {!report.documents && (
              <p className="mt-1 text-[12.5px] text-fg-secondary">
                {t('platform.referenceIntegrity.coverage.documentsNotWalked')}
              </p>
            )}
            {report.documents && report.documents.diagramsSkipped > 0 && (
              <p className="mt-1 text-[12.5px] text-warning-text">
                {t('platform.referenceIntegrity.coverage.diagramsSkipped', { count: report.documents.diagramsSkipped })}
              </p>
            )}
            {truncated && (
              <p data-testid="reference-truncated" className="mt-1 flex items-center gap-1.5 text-[12.5px] text-warning-text">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {t('platform.referenceIntegrity.coverage.truncated')}
              </p>
            )}
            {Object.keys(counts).length > 0 && (
              <p data-testid="reference-coverage" className="mt-2 text-[11.5px] text-fg-subtle">
                {Object.entries(counts).map(([kind, n]) => `${kind}: ${n}`).join('  ·  ')}
              </p>
            )}
          </SectionCard>

          {findings.length > 0 && (
            <SectionCard className="p-4">
              <h2 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                <Wrench className="h-3.5 w-3.5 text-fg-subtle" />
                {t('platform.referenceIntegrity.repair.title')}
              </h2>
              <p className="mb-3 text-[12.5px] text-fg-secondary">
                {scoped
                  ? t('platform.referenceIntegrity.repair.description')
                  : t('platform.referenceIntegrity.repair.needsWorkspace')}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" onClick={() => void runRepair(false)} disabled={!scoped || busy} data-testid="reference-dry-run">
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {t('platform.referenceIntegrity.repair.dryRun')}
                </Button>
                {/* Apply appears only AFTER a dry run has said what it would do. */}
                {repair && repairable.length > 0 && (
                  <Button onClick={() => void runRepair(true)} disabled={busy} data-testid="reference-apply">
                    <Wrench className="mr-1.5 h-3.5 w-3.5" />
                    {t('platform.referenceIntegrity.repair.apply', { count: repairable.length })}
                  </Button>
                )}
              </div>

              {repairError && <p className="mt-3 text-[12.5px] text-error-text">{repairError}</p>}

              {repair && !repair.reportOnly && (
                <p data-testid="reference-applied" className="mt-3 flex items-center gap-1.5 text-[12.5px] text-fg">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                  {t('platform.referenceIntegrity.repair.applied', { count: repair.applied })}
                </p>
              )}

              {repair && repair.reportOnly && (
                <p className="mt-3 text-[12.5px] text-fg-secondary">
                  {t('platform.referenceIntegrity.repair.wouldRepair', { count: repairable.length })}
                </p>
              )}

              {declined.length > 0 && (
                <ul data-testid="reference-declined" className="mt-3 space-y-1.5">
                  {declined.map((plan, index) => (
                    <li key={index} className="flex items-start gap-2 text-[12.5px] text-fg-secondary">
                      <Link2Off className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                      <span>
                        <span className="font-mono text-[12px] text-fg">{plan.finding.sourceId}</span>
                        {' — '}
                        {/* The server's own reason, verbatim: a console that
                            paraphrases a refusal invites a second-guess. */}
                        {plan.reason ?? t('platform.referenceIntegrity.repair.declinedNoReason')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          )}
        </>
      )}
    </div>
  )
}
