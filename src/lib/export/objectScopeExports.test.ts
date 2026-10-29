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

import { beforeAll, describe, expect, it } from 'vitest'
import type { C4Object, Diagram } from '../../types'
import type { ExportBundle } from './types'
import { buildMermaid } from './mermaid'
import { sliceForSummary } from './summary'
import { sceneFromBundle } from './image'
import i18n from '../i18n'

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

// Every export of ONE diagram must show the scope that diagram shows: the
// override, then the C4 boundary rule, then the default. The landscape export
// has no diagram and reports the default.
const obj = (id: string, type: C4Object['type'], parentId?: string): C4Object => ({
  id, name: id, type, position: { x: 0, y: 0 }, size: { width: 180, height: 110 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  ...(parentId ? { parentId } : {}),
} as C4Object)

// shop ⊃ web, api ; bank ⊃ ledger. Container view of shop shows web, api and
// ledger (bank itself is NOT on the diagram: the boundary verdict for ledger
// needs its ancestor from the whole bundle).
function bundle(): ExportBundle {
  const shopView: Diagram = {
    id: 'shop-c', name: 'Shop containers', type: 'container', parentObjectId: 'shop',
    objectIds: ['web', 'api', 'ledger'], connectionIds: [], groupIds: [],
    objectScopes: { api: 'external' },
  }
  return {
    landscapeName: 'L', generatedAt: '2026-10-21T00:00:00.000Z',
    diagrams: [shopView], activeDiagramId: 'shop-c', flowsByDiagram: {},
    objects: [obj('shop', 'system'), obj('web', 'app', 'shop'), obj('api', 'app', 'shop'), obj('bank', 'system'), obj('ledger', 'app', 'bank')],
    connections: [], groups: [], domains: [], tags: [], decisionRecords: [],
  }
}
const EXPECTED = { web: 'internal', api: 'external', ledger: 'external' }
const scopes = (objects: C4Object[]) => Object.fromEntries(objects.map((o) => [o.id, o.scope]))

describe('per-diagram scope in diagram exports', () => {
  it('image/SVG/PDF scene carries the effective scope (override + boundary through an off-diagram ancestor)', () => {
    expect(scopes(sceneFromBundle(bundle(), 'shop-c')!.objects)).toEqual(EXPECTED)
  })

  it('mermaid diagram export picks the _Ext flavour per diagram', () => {
    const mmd = buildMermaid(bundle(), 'diagram')
    expect(mmd).toMatch(/\bContainer\(web,/)
    expect(mmd).toMatch(/\bContainer_Ext\(api,/)
    expect(mmd).toMatch(/\bContainer_Ext\(ledger,/)
  })

  it('diagram summary reports the per-diagram scope; landscape summary the default', () => {
    expect(scopes(sliceForSummary(bundle(), 'diagram', 'shop-c').objects)).toEqual(EXPECTED)
    const landscape = scopes(sliceForSummary(bundle(), 'landscape').objects)
    expect(landscape.api).toBe('internal')
    expect(landscape.ledger).toBe('internal')
  })
})
