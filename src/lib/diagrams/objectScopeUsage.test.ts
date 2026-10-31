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
import type { C4Object, ObjectScope } from '../../types'
import { parentLookup } from './objectScope'
import { scopeUsageOf, type ScopeUsageDiagram } from './objectScopeUsage'

type Obj = Pick<C4Object, 'id' | 'type' | 'scope' | 'parentId'>
const obj = (id: string, parentId?: string, scope: ObjectScope = 'internal', type: C4Object['type'] = 'system'): Obj =>
  parentId ? { id, type, parentId, scope } : { id, type, scope }

// Same model as the server twin (server/src/readModel/objectScopeUsage.integration.test.ts):
// shop ⊃ web, api ⊃ auth; bank ⊃ ledger; stripe external by default.
const model = [
  obj('shop'), obj('web', 'shop'), obj('api', 'shop'), obj('auth', 'api'),
  obj('bank'), obj('ledger', 'bank'), obj('stripe', undefined, 'external'), obj('customer', undefined, 'internal', 'actor'),
]
const byId = new Map(model.map((o) => [o.id, o]))
const parentOf = parentLookup((id) => byId.get(id))
/** Membership the way the resident tier's DiagramIndex supplies it. */
const usageOf = (id: string, diagrams: ScopeUsageDiagram[], object = byId.get(id)!) =>
  scopeUsageOf(object, diagrams.filter((d) => d.objectIds.includes(id)), parentOf)

const landscape: ScopeUsageDiagram = { objectIds: ['shop', 'bank', 'stripe', 'customer'] }
const shopContainers: ScopeUsageDiagram = { parentObjectId: 'shop', objectIds: ['shop', 'web', 'api', 'bank', 'stripe', 'customer'] }
const apiComponents: ScopeUsageDiagram = { parentObjectId: 'api', objectIds: ['auth', 'web', 'ledger'] }
const bankContainers: ScopeUsageDiagram = { parentObjectId: 'bank', objectIds: ['ledger', 'auth'] }
const all = [landscape, shopContainers, apiComponents]

describe('scopeUsageOf', () => {
  it('counts the C4 boundary rule: outside the drill-down focus is external', () => {
    // bank: internal on the landscape (default), external on shop's container view.
    expect(usageOf('bank', all)).toEqual({ external: 1, total: 2 })
    // web: inside shop's view, but a sibling OUTSIDE api's component view.
    expect(usageOf('web', all)).toEqual({ external: 1, total: 2 })
    // auth is nested two deep under api: inside.
    expect(usageOf('auth', all)).toEqual({ external: 0, total: 1 })
    // ledger's parent bank is outside api: external.
    expect(usageOf('ledger', all)).toEqual({ external: 1, total: 1 })
    // An external default stays external everywhere.
    expect(usageOf('stripe', all)).toEqual({ external: 2, total: 2 })
    // An actor is exempt from the boundary: internal on shop's view too.
    expect(usageOf('customer', all)).toEqual({ external: 0, total: 2 })
  })

  it('the focus is inside its own drill-down; a two-step ancestry outside the focus is external', () => {
    expect(usageOf('shop', all)).toEqual({ external: 0, total: 2 })
    expect(usageOf('auth', [bankContainers])).toEqual({ external: 1, total: 1 })
  })

  it('lets a per-diagram override win over the boundary rule and the default, both ways', () => {
    const diagrams: ScopeUsageDiagram[] = [
      { ...landscape, objectScopes: { shop: 'external', stripe: 'internal' } },
      { ...shopContainers, objectScopes: { bank: 'internal' } },
    ]
    expect(usageOf('shop', [diagrams[0]])).toEqual({ external: 1, total: 1 })
    expect(usageOf('stripe', diagrams)).toEqual({ external: 1, total: 2 })
    expect(usageOf('bank', diagrams)).toEqual({ external: 0, total: 2 })
  })

  it('counts external an object whose ancestry runs off the resident model (inside must be proven, as on the canvas)', () => {
    const orphan = obj('orphan', 'not-loaded')
    expect(usageOf('orphan', [{ parentObjectId: 'shop', objectIds: ['orphan'] }], orphan))
      .toEqual({ external: 1, total: 1 })
  })
})
