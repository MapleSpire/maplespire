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
import { renderPrometheus } from '../runtime/metrics.js'
import {
  syncCellOwnershipMetricSamples,
  type SyncCellOwnershipSnapshot,
} from './ownership.js'

/**
 * Prometheus delivery of the two restore detectors: the fence-divergence
 * reading (`fenceDivergencesSeen`) and the boot-time world-mismatch survey
 * (`durableFencesWithoutSequence`). Without these series they reach an
 * operator only through stdout and `/api/platform/sync-cell` — a detector that
 * cannot raise an alert is a detector waiting on a human.
 *
 * FOUR properties carry the weight here:
 *
 *   1. NULL IS NaN, NOT ZERO. `null` on these fields means "not known" — no
 *      pass has run, the reading threw, or the lease set moved under it. Zero
 *      means "nothing is wrong". Rendering the first as the second gives a
 *      blind detector the healthiest possible line on a dashboard.
 *   2. THE READING FOLLOWS THE COORDINATOR. A builder that latches publishes
 *      the boot value for ever and no scrape can tell.
 *   3. EVERY SERIES AN ALERT DEPENDS ON IS ASSERTED IN BOTH DIRECTIONS. The
 *      alert rules join on `_enabled == 1`, so a gauge pinned to a constant `0`
 *      would silence the entire delivery on every cell while a test that only
 *      checked the disabled case stayed green.
 *   4. THE SERIES SET IS ASSERTED AS A SET. Deleting one from the returned list
 *      is otherwise invisible to a test that only looks up the ones it names.
 */

const SNAPSHOT: SyncCellOwnershipSnapshot = {
  ownerRouteMap: { enabled: true, usable: false, sampledAt: null, sampleAgeMs: null,
    sampleSequence: 0, entries: 0, refreshMs: 1000, maxAgeMs: 3000,
    refreshInFlight: false, refreshCount: 0, refreshErrorCount: 0 },
  enabled: true,
  ready: true,
  cellId: 'cell-a',
  topologyGeneration: 'v1',
  partitionCount: 4,
  partitionIndex: 1,
  partitionReady: true,
  routeAdvertised: true,
  partitionAcquisitionCount: 1,
  partitionLossCount: 0,
  discoveredWorkspaceCount: 12,
  expectedWorkspaceCount: 3,
  ownedWorkspaceCount: 3,
  conflictCount: 0,
  supersededByGeneration: false,
  standDownActive: false,
  crossGenerationRefusalCount: 0,
  acquisitionCount: 3,
  renewalCount: 9,
  workspaceLeaseRecoveryCount: 0,
  lossCount: 0,
  errorCount: 0,
  fenceDivergencesSeen: 0,
  fenceDivergenceByCause: {
    belowLive: 0, aboveLive: 0, released: 0, absent: 0, foreignCellAtSameToken: 0,
  },
  fenceReadingObservedAt: '2026-08-30T12:04:30.000Z',
  fenceReadingCurrent: true,
  fenceRepairCount: 0,
  fenceRepairFailureCount: 0,
  durableFencesWithoutSequence: 0,
  durableFenceSurveyObservedAt: '2026-08-30T12:00:00.000Z',
  topologyKeyCreatedAtBoot: false,
  bootObservedAt: '2026-08-30T11:59:00.000Z',
  minimumRemainingLeaseMs: 14_000,
}

const snapshot = (overrides: Partial<SyncCellOwnershipSnapshot> = {}): SyncCellOwnershipSnapshot =>
  ({ ...SNAPSHOT, ...overrides })

/**
 * The builder takes the COORDINATOR, so the fake is the smallest thing that
 * answers `readSnapshot()`.
 *
 * Taking the coordinator rather than a snapshot ARGUMENT is deliberate: an
 * argument built at the call site (e.g. passed as `null`, or frozen at boot)
 * would be unreachable by any test, whereas the builder reading the
 * coordinator itself is what these tests can pin.
 */
