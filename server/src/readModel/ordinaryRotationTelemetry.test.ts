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
  DEFAULT_ORDINARY_CHAIN_ALERT_LENGTH,
  ORDINARY_CHAIN_ALERT_LENGTH_ENV,
  ORDINARY_CHAIN_FOLD_FLAG,
  ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV,
  ORDINARY_HEAD_ROTATION_FLAG,
  ORDINARY_HEAD_ROTATION_OFF,
  ordinaryHeadRotationConfig,
  type OrdinaryHeadRotationConfig,
} from './ordinaryHeadRotation.js'
import {
  OrdinaryRotationTelemetry,
  ordinaryChainAlertLength,
  ordinaryChainUnboundedBootWarning,
  ordinaryChainUnboundedConfig,
  ordinaryRotationMetricSamples,
  type OrdinaryRotationLiveView,
} from './ordinaryRotationTelemetry.js'

const WS = { landscapeId: 'land-a', versionId: 'ver-1' }
const OTHER = { landscapeId: 'land-b', versionId: 'ver-2' }
const on = (overrides: Partial<OrdinaryHeadRotationConfig> = {}): OrdinaryHeadRotationConfig => ({
  mode: 'on', allowlist: new Set(['land-a/ver-1']), maxActors: 128, maxChanges: 512, chainAlertLength: 4, ...overrides,
})
const foldOn = (overrides: Partial<OrdinaryHeadRotationConfig> = {}) =>
  on({ chainFold: { minChain: 2, budget: 8, retainMs: 1 }, ...overrides })
const START = Date.parse('2026-11-04T12:00:00.000Z')
const DAY = 86_400_000

function subject(start = START) {
  let now = start
  const lines: Array<Record<string, unknown>> = []
  const telemetry = new OrdinaryRotationTelemetry(() => now, (line) => { lines.push(JSON.parse(line)) })
  return { telemetry, lines, advance: (ms: number) => { now += ms } }
}

type KindView = {
  shards: number | null; overlay: number | null; parked: number; retired: number; folded: number
  createdAtMs: number[]; head: { actors: number; changes: number } | null
}
function view(overrides: Partial<Record<'object' | 'connection', Partial<KindView>>> = {}): OrdinaryRotationLiveView {
  const of = (kind: 'object' | 'connection'): KindView => ({
    shards: 3, overlay: 2, parked: 0, retired: 1, folded: 0, createdAtMs: [START - 1_000],
    head: { actors: 5, changes: 40 }, ...overrides[kind],
  })
  return {
    listed: (kind) => ({ shards: of(kind).shards, overlay: of(kind).overlay }),
    parkedHeads: (kind) => of(kind).parked,
    rows: (kind) => ({ retired: of(kind).retired, folded: of(kind).folded, createdAtMs: of(kind).createdAtMs }),
    currentHead: (kind) => of(kind).head,
  }
}
const find = (telemetry: OrdinaryRotationTelemetry, config: OrdinaryHeadRotationConfig, workspace: string, collection: string) =>
  telemetry.snapshot(config).entries.find((e) => e.workspace === workspace && e.collection === collection)

