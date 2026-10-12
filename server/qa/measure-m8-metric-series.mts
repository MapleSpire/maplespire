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
 * Metric SERIES count before and after, at 1 and at 50 workspaces.
 *
 * Four numbers, and TWO OF THEM MUST BE EQUAL: the series count must not grow
 * with the number of workspaces. The equality is the proof, not an
 * observation.
 *
 * ## What "before" and "after" mean here
 *
 * "After" is the payload as it stands today. "Before" is the same payload with
 * the SYNC-CELL OWNERSHIP family removed, so the two pairs answer a question
 * about that family rather than about the whole server.
 *
 * ## The trap this harness is built to avoid
 *
 * A harness that cannot make "50 workspaces" differ from "1 workspace" proves
 * nothing: the series counts would be equal because the two runs were the same
 * run, and the equality would be a property of the instrument. So every
 * condition drives REAL module state through the real recorders —
 * `noteServerCreationPlacement` once per workspace and
 * `reportOverlayRotationLockContended` once per workspace — and the harness
 * FAILS unless at least one metric VALUE is observed to move between the two
 * conditions. The moving values are the witness that the conditions differ; the
 * unmoving series count is then the finding.
 *
 * `overlayRotationLock` is the clearest case in the tree: it iterates
 * `refusalStreaks.values()` — an unbounded per-workspace map — and folds it
 * into three scalars. The collection reaches the VALUE and never the LABELS,
 * which is the metric cardinality convention, executed rather than asserted.
 *
 * ## What this harness is NOT
 *
 * It is not a scrape of the live route. Nothing in this tree mounts
 * `app.get('/metrics')` (index.ts says so in its own comment). This assembles the same builders the handler calls, in the
 * handler's order, and counts what they produce. The families the handler adds
 * from Postgres are excluded and enumerated in the record instead.
 */
import { renderPrometheus, type MetricSample } from '../src/runtime/metrics.js'
import {
  syncCellOwnershipMetricSamples,
  type SyncCellOwnershipSnapshot,
} from '../src/syncCells/ownership.js'
import {
  noteServerCreationPlacement,
  resetServerCreationPlacementForTest,
  serverCreationPlacementMetricSamples,
} from '../src/rbac/serverCreationPlacement.js'
import {
  __resetOverlayRotationRefusalStreaks,
  overlayRotationLockMetricSamples,
  reportOverlayRotationLockContended,
} from '../src/readModel/overlayRotationLock.js'
import { docScopeMetricSamples } from '../src/rbac/docScope.js'

const REPEATS = 5

/** A snapshot describing a cell that owns `workspaces` workspaces. */
function snapshotOwning(workspaces: number): SyncCellOwnershipSnapshot {
  return {
    ownerRouteMap: {
      enabled: true, usable: true, sampledAt: '2026-09-01T00:00:00.000Z',
      sampleAgeMs: 0, sampleSequence: 1, entries: 1, refreshMs: 1000,
      maxAgeMs: 3000, refreshInFlight: false, refreshCount: 1, refreshErrorCount: 0,
    },
    enabled: true,
    ready: true,
    canServe: true,
    cellId: 'm8-cell',
    configuredGeneration: 'gen-1',
    effectiveGeneration: 'gen-1.ce1461953e2b8ac2',
    topologyGeneration: 'gen-1.ce1461953e2b8ac2',
    placementMode: 'shadow',
    reservedPartitions: [],
    role: 'pool',
    partitionCount: 1,
    partitionIndex: 0,
    partitionReady: true,
    routeAdvertised: true,
    partitionAcquisitionCount: 1,
    partitionLossCount: 0,
    // The three that MOVE with the condition. Everything else is held fixed so
    // that any series-count difference could only come from these.
    discoveredWorkspaceCount: workspaces,
    expectedWorkspaceCount: workspaces,
    ownedWorkspaceCount: workspaces,
    conflictCount: 0,
    supersededByGeneration: false,
    standDownActive: false,
    crossGenerationRefusalCount: 0,
    acquisitionCount: workspaces,
    renewalCount: 0,
    workspaceLeaseRecoveryCount: 0,
    lossCount: 0,
    errorCount: 0,
    fenceDivergencesSeen: 0,
    fenceDivergenceByCause: {
      belowLive: 0, aboveLive: 0, released: 0, absent: 0, foreignCellAtSameToken: 0,
    },
    fenceRepairCount: 0,
    placementDivergenceCount: 0,
    placementRowsCompared: 0,
    fenceRepairFailureCount: 0,
    durableFencesWithoutSequence: 0,
    slowestStatementMs: 0,
    serverCeilingFiredCount: 0,
    passAbandonedCount: 0,
    effectiveStatementTimeout: '30s',
    effectiveLockTimeout: '5s',
    fenceReadingObservedAt: '2026-09-01T00:00:00.000Z',
    fenceReadingCurrent: true,
    bootReconcileFailed: false,
    topologyConfirmed: true,
    topologyKeyCreatedAtBoot: false,
    bootObservedAt: '2026-09-01T00:00:00.000Z',
    durableFenceSurveyObservedAt: '2026-09-01T00:00:00.000Z',
    minimumRemainingLeaseMs: 30_000,
  }
}

