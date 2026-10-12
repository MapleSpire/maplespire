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
import type { C4Object, Connection } from '../../types'
import type { ExportBundle } from './types'
import { buildConnectionsCsv, buildObjectsCsv, CONNECTIONS_CSV_HEADER } from './csv'

const object = (id: string, name: string): C4Object => ({
  id,
  type: 'app',
  name,
  shortDescription: 'Compact label',
  description: '## Detailed documentation',
  position: { x: 0, y: 0 },
  size: { width: 180, height: 100 },
  tagAssignments: {},
  tagOrder: [],
  ownerAssignments: {
    'user:alice': { id: 'user:alice', kind: 'person', source: 'platform', name: 'Alice Martin' },
  },
  ownerAssignmentOrder: ['user:alice'],
  scope: 'internal',
  status: 'live',
  properties: {},
})

const from = object('from', 'Producer')
const to = object('to', 'Consumer')
const connection: Connection = {
  id: 'connection',
  fromId: from.id,
  toId: to.id,
  label: 'publishes',
  description: '## Event contract',
  type: 'solid',
  tagAssignments: { 'risk-high': { tagId: 'risk-high' } },
  tagOrder: ['risk-high'],
  technologyUsages: {
    grpc: {
      id: 'grpc', technologyId: 'tech-grpc', catalogRevision: 1,
      snapshot: { schemaVersion: 1, name: 'gRPC' },
    },
  },
  technologyUsageOrder: ['grpc'],
  ownerAssignments: {
    'team-platform': { id: 'team-platform', kind: 'team', source: 'platform', name: 'Platform' },
  },
  ownerAssignmentOrder: ['team-platform'],
}

const bundle: ExportBundle = {
  landscapeName: 'Test',
  generatedAt: '2026-07-30T00:00:00.000Z',
  diagrams: [],
  activeDiagramId: null,
  flowsByDiagram: {},
  objects: [from, to],
  connections: [connection],
  groups: [],
  domains: [],
  tags: [{
    tagId: 'risk-high', value: 'High', color: '#b42318', groupId: 'risk', groupName: 'Risk', catalogRevision: 1,
  }],
  decisionRecords: [],
}

describe('CSV metadata export', () => {
  it('exports compact and detailed shape descriptions as distinct columns', () => {
    const csv = buildObjectsCsv(bundle)
    expect(csv).toContain('Compact label')
    expect(csv).toContain('## Detailed documentation')
    expect(csv).toContain('Alice Martin')
  })

  it('exports connection tags, technologies, owners and Markdown description', () => {
    expect(CONNECTIONS_CSV_HEADER).toContain('Connection Teams')
    const csv = buildConnectionsCsv(bundle)
    expect(csv).toContain('High,gRPC,Platform,## Event contract')
  })
})
