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
import { PerformanceSeedPlan } from './generator.js'
import {
  FULL_PERFORMANCE_SEED_SCALE,
  TEST_PERFORMANCE_SEED_SCALE,
  type PerformanceTagSnapshot,
} from './types.js'

function tags(): PerformanceTagSnapshot[] {
  return Array.from({ length: 14 }, (_, index) => ({
    tagId: `tag-${index}`,
    value: `Value ${index}`,
    color: `#${String(index + 1).padStart(6, '0')}`,
    groupId: `group-${index % 4}`,
    groupName: `Group ${index % 4}`,
    catalogRevision: 1,
  }))
}

function planFor(scale = TEST_PERFORMANCE_SEED_SCALE): PerformanceSeedPlan {
  return new PerformanceSeedPlan({
    scale,
    tags: tags(),
    teamIds: Array.from({ length: scale.teams }, (_, index) => `team-${index}`),
    seed: 77,
  })
}

describe('distinct enterprise performance seed generator', () => {
  it('pins the full profile to the requested cardinalities and shape distribution', () => {
    const plan = planFor(FULL_PERFORMANCE_SEED_SCALE)
    expect(plan.summary()).toEqual({
      profile: 'full',
      objects: 200_000,
      connections: 320_000,
      diagrams: 30_000,
      diagramShapeAppearances: 2_670_000,
      decisionRecords: 100_000,
      users: 20_000,
      teams: 200,
      domains: 96,
    })
    expect(plan.diagramIdentityAt(0).shapeCount).toBe(10)
    expect(plan.diagramIdentityAt(11_999).shapeCount).toBe(10)
    expect(plan.diagramIdentityAt(12_000).shapeCount).toBe(50)
    expect(plan.diagramIdentityAt(20_999).shapeCount).toBe(50)
    expect(plan.diagramIdentityAt(21_000).shapeCount).toBe(100)
    expect(plan.diagramIdentityAt(26_999).shapeCount).toBe(100)
    expect(plan.diagramIdentityAt(27_000).shapeCount).toBe(500)
    expect(plan.diagramIdentityAt(29_999).shapeCount).toBe(500)
  })

  it('builds a coherent C4 hierarchy with governed tags, technologies, links and icons', () => {
    const plan = planFor(FULL_PERFORMANCE_SEED_SCALE)
    const actor = plan.objectAt(0)
    const system = plan.objectAt(plan.tierCounts.actors)
    const container = plan.objectAt(plan.tierCounts.actors + plan.tierCounts.systems)
    const component = plan.objectAt(plan.tierCounts.actors + plan.tierCounts.systems + plan.tierCounts.containers)

    expect(actor.type).toBe('actor')
    expect(system.type).toBe('system')
    expect(container.parentId).toBe(system.id)
    expect(component.parentId).toBe(container.id)
    for (const object of [system, container, component]) {
      expect(object.description.length).toBeGreaterThan(40)
      expect(object.tagOrder).toHaveLength(3)
      expect(Object.keys(object.technologyUsages ?? {}).length).toBeGreaterThan(0)
      expect(object.iconAssignment).toMatchObject({ source: 'technology', mode: 'automatic' })
      expect(object.links.every((link) => link.startsWith('https://'))).toBe(true)
      expect(object.ownerTeamIds).toHaveLength(1)
    }
  })

  it('creates valid, non-self connections and indexes outgoing edges without scanning the graph', () => {
    const plan = planFor(FULL_PERFORMANCE_SEED_SCALE)
    const samples = [0, 4_999, 5_000, 29_999, 30_000, 149_999, 150_000, 299_999, 300_000, 319_999]
    for (const index of samples) {
      const connection = plan.connectionAt(index)
      expect(connection.id).toBe(plan.connectionId(index))
      expect(connection.fromId).not.toBe(connection.toId)
      expect(connection.label.length).toBeGreaterThan(3)
    }
    const sourceIndex = plan.tierCounts.actors + plan.tierCounts.systems
    const outgoing = plan.outgoingConnectionIndexes(sourceIndex)
    expect(outgoing.length).toBeGreaterThan(0)
    expect(outgoing.every((index) => plan.connectionAt(index).fromId === plan.objectId(sourceIndex))).toBe(true)
  })

  it('adds an exact 500-shape / 20k-connection Canvas fixture after the 300k reference graph', () => {
    const plan = planFor(FULL_PERFORMANCE_SEED_SCALE)
    const dense = plan.diagramAt(plan.denseDiagramIndex)
    const selected = new Set(dense.objectIds)

    expect(plan.denseDiagramIndex).toBe(29_999)
    expect(plan.denseConnectionStart).toBe(300_000)
    expect(dense.objectIds).toHaveLength(500)
    expect(dense.connectionIds).toHaveLength(20_000)
    expect(dense.connectionIds[0]).toBe(plan.connectionId(300_000))
    expect(dense.connectionIds.at(-1)).toBe(plan.connectionId(319_999))
    for (let index = plan.denseConnectionStart; index < plan.scale.connections; index++) {
      const connection = plan.connectionAt(index)
      expect(selected.has(connection.fromId)).toBe(true)
      expect(selected.has(connection.toId)).toBe(true)
      expect(connection.fromId).not.toBe(connection.toId)
    }
  })

  it('preserves every reference connection when the dedicated dense fixture is appended', () => {
    const extended = planFor(FULL_PERFORMANCE_SEED_SCALE)
    const baseline = planFor({
      ...FULL_PERFORMANCE_SEED_SCALE,
      connections: 300_000,
      denseDiagramConnections: 0,
    })
    for (const index of [0, 4_999, 5_000, 29_999, 30_000, 149_999, 150_000, 299_999]) {
      expect(extended.connectionAt(index)).toEqual(baseline.connectionAt(index))
    }
  })

  it('places one governed Tag and Technology on 80% of objects', () => {
    const plan = planFor(FULL_PERFORMANCE_SEED_SCALE)
    const first = plan.objectAt(plan.tierCounts.actors)
    const last = plan.objectAt(plan.tierCounts.actors + plan.denseGovernanceObjectCount - 1)

    expect(plan.denseGovernanceObjectCount).toBe(160_000)
    for (const object of [first, last]) {
      expect(object.tagAssignments['tag-0']).toEqual({ tagId: 'tag-0' })
      expect(Object.values(object.technologyUsages ?? {}).some(
        (usage) => usage.snapshot.name === 'Prometheus',
      )).toBe(true)
    }
    expect(plan.objectAt(plan.tierCounts.actors - 1).technologyUsages).toBeUndefined()
  })

  it('materializes every requested diagram size with valid composition, comments and flows', () => {
    const plan = planFor()
    const boundaries = [0, 3, 4, 6, 7, 8, 9]
    for (const index of boundaries) {
      const diagram = plan.diagramAt(index)
      expect(diagram.objectIds).toHaveLength(diagram.shapeCount)
      expect(new Set(diagram.objectIds).size).toBe(diagram.shapeCount)
      expect(Object.keys(diagram.layouts)).toHaveLength(diagram.shapeCount)
      expect(diagram.connectionIds.every((id) => id.startsWith('perf-c-'))).toBe(true)
      expect(Object.values(diagram.comments).every((comment) => comment.diagramId === diagram.id)).toBe(true)
      expect(Object.values(diagram.flows)).toHaveLength(1)
    }
    expect(plan.diagramAt(9).shapeCount).toBe(500)
  })

  it('links every lower-level C4 diagram to the object it decomposes', () => {
    const plan = planFor()
    for (let index = 0; index < plan.diagramCount; index++) {
      const diagram = plan.diagramIdentityAt(index)
      if (diagram.type === 'context') {
        expect(diagram.parentObjectId).toBeUndefined()
        continue
      }
      expect(diagram.parentObjectId).toBeDefined()
      const parentIndex = Number(diagram.parentObjectId?.slice('perf-o-'.length))
      const parent = plan.objectAt(parentIndex)
      if (diagram.type === 'container') expect(parent.type).toBe('system')
      else expect(['app', 'store']).toContain(parent.type)
    }
  })

  it('links every ADR to a real generated diagram, an external reference and adjacent decisions', () => {
    const plan = planFor(FULL_PERFORMANCE_SEED_SCALE)
    const first = plan.decisionRecordAt(0)
    const middle = plan.decisionRecordAt(54_321)
    const last = plan.decisionRecordAt(99_999)
    expect(first.related.some((link) => link.type === 'diagram' && link.targetId === plan.diagramId(0))).toBe(true)
    for (const adr of [first, middle, last]) {
      expect(adr.content).toContain('## Decision')
      expect(adr.related.some((link) => link.type === 'url' && link.url?.startsWith('https://'))).toBe(true)
      expect(adr.related.some((link) => link.type === 'diagram' && link.targetId?.startsWith('perf-dg-'))).toBe(true)
    }
    expect(middle.related).toContainEqual(expect.objectContaining({ type: 'adr', targetId: plan.decisionRecordId(54_320) }))
  })

  it('is deterministic for a fixed seed', () => {
    const left = planFor()
    const right = planFor()
    expect(left.objectAt(417)).toEqual(right.objectAt(417))
    expect(left.connectionAt(733)).toEqual(right.connectionAt(733))
    expect(left.diagramAt(9)).toEqual(right.diagramAt(9))
    expect(left.decisionRecordAt(31)).toEqual(right.decisionRecordAt(31))
  })
})
