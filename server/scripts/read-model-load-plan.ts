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

export const DEFAULT_ADR_COUNT = 100_000
export const DENSE_DIAGRAM_OBJECTS = 500
export const DENSE_DIAGRAM_CONNECTIONS = 20_000
export const REQUESTED_DEPENDENCY_HUBS = [1_000, 10_000, 100_000] as const

export interface ConnectionRange {
  first: number
  count: number
}

export interface DependencyHubPlan extends ConnectionRange {
  focusIndex: number
  focusId: string
  requestedPeers: number
  peerCount: number
}

export interface ReadModelLoadSeedPlan {
  objectCount: number
  connectionCount: number
  decisionRecordCount: number
  denseDiagram: ConnectionRange & {
    objectCount: number
    requestedObjects: number
    requestedConnections: number
  }
  dependencyHubs: DependencyHubPlan[]
  baselineConnections: ConnectionRange
  limitations: string[]
}

function objectId(index: number): string {
  return `obj-${String(index).padStart(6, '0')}`
}

/**
 * Reserve deterministic, non-overlapping connection ranges for adversarial
 * fixtures while keeping the configured total cardinalities exact.
 *
 * Three object ids are reserved as dependency foci. Dense-diagram edges use
 * the remaining ids as senders, so their parallel edges cannot inflate a
 * focus node's measured outgoing fan-out.
 */
export function planReadModelLoadSeed(input: {
  objectCount: number
  connectionCount: number
  decisionRecordCount?: number
}): ReadModelLoadSeedPlan {
  const { objectCount, connectionCount } = input
  const decisionRecordCount = input.decisionRecordCount ?? DEFAULT_ADR_COUNT
  if (!Number.isSafeInteger(objectCount) || objectCount < 4) {
    throw new Error('READ_MODEL_LOAD_OBJECTS must be at least 4 (three hub foci plus one peer)')
  }
  if (!Number.isSafeInteger(connectionCount) || connectionCount <= 0) {
    throw new Error('READ_MODEL_LOAD_CONNECTIONS must be a positive integer')
  }
  if (!Number.isSafeInteger(decisionRecordCount) || decisionRecordCount <= 0) {
    throw new Error('READ_MODEL_LOAD_ADRS must be a positive integer')
  }

  const limitations: string[] = []
  let nextConnection = 1
  let remainingConnections = connectionCount
  const denseObjectCount = Math.min(DENSE_DIAGRAM_OBJECTS, objectCount)
  const denseEligibleObjects = Math.max(0, denseObjectCount - 3)
  const denseConnectionCount = denseEligibleObjects >= 2
    ? Math.min(DENSE_DIAGRAM_CONNECTIONS, remainingConnections)
    : 0
  const denseDiagram = {
    first: nextConnection,
    count: denseConnectionCount,
    objectCount: denseObjectCount,
    requestedObjects: DENSE_DIAGRAM_OBJECTS,
    requestedConnections: DENSE_DIAGRAM_CONNECTIONS,
  }
  nextConnection += denseConnectionCount
  remainingConnections -= denseConnectionCount
  if (denseObjectCount < DENSE_DIAGRAM_OBJECTS) {
    limitations.push(
      `dense diagram limited to ${denseObjectCount}/${DENSE_DIAGRAM_OBJECTS} shapes by object cardinality`,
    )
  }
  if (denseConnectionCount < DENSE_DIAGRAM_CONNECTIONS) {
    limitations.push(
      `dense diagram limited to ${denseConnectionCount}/${DENSE_DIAGRAM_CONNECTIONS} connections by configured scale`,
    )
  }

  const dependencyHubs: DependencyHubPlan[] = REQUESTED_DEPENDENCY_HUBS.map(
    (requestedPeers, index) => {
      const focusIndex = index + 1
      const peerCount = Math.min(requestedPeers, objectCount - 1, remainingConnections)
      const hub = {
        first: nextConnection,
        count: peerCount,
        focusIndex,
        focusId: objectId(focusIndex),
        requestedPeers,
        peerCount,
      }
      nextConnection += peerCount
      remainingConnections -= peerCount
      if (peerCount < requestedPeers) {
        const constraints: string[] = []
        if (objectCount - 1 < requestedPeers) constraints.push(`at most ${objectCount - 1} distinct non-self peers`)
        if (peerCount >= remainingConnections + peerCount && remainingConnections === 0) {
          constraints.push('connection cardinality exhausted')
        }
        limitations.push(
          `dependency hub ${requestedPeers.toLocaleString('en-CA')} limited to ` +
          `${peerCount.toLocaleString('en-CA')} peers` +
          (constraints.length ? ` (${constraints.join('; ')})` : ''),
        )
      }
      return hub
    },
  )

  const baselineConnections = { first: nextConnection, count: remainingConnections }
  const plannedConnections = denseDiagram.count
    + dependencyHubs.reduce((total, hub) => total + hub.count, 0)
    + baselineConnections.count
  if (plannedConnections !== connectionCount) {
    throw new Error(`Connection plan mismatch: ${plannedConnections}/${connectionCount}`)
  }
  return {
    objectCount,
    connectionCount,
    decisionRecordCount,
    denseDiagram,
    dependencyHubs,
    baselineConnections,
    limitations,
  }
}

export function loadAdrId(index: number): string {
  return `adr-load-${String(index).padStart(6, '0')}`
}

export function loadAdrCreatedAt(index: number): string {
  return new Date(Date.UTC(2020, 0, 1) + index * 1_000).toISOString()
}

export function deepSearchAdrIndex(decisionRecordCount: number): number {
  return Math.max(1, Math.min(decisionRecordCount, Math.floor(decisionRecordCount * 0.731)))
}
