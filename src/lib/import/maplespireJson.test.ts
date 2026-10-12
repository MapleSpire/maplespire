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
import type { Flow } from '../../types'
import { seededTechnologyUsages } from '../technologyUsage'
import { parseMapleSpireJson, planJsonImport, existingIdsFromState, type MapleSpireExport } from './maplespireJson'

function fixtureExport(): MapleSpireExport {
  return {
    format: 'maplespire-model',
    version: 3,
    landscape: 'E-commerce platform',
    scope: 'landscape',
    domains: [{ id: 'dom-a', name: 'Storefront' }],
    objects: [
      { id: 'sys', type: 'system', name: 'Platform', position: { x: 0, y: 0 }, size: { width: 200, height: 100 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} },
      { id: 'web', type: 'app', name: 'Web app', parentId: 'sys', technologyUsages: seededTechnologyUsages('web', ['React']), position: { x: 0, y: 0 }, size: { width: 185, height: 100 }, tagAssignments: { t1: { tagId: 't1' } }, tagOrder: ['t1'], scope: 'internal', status: 'live', properties: {} },
      { id: 'ghost-child', type: 'app', name: 'Ghost child', parentId: 'missing-parent', position: { x: 0, y: 0 }, size: { width: 185, height: 100 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} },
    ],
    connections: [
      { id: 'c1', fromId: 'web', toId: 'sys', label: 'Calls', type: 'solid' },
      { id: 'c-dangling', fromId: 'web', toId: 'nowhere', type: 'solid' },
    ],
    groups: [{
      id: 'g1', name: 'Platform group', color: '#888', objectIds: ['web'],
      technologyUsages: {
        terraform: {
          id: 'terraform', technologyId: 'tech_seed_terraform', catalogRevision: 2,
          role: 'infrastructure',
          snapshot: {
            schemaVersion: 1, name: 'Terraform', recommendedShapeTypes: ['group'],
            defaultRole: 'infrastructure',
          },
        },
      },
      tagAssignments: {},
      tagOrder: [],
    }],
    tags: [
      { tagId: 't1', value: 'frontend', color: '#D97A3D', groupId: 'taggrp-layer', groupName: 'Layer', catalogRevision: 1 },
      { tagId: 't2', value: 'existing-name', color: '#333333', groupId: 'taggrp-layer', groupName: 'Layer', catalogRevision: 1 },
    ],
    flows: [
      {
        id: 'f1',
        name: 'Checkout',
        diagramId: 'd1',
        steps: [{ id: 's1', order: 1, type: 'introduction', title: 'Start' }],
      } as Flow,
    ],
    diagrams: [
      {
        id: 'd1',
        name: 'Context',
        type: 'context',
        objectIds: ['sys', 'web', 'unknown-obj'],
        connectionIds: ['c1', 'c-dangling'],
        groupIds: [],
        layouts: { web: { position: { x: 10, y: 20 }, size: { width: 185, height: 100 } } },
      },
    ],
  }
}

const EMPTY_STATE = { objects: [], connections: [], groups: [], domains: [], tags: [], diagrams: [], flows: [] }

