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
import { parentLookup, resolveObjectScope, withEffectiveScope, type ScopeSource } from './objectScope'
import * as server from '../../../server/src/ai/core/objectScope.js'

/**
 * ONE table, run through BOTH copies of the rule: this module and the server's
 * `server/src/ai/core/objectScope.ts` (the server does not import client
 * source). Same shape as `documentResolution.conformance.test.ts`: a drift
 * between the copies goes red here, and the case says which answer is right.
 */
type Obj = Pick<C4Object, 'id' | 'type' | 'scope' | 'parentId'>
const obj = (id: string, parentId?: string, scope: ObjectScope = 'internal', type: C4Object['type'] = 'system'): Obj =>
  parentId ? { id, type, parentId, scope } : { id, type, scope }

// shop (system) ⊃ web, api (apps) ⊃ auth (component); bank (system) ⊃ ledger
const model = [
  obj('shop'),
  obj('web', 'shop'),
  obj('api', 'shop'),
  obj('auth', 'api'),
  obj('bank'),
  obj('ledger', 'bank'),
  obj('stripe', undefined, 'external'),
  obj('customer', undefined, 'internal', 'actor'),
  obj('partner', undefined, 'external', 'actor'),
  obj('stripe-api', 'shop', 'external'),
  obj('orphan', 'not-loaded'),
  obj('cyc-a', 'cyc-b'),
  obj('cyc-b', 'cyc-a'),
]
const byId = new Map(model.map((o) => [o.id, o]))

type Diagram = { parentObjectId?: string; objectScopes?: Record<string, ObjectScope> }
type Case = [label: string, objectId: string, diagram: Diagram, scope: ObjectScope, source: ScopeSource]

const CASES: Case[] = [
  ['default on a flat diagram (internal)', 'bank', {}, 'internal', 'default'],
  ['default on a flat diagram (external)', 'stripe', {}, 'external', 'default'],
  ['the focus itself is inside', 'shop', { parentObjectId: 'shop' }, 'internal', 'default'],
  ['a direct child of the focus is inside', 'web', { parentObjectId: 'shop' }, 'internal', 'default'],
  ['a grandchild of the focus is inside', 'auth', { parentObjectId: 'shop' }, 'internal', 'default'],
  ['another root system is outside (C4 level 2)', 'bank', { parentObjectId: 'shop' }, 'external', 'boundary'],
  ['an actor outside the focus is exempt from the boundary rule', 'customer', { parentObjectId: 'shop' }, 'internal', 'default'],
  ["an exempt actor keeps an external default", 'partner', { parentObjectId: 'shop' }, 'external', 'default'],
  ['an override still applies to an actor', 'customer', { parentObjectId: 'shop', objectScopes: { customer: 'external' } }, 'external', 'diagram'],
  ["a sibling system's child is outside", 'ledger', { parentObjectId: 'shop' }, 'external', 'boundary'],
  ['a sibling container is outside a component view', 'web', { parentObjectId: 'api' }, 'external', 'boundary'],
  ["the focus's own parent is outside its component view", 'shop', { parentObjectId: 'api' }, 'external', 'boundary'],
  ['an unresolvable ancestor is not proof of inside', 'orphan', { parentObjectId: 'shop' }, 'external', 'boundary'],
  ['a parent cycle terminates and is not inside', 'cyc-a', { parentObjectId: 'shop' }, 'external', 'boundary'],
  ['the boundary rule never turns an external default internal', 'stripe-api', { parentObjectId: 'shop' }, 'external', 'default'],
  ['an override wins over the boundary rule', 'bank', { parentObjectId: 'shop', objectScopes: { bank: 'internal' } }, 'internal', 'diagram'],
  ['an override wins over an inside verdict', 'web', { parentObjectId: 'shop', objectScopes: { web: 'external' } }, 'external', 'diagram'],
  ['an override wins over an external default', 'stripe', { objectScopes: { stripe: 'internal' } }, 'internal', 'diagram'],
  ['a junk override value is ignored', 'bank', { objectScopes: { bank: 'maybe' as ObjectScope } }, 'internal', 'default'],
]

describe('per-diagram scope rule — client and server copies agree on one table', () => {
  const clientParentOf = parentLookup((id) => byId.get(id))
  for (const [label, objectId, diagram, scope, source] of CASES) {
    it(label, () => {
      const object = byId.get(objectId)!
      expect(resolveObjectScope(object, diagram, clientParentOf), 'client').toEqual({ scope, source })
      expect(server.resolveObjectScope(object, diagram, (id) => byId.get(id)), 'server').toEqual({ scope, source })
    })
  }
})

describe('the verdict does not depend on which ancestors are loaded', () => {
  // The server-booted editor holds only the diagram's own objects; share bake
  // and the AI tools resolve against the whole model. The common shapes must
  // agree. (Architect lens 2026-10-21: "unknown ancestor ⇒ inside" drew `web`
  // internal on api's component view in one tier, external in the others.)
  it('a sibling container on a component view is external with or without its parent system loaded', () => {
    const onDiagram = new Map(['web', 'api', 'auth'].map((id) => [id, byId.get(id)!]))
    const full = parentLookup((id) => byId.get(id))
    const resident = parentLookup((id) => onDiagram.get(id))
    for (const id of ['web', 'auth']) {
      expect(resolveObjectScope(byId.get(id)!, { parentObjectId: 'api' }, resident))
        .toEqual(resolveObjectScope(byId.get(id)!, { parentObjectId: 'api' }, full))
    }
    expect(resolveObjectScope(byId.get('web')!, { parentObjectId: 'api' }, resident).scope).toBe('external')
  })

  it('without any lookup, direct children are still inside and everything else outside', () => {
    expect(resolveObjectScope(byId.get('web')!, { parentObjectId: 'shop' }).scope).toBe('internal')
    expect(resolveObjectScope(byId.get('ledger')!, { parentObjectId: 'shop' }).scope).toBe('external')
  })
})

describe('withEffectiveScope', () => {
  const parentOf = parentLookup((id) => byId.get(id))

  it('keeps the same reference when the effective scope equals the default', () => {
    const o = byId.get('web')!
    expect(withEffectiveScope(o, { parentObjectId: 'shop' }, parentOf)).toBe(o)
  })

  it('returns a copy carrying the effective scope and never mutates the model object', () => {
    const o = byId.get('bank')!
    const shown = withEffectiveScope(o, { parentObjectId: 'shop' }, parentOf)
    expect(shown).not.toBe(o)
    expect(shown.scope).toBe('external')
    expect(o.scope).toBe('internal')
  })
})
