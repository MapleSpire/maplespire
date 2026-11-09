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

import {
  lightweightSynchronizerPeerSnapshot,
  type AutomergeTransportSnapshot,
  type LightweightSynchronizerPeerSource,
} from './automergeTransportTelemetry.js'
import type { OrdinaryHeadRotationConfig } from './readModel/ordinaryHeadRotation.js'
import {
  ordinaryRotationTelemetry,
  type OrdinaryRotationTelemetry,
} from './readModel/ordinaryRotationTelemetry.js'

/**
 * The body of `GET /api/automerge/stats` (`index.ts`), built here so it is
 * testable: nothing in CI mounts that route. Every input is read by the route
 * on each request; this only assembles it.
 *
 * Privacy-minimized: no peer, user, organization or document identifier. ONE
 * exception, since G4-16e: `ordinaryHeadRotation` names the workspaces this
 * cell ROTATES (`landscapeId/versionId`), each one named by an operator in
 * `AM_ORDINARY_HEAD_ROTATION_WORKSPACE_ALLOWLIST` (`on` refuses `*`). The
 * load-soak bench copies them into its evidence (`rotationByService`).
 */
export interface AutomergeStatsBodyInput {
  processBootId: string
  handleStates: readonly string[]
  syncStateLookup: Record<string, number>
  joinedConnections: number
  synchronizer: LightweightSynchronizerPeerSource & {
    retirementMetrics?: () => { count: number; limit: number; overLimit: boolean }
  }
  transport: AutomergeTransportSnapshot
  /** Required, so a route that forgets the rotation block does not compile. */
  ordinaryHeadRotation: {
    config: OrdinaryHeadRotationConfig
    telemetry?: OrdinaryRotationTelemetry
  }
  now?: Date
}

export function automergeStatsBody(input: AutomergeStatsBodyInput) {
  const byState: Record<string, number> = {}
  for (const state of input.handleStates) byState[state] = (byState[state] ?? 0) + 1
  const telemetry = input.ordinaryHeadRotation.telemetry ?? ordinaryRotationTelemetry
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    // The same per-process identity the residency snapshot carries. The
    // counters below are diffed by the caller at window edges, so the caller
    // needs this to detect a restart inside the window (otherwise a reset
    // `documentsWithPeers` reads as a peer-binding drop).
    processBootId: input.processBootId,
    totalHandles: input.handleStates.length,
    // Monotonic, diffed by the caller at the window edges. Never reset
    // here: a counter reset by a path other than the one that owns the window
    // describes a different interval than everything it is compared against.
    syncStateLookup: { ...input.syncStateLookup },
    byState,
    joinedConnections: input.joinedConnections,
    synchronizer: {
      ...lightweightSynchronizerPeerSnapshot(input.synchronizer),
      retiredDocuments: input.synchronizer.retirementMetrics?.() ?? null,
    },
    transport: input.transport,
    // G4-16e. Read from what the projectors hold; no document load, no SQL.
    ordinaryHeadRotation: telemetry.snapshot(input.ordinaryHeadRotation.config),
  }
}
