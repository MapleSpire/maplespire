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

// Regression: a user filled in their imported model (technology versions and
// notes, descriptions, tags, owners) and exported it; most of it was missing
// from the file. The DSL export wrote relationships as `a -> b "label"` only and
// technologies without versions; both exports dropped technology versions and
// notes, and our importers left the facts they did carry (status, owners) as
// plain properties, which the NEXT export strips — so export → import → export
// lost them. Both formats are checked through a full re-import.

import { describe, expect, it } from 'vitest'
import type { C4Object, Connection, Diagram, Tag } from '../../types'
import type { ExportBundle } from './types'
import { buildStructurizrDsl } from './structurizr'
import { buildStructurizrJson } from './structurizrJson'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace as mapDsl } from '../structurizr/mapper'
import { parseWorkspaceJson } from '../structurizr/json/parse'
import { mapWorkspace as mapJson } from '../structurizr/json/mapWorkspace'
import { createTechnologyUsage } from '../technologyUsage'
import { parseTechnologies } from '../structurizr/conventions'

const tag: Tag = { tagId: 'tag-critical', value: 'Critical', color: '#f00', catalogRevision: 1 } as Tag

function object(id: string, name: string, type: C4Object['type'], extra: Partial<C4Object> = {}): C4Object {
  return {
    id,
    name,
    type,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 120 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
    ...extra,
  }
}

function bundle(): ExportBundle {
  const web = object('web', 'Web App', 'app', {
    parentId: 'sys',
    shortDescription: 'Citizen portal',
    description: 'The **Angular** portal citizens use to file requests.',
    technologyUsages: {
      u1: createTechnologyUsage({ id: 'u1', name: 'Angular', usedVersion: '17', notes: 'Standalone components' }),
      u2: createTechnologyUsage({ id: 'u2', name: 'TypeScript', usedVersion: '5.4' }),
      u3: createTechnologyUsage({ id: 'u3', name: 'Dynamics', usedVersion: '365' }),
    },
    technologyUsageOrder: ['u1', 'u2', 'u3'],
    tagAssignments: { [tag.tagId]: { tagId: tag.tagId } },
    tagOrder: [tag.tagId],
    ownerAssignments: {
      o1: { id: 'o1', kind: 'team', source: 'platform', name: 'Permits, Core' },
      o2: { id: 'o2', kind: 'person', source: 'external', name: 'Alice' },
    },
    ownerAssignmentOrder: ['o1', 'o2'],
    status: 'draft',
    links: ['https://example.test/web', 'https://example.test/runbook'],
    properties: { 'cost-centre': 'CC-42' },
  })
  const api = object('api', 'API', 'app', { parentId: 'sys' })
  const sys = object('sys', 'Permits', 'system')
  const connection: Connection = {
    id: 'c1',
    fromId: 'web',
    toId: 'api',
    label: 'Calls',
    description: 'Retries **3 times** with backoff.',
    type: 'solid',
    technologyUsages: { cu: createTechnologyUsage({ id: 'cu', name: 'HTTPS', usedVersion: '2.0' }) },
    technologyUsageOrder: ['cu'],
    tagAssignments: { [tag.tagId]: { tagId: tag.tagId } },
    tagOrder: [tag.tagId],
    ownerAssignments: { o3: { id: 'o3', kind: 'person', source: 'external', name: 'Bob' } },
    ownerAssignmentOrder: ['o3'],
    status: 'unstable',
    properties: { 'structurizr.url': 'https://example.test/api-docs', sla: '99.9' },
  }
  const diagram: Diagram = {
    id: 'd1',
    name: 'Containers',
    type: 'container',
    parentObjectId: 'sys',
    objectIds: ['web', 'api'],
    connectionIds: ['c1'],
    groupIds: [],
  } as Diagram
  return {
    landscapeName: 'Facts',
    generatedAt: '2026-10-21T00:00:00.000Z',
    diagrams: [diagram],
    activeDiagramId: 'd1',
    flowsByDiagram: {},
    objects: [sys, web, api],
    connections: [connection],
    groups: [],
    domains: [],
    tags: [tag],
    decisionRecords: [],
  }
}

type Imported = { objects: C4Object[]; connections: Connection[] }

