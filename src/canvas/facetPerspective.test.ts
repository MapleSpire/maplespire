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
import type { C4Object } from '../types'
import {
  collectDiagramFacetValues,
  objectFacetValues,
  resolveFacetFocusMembership,
  resolveHiddenFacetState,
  resolvePinnedFacetPresentation,
  resolveConnectionPerspectiveFacet,
} from './facetPerspective'

const object = (id: string, status: C4Object['status'], technologies: Array<[string, string]> = []): C4Object => ({
  id,
  type: 'app',
  name: id,
  position: { x: 0, y: 0 },
  size: { width: 100, height: 80 },
  tagAssignments: {},
  tagOrder: [],
  scope: 'internal',
  status,
  properties: {},
  technologyUsages: Object.fromEntries(technologies.map(([technologyId, name], index) => [`usage-${index}`, {
    id: `usage-${index}`,
    technologyId,
    catalogRevision: 1,
    snapshot: { schemaVersion: 1, name },
  }])),
  technologyUsageOrder: technologies.map((_, index) => `usage-${index}`),
})

describe('managed diagram perspectives', () => {
  it('deduplicates only resident technology values and preserves object usage order', () => {
    const a = object('a', 'live', [['node', 'Node.js'], ['postgres', 'PostgreSQL']])
    const b = object('b', 'draft', [['node', 'Node.js']])
    expect(objectFacetValues(a, 'technology').map((value) => value.label)).toEqual(['Node.js', 'PostgreSQL'])
    expect(collectDiagramFacetValues([a, b], 'technology').map((value) => value.label)).toEqual(['Node.js', 'PostgreSQL'])
  })

  it('collects governed teams and people saved on diagram shapes', () => {
    const owned = object('owned', 'live')
    owned.ownerTeamIds = ['team-platform']
    owned.ownerAssignments = {
      'team-platform': {
        id: 'team-platform', kind: 'team', source: 'platform', catalogId: 'team-platform', name: 'Platform',
      },
      'user:alice': {
        id: 'user:alice', kind: 'person', source: 'platform', catalogId: 'alice', name: 'Alice Martin', email: 'alice@example.test',
      },
    }
    owned.ownerAssignmentOrder = ['user:alice', 'team-platform']

    expect(objectFacetValues(owned, 'teams')).toEqual([
      { id: 'user:alice', label: 'Alice Martin' },
      { id: 'team-platform', label: 'Platform' },
    ])
    expect(resolveFacetFocusMembership([owned, object('other', 'draft')], [], 'teams', 'user:alice').matchingObjectIds)
      .toEqual(new Set(['owned']))
  })

  it('focuses matches and direct neighbours in one bounded pass', () => {
    const result = resolveFacetFocusMembership(
      [object('a', 'live'), object('b', 'draft'), object('c', 'down')],
      [{ fromId: 'a', toId: 'b' }],
      'status',
      'live',
    )
    expect([...result.matchingObjectIds]).toEqual(['a'])
    expect([...result.connectedObjectIds]).toEqual(['b'])
  })

  it('temporarily reveals hidden matches and uses the latest pin for the outline', () => {
    const subject = object('a', 'live', [['node', 'Node.js'], ['postgres', 'PostgreSQL']])
    expect(resolveHiddenFacetState(subject, 'status', new Set(['live']), 'live')).toEqual({
      hidden: false,
      temporarilyRevealed: true,
    })
    expect(resolvePinnedFacetPresentation(subject, 'technology', ['postgres', 'node']).outline?.id).toBe('node')
  })

  it('includes connection-owned technologies and owners in diagram perspectives', () => {
    const connection = {
      id: 'c1', fromId: 'a', toId: 'b', type: 'solid' as const,
      technologyUsages: {
        protocol: {
          id: 'protocol', technologyId: 'grpc', catalogRevision: 1,
          snapshot: { schemaVersion: 1 as const, name: 'gRPC' },
        },
      },
      technologyUsageOrder: ['protocol'],
      ownerAssignments: {
        'user:alice': { id: 'user:alice', kind: 'person' as const, source: 'platform' as const, name: 'Alice Martin' },
      },
      ownerAssignmentOrder: ['user:alice'],
    }

    expect(collectDiagramFacetValues([connection], 'technology')).toEqual([{ id: 'grpc', label: 'gRPC' }])
    expect(collectDiagramFacetValues([connection], 'teams')).toEqual([{ id: 'user:alice', label: 'Alice Martin' }])
    expect(resolveConnectionPerspectiveFacet(undefined, undefined, 'technology', {
      hoveredId: 'grpc', focusedId: null, pinnedIds: [],
    }, connection)?.label).toBe('gRPC')
  })
})