describe('ordinaryRotationTelemetry — counters', () => {
  it('counts this process\'s rotations per workspace, kind and trigger', () => {
    const { telemetry, advance } = subject()
    telemetry.recordRotation(WS, 'object', 'changes')
    advance(3_600_000)
    telemetry.recordRotation(WS, 'object', 'actors')
    telemetry.recordRotation(WS, 'object', null)
    telemetry.recordRotation(WS, 'connection', 'both')
    telemetry.recordRotation(OTHER, 'object', 'changes')
    expect(find(telemetry, on(), 'land-a/ver-1', 'object')).toMatchObject({
      rotations: 3, rotationsByTrigger: { actors: 1, changes: 1, both: 0, unknown: 1 }, resident: false,
      lastRotatedAt: new Date(START + 3_600_000).toISOString(),
      // Never observed live: no durable rate, not 0.
      rotationsLast24h: null, rotationsLast7d: null, rotationsLast30d: null,
    })
    expect(find(telemetry, on(), 'land-a/ver-1', 'connection')).toMatchObject({ rotations: 1, rotationsByTrigger: { both: 1 } })
    expect(find(telemetry, on(), 'land-b/ver-2', 'object')).toMatchObject({ rotations: 1 })
  })

  it('the durable rate comes from the rows\' created_at, in 24 h / 7 d / 30 d windows, as time passes', () => {
    const { telemetry, advance } = subject()
    const createdAtMs = [START - 40 * DAY, START - 20 * DAY, START - 3 * DAY, START - 2 * 3_600_000, START - 60_000]
    telemetry.register(WS, view({ object: { createdAtMs } }))
    expect(find(telemetry, on(), 'land-a/ver-1', 'object')).toMatchObject({
      rotationsLast24h: 2, rotationsLast7d: 3, rotationsLast30d: 4,
      // Independent of this process's own count: a restart loses that, not this.
      rotations: 0,
    })
    advance(DAY)
    expect(find(telemetry, on(), 'land-a/ver-1', 'object')).toMatchObject({ rotationsLast24h: 0, rotationsLast7d: 3, rotationsLast30d: 4 })
  })

  it('reads the live fields from the registered view', () => {
    const { telemetry } = subject()
    telemetry.register(WS, view({ object: { shards: 30, overlay: 7, parked: 5, retired: 6, folded: 1, head: { actors: 12, changes: 99 } } }))
    telemetry.recordRotation(WS, 'object', 'changes')
    const live = telemetry.snapshot(on()).entries
    expect(live.map((e) => `${e.workspace}/${e.collection}`)).toEqual(['land-a/ver-1/connection', 'land-a/ver-1/object'])
    expect(live[1]).toMatchObject({
      workspace: 'land-a/ver-1', collection: 'object', resident: true, observedAt: new Date(START).toISOString(),
      rotations: 1, listedShards: 30, overlayChain: 7, parkedHeads: 5,
      retiredRows: 6, foldedRows: 1, currentHead: { actors: 12, changes: 99 }, chainAlert: true,
    })
  })

  it('NOT RESIDENT: keeps the last known chain and rows (and so the alert), drops parked heads and the current head', () => {
    const { telemetry, advance } = subject()
    let overlay = 6
    const unregister = telemetry.register(WS, { ...view({ object: { parked: 5 } }), listed: () => ({ shards: 20, overlay }) })
    // Grows after the last scrape: unregister reads it once more.
    overlay = 9
    advance(1_000)
    unregister()
    advance(60_000)
    const gone = find(telemetry, on(), 'land-a/ver-1', 'object')
    expect(gone).toMatchObject({
      resident: false, observedAt: new Date(START + 1_000).toISOString(),
      overlayChain: 9, listedShards: 20, retiredRows: 1, foldedRows: 0, rotationsLast24h: 1,
      parkedHeads: null, currentHead: null, chainAlert: true,
    })
    expect(telemetry.snapshot(on()).chainAlerts).toBe(2)
    // A ModelMeta that is not resident (null lists) keeps what was known.
    telemetry.register(WS, view({ object: { shards: null, overlay: null } }))
    expect(find(telemetry, on(), 'land-a/ver-1', 'object')).toMatchObject({ resident: true, overlayChain: 9, listedShards: 20 })
  })

  it('observeChain alone (no scrape while resident) is remembered too', () => {
    const { telemetry } = subject()
    telemetry.observeChain(WS, 'connection', 11, on(), 12)
    expect(find(telemetry, on(), 'land-a/ver-1', 'connection')).toMatchObject({ resident: false, overlayChain: 11, listedShards: 12, chainAlert: true })
  })

  it('a re-attach replaces the view, and the earlier projector\'s unregister leaves the new one', () => {
    const { telemetry } = subject()
    const stopFirst = telemetry.register(WS, view({ object: { overlay: 1 } }))
    const stopSecond = telemetry.register(WS, view({ object: { overlay: 9 } }))
    stopFirst()
    expect(find(telemetry, on(), 'land-a/ver-1', 'object')).toMatchObject({ resident: true, overlayChain: 9 })
    stopSecond()
    expect(find(telemetry, on(), 'land-a/ver-1', 'object')).toMatchObject({ resident: false, overlayChain: 9 })
  })

  it('a view that throws costs the entry its live fields, never the snapshot', () => {
    const { telemetry } = subject()
    telemetry.register(WS, { ...view(), listed: () => { throw new Error('boom') } })
    const entries = telemetry.snapshot(on()).entries
    expect(entries).toHaveLength(2)
    for (const entry of entries) expect(entry).toMatchObject({ resident: false, overlayChain: null })
  })
})

