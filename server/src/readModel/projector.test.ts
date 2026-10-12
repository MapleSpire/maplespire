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

import { describe, it, expect } from 'vitest'
import {
  connectionToRow,
  groupTagRows,
  groupTechnologyRows,
  objectTagRows,
  objectTeamRows,
  objectTechnologyRows,
  objectToRow,
  type WorkspaceKey,
} from './projector.js'

const WS: WorkspaceKey = { landscapeId: 'ls1', versionId: 'v1' }

describe('projector row mappers (pure)', () => {
  it('maps object fields to columns and keeps the entity verbatim in data', () => {
    const o = {
      id: 'o1', type: 'app', name: 'API', description: 'desc', technology: 'Go',
      domainId: 'dom1', parentId: 'p1', scope: 'internal', status: 'live',
      tagAssignments: { 'tag-x': { tagId: 'tag-x' } }, tagOrder: ['tag-x'],
    }
    const r = objectToRow(WS, 'org1', o)
    expect(r).toMatchObject({
      landscape_id: 'ls1', version_id: 'v1', org_id: 'org1',
      id: 'o1', type: 'app', name: 'API', description: 'desc', technology: 'Go',
      domain_id: 'dom1', parent_id: 'p1', scope: 'internal', status: 'live',
    })
    expect(r.data).toBe(o) // verbatim → object(id) reconstructs byte-for-byte
  })

  it('defaults missing string fields to empty and optional ids to null', () => {
    const r = objectToRow(WS, null, { id: 'o2' })
    expect(r).toMatchObject({
      type: '', name: '', description: '', technology: '',
      domain_id: null, parent_id: null, scope: null, status: null, org_id: null,
    })
  })

  it('denormalizes the technology column from `technology` + `technologies[]`', () => {
    expect(objectToRow(WS, null, { id: 'o', technology: 'Go' }).technology).toBe('Go')
    expect(objectToRow(WS, null, { id: 'o', technologies: [{ name: 'Kafka' }, { name: 'Flink' }] }).technology).toBe('Kafka Flink')
    expect(objectToRow(WS, null, { id: 'o', technology: 'Go', technologies: [{ name: 'Kafka' }] }).technology).toBe('Go Kafka')
  })

  it('maps connection fields, defaulting label to empty and kind to null', () => {
    expect(connectionToRow(WS, 'org1', { id: 'c1', fromId: 'a', toId: 'b', label: 'calls', kind: 'direct' })).toMatchObject({
      landscape_id: 'ls1', version_id: 'v1', org_id: 'org1',
      id: 'c1', from_id: 'a', to_id: 'b', label: 'calls', kind: 'direct',
    })
    expect(connectionToRow(WS, null, { id: 'c2', fromId: 'a', toId: 'b' })).toMatchObject({ label: '', kind: null })
  })

  it('normalizes governed technology usages by stable IDs and keeps versions per usage', () => {
    const rows = objectTechnologyRows(WS, 'org1', {
      id: 'o1',
      technologyUsages: {
        angular: {
          id: 'usage-a', technologyId: 'tech-angular', catalogRevision: 7,
          usedVersion: '21', role: 'framework', snapshot: { name: 'Angular', iconLightPath: '/a.hash.svg' },
        },
        invalid: {
          id: 'bad', technologyId: '', catalogRevision: 0, snapshot: { name: 'Bad' },
        },
      },
    })
    expect(rows).toEqual([{
      landscape_id: 'ls1', version_id: 'v1', org_id: 'org1', object_id: 'o1',
      usage_id: 'usage-a', technology_id: 'tech-angular', catalog_revision: 7,
      used_version: '21', role: 'framework',
      snapshot: { name: 'Angular', iconLightPath: '/a.hash.svg' },
    }])
  })

  it('normalizes governed group technologies into group postings', () => {
    expect(groupTechnologyRows(WS, 'org1', {
      id: 'g1',
      technologyUsages: {
        docker: {
          id: 'usage-docker', technologyId: 'tech-docker', catalogRevision: 2,
          role: 'infrastructure', snapshot: { name: 'Docker', recommendedShapeTypes: ['group'] },
        },
      },
    })).toEqual([{
      landscape_id: 'ls1', version_id: 'v1', org_id: 'org1', group_id: 'g1',
      usage_id: 'usage-docker', technology_id: 'tech-docker', catalog_revision: 2,
      used_version: null, role: 'infrastructure',
      snapshot: { name: 'Docker', recommendedShapeTypes: ['group'] },
    }])
  })

  it('normalizes stable Tag assignments and repairs incomplete CRDT order deterministically', () => {
    expect(objectTagRows(WS, 'org1', {
      id: 'o1',
      tagAssignments: {
        'tag-b': { tagId: 'tag-b' },
        'tag-a': { tagId: 'tag-a' },
        invalid: { tagId: 'different-id' },
      },
      tagOrder: ['tag-b', 'tag-b', 'missing'],
    })).toEqual([
      { landscape_id: 'ls1', version_id: 'v1', org_id: 'org1', object_id: 'o1', tag_id: 'tag-b', ordinal: 0 },
      { landscape_id: 'ls1', version_id: 'v1', org_id: 'org1', object_id: 'o1', tag_id: 'tag-a', ordinal: 1 },
    ])
    expect(groupTagRows(WS, null, {
      id: 'g1', tagAssignments: { risk: { tagId: 'risk' } }, tagOrder: ['risk'],
    })).toEqual([
      { landscape_id: 'ls1', version_id: 'v1', org_id: null, group_id: 'g1', tag_id: 'risk', ordinal: 0 },
    ])
  })

  it('normalizes and deduplicates owner/member teams for indexed facets', () => {
    expect(objectTeamRows(WS, 'org1', {
      id: 'o1', ownerTeamIds: ['team-b', 'team-shared'], teamIds: ['team-a', 'team-shared'],
    })).toEqual([
      { landscape_id: 'ls1', version_id: 'v1', org_id: 'org1', object_id: 'o1', team_id: 'team-b' },
      { landscape_id: 'ls1', version_id: 'v1', org_id: 'org1', object_id: 'o1', team_id: 'team-shared' },
      { landscape_id: 'ls1', version_id: 'v1', org_id: 'org1', object_id: 'o1', team_id: 'team-a' },
    ])
  })
})