/**
 * CONTROL ONLY — a family that DOES spread a collection across labels. It is
 * never emitted by the server; it exists so the counter can be shown reporting
 * INEQUALITY. Without it, "the two numbers are equal" is equally consistent
 * with a counter that always returns the same value.
 */
function syntheticPerWorkspaceFamily(workspaces: number): MetricSample {
  return {
    name: 'maplespire_m8_synthetic_per_workspace',
    help: 'CONTROL ONLY. Never emitted by the server.',
    type: 'gauge',
    values: Array.from({ length: workspaces }, (_, index) => ({
      labels: { kind: `workspace-${index}` },
      value: 1,
    })),
  }
}

/** Drive real module state to represent exactly `workspaces` workspaces. */
function driveState(workspaces: number): void {
  // Reset FIRST: a counter that bleeds between runs reports non-zero where zero
  // is correct.
  resetServerCreationPlacementForTest()
  __resetOverlayRotationRefusalStreaks()
  for (let index = 0; index < workspaces; index += 1) {
    const landscapeId = `m8-landscape-${index}`
    noteServerCreationPlacement(`m8-document-${index}`, { landscapeId, versionId: 'v1' })
    reportOverlayRotationLockContended({
      path: 'rotate', landscapeId, versionId: 'v1', kind: 'object',
    })
  }
}

interface Condition {
  samples: MetricSample[]
  series: number
  renderedSeriesLines: number
  families: number
}

function assemble(workspaces: number, withCellPlan: boolean, withControl: boolean): Condition {
  driveState(workspaces)
  const samples: MetricSample[] = []
  // The handler's order, for the families that are reachable without Postgres.
  samples.push(...docScopeMetricSamples())
  samples.push(...serverCreationPlacementMetricSamples())
  samples.push(...overlayRotationLockMetricSamples())
  if (withCellPlan) {
    samples.push(...syncCellOwnershipMetricSamples({ readSnapshot: () => snapshotOwning(workspaces) }))
  }
  if (withControl) samples.push(syntheticPerWorkspaceFamily(workspaces))

  const series = samples.reduce((total, sample) => total + sample.values.length, 0)
  // Independent second count, straight off the rendered payload: a series is a
  // non-comment line. If the two counts disagree the instrument is wrong.
  const renderedSeriesLines = renderPrometheus(samples)
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .length
  return { samples, series, renderedSeriesLines, families: samples.length }
}

/** Every `name{labels} value` line, for the value-movement control. */
function valueLines(samples: MetricSample[]): string[] {
  return renderPrometheus(samples)
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function fail(message: string): never {
  console.error(`VOID — ${message}`)
  process.exit(2)
}

const runs: Array<Record<string, number>> = []
let movedValues: string[] = []

for (let repeat = 0; repeat < REPEATS; repeat += 1) {
  const before1 = assemble(1, false, false)
  const before50 = assemble(50, false, false)
  const after1 = assemble(1, true, false)
  const after50 = assemble(50, true, false)

  for (const [label, condition] of Object.entries({ before1, before50, after1, after50 })) {
    if (condition.series !== condition.renderedSeriesLines) {
      fail(`${label}: structural count ${condition.series} disagrees with rendered count `
        + `${condition.renderedSeriesLines} — the instrument is broken, not the system`)
    }
    if (condition.series === 0) fail(`${label} produced ZERO series`)
  }

  if (repeat === 0) {
    // CONTROL 1 — the two conditions must actually differ. Collected from the
    // rendered lines so it is the published payload being compared, not the
    // harness's own bookkeeping.
    const lines1 = new Set(valueLines(after1.samples))
    movedValues = valueLines(after50.samples).filter((line) => !lines1.has(line))
  }

  runs.push({
    seriesBefore1: before1.series,
    seriesAfter1: after1.series,
    seriesBefore50: before50.series,
    seriesAfter50: after50.series,
    familiesBefore1: before1.families,
    familiesAfter1: after1.families,
  })
}

if (movedValues.length === 0) {
  fail('no metric VALUE moved between 1 and 50 workspaces — the two conditions were '
    + 'the same condition, so an equal series count would be a property of this harness')
}

// Every repeat must agree, or a point value would be a fiction.
const first = JSON.stringify(runs[0])
if (!runs.every((run) => JSON.stringify(run) === first)) {
  fail(`the ${REPEATS} runs disagree: ${JSON.stringify(runs)}`)
}

// CONTROL 2 — the counter must be able to report INEQUALITY.
const control1 = assemble(1, true, true)
const control50 = assemble(50, true, true)
if (control50.series <= control1.series) {
  fail(`the synthetic per-workspace family did not grow the count `
    + `(${control1.series} -> ${control50.series}); this counter cannot report inequality`)
}

const result = {
  ...runs[0],
  samples: REPEATS,
  movedValueCount: movedValues.length,
  movedValueExamples: movedValues.slice(0, 4),
  controlWithSyntheticLabelAt1: control1.series,
  controlWithSyntheticLabelAt50: control50.series,
}
console.log(JSON.stringify(result, null, 2))