describe('ordinaryRotationTelemetry — the fold-off chain alert', () => {
  it('flags only an overlay list LONGER than the threshold, with rotation on and the fold off', () => {
    const { telemetry } = subject()
    telemetry.register(WS, view({ object: { shards: 9, overlay: 5 }, connection: { shards: 9, overlay: 4 } }))
    const snapshot = telemetry.snapshot(on())
    expect(snapshot).toMatchObject({ mode: 'on', chainFold: false, unboundedChainConfig: true, chainAlertLength: 4, chainAlerts: 1 })
    expect(snapshot.entries.find((e) => e.collection === 'object')?.chainAlert).toBe(true)
    // At the threshold is not over it; the read order (9) is not the subject.
    expect(snapshot.entries.find((e) => e.collection === 'connection')?.chainAlert).toBe(false)
    for (const config of [foldOn(), on({ chainAlertLength: 0 }), on({ mode: 'shadow' }), ORDINARY_HEAD_ROTATION_OFF]) {
      const quiet = telemetry.snapshot(config)
      expect(quiet.chainAlerts).toBe(0)
      expect(quiet.chainAlertLength).toBe(0)
      expect(quiet.entries.every((e) => !e.chainAlert)).toBe(true)
    }
  })

  it('logs once on the crossing, not on every later observation, and again after falling back under', () => {
    const { telemetry, lines } = subject()
    expect(telemetry.observeChain(WS, 'object', 4, on(), 20)).toBe(false)
    expect(lines).toEqual([])
    expect(telemetry.observeChain(WS, 'object', 5, on(), 21)).toBe(true)
    expect(telemetry.observeChain(WS, 'object', 6, on(), 22)).toBe(true)
    expect(lines).toEqual([{
      event: 'read_model.ordinary_chain_length_alert', workspace: 'land-a/ver-1', kind: 'object',
      overlay: 5, shards: 21, threshold: 4, chainFold: 'off',
    }])
    telemetry.observeChain(WS, 'connection', 5, on())
    telemetry.observeChain(OTHER, 'object', 5, on())
    expect(lines).toHaveLength(3)
    telemetry.observeChain(WS, 'object', 3, on())
    telemetry.observeChain(WS, 'object', 7, on())
    expect(lines).toHaveLength(4)
    expect(lines[3]).toMatchObject({ overlay: 7 })
  })

  it('never logs with the fold on, the alert disabled, or no ModelMeta', () => {
    const { telemetry, lines } = subject()
    expect(telemetry.observeChain(WS, 'object', 500, foldOn())).toBe(false)
    expect(telemetry.observeChain(WS, 'object', 500, on({ chainAlertLength: 0 }))).toBe(false)
    expect(telemetry.observeChain(WS, 'object', null, on())).toBe(false)
    expect(lines).toEqual([])
  })

  it('the threshold: the default when unset, 0 with the fold on or rotation not on', () => {
    expect(ordinaryChainAlertLength(on({ chainAlertLength: undefined }))).toBe(DEFAULT_ORDINARY_CHAIN_ALERT_LENGTH)
    expect(ordinaryChainAlertLength(on({ chainAlertLength: 9 }))).toBe(9)
    expect(ordinaryChainAlertLength(foldOn({ chainAlertLength: 9 }))).toBe(0)
    expect(ordinaryChainAlertLength(on({ mode: 'shadow', chainAlertLength: 9 }))).toBe(0)
  })

  it('the risky configuration: rotation on, something listed, fold off — and its boot line', () => {
    expect(ordinaryChainUnboundedConfig(on())).toBe(true)
    for (const config of [foldOn(), on({ allowlist: new Set() }), on({ mode: 'shadow' }), ORDINARY_HEAD_ROTATION_OFF]) {
      expect(ordinaryChainUnboundedConfig(config)).toBe(false)
      expect(ordinaryChainUnboundedBootWarning(config)).toBeNull()
    }
    expect(JSON.parse(ordinaryChainUnboundedBootWarning(on())!)).toMatchObject({
      event: 'read_model.ordinary_chain_unbounded_config', rotation: 'on', chainFold: 'off', workspaces: 1, chainAlertLength: 4,
    })
  })
})