function coordinator(...readings: SyncCellOwnershipSnapshot[]) {
  let calls = 0
  return {
    calls: () => calls,
    readSnapshot() {
      const reading = readings[Math.min(calls, readings.length - 1)]!
      calls += 1
      return reading
    },
  }
}

type Samples = ReturnType<typeof syncCellOwnershipMetricSamples>

/** The value of a single-valued series, by name. */
function value(samples: Samples, name: string): number {
  const sample = samples.find((candidate) => candidate.name === name)
  expect(sample, `no series named ${name}`).toBeDefined()
  expect(sample!.values, `${name} carries no value`).toHaveLength(1)
  return sample!.values[0]!.value
}

const NOW = Date.parse('2026-08-30T12:05:00.000Z')

/** Every series this builder is contracted to publish.
 *
 * Asserted as a SET, because a lookup-by-name test cannot see a deletion: a
 * series removed from the list is simply a name nobody asks for, and it
 * surfaces later as a dashboard panel that went blank. */
const EXPECTED_SERIES = [
  'maplespire_sync_cell_ready',
  'maplespire_sync_cell_owned_workspaces',
  'maplespire_sync_cell_expected_workspaces',
  'maplespire_sync_cell_partition_conflicts_total',
  'maplespire_sync_cell_partition_loss_total',
  'maplespire_sync_cell_foreign_resident_projectors',
  'maplespire_sync_cell_topology_state',
  'maplespire_sync_cell_fence_rejections_total',
  'maplespire_sync_cell_owner_route_map_enabled',
  'maplespire_sync_cell_owner_route_map_usable',
  'maplespire_sync_cell_owner_route_map_sample_age_seconds',
  'maplespire_sync_cell_owner_route_map_max_age_seconds',
  'maplespire_sync_cell_owner_route_map_refresh_total',
  'maplespire_sync_cell_owner_route_map_refresh_errors_total',
  'maplespire_sync_cell_ownership_enabled',
  'maplespire_sync_cell_fence_divergences_seen',
  'maplespire_sync_cell_fence_divergences_by_cause',
  'maplespire_sync_cell_ownership_errors_total',
  'maplespire_sync_cell_workspace_losses_by_reason_total',
  'maplespire_sync_cell_superseded_by_generation',
  'maplespire_sync_cell_stood_down',
  'maplespire_sync_cell_cross_generation_refusals_total',
  'maplespire_sync_cell_fence_reading_current',
  'maplespire_sync_cell_fence_reading_age_seconds',
  'maplespire_sync_cell_fence_repairs_total',
  'maplespire_sync_cell_fence_repair_failures_total',
  'maplespire_sync_cell_topology_created_at_boot',
  'maplespire_sync_cell_durable_fences_without_sequence_at_boot',
  'maplespire_sync_cell_durable_fence_survey_age_seconds',
  'maplespire_sync_cell_boot_observed_age_seconds',
]