function expectFactsSurvived(imported: Imported) {
  const web = imported.objects.find((o) => o.name === 'Web App')!
  expect(web.description).toBe('The **Angular** portal citizens use to file requests.')
  expect(web.shortDescription).toBe('Citizen portal')
  expect(web.status).toBe('draft')
  const usages = Object.values(web.technologyUsages ?? {}).map((u) => [u.snapshot.name, u.usedVersion, u.notes])
  expect(usages).toEqual([
    ['Angular', '17', 'Standalone components'],
    ['TypeScript', '5.4', undefined],
    ['Dynamics', '365', undefined],
  ])
  const owners = (web.ownerAssignmentOrder ?? []).map((k) => web.ownerAssignments![k].name)
  expect(owners).toEqual(['Permits, Core', 'Alice'])
  expect(web.links?.map((l) => (typeof l === 'string' ? l : l.url))).toEqual([
    'https://example.test/web',
    'https://example.test/runbook',
  ])
  expect(web.properties['cost-centre']).toBe('CC-42')
  // The revived facts are fields now, not stale property copies.
  expect(Object.keys(web.properties).filter((k) => k.startsWith('maplespire.'))).toEqual([])

  const c = imported.connections.find((x) => x.label === 'Calls')!
  expect(c).toBeDefined()
  expect(c.description).toBe('Retries **3 times** with backoff.')
  expect(c.status).toBe('unstable')
  expect(Object.values(c.technologyUsages ?? {}).map((u) => [u.snapshot.name, u.usedVersion])).toEqual([['HTTPS', '2.0']])
  expect((c.ownerAssignmentOrder ?? []).map((k) => c.ownerAssignments![k].name)).toEqual(['Bob'])
  expect(c.properties?.['structurizr.url']).toBe('https://example.test/api-docs')
  expect(c.properties?.sla).toBe('99.9')
  expect(c.tagOrder?.length).toBe(1)
}