describe('ordinaryRotationMetricSamples — /metrics, no workspace label', () => {
  const value = (samples: ReturnType<typeof ordinaryRotationMetricSamples>, name: string, labels?: Record<string, string>) =>
    samples.find((s) => s.name === name)?.values.find((v) => JSON.stringify(v.labels ?? {}) === JSON.stringify(labels ?? {}))?.value

  it('alerts, longest chain per collection, the risky config, rotations by collection and trigger', () => {
    const { telemetry } = subject()
    telemetry.register(WS, view({ object: { overlay: 7 }, connection: { overlay: 2 } }))
    telemetry.observeChain(OTHER, 'object', 12, on())
    telemetry.recordRotation(WS, 'object', 'changes')
    telemetry.recordRotation(OTHER, 'object', 'changes')
    telemetry.recordRotation(WS, 'connection', 'actors')
    const samples = ordinaryRotationMetricSamples(on(), telemetry)
    expect(value(samples, 'maplespire_read_model_ordinary_chain_alerts')).toBe(2)
    expect(value(samples, 'maplespire_read_model_ordinary_overlay_chain_max', { collection: 'object' })).toBe(12)
    expect(value(samples, 'maplespire_read_model_ordinary_overlay_chain_max', { collection: 'connection' })).toBe(2)
    expect(value(samples, 'maplespire_read_model_ordinary_rotation_unbounded_chain')).toBe(1)
    expect(value(samples, 'maplespire_read_model_ordinary_head_rotations_total', { collection: 'object', trigger: 'changes' })).toBe(2)
    expect(value(samples, 'maplespire_read_model_ordinary_head_rotations_total', { collection: 'connection', trigger: 'actors' })).toBe(1)
    expect(value(samples, 'maplespire_read_model_ordinary_head_rotations_total', { collection: 'object', trigger: 'actors' })).toBe(0)
    expect(samples.find((s) => s.name === 'maplespire_read_model_ordinary_head_rotations_total')?.type).toBe('counter')
    // No sample carries a workspace.
    for (const sample of samples) for (const v of sample.values) {
      expect(Object.keys(v.labels ?? {}).every((label) => label === 'collection' || label === 'trigger')).toBe(true)
    }
  })

  it('an idle cell: zeros, not absent series; fold on: no alert and no risky config', () => {
    const empty = ordinaryRotationMetricSamples(on(), subject().telemetry)
    expect(value(empty, 'maplespire_read_model_ordinary_chain_alerts')).toBe(0)
    expect(value(empty, 'maplespire_read_model_ordinary_overlay_chain_max', { collection: 'object' })).toBe(0)
    expect(empty.find((s) => s.name === 'maplespire_read_model_ordinary_head_rotations_total')?.values).toHaveLength(8)
    const { telemetry } = subject()
    telemetry.observeChain(WS, 'object', 500, foldOn())
    const folded = ordinaryRotationMetricSamples(foldOn(), telemetry)
    expect(value(folded, 'maplespire_read_model_ordinary_chain_alerts')).toBe(0)
    expect(value(folded, 'maplespire_read_model_ordinary_rotation_unbounded_chain')).toBe(0)
    expect(value(folded, 'maplespire_read_model_ordinary_overlay_chain_max', { collection: 'object' })).toBe(500)
  })
})

describe(`${ORDINARY_CHAIN_ALERT_LENGTH_ENV} parse`, () => {
  const rotationOn = { [ORDINARY_HEAD_ROTATION_FLAG]: 'on', [ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]: 'l/v' }

  it('defaults to 64, reads a value, and an explicit 0 disables', () => {
    expect(ordinaryHeadRotationConfig(rotationOn).chainAlertLength).toBe(64)
    expect(ordinaryHeadRotationConfig({ ...rotationOn, [ORDINARY_CHAIN_ALERT_LENGTH_ENV]: '200' }).chainAlertLength).toBe(200)
    expect(ordinaryHeadRotationConfig({ ...rotationOn, [ORDINARY_CHAIN_ALERT_LENGTH_ENV]: '0' }).chainAlertLength).toBe(0)
  })

  it('a blank or garbage keeps the default (never the 0 a blank would coerce to)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const raw of ['', ' ', 'many', '-1', '2.5']) {
        expect(ordinaryHeadRotationConfig({ ...rotationOn, [ORDINARY_CHAIN_ALERT_LENGTH_ENV]: raw }).chainAlertLength).toBe(64)
      }
    } finally { warn.mockRestore() }
  })

  it('is not read with rotation off, and is carried with the fold on (where it does not fire)', () => {
    expect(ordinaryHeadRotationConfig({ [ORDINARY_CHAIN_ALERT_LENGTH_ENV]: '7' }).chainAlertLength).toBeUndefined()
    const folded = ordinaryHeadRotationConfig({ ...rotationOn, [ORDINARY_CHAIN_FOLD_FLAG]: 'on', [ORDINARY_CHAIN_ALERT_LENGTH_ENV]: '7' })
    expect(folded.chainAlertLength).toBe(7)
    expect(ordinaryChainAlertLength(folded)).toBe(0)
  })
})
