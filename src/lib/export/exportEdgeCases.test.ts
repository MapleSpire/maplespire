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

// Holes found by the QA lens (mutation battery, 2026-10-21) on the Structurizr
// import/export change set: each test names the mutant it kills — one that
// survived every existing test.
import { describe, expect, it } from 'vitest'
import type { C4Object, Connection, Diagram } from '../../types'
import type { ExportBundle } from './types'
import { buildStructurizrDsl } from './structurizr'
import { buildStructurizrJson } from './structurizrJson'
import { createTechnologyUsage } from '../technologyUsage'
import { parseTechnologies } from '../structurizr/conventions'
import { reviveMapleSpireFacts } from '../structurizr/maplespireFacts'
import { parseWorkspaceJson } from '../structurizr/json/parse'
import { mapWorkspace as mapJson } from '../structurizr/json/mapWorkspace'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace as mapDsl } from '../structurizr/mapper'
import { parseMapleSpireJson } from '../import/maplespireJson'
import { DEFAULT_SHAPE_SIZE } from '../shapeDefaults'

function object(id: string, name: string, type: C4Object['type'], extra: Partial<C4Object> = {}): C4Object {
  return {
    id, name, type,
    position: { x: 0, y: 0 }, size: { width: 160, height: 100 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
    ...extra,
  }
}

function bundle(over: { web?: Partial<C4Object>; conn?: Partial<Connection> } = {}): ExportBundle {
  const sys = object('sys', 'Permits', 'system')
  const web = object('web', 'Web App', 'app', { parentId: 'sys', ...over.web })
  const api = object('api', 'API', 'app', { parentId: 'sys' })
  const connection: Connection = {
    id: 'c1', fromId: 'web', toId: 'api', label: 'Calls', type: 'solid',
    tagAssignments: {}, tagOrder: [], ...over.conn,
  } as Connection
  const diagram = {
    id: 'd1', name: 'Containers', type: 'container', parentObjectId: 'sys',
    objectIds: ['web', 'api'], connectionIds: ['c1'], groupIds: [],
  } as unknown as Diagram
  return {
    landscapeName: 'QA', generatedAt: '2026-10-21T00:00:00.000Z', diagrams: [diagram], activeDiagramId: 'd1',
    flowsByDiagram: {}, objects: [sys, web, api], connections: [connection], groups: [], domains: [], tags: [],
    decisionRecords: [],
  } as unknown as ExportBundle
}

const jsonWeb = (b: ExportBundle) =>
  JSON.parse(buildStructurizrJson(b)).model.softwareSystems[0].containers.find((c: { name: string }) => c.name === 'Web App')

describe('export edge cases — stale MapleSpire keys read back by an OLDER importer', () => {
  // Data imported before this branch kept `maplespire.*` as plain properties.
  const stale = { web: { status: 'live' as const, properties: { 'maplespire.status': 'down', 'maplespire.technology.Foo.notes': 'stale' } } }

  it('E1/F12: DSL does not re-emit a stale derived key', () => {
    const dsl = buildStructurizrDsl(bundle(stale))
    expect(dsl).not.toContain('maplespire.status')
    expect(dsl).not.toContain('maplespire.technology.Foo')
  })

  it('J5/F12: JSON does not re-emit a stale derived key', () => {
    const props = jsonWeb(bundle(stale)).properties ?? {}
    expect(Object.keys(props).filter((k) => k.startsWith('maplespire.'))).toEqual([])
  })
})

describe('export edge cases — facts', () => {
  it('J4: a connection technology note survives JSON and DSL round trips', () => {
    const b = bundle({ conn: {
      technologyUsages: { cu: createTechnologyUsage({ id: 'cu', name: 'HTTPS', notes: 'mTLS only' }) },
      technologyUsageOrder: ['cu'],
    } })
    const notesOf = (cs: Connection[]) =>
      Object.values(cs.find((c) => c.label === 'Calls')!.technologyUsages ?? {}).map((u) => u.notes)
    expect(notesOf(mapJson(parseWorkspaceJson(buildStructurizrJson(b))).connections)).toEqual(['mTLS only'])
    expect(notesOf(mapDsl(parseWorkspace(buildStructurizrDsl(b))).connections)).toEqual(['mTLS only'])
  })

  it('F7: a version the string carries is not repeated as a property', () => {
    const b = bundle({ web: {
      technologyUsages: { u: createTechnologyUsage({ id: 'u', name: 'TypeScript', usedVersion: '5.4' }) },
      technologyUsageOrder: ['u'],
    } })
    expect(buildStructurizrDsl(b)).not.toContain('maplespire.technology.TypeScript.version')
  })

  it('J2: the compact summary is not stated twice when it equals the description', () => {
    const props = jsonWeb(bundle({ web: { shortDescription: 'Portal', description: 'Portal' } })).properties ?? {}
    expect(props['maplespire.shortDescription']).toBeUndefined()
  })

  it('F3: an older export joined owners with ", "', () => {
    expect(reviveMapleSpireFacts({ 'maplespire.owners': 'Alice, Bob' }).owners).toEqual(['Alice', 'Bob'])
  })
})

describe('export edge cases — technology strings', () => {
  it('C1: wildcard and pre-release versions', () => {
    expect(parseTechnologies('Angular 5.x')).toEqual([{ name: 'Angular', version: '5.x' }])
    expect(parseTechnologies('Node.js 20.0.0-rc1')).toEqual([{ name: 'Node.js', version: '20.0.0-rc1' }])
  })

  it('C4: a v-prefixed version after a name the catalog does not know', () => {
    expect(parseTechnologies('Acmeware v2')).toEqual([{ name: 'Acmeware', version: 'v2' }])
  })
})

describe('export edge cases — MapleSpire JSON import sizes', () => {
  it('C7: a sizeless object of every type gets the editor box', () => {
    const types: C4Object['type'][] = ['actor', 'system', 'app', 'store', 'component']
    const parsed = parseMapleSpireJson(JSON.stringify({
      format: 'maplespire-model', version: 3,
      objects: types.map((type) => ({ id: type, name: type, type, tagAssignments: {}, tagOrder: [] })),
    }))
    for (const o of parsed.objects) expect(o.size, o.type).toEqual(DEFAULT_SHAPE_SIZE)
  })
})