describe('parseMapleSpireJson', () => {
  it('rejects non-JSON and foreign formats with friendly messages', () => {
    expect(() => parseMapleSpireJson('not json')).toThrow(/Not valid JSON/)
    expect(() => parseMapleSpireJson('{"format":"other"}')).toThrow(/Not a MapleSpire model export/)
    expect(() => parseMapleSpireJson('{"format":"maplespire-model","version":1}')).toThrow(/version 1/)
  })

  it('parses a full export and normalises defensively', () => {
    const parsed = parseMapleSpireJson(JSON.stringify(fixtureExport()))
    expect(parsed.landscape).toBe('E-commerce platform')
    expect(parsed.objects).toHaveLength(3)
    expect(parsed.groups[0].technologyUsages?.terraform.snapshot.recommendedShapeTypes).toEqual(['group'])
    expect(parsed.diagrams[0].layouts?.web.position.x).toBe(10)
    // Missing/foreign fields degrade instead of crashing.
    const sparse = parseMapleSpireJson(
      '{"format":"maplespire-model","version":3,"objects":[{"id":"a","name":"A","type":"weird","tagAssignments":{},"tagOrder":[]}]}',
    )
    expect(sparse.objects[0].type).toBe('app')
    expect(sparse.objects[0].position).toEqual({ x: 0, y: 0 })
    expect(sparse.objects[0].tagOrder).toEqual([])
  })

  it('sanitizes imported scene decoration and strips invalid blocks entirely', () => {
    const doc = fixtureExport()
    doc.diagrams[0].sceneDecor = {
      packId: 'maquette-people',
      density: 'rich',
      seed: 5.4,
      evil: 'url(javascript:alert(1))',
    } as never
    const parsed = parseMapleSpireJson(JSON.stringify(doc))
    expect(parsed.diagrams[0].sceneDecor).toEqual({ packId: 'maquette-people', density: 'rich', seed: 5 })

    doc.diagrams[0].sceneDecor = { packId: 'no/slashes' } as never
    const stripped = parseMapleSpireJson(JSON.stringify(doc))
    // invalid decor is REMOVED, never kept as a key holding undefined
    // (Automerge rejects undefined values at write time)
    expect('sceneDecor' in stripped.diagrams[0]).toBe(false)
  })

  it('rejects legacy and malformed technology payloads in version 3', () => {
    expect(() => parseMapleSpireJson(JSON.stringify({
      format: 'maplespire-model',
      version: 3,
      objects: [{ id: 'a', name: 'A', technologies: [{ name: 'React' }] }],
    }))).toThrow(/removed technology format/)
    expect(() => parseMapleSpireJson(JSON.stringify({
      format: 'maplespire-model',
      version: 3,
      objects: [{
        id: 'a',
        name: 'A',
        technologyUsages: { bad: { id: 'different', technologyId: 'tech_seed_react' } },
      }],
    }))).toThrow(/invalid technology usage/)
    expect(() => parseMapleSpireJson(JSON.stringify({
      format: 'maplespire-model',
      version: 3,
      groups: [{
        id: 'g1', name: 'Group', color: '#888', objectIds: [],
        technologyUsages: {
          bad: {
            id: 'bad', technologyId: 'tech', catalogRevision: 2,
            snapshot: { schemaVersion: 1, name: 'Bad', recommendedShapeTypes: ['actor'] },
          },
        },
      }],
    }))).toThrow(/Group "g1" has an invalid technology usage/)

    for (const recommendations of [
      [],
      ['store', 'store'],
      ['system', 'app', 'store', 'component', 'group', 'group'],
    ]) {
      expect(() => parseMapleSpireJson(JSON.stringify({
        format: 'maplespire-model',
        version: 3,
        objects: [{
          id: 'a', name: 'A',
          technologyUsages: {
            invalidRecommendations: {
              id: 'invalidRecommendations', technologyId: 'tech', catalogRevision: 2,
              snapshot: {
                schemaVersion: 1, name: 'Technology', recommendedShapeTypes: recommendations,
              },
            },
          },
        }],
      }))).toThrow(/Object "a" has an invalid technology usage/)
    }
  })

  it('validates imported Tag snapshots as untrusted catalog fallbacks', () => {
    const fixture = fixtureExport()
    fixture.tags[0].color = '#d97a3d'
    const parsed = parseMapleSpireJson(JSON.stringify(fixture))
    expect(parsed.tags[0].color).toBe('#D97A3D')

    for (const invalidTag of [
      { ...fixture.tags[0], color: 'red' },
      { ...fixture.tags[0], value: 'Risk\u202Ehidden' },
      { ...fixture.tags[0], catalogRevision: 0 },
    ]) {
      expect(() => parseMapleSpireJson(JSON.stringify({
        ...fixture,
        tags: [invalidTag],
      }))).toThrow(/Invalid Tag snapshot/)
    }

    expect(() => parseMapleSpireJson(JSON.stringify({
      ...fixture,
      tags: [fixture.tags[0], { ...fixture.tags[0] }],
    }))).toThrow(/Duplicate Tag snapshot id/)
  })
})

