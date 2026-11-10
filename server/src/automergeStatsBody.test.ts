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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { automergeStatsBody, type AutomergeStatsBodyInput } from './automergeStatsBody.js'
import type { AutomergeTransportSnapshot } from './automergeTransportTelemetry.js'
import type { OrdinaryHeadRotationConfig } from './readModel/ordinaryHeadRotation.js'
import { OrdinaryRotationTelemetry } from './readModel/ordinaryRotationTelemetry.js'

const config: OrdinaryHeadRotationConfig = {
  mode: 'on', allowlist: new Set(['ls/v1']), maxActors: 128, maxChanges: 512, chainAlertLength: 2,
}

function input(telemetry: OrdinaryRotationTelemetry): AutomergeStatsBodyInput {
  return {
    processBootId: 'boot-1',
    handleStates: ['ready', 'ready', 'loading'],
    syncStateLookup: { hits: 3 },
    joinedConnections: 4,
    synchronizer: {
      peers: ['p1', 'p2'],
      docSynchronizers: { d1: { hasPeer: (peer) => peer === 'p1' }, d2: { hasPeer: () => false } },
      retirementMetrics: () => ({ count: 1, limit: 10, overLimit: false }),
    },
    transport: { connections: { active: 1 } } as unknown as AutomergeTransportSnapshot,
    ordinaryHeadRotation: { config, telemetry },
    now: new Date('2026-11-04T12:00:00.000Z'),
  }
}

describe('GET /api/automerge/stats body (automergeStatsBody)', () => {
  it('carries the rotation block from the telemetry it is given, beside the existing fields', () => {
    const telemetry = new OrdinaryRotationTelemetry(() => Date.parse('2026-11-04T12:00:00.000Z'), () => {})
    telemetry.recordRotation({ landscapeId: 'ls', versionId: 'v1' }, 'object', 'changes')
    telemetry.observeChain({ landscapeId: 'ls', versionId: 'v1' }, 'object', 3, config, 9)
    const given = input(telemetry)
    const body = automergeStatsBody(given)
    expect(body).toMatchObject({
      generatedAt: '2026-11-04T12:00:00.000Z',
      processBootId: 'boot-1',
      totalHandles: 3,
      byState: { ready: 2, loading: 1 },
      syncStateLookup: { hits: 3 },
      joinedConnections: 4,
      synchronizer: { documentsObserved: 2, documentsWithPeers: 1, totalPeerBindings: 1, retiredDocuments: { count: 1 } },
      transport: { connections: { active: 1 } },
    })
    expect(body.ordinaryHeadRotation).toEqual(telemetry.snapshot(config))
    expect(body.ordinaryHeadRotation).toMatchObject({
      mode: 'on', unboundedChainConfig: true, chainAlerts: 1,
      entries: [expect.objectContaining({ workspace: 'ls/v1', collection: 'object', rotations: 1, overlayChain: 3, chainAlert: true })],
    })
    // A copy, not the live counters: mutating the body leaves the input's.
    body.syncStateLookup.hits = 99
    expect(given.syncStateLookup.hits).toBe(3)
  })

  it('the route builds its body here, with the boot config — the wiring nothing mounts', () => {
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const route = index.slice(index.indexOf("app.get('/api/automerge/stats'"))
    const handler = route.slice(0, route.indexOf('\n  })\n'))
    expect(handler).toContain('res.json(automergeStatsBody({')
    expect(handler).toContain('ordinaryHeadRotation: { config: ordinaryHeadRotation }')
    // The /metrics half of the same block.
    expect(index).toContain('metrics.push(...ordinaryRotationMetricSamples(ordinaryHeadRotation))')
  })
})
