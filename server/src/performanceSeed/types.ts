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

import type { TechnologyRole, TechnologyShapeType } from '../technologies/types.js'

export type PerformanceObjectType = 'actor' | 'system' | 'app' | 'store' | 'component'
export type PerformanceDiagramType = 'context' | 'container' | 'component'

export interface PerformanceSeedScale {
  name: 'full' | 'smoke' | 'test'
  objects: number
  connections: number
  decisionRecords: number
  users: number
  teams: number
  /** Connections reserved for one 500-shape adversarial Canvas fixture. */
  denseDiagramConnections: number
  diagramBuckets: ReadonlyArray<{ shapes: 10 | 50 | 100 | 500; count: number }>
}

export const FULL_PERFORMANCE_SEED_SCALE = {
  name: 'full',
  objects: 200_000,
  // Preserve the 300k reference-architecture graph and add a dedicated 20k
  // adversarial Canvas fixture. Dense edges must not steal/rewrite edges that
  // are already referenced by other diagrams.
  connections: 320_000,
  decisionRecords: 100_000,
  users: 20_000,
  teams: 200,
  denseDiagramConnections: 20_000,
  diagramBuckets: [
    { shapes: 10, count: 12_000 },
    { shapes: 50, count: 9_000 },
    { shapes: 100, count: 6_000 },
    { shapes: 500, count: 3_000 },
  ],
} as const satisfies PerformanceSeedScale

export const SMOKE_PERFORMANCE_SEED_SCALE = {
  name: 'smoke',
  objects: 1_000,
  connections: 2_500,
  decisionRecords: 250,
  users: 100,
  teams: 12,
  denseDiagramConnections: 1_000,
  diagramBuckets: [
    { shapes: 10, count: 16 },
    { shapes: 50, count: 12 },
    { shapes: 100, count: 8 },
    { shapes: 500, count: 4 },
  ],
} as const satisfies PerformanceSeedScale

export const TEST_PERFORMANCE_SEED_SCALE = {
  name: 'test',
  objects: 600,
  connections: 1_200,
  decisionRecords: 40,
  users: 24,
  teams: 8,
  denseDiagramConnections: 300,
  diagramBuckets: [
    { shapes: 10, count: 4 },
    { shapes: 50, count: 3 },
    { shapes: 100, count: 2 },
    { shapes: 500, count: 1 },
  ],
} as const satisfies PerformanceSeedScale

export interface PerformanceTechnologyUsage {
  id: string
  technologyId: string
  catalogRevision: number
  role?: TechnologyRole
  snapshot: {
    schemaVersion: 1
    name: string
    recommendedShapeTypes: TechnologyShapeType[]
    defaultRole: TechnologyRole
    iconLightPath?: string
    iconDarkPath?: string
  }
}

export interface PerformanceTagSnapshot {
  tagId: string
  value: string
  color: string
  groupId: string
  groupName: string
  catalogRevision: number
}

export interface PerformanceObject {
  id: string
  type: PerformanceObjectType
  name: string
  description: string
  technologyUsages?: Record<string, PerformanceTechnologyUsage>
  technologyUsageOrder?: string[]
  icon?: string
  iconAssignment?: {
    source: 'technology'
    mode: 'automatic'
    displayName: string
    technologyUsageId: string
    catalogRevision: number
    iconLightPath?: string
    iconDarkPath?: string
  }
  position: { x: number; y: number }
  size: { width: number; height: number }
  parentId?: string
  domainId: string
  tagAssignments: Record<string, { tagId: string }>
  tagOrder: string[]
  ownerTeamIds: string[]
  teamIds: string[]
  links: string[]
  scope: 'internal' | 'external'
  status: 'live' | 'draft' | 'down' | 'unstable'
  properties: Record<string, string>
}

export interface PerformanceConnection {
  id: string
  fromId: string
  toId: string
  label: string
  type: 'solid' | 'dashed' | 'dotted'
  shape: 'curved' | 'straight'
  status: 'live' | 'draft' | 'down' | 'unstable'
}

export interface PerformanceComment {
  id: string
  diagramId: string
  type: 'question' | 'inaccuracy' | 'idea'
  text: string
  position: { x: number; y: number }
  author: string
  createdAt: string
  resolved: boolean
  pinned: boolean
  replies: Array<{ id: string; text: string; author: string; createdAt: string }>
}

export interface PerformanceFlow {
  id: string
  name: string
  diagramId: string
  steps: Array<Record<string, unknown> & { id: string; order: number; type: string; title: string }>
}

export interface PerformanceDiagramIdentity {
  id: string
  name: string
  type: PerformanceDiagramType
  description: string
  shapeCount: number
  domainId: string
  parentObjectId?: string
}

export interface PerformanceDiagram extends PerformanceDiagramIdentity {
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
  layouts: Record<string, {
    position: { x: number; y: number }
    size: { width: number; height: number }
  }>
  comments: Record<string, PerformanceComment>
  flows: Record<string, PerformanceFlow>
  connectionHighlightStyle: 'none' | 'traveling-dot' | 'gradient-flow' | 'pulse'
  connectionAnimationsEnabled: boolean
  defaultConnectionShape: 'curved' | 'straight'
  skinId: string
}

export interface PerformanceDecisionRecord {
  id: string
  number: number
  title: string
  summary: string
  status: 'in-progress' | 'approved' | 'rejected'
  author: string
  createdAt: string
  updatedAt: string
  content: string
  related: Array<{
    id: string
    type: 'url' | 'adr' | 'diagram'
    label: string
    targetId?: string
    url?: string
  }>
  history: Array<{ status: 'in-progress' | 'approved' | 'rejected'; date: string }>
}

export interface PerformanceDomain {
  id: string
  name: string
  description: string
  color: string
}

export interface PerformanceSeedSummary {
  profile: PerformanceSeedScale['name']
  objects: number
  connections: number
  diagrams: number
  diagramShapeAppearances: number
  decisionRecords: number
  users: number
  teams: number
  domains: number
}