describe('syncCellOwnershipMetricSamples', () => {
  it('keeps local convergence, partition events, workspace events and fencing distinct', () => {
    const cell = coordinator(snapshot({ ready: false, canServe: true,
      ownedWorkspaceCount: 2, expectedWorkspaceCount: 5, conflictCount: 7,
      partitionLossCount: 11, lossCount: 13, fenceDivergencesSeen: 17,
      fenceRepairCount: 19, topologyConfirmed: true,
    }), snapshot({ ready: true, canServe: false, ownedWorkspaceCount: 5,
      expectedWorkspaceCount: 5, conflictCount: 8, partitionLossCount: 12,
      topologyConfirmed: false,
    }))
    let rejected = 23, foreign = 29, storageReads = 0, fleetReads = 0
    const readers = {
      storageFenceRejections: () => { storageReads++; return rejected },
      foreignResidentProjectors: () => { fleetReads++; return foreign },
    }
    const first = syncCellOwnershipMetricSamples(cell, NOW, readers)
    const expected: Record<string, [number, 'gauge' | 'counter']> = {
      ready: [0, 'gauge'], owned_workspaces: [2, 'gauge'], expected_workspaces: [5, 'gauge'],
      partition_conflicts_total: [7, 'counter'], partition_loss_total: [11, 'counter'],
      foreign_resident_projectors: [29, 'gauge'], topology_state: [1, 'gauge'],
      fence_rejections_total: [23, 'counter'],
    }
    for (const [suffix, [reading, type]] of Object.entries(expected)) {
      const name = `maplespire_sync_cell_${suffix}`
      expect(first.find(sample => sample.name === name)).toMatchObject({
        type, values: [{ labels: { cell_id: 'cell-a' }, value: reading }],
      })
    }
    rejected = 31; foreign = 0
    const second = syncCellOwnershipMetricSamples(cell, NOW + 1000, readers)
    expect(cell.calls()).toBe(2)
    expect(storageReads).toBe(2)
    expect(fleetReads).toBe(2)
    for (const [suffix, reading] of Object.entries({ ready: 1, owned_workspaces: 5,
      expected_workspaces: 5, partition_conflicts_total: 8, partition_loss_total: 12,
      foreign_resident_projectors: 0, topology_state: 0, fence_rejections_total: 31 })) {
      expect(value(second, `maplespire_sync_cell_${suffix}`)).toBe(reading)
    }
  })

  it('preserves unavailable storage and fleet readings as NaN, and a measured zero as zero', () => {
    for (const readers of [undefined, {
      storageFenceRejections: () => null, foreignResidentProjectors: () => null,
    }]) {
      const samples = syncCellOwnershipMetricSamples(coordinator(snapshot()), NOW, readers)
      const text = renderPrometheus(samples)
      for (const suffix of ['fence_rejections_total', 'foreign_resident_projectors']) {
        expect(value(samples, `maplespire_sync_cell_${suffix}`)).toBeNaN()
        expect(text).toContain(`maplespire_sync_cell_${suffix}{cell_id="cell-a"} NaN\n`)
      }
    }
    const measured = syncCellOwnershipMetricSamples(coordinator(snapshot()), NOW, {
      storageFenceRejections: () => 0, foreignResidentProjectors: () => 0,
    })
    expect(value(measured, 'maplespire_sync_cell_fence_rejections_total')).toBe(0)
    expect(value(measured, 'maplespire_sync_cell_foreign_resident_projectors')).toBe(0)
  })

  it('keeps superseded topology visible after confirmation and after successful stand down', () => {
    for (const standDownActive of [false, true]) {
      const samples = syncCellOwnershipMetricSamples(coordinator(snapshot({
        topologyConfirmed: true, supersededByGeneration: true, standDownActive,
      })))
      expect(value(samples, 'maplespire_sync_cell_topology_state')).toBe(2)
      expect(value(samples, 'maplespire_sync_cell_stood_down')).toBe(standDownActive ? 1 : 0)
    }
  })

  it('uses only the configured cell identity even as workspace counts change', () => {
    const cellId = 'cell-"quoted"\\line\nnext'
    const cell = coordinator(snapshot({ cellId, ownedWorkspaceCount: 1 }),
      snapshot({ cellId, ownedWorkspaceCount: 1000 }))
    for (let scrape = 0; scrape < 2; scrape++) {
      const samples = syncCellOwnershipMetricSamples(cell)
      const newSeries = samples.filter(sample => sample.values.some(entry => entry.labels?.cell_id))
      expect(newSeries).toHaveLength(8)
      for (const sample of newSeries) expect(sample.values.map(entry => entry.labels)).toEqual([{ cell_id: cellId }])
      expect(renderPrometheus(newSeries)).toContain('cell_id="cell-\\"quoted\\"\\\\line\\nnext"')
    }
  })

  it('distinguishes no route sample, a fresh empty sample and failed refreshes', () => {
    const absent = syncCellOwnershipMetricSamples(coordinator(snapshot()))
    expect(value(absent, 'maplespire_sync_cell_owner_route_map_sample_age_seconds')).toBeNaN()
    expect(value(absent, 'maplespire_sync_cell_owner_route_map_usable')).toBe(0)
    const sampled = syncCellOwnershipMetricSamples(coordinator(snapshot({ ownerRouteMap: {
      ...SNAPSHOT.ownerRouteMap, usable: true, sampleAgeMs: 250, sampleSequence: 1,
      sampledAt: '2026-09-09T00:00:00Z', refreshCount: 4, refreshErrorCount: 3,
    } })))
    expect(value(sampled, 'maplespire_sync_cell_owner_route_map_sample_age_seconds')).toBe(0.25)
    expect(value(sampled, 'maplespire_sync_cell_owner_route_map_usable')).toBe(1)
    expect(value(sampled, 'maplespire_sync_cell_owner_route_map_refresh_total')).toBe(4)
    expect(value(sampled, 'maplespire_sync_cell_owner_route_map_refresh_errors_total')).toBe(3)
    expect(value(sampled, 'maplespire_sync_cell_owner_route_map_max_age_seconds')).toBe(3)
  })
  it('publishes the closed drain reason labels and the supplied workspace move count', () => {
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot({
      lossByReason: { 'workspace-moved': 3, 'workspace-retired': 2 },
    })))
    const series = samples.find(sample => sample.name === 'maplespire_sync_cell_workspace_losses_by_reason_total')!
    expect(series.type).toBe('counter')
    expect(series.values).toEqual([
      { labels: { reason: 'partition-unavailable' }, value: 0 },
      { labels: { reason: 'partition-expired' }, value: 0 },
      { labels: { reason: 'workspace-lease-lost' }, value: 0 },
      { labels: { reason: 'workspace-lease-expired' }, value: 0 },
      { labels: { reason: 'workspace-retired' }, value: 2 },
      { labels: { reason: 'workspace-moved' }, value: 3 },
    ])
  })
  it('publishes nothing at all for a process that has no coordinator', () => {
    // `null` is what `index.ts` holds before the coordinator is constructed, and
    // the field is typed that way — so this branch answers the TYPE. A flat
    // `..._fence_divergences_seen 0` from a process that is not a sync cell
    // would not be a reassuring reading, it would be a fabricated one.
    expect(syncCellOwnershipMetricSamples(null)).toEqual([])
  })

  it('publishes exactly the contracted set of series, no more and no fewer', () => {
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot()))
    expect(samples.map((sample) => sample.name).sort()).toEqual([...EXPECTED_SERIES].sort())
  })

  it('the T-13g gauges carry the right VALUE, in both directions', () => {
    // `EXPECTED_SERIES` asserts the NAME, `typeOf` asserts the TYPE, and
    // neither looks at the number, so an inverted gauge (`? 1 : 0` → `? 0 : 1`)
    // needs this test. The promtool fixtures cannot see it either:
    // `infra/monitoring/alerts.test.yml` supplies the series by hand.
    //
    // `SyncCellSupersededGeneration` matches `== 1`, so an inverted gauge opens
    // a ticket on every healthy cell for ever and stays silent through the
    // actual incident.
    const healthy = syncCellOwnershipMetricSamples(coordinator(snapshot()))
    expect(value(healthy, 'maplespire_sync_cell_superseded_by_generation')).toBe(0)
    expect(value(healthy, 'maplespire_sync_cell_stood_down')).toBe(0)

    // SUPERSEDED, NOT YET HANDED OVER — the incident the alert fires on.
    const stranded = syncCellOwnershipMetricSamples(
      coordinator(snapshot({ supersededByGeneration: true })),
    )
    expect(value(stranded, 'maplespire_sync_cell_superseded_by_generation')).toBe(1)
    expect(value(stranded, 'maplespire_sync_cell_stood_down')).toBe(0)

    // SUPERSEDED AND HANDED OVER — the success. Both at 1, and the alert's
    // `stood_down == 0` half is what keeps it silent here. Asserting the pair
    // rather than each alone is the point: the two gauges are only meaningful
    // together, and an implementation that tied one to the other would pass
    // any test that read them separately.
    const handedOver = syncCellOwnershipMetricSamples(
      coordinator(snapshot({ supersededByGeneration: true, standDownActive: true })),
    )
    expect(value(handedOver, 'maplespire_sync_cell_superseded_by_generation')).toBe(1)
    expect(value(handedOver, 'maplespire_sync_cell_stood_down')).toBe(1)
  })

  it('says the feature is ON when it is on, and OFF when it is off', () => {
    // BOTH directions. The alert rules carry `and on (instance, job)
    // ..._enabled == 1`, so pinning this gauge to a constant 0 makes the fence
    // alerts permanently silent on every cell — while every promtool fixture
    // stays green, because the fixtures supply the series by hand.
    expect(value(syncCellOwnershipMetricSamples(coordinator(snapshot())),
      'maplespire_sync_cell_ownership_enabled')).toBe(1)
    expect(value(syncCellOwnershipMetricSamples(coordinator(snapshot({ enabled: false }))),
      'maplespire_sync_cell_ownership_enabled')).toBe(0)
  })

  it('still publishes when ownership is DISABLED — the coordinator exists', () => {
    // Different from the no-coordinator case, and the difference is the point:
    // "this cell's fence detector reports nothing" is a fact about the cell.
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot({ enabled: false })))
    expect(samples.map((sample) => sample.name).sort()).toEqual([...EXPECTED_SERIES].sort())
  })

  it('renders an UNKNOWN reading as NaN and never as zero', () => {
    // The three `null` states are "no pass yet", "the reading threw", and "the
    // lease set changed under the reading". None of them is "no divergence".
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot({
      fenceDivergencesSeen: null,
      fenceDivergenceByCause: null,
      fenceReadingObservedAt: null,
      fenceReadingCurrent: false,
      durableFencesWithoutSequence: null,
      durableFenceSurveyObservedAt: null,
    })))
    expect(value(samples, 'maplespire_sync_cell_fence_divergences_seen')).toBeNaN()
    expect(value(samples, 'maplespire_sync_cell_durable_fences_without_sequence_at_boot')).toBeNaN()
    expect(value(samples, 'maplespire_sync_cell_durable_fence_survey_age_seconds')).toBeNaN()
    expect(value(samples, 'maplespire_sync_cell_fence_reading_age_seconds')).toBeNaN()
    // The topology-created bit: `null` here is a THIRD state that 1/0 cannot express:
    // `start()` has not run. Publishing it as 0 would say "this cell did not
    // create the topology key", which is a claim about the world rather than
    // about the reading.
    expect(value(
      syncCellOwnershipMetricSamples(coordinator(snapshot({ topologyKeyCreatedAtBoot: null }))),
      'maplespire_sync_cell_topology_created_at_boot',
    )).toBeNaN()
    const byCause = samples.find((s) => s.name === 'maplespire_sync_cell_fence_divergences_by_cause')!
    expect(byCause.values).toHaveLength(5)
    for (const entry of byCause.values) expect(entry.value).toBeNaN()

    // ...but the VALIDITY series is a real 0, not NaN. That is the whole reason
    // it exists: for an alert, `NaN > 0` is false, so an unknown reading and a
    // healthy one are the same fact and a blind detector pages nobody. This is
    // the one number that can still be compared while every neighbour is NaN.
    expect(value(samples, 'maplespire_sync_cell_fence_reading_current')).toBe(0)

    // Through the RENDERER, not only through the object: `renderPrometheus` is
    // where a non-finite value becomes the literal `NaN`, and asserting only on
    // the sample would leave a renderer that coerced to 0 undetected.
    const text = renderPrometheus(samples)
    expect(text).toMatch(/^maplespire_sync_cell_fence_divergences_seen NaN$/m)
    expect(text).not.toMatch(/^maplespire_sync_cell_fence_divergences_seen 0$/m)
    expect(text).toMatch(/^maplespire_sync_cell_fence_reading_current 0$/m)
  })

  it('splits the reading by cause, because the causes have opposite remedies', () => {
    // `released` is the SUCCESS condition of `restore:reset-routing`, and
    // `absent`/`belowLive` are repaired inside the pass that counts them. A rule
    // written on the total fires on a correct restore and stays quiet on a wedge
    // nobody is fixing — which is why the alert is on two causes and not on
    // this scalar.
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot({
      fenceDivergencesSeen: 4,
      fenceDivergenceByCause: {
        belowLive: 1, aboveLive: 1, released: 1, absent: 1, foreignCellAtSameToken: 2,
      },
    })))
    const byCause = samples.find((s) => s.name === 'maplespire_sync_cell_fence_divergences_by_cause')!
    expect(Object.fromEntries(byCause.values.map((entry) => [entry.labels!.cause, entry.value]))).toEqual({
      belowLive: 1, aboveLive: 1, released: 1, absent: 1, foreignCellAtSameToken: 2,
    })
    // The total EXCLUDES the foreign-cell observation, and the two series must
    // stay independently readable: the gate does not test `cell_id`, so those
    // writes are admitted and folding them into the total would inflate the
    // number an operator uses to decide whether writes are being refused.
    expect(value(samples, 'maplespire_sync_cell_fence_divergences_seen')).toBe(4)
  })

  it('FOLLOWS the coordinator rather than latching its first reading', () => {
    // A builder that caches publishes the boot value for ever and every scrape
    // agrees with every other one, so a dashboard shows a perfectly steady line
    // for a detector that stopped reporting.
    //
    // Asserted through ONE coordinator answering twice, not two calls with two
    // arguments: the second shape only proves the function is pure over its
    // argument, and a latch would live at the call site.
    const cell = coordinator(
      snapshot({ fenceDivergencesSeen: 0, fenceRepairCount: 0 }),
      snapshot({ fenceDivergencesSeen: 7, fenceRepairCount: 3 }),
    )
    const first = syncCellOwnershipMetricSamples(cell)
    const second = syncCellOwnershipMetricSamples(cell)
    expect(cell.calls(), 'the builder did not read the coordinator on every call').toBe(2)
    expect(value(first, 'maplespire_sync_cell_fence_divergences_seen')).toBe(0)
    expect(value(second, 'maplespire_sync_cell_fence_divergences_seen')).toBe(7)
    expect(value(first, 'maplespire_sync_cell_fence_repairs_total')).toBe(0)
    expect(value(second, 'maplespire_sync_cell_fence_repairs_total')).toBe(3)
  })

  it('publishes the topology bit in all THREE states, not just the unknown one', () => {
    // Flipped polarity, a constant 0, and the HEALTHY state (`false`) rendering
    // NaN would all pass a test that only checked `null` → NaN. The last is the
    // worst: `false` rendering NaN is indistinguishable from a blind detector,
    // the exact failure `..._fence_reading_current` exists to prevent.
    const at = (topologyKeyCreatedAtBoot: boolean | null) => value(
      syncCellOwnershipMetricSamples(coordinator(snapshot({ topologyKeyCreatedAtBoot }))),
      'maplespire_sync_cell_topology_created_at_boot',
    )
    expect(at(true)).toBe(1)
    expect(at(false)).toBe(0)
    expect(at(null)).toBeNaN()
  })

  it('publishes the detector’s OWN failure count', () => {
    // Without it, the fence detector throwing on every pass is invisible to
    // Prometheus: the catch publishes null, every fence series renders NaN,
    // `NaN > 0` is false, and no rule fires.
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot({ errorCount: 4 })))
    expect(value(samples, 'maplespire_sync_cell_ownership_errors_total')).toBe(4)
  })

  it('carries each reading’s epoch: the boot one in its NAME, both as ages', () => {
    // The world-mismatch survey is read once, between `ensureTopology` and the
    // first reconcile, and never again. The fence-divergence reading is re-read
    // every pass but can stop being re-read at all if a pass stalls. Both need
    // an age beside them.
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot({
      durableFencesWithoutSequence: 2,
    })), NOW)
    expect(value(samples, 'maplespire_sync_cell_durable_fences_without_sequence_at_boot')).toBe(2)
    expect(value(samples, 'maplespire_sync_cell_durable_fence_survey_age_seconds')).toBe(300)
    expect(value(samples, 'maplespire_sync_cell_fence_reading_age_seconds')).toBe(30)
    // A series whose name does not say it is a boot reading would mislead, so
    // the name is asserted.
    expect(samples.map((sample) => sample.name)).toContain(
      'maplespire_sync_cell_durable_fences_without_sequence_at_boot',
    )
  })

  it('reports a malformed timestamp as NaN rather than as a plausible age', () => {
    // `Date.parse` of nonsense is NaN, and NaN seconds is the honest answer. The
    // failure to avoid is a large-but-finite number that reads as a stale
    // reading somebody then investigates.
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot({
      fenceReadingObservedAt: 'not-a-timestamp',
    })), NOW)
    expect(value(samples, 'maplespire_sync_cell_fence_reading_age_seconds')).toBeNaN()
    expect(renderPrometheus(samples)).toMatch(/^maplespire_sync_cell_fence_reading_age_seconds NaN$/m)
  })

  it('declares cumulative totals as counters and current states as gauges', () => {
    // The TYPE declares the contract. PromQL over classic float samples can
    // still evaluate rate/increase after a mistyped export, so a passing alert
    // fixture does not validate that declaration.
    const samples = syncCellOwnershipMetricSamples(coordinator(snapshot()))
    const typeOf = (name: string) => samples.find((sample) => sample.name === name)?.type
    expect(typeOf('maplespire_sync_cell_fence_repairs_total')).toBe('counter')
    expect(typeOf('maplespire_sync_cell_fence_repair_failures_total')).toBe('counter')
    expect(typeOf('maplespire_sync_cell_ownership_errors_total')).toBe('counter')
    // SyncCellCrossGenerationRefusal reads increase(...[10m]) > 0. Its input is
    // cumulative and may reset with the process; the TYPE must say so too.
    expect(typeOf('maplespire_sync_cell_cross_generation_refusals_total')).toBe('counter')
    // GAUGE, and the pair is deliberate: this one is a STATE that can go back to
    // 0 when the contract is restored, so typing it as a counter would make
    // `increase()` over it report a rise on every recovery.
    expect(typeOf('maplespire_sync_cell_superseded_by_generation')).toBe('gauge')
    expect(typeOf('maplespire_sync_cell_stood_down')).toBe('gauge')
    expect(typeOf('maplespire_sync_cell_fence_divergences_seen')).toBe('gauge')
    expect(typeOf('maplespire_sync_cell_fence_reading_current')).toBe('gauge')
    expect(typeOf('maplespire_sync_cell_durable_fences_without_sequence_at_boot')).toBe('gauge')
    // The list has to GROW with the series set, or it decays into a check on
    // whichever few somebody happened to enumerate.
    expect(typeOf('maplespire_sync_cell_topology_created_at_boot')).toBe('gauge')
    expect(typeOf('maplespire_sync_cell_boot_observed_age_seconds')).toBe('gauge')
    // Every contracted series is typed by this test, so adding one without
    // typing it is red rather than silently uncovered.
    expect(new Set(samples.map((sample) => sample.name)).size).toBe(EXPECTED_SERIES.length)
    for (const name of EXPECTED_SERIES) expect(typeOf(name), `${name} has no type`).toBeDefined()
  })
})