describe('Structurizr export keeps the facts a user filled in', () => {
  it('DSL: element and relationship facts survive export → import', () => {
    const dsl = buildStructurizrDsl(bundle())
    // What a Structurizr reader sees: versions in the technology string, and the
    // relationship's technology, tags, url and properties in its block.
    expect(dsl).toContain('"Angular 17, TypeScript 5.4, Dynamics 365"')
    expect(dsl).toMatch(/web_app -> api "Calls" "HTTPS 2\.0" \{/)
    expect(dsl).toContain('"maplespire.owners" "[\\"Permits, Core\\",\\"Alice\\"]"')
    const ws = parseWorkspace(dsl)
    expectFactsSurvived(mapDsl(ws))
  })

  it('DSL: a second export of the re-import is identical to the first', () => {
    const first = buildStructurizrDsl(bundle())
    const mapped = mapDsl(parseWorkspace(first))
    const second = buildStructurizrDsl({
      ...bundle(),
      objects: mapped.objects,
      connections: mapped.connections,
      tags: mapped.tags,
      diagrams: mapped.diagrams,
    })
    const model = (s: string) => s.slice(s.indexOf('model {'), s.indexOf('views {'))
    expect(model(second)).toBe(model(first))
  })

  it('JSON: element and relationship facts survive export → import', () => {
    const json = buildStructurizrJson(bundle())
    const parsed = JSON.parse(json)
    const web = parsed.model.softwareSystems[0].containers.find((c: { name: string }) => c.name === 'Web App')
    expect(web.technology).toBe('Angular 17, TypeScript 5.4, Dynamics 365')
    expect(web.properties['maplespire.technology.Angular.notes']).toBe('Standalone components')
    expectFactsSurvived(mapJson(parseWorkspaceJson(json)))
  })
})

describe('round-trip edge cases (reviewer lens, 2026-10-21)', () => {
  /** One connection web → api, everything else as in `bundle()`. */
  const withConnection = (over: Partial<Connection>): ExportBundle => {
    const b = bundle()
    return { ...b, connections: [{ ...b.connections[0], ...over }] }
  }
  const viaJson = (b: ExportBundle) => mapJson(parseWorkspaceJson(buildStructurizrJson(b)))
  const viaDsl = (b: ExportBundle) => mapDsl(parseWorkspace(buildStructurizrDsl(b)))

  it('a single owner whose name contains a comma stays one owner, in both formats', () => {
    const b = bundle()
    const web = b.objects.find((o) => o.id === 'web')!
    web.ownerAssignments = { o1: { id: 'o1', kind: 'team', source: 'platform', name: 'Payments, Core' } }
    web.ownerAssignmentOrder = ['o1']
    for (const imported of [viaJson(b), viaDsl(b)]) {
      const w = imported.objects.find((o) => o.name === 'Web App')!
      expect((w.ownerAssignmentOrder ?? []).map((k) => w.ownerAssignments![k].name)).toEqual(['Payments, Core'])
    }
  })

  it('still reads the comma-joined owners older exports wrote', () => {
    const ws = parseWorkspace(
      `workspace { model { s = softwareSystem "S" { properties { "maplespire.owners" "Alice, Bob" } } } }`,
    )
    const s = mapDsl(ws).objects[0]
    expect((s.ownerAssignmentOrder ?? []).map((k) => s.ownerAssignments![k].name)).toEqual(['Alice', 'Bob'])
  })

  it('JSON: a label equal to the technology keeps multi-paragraph Markdown out of the label', () => {
    const imported = viaJson(withConnection({ label: 'HTTPS 2.0', description: 'Uses mTLS\n\nRotation weekly' }))
    const c = imported.connections[0]
    expect(c.label).toBe('HTTPS 2.0')
    expect(c.description).toBe('Uses mTLS\n\nRotation weekly')
  })

  it('JSON: an empty label with Markdown comes back with no label, not the Markdown as label', () => {
    const imported = viaJson(withConnection({ label: '', description: 'Only documentation' }))
    const c = imported.connections[0]
    expect(c.description).toBe('Only documentation')
    expect(c.label).not.toBe('Only documentation')
  })

  it("JSON: a third-party multi-paragraph description is drawn whole, not cut at its first blank line", () => {
    const raw = {
      id: 1,
      name: 'T',
      model: {
        softwareSystems: [
          { id: '1', name: 'A', relationships: [{ id: '3', sourceId: '1', destinationId: '2', description: 'Para one\n\nPara two' }] },
          { id: '2', name: 'B' },
        ],
      },
      views: {},
    }
    const c = mapJson(parseWorkspaceJson(JSON.stringify(raw))).connections[0]
    expect(c.label).toBe('Para one\n\nPara two')
    expect(c.description).toBeUndefined()
  })

  it('DSL: an implied relationship a dynamic view needed is not exported as an authored one', () => {
    const dsl = `workspace {
      model {
        u = person "U"
        s = softwareSystem "S" {
          flows = container "Flows" {
            sla = component "SLA"
          }
        }
        sla -> u "Notifies"
      }
      views {
        dynamic s "F" { flows -> u "Notifies" }
      }
    }`
    const first = mapDsl(parseWorkspace(dsl))
    const implied = first.connections.filter((c) => c.properties?.['structurizr.implied'] === 'true')
    expect(implied).toHaveLength(1)
    const exported = buildStructurizrDsl({
      ...bundle(),
      objects: first.objects,
      connections: first.connections,
      tags: first.tags,
      diagrams: first.diagrams,
    })
    expect(exported).toMatch(/sla -> u "Notifies"/)
    expect(exported).not.toMatch(/flows -> u/)
  })
})

describe('technology strings', () => {
  it('splits an unambiguous trailing version off the name', () => {
    expect(parseTechnologies('Angular 17, TypeScript')).toEqual([{ name: 'Angular', version: '17' }, { name: 'TypeScript' }])
    expect(parseTechnologies('Node.js 20, Express')).toEqual([{ name: 'Node.js', version: '20' }, { name: 'Express' }])
    expect(parseTechnologies('Spring Boot 3.2.1')).toEqual([{ name: 'Spring Boot', version: '3.2.1' }])
    expect(parseTechnologies('Python v3')).toEqual([{ name: 'Python', version: 'v3' }])
  })

  it('leaves product names that end in a number alone', () => {
    expect(parseTechnologies('Office 365')).toEqual([{ name: 'Office 365' }])
    expect(parseTechnologies('Microsoft Azure - Power Platform')).toEqual([{ name: 'Microsoft Azure - Power Platform' }])
    expect(parseTechnologies('S3')).toEqual([{ name: 'S3' }])
  })

  it('an imported "Angular 17" is Angular with version 17, not a technology named "Angular 17"', () => {
    const ws = parseWorkspace(`workspace { model { s = softwareSystem "S" { a = container "A" "" "Angular 17, TypeScript" } } }`)
    const a = mapDsl(ws).objects.find((o) => o.name === 'A')!
    expect(Object.values(a.technologyUsages!).map((u) => [u.snapshot.name, u.usedVersion])).toEqual([
      ['Angular', '17'],
      ['TypeScript', undefined],
    ])
  })
})