describe('planJsonImport', () => {
  it('imports everything into an empty workspace, keeping ids', () => {
    const plan = planJsonImport(fixtureExport(), existingIdsFromState(EMPTY_STATE))
    expect(plan.stats.newObjects).toBe(3)
    expect(plan.stats.existingObjects).toBe(0)
    expect(plan.diagrams[0].id).toBe('d1')
    expect(plan.flows[0].diagramId).toBe('d1')
    expect(plan.entryDiagramId).toBe('d1')
    // Dangling references are stripped, never imported blind.
    expect(plan.objects.find((o) => o.id === 'ghost-child')?.parentId).toBeUndefined()
    expect(plan.stats.droppedConnections).toBe(1)
    expect(plan.diagrams[0].objectIds).toEqual(['sys', 'web'])
    expect(plan.diagrams[0].connectionIds).toEqual(['c1'])
    expect(plan.tags.find((t) => t.tagId === 't1')?.value).toBe('frontend')
  })

  it('reuses existing entities without touching them and remaps colliding diagrams', () => {
    const existing = existingIdsFromState({
      ...EMPTY_STATE,
      objects: [{ id: 'web', type: 'app', name: 'Old web', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} }],
      connections: [{ id: 'c1', fromId: 'x', toId: 'y', type: 'solid' }],
      tags: [{ tagId: 't2', value: 'existing-name', color: '#000000', groupId: 'taggrp-layer', groupName: 'Layer', catalogRevision: 1 }],
      diagrams: [{ id: 'd1', name: 'Mine', type: 'context', objectIds: [], connectionIds: [], groupIds: [] }],
      flows: [{ id: 'f1', name: 'Mine', diagramId: 'd1', steps: [] }],
    })
    let n = 0
    const plan = planJsonImport(fixtureExport(), existing, { idFactory: () => `gen-${++n}` })

    // Existing object wins: NOT re-imported, properties untouched by construction.
    expect(plan.objects.some((o) => o.id === 'web')).toBe(false)
    expect(plan.stats.existingObjects).toBe(1)
    expect(plan.stats.newObjects).toBe(2)
    // Existing connection reused.
    expect(plan.connections.some((c) => c.id === 'c1')).toBe(false)
    expect(plan.stats.existingConnections).toBe(1)
    // Stable IDs dedupe snapshots; display values are not identities.
    expect(plan.tags.some((t) => t.tagId === 't2')).toBe(false)
    expect(plan.tags.some((t) => t.tagId === 't1')).toBe(true)
    // The diagram is ALWAYS created — under a fresh id — and its flow follows.
    expect(plan.diagrams[0].id).toBe('gen-1')
    expect(plan.flows[0].diagramId).toBe('gen-1')
    expect(plan.flows[0].id).toBe('gen-2') // f1 collided too
    // Composition still references the EXISTING web/c1 by id.
    expect(plan.diagrams[0].objectIds).toContain('web')
    expect(plan.diagrams[0].connectionIds).toContain('c1')
  })
})

describe('applyJsonImport — ONE store tick per import (the linearity guard)', () => {
  it('notifies subscribers exactly once for a multi-entity plan', async () => {
    // Under boot-from-server every store tick runs detectEdits, and each NEW
    // entity is journaled with an immediate first persist. The cost of
    // importing THROUGH the crash journal is linear (~5×N serializations)
    // ONLY because the whole import is a single set(): N
    // ticks would make it N × journal-serialization — quadratic. This pins
    // the tick count; break the batching and this fails before a profiler
    // has to.
    const { useModelStore } = await import('../../stores/modelStore')
    const plan = planJsonImport(fixtureExport(), existingIdsFromState(EMPTY_STATE))
    let ticks = 0
    const unsubscribe = useModelStore.subscribe(() => { ticks += 1 })
    try {
      useModelStore.getState().applyJsonImport(plan)
    } finally {
      unsubscribe()
    }
    expect(ticks).toBe(1)
    expect(useModelStore.getState().objects.some((o) => o.id === 'sys')).toBe(true)
  })
})
